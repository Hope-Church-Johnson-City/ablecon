// HTTP + WebSocket server for the web UI. Used by both the command line
// entry (main.ts) and the Mac app (app/main.cjs).

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { Controller } from './controller.ts';
import { LiveClient } from './liveClient.ts';
import { APP_VERSION } from './version.ts';
import { EnvelopeCache, Waveforms } from './waveform.ts';

export interface ServerOptions {
  port?: number; // web UI port (default 8420)
  host?: string; // interface to listen on (default all, so phones can connect)
  livePort?: number; // Remote Script UDP port (default 11100)
  setlistPath: string;
  publicDir: string;
  waveformDir?: string; // where read audio is remembered (default: next to the setlist)
  log?: (msg: string) => void;
}

export interface RunningServer {
  port: number;
  urls: string[];
  controller: Controller;
  /** Tell every page that a newer Ablecon is available (null: none). */
  setUpdate(update: { version: string; url: string } | null): void;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

export function lanUrls(port: number): string[] {
  const urls: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) urls.push(`http://${addr.address}:${port}`);
    }
  }
  return urls.length ? urls : [`http://localhost:${port}`];
}

type Command = { id?: number; action: string; [key: string]: unknown };

function mode(v: unknown): 'on' | 'off' | 'toggle' {
  return v === 'on' || v === 'off' ? v : 'toggle';
}

async function dispatch(c: Controller, cmd: Command): Promise<void> {
  const id = String(cmd.songId ?? '');
  const n = (v: unknown) => Number(v);
  switch (cmd.action) {
    case 'play': return c.play();
    case 'stop': return c.stop();
    case 'cue': return c.cue(id);
    case 'start': return c.start(id, cmd.section === undefined ? undefined : n(cmd.section));
    case 'section': return c.jumpToSection(id, n(cmd.section));
    case 'loop': return c.toggleLoop(id, n(cmd.section));
    case 'loopOff': return c.loopOff();
    case 'nextSection': return c.nextSection();
    case 'cancelJump': return c.cancelJump();
    case 'move': return c.move(n(cmd.from), n(cmd.to));
    case 'reorder': return c.reorder((cmd.order as string[]) ?? []);
    case 'remove': return c.remove(id);
    case 'tempo': return c.setTempo(id, cmd.tempo);
    case 'key': return c.setKey(id, cmd.semitones);
    case 'applyKey': return c.applyKeyNow(id);
    case 'settings': return c.updateSettings((cmd.settings as object) ?? {});
    case 'refresh': return c.refresh();
    case 'mute': return c.setMute(n(cmd.track), String(cmd.name ?? ''), Boolean(cmd.muted));
    case 'solo': return c.setSolo(n(cmd.track), String(cmd.name ?? ''), Boolean(cmd.soloed));
    case 'clearSolos': return c.clearSolos();
    // Simple commands for button boxes (Stream Deck via Companion).
    case 'nextSong': return c.nextSong();
    case 'previousSong': return c.previousSong();
    case 'cueNumber': return c.cueNumber(n(cmd.number));
    case 'startNumber': return c.startNumber(n(cmd.number));
    case 'sectionNumber': return c.sectionNumber(n(cmd.number));
    case 'loopNumber': return c.loopNumber(n(cmd.number));
    case 'togglePlay': return c.togglePlay();
    case 'muteByName': return c.muteByName(String(cmd.name ?? ''), String(cmd.group ?? ''), mode(cmd.mode));
    case 'soloByName': return c.soloByName(String(cmd.name ?? ''), String(cmd.group ?? ''), mode(cmd.mode));
    default: throw new Error(`unknown action "${cmd.action}"`);
  }
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const live = new LiveClient({ port: opts.livePort ?? 11100 });
  const controller = new Controller(live, opts.setlistPath);
  await controller.init();
  let update: { version: string; url: string } | null = null;
  const snapshot = () => ({ ...controller.snapshot(), appVersion: APP_VERSION, update, waveforms: waveforms.versions() });
  const waveforms = new Waveforms(
    live,
    new EnvelopeCache(opts.waveformDir ?? path.join(path.dirname(opts.setlistPath), 'ablecon-waveforms')),
    () => broadcast({ type: 'state', state: snapshot() }),
  );
  controller.on('songs', () => {
    const tempoOf = (id: string) => {
      const e = controller.file.entries.find((x) => x.songId === id);
      return e?.tempo ?? e?.seenTempo ?? controller.position.tempo;
    };
    waveforms.update(
      controller.songs.map((s) => ({ id: s.id, start: s.start, end: s.end, bpm: tempoOf(s.id) })),
      controller.file.settings.sectionsTrack,
    );
  });
  const publicDir = path.resolve(opts.publicDir);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(snapshot()));
      return;
    }
    if (url.pathname === '/api/waveform') {
      const wave = waveforms.get(url.searchParams.get('song') ?? '');
      if (!wave) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('null');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ...wave, peaks: wave.peaks.map((p) => Math.round(p * 255)) }));
      return;
    }
    if (url.pathname === '/api/urls') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(lanUrls(running.port)));
      return;
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(publicDir, rel);
    if (!file.startsWith(publicDir + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  const broadcast = (msg: unknown) => {
    const text = JSON.stringify(msg);
    for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(text);
  };
  controller.on('state', () => broadcast({ type: 'state', state: snapshot() }));
  controller.on('position', (position) => broadcast({ type: 'position', position }));
  controller.on('notice', (notice) => broadcast({ type: 'notice', notice }));

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'state', state: snapshot() }));
    ws.on('message', async (data) => {
      let cmd: Command;
      try {
        cmd = JSON.parse(String(data));
      } catch {
        return;
      }
      try {
        await dispatch(controller, cmd);
        ws.send(JSON.stringify({ type: 'result', id: cmd.id, ok: true }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'result', id: cmd.id, ok: false, error: (err as Error).message }));
      }
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 8420, opts.host ?? '0.0.0.0', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : opts.port ?? 8420);
    });
  });

  live.on('connection', (up) => log(up ? `Connected to Live ${live.liveVersion ?? ''}`.trim() : 'Waiting for Live (is the Ablecon control surface selected?)'));
  await live.start();

  const running: RunningServer = {
    port,
    urls: lanUrls(port),
    controller,
    setUpdate: (next) => {
      update = next ? { version: next.version, url: next.url } : null;
      broadcast({ type: 'state', state: snapshot() });
    },
    close: async () => {
      live.stop();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return running;
}
