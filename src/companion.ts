// Sets up the Stream Deck module in Bitfocus Companion on this Mac, and keeps it set up
// (app/main.js runs this at launch and every minute; see "Stream Deck" in README.md).
//
// Ablecon carries the module package (companion-module/<id>-<version>.tgz, kept in the repo). When
// Companion is running on this Mac, Ablecon talks to it the way Companion's own page does (tRPC over
// its local WebSocket, /trpc; importing a module package is only allowed from the same computer) and:
//   - imports the module if this version isn't installed yet,
//   - adds an "ablecon" connection to this Ablecon if there's none,
//   - moves connections on an older version of the module to this one (so a new Ablecon brings its
//     module with it the first time it starts), and turns them back on if they were turned off.
// A connection using a developer copy of the module (Companion's "dev" version) is left alone, and
// nothing is changed while Live is playing (switching versions restarts the module in Companion).
// Written against Companion 5.1.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { isNewer } from './update.ts';
import { SEMVER } from './version.ts';

export const MODULE_ID = 'hopechurch-ablecon';
export const CONNECTION_LABEL = 'ablecon'; // the prefix in $(ablecon:song_name)

/** Companion's data folder on a Mac (its launcher keeps http_port and bind_ip in config.json). */
export const COMPANION_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'companion');

/** "…/hopechurch-ablecon-1.2.1.tgz" → "1.2.1". */
export function packageVersion(tgz: string): string | null {
  return new RegExp(`${MODULE_ID}-(\\d+\\.\\d+\\.\\d+)\\.tgz$`).exec(tgz)?.[1] ?? null;
}

/**
 * Where Companion's page is, from its launcher settings; null when Companion has never run on this
 * Mac. Companion listens on 127.0.0.1:8000 unless it was changed in its launcher window.
 */
export async function companionUrl(dir = COMPANION_DIR): Promise<string | null> {
  if (!existsSync(dir)) return null;
  let host = '127.0.0.1';
  let port = 8000;
  try {
    const cfg = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8')) as { http_port?: unknown; bind_ip?: unknown };
    if (Number.isInteger(cfg.http_port)) port = cfg.http_port as number;
    // 0.0.0.0 listens everywhere, this Mac included; any other address is one of this Mac's own.
    if (typeof cfg.bind_ip === 'string' && cfg.bind_ip && cfg.bind_ip !== '0.0.0.0') host = cfg.bind_ip;
  } catch {
    // No settings file yet: Companion's defaults.
  }
  return `ws://${host.includes(':') ? `[${host}]` : host}:${port}/trpc`;
}

// ---- deciding what to do ---------------------------------------------------------------

export interface CompanionConnection {
  id: string;
  label: string;
  moduleVersionId: string | null;
  enabled: boolean;
}

export type Step =
  | { do: 'install'; version: string }
  | { do: 'add'; version: string }
  | { do: 'upgrade'; id: string; label: string; from: string | null; version: string }
  | { do: 'enable'; id: string; label: string };

/** What has to change so Companion has this module version and a working connection to Ablecon. */
export function planCompanion(installedVersions: string[], connections: CompanionConnection[], version: string): Step[] {
  const steps: Step[] = [];
  if (!installedVersions.includes(version)) steps.push({ do: 'install', version });
  if (connections.length === 0) steps.push({ do: 'add', version });
  for (const c of connections) {
    if (c.moduleVersionId === 'dev') continue; // someone is working on the module: hands off
    const v = c.moduleVersionId;
    // Older (or missing) versions move to this one; a newer one, from a newer Ablecon, stays.
    if (v === null || !SEMVER.test(v) || isNewer(version, v)) steps.push({ do: 'upgrade', id: c.id, label: c.label, from: v, version });
    if (!c.enabled) steps.push({ do: 'enable', id: c.id, label: c.label });
  }
  return steps;
}

export function describeStep(s: Step): string {
  switch (s.do) {
    case 'install': return `imported the Ablecon module ${s.version}`;
    case 'add': return `added the "${CONNECTION_LABEL}" connection (module ${s.version})`;
    case 'upgrade': return `moved "${s.label}" to module ${s.version}${s.from ? ` (was ${s.from})` : ''}`;
    case 'enable': return `turned "${s.label}" back on`;
  }
}

// ---- talking to Companion ---------------------------------------------------------------

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  subscription: boolean;
}

/** Just enough of a tRPC (v11) WebSocket client for the calls below. */
export class TrpcSocket {
  #ws: WebSocket;
  #next = 1;
  #pending = new Map<number, Pending>();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on('message', (raw) => this.#onMessage(String(raw)));
    ws.on('close', () => {
      for (const p of this.#pending.values()) p.reject(new Error('Companion closed the connection'));
      this.#pending.clear();
    });
  }

  static open(url: string, timeoutMs = 3000): Promise<TrpcSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
      ws.once('open', () => resolve(new TrpcSocket(ws)));
      ws.once('error', (err) => reject(err));
    });
  }

  #onMessage(text: string) {
    let msg: { id?: number; result?: { type?: string; data?: unknown }; error?: { message?: string } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const p = typeof msg.id === 'number' ? this.#pending.get(msg.id) : undefined;
    if (!p) return;
    if (msg.error) {
      this.#pending.delete(msg.id!);
      p.reject(new Error(msg.error.message ?? 'Companion reported an error'));
    } else if (msg.result?.type === 'data') {
      this.#pending.delete(msg.id!);
      if (p.subscription) this.#send({ id: msg.id, method: 'subscription.stop' });
      p.resolve(msg.result.data);
    }
  }

  #send(msg: object) {
    this.#ws.send(JSON.stringify(msg));
  }

  #request(method: 'query' | 'mutation' | 'subscription', procedure: string, input: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Companion didn't answer ${procedure}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (d) => (clearTimeout(timer), resolve(d)),
        reject: (e) => (clearTimeout(timer), reject(e)),
        subscription: method === 'subscription',
      });
      this.#send({ id, method, params: { path: procedure, input } });
    });
  }

  mutation(procedure: string, input: unknown, timeoutMs = 30000): Promise<unknown> {
    return this.#request('mutation', procedure, input, timeoutMs);
  }

  /** The first value a subscription sends (its current state), then stops it. */
  first(procedure: string, input?: unknown, timeoutMs = 10000): Promise<unknown> {
    return this.#request('subscription', procedure, input, timeoutMs);
  }

  close() {
    this.#ws.close();
  }
}

async function installedVersions(rpc: TrpcSocket): Promise<string[]> {
  const update = (await rpc.first('instances.modules.watch')) as { info?: Record<string, { installedVersions?: Array<{ versionId: string }> }> };
  return (update.info?.[`connection:${MODULE_ID}`]?.installedVersions ?? []).map((v) => v.versionId);
}

async function ableconConnections(rpc: TrpcSocket): Promise<CompanionConnection[]> {
  const updates = (await rpc.first('instances.connections.watch')) as Array<{ type: string; info?: Record<string, CompanionConnection & { moduleId: string }> }>;
  const init = updates.find((u) => u.type === 'init');
  return Object.values(init?.info ?? {})
    .filter((c) => c.moduleId === MODULE_ID)
    .map(({ id, label, moduleVersionId, enabled }) => ({ id, label, moduleVersionId, enabled }));
}

/** Companion answers these calls with null when they worked and a message when they didn't. */
function ok(result: unknown, what: string) {
  if (typeof result === 'string' && result) throw new Error(`${what}: ${result}`);
}

export type CompanionResult =
  | { state: 'absent' } // Companion has never run on this Mac
  | { state: 'not-running'; url: string }
  | { state: 'waiting'; url: string; steps: Step[] } // changes are due, but Live is playing
  | { state: 'ok'; url: string; version: string; steps: Step[] }; // steps: what was changed (often none)

export interface EnsureOptions {
  tgz: string; // the module package this Ablecon carries
  ablePort: number; // where a new connection should find Ablecon
  url?: string | null; // Companion's /trpc address (default: from its settings)
  companionDir?: string;
  busy?: () => boolean; // true while Live is playing: make no changes
}

/** Brings Companion's Ablecon module and connection up to date. Throws if Companion refuses a change. */
export async function ensureCompanion(opts: EnsureOptions): Promise<CompanionResult> {
  const version = packageVersion(opts.tgz);
  if (!version) throw new Error(`not an Ablecon module package: ${opts.tgz}`);
  const url = opts.url === undefined ? await companionUrl(opts.companionDir) : opts.url;
  if (!url) return { state: 'absent' };

  let rpc: TrpcSocket;
  try {
    rpc = await TrpcSocket.open(url);
  } catch {
    return { state: 'not-running', url };
  }
  try {
    const steps = planCompanion(await installedVersions(rpc), await ableconConnections(rpc), version);
    if (steps.length && opts.busy?.()) return { state: 'waiting', url, steps };
    for (const step of steps) {
      if (step.do === 'install') {
        const tarBuffer = (await readFile(opts.tgz)).toString('base64');
        const result = await rpc.mutation('instances.modulesManager.installModuleTar', { tarBuffer });
        if (!(typeof result === 'string' && /already exists/.test(result))) ok(result, 'Companion refused the module');
      } else if (step.do === 'add') {
        const id = (await rpc.mutation('instances.connections.add', {
          module: { type: MODULE_ID },
          label: CONNECTION_LABEL,
          versionId: step.version,
        })) as string;
        // Companion may have renamed it (if "ablecon" was taken); keep its label.
        const label = (await ableconConnections(rpc)).find((c) => c.id === id)?.label ?? CONNECTION_LABEL;
        ok(
          await rpc.mutation('instances.connections.setConfig', {
            connectionId: id,
            label,
            enabled: true,
            config: { host: '127.0.0.1', port: opts.ablePort },
          }),
          'Companion refused the connection settings',
        );
      } else if (step.do === 'upgrade') {
        ok(
          await rpc.mutation('instances.connections.setModuleAndVersion', { connectionId: step.id, moduleId: MODULE_ID, versionId: step.version }),
          `Companion didn't move "${step.label}" to module ${step.version}`,
        );
      } else {
        await rpc.mutation('instances.connections.setEnabled', { connectionId: step.id, enabled: true });
      }
    }
    return { state: 'ok', url, version, steps };
  } finally {
    rpc.close();
  }
}
