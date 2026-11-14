// Setting up and keeping up the Stream Deck module in Companion (src/companion.ts), against a
// stand-in Companion that answers the same tRPC calls over a WebSocket as Companion 5.1 does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import {
  companionUrl, describeStep, ensureCompanion, MODULE_ID, packageVersion, planCompanion, type CompanionConnection,
} from '../src/companion.ts';

const root = path.resolve(import.meta.dirname, '..');
const TGZ = '/x/hopechurch-ablecon-1.3.0.tgz';

interface FakeConn extends CompanionConnection {
  moduleId: string;
  config: Record<string, unknown>;
}

/** A stand-in Companion: just the module and connection calls Ablecon makes. */
async function fakeCompanion(start: { installed?: string[]; connections?: FakeConn[]; refuseInstall?: string } = {}) {
  const state = {
    installed: [...(start.installed ?? [])],
    connections: new Map((start.connections ?? []).map((c) => [c.id, { ...c }])),
    imported: [] as Buffer[],
    calls: [] as string[],
  };
  let nextId = 1;
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', path: '/trpc' });
  await new Promise((r) => wss.once('listening', r));
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.method === 'subscription.stop') return void state.calls.push('stop');
      const { path: p, input } = msg.params;
      state.calls.push(p);
      const reply = (data: unknown) => ws.send(JSON.stringify({ id: msg.id, result: { type: 'data', data } }));
      const fail = (message: string) => ws.send(JSON.stringify({ id: msg.id, error: { message, code: -32600 } }));
      if (msg.method === 'subscription') ws.send(JSON.stringify({ id: msg.id, result: { type: 'started' } }));
      switch (p) {
        case 'instances.modules.watch':
          return reply({
            type: 'init',
            info: state.installed.length
              ? { [`connection:${MODULE_ID}`]: { moduleType: 'connection', installedVersions: state.installed.map((versionId) => ({ versionId })) } }
              : {},
          });
        case 'instances.connections.watch': // Companion sends a list of updates; the first is "init"
          return reply([{ type: 'init', info: Object.fromEntries([...state.connections].map(([id, c]) => [id, c])) }]);
        case 'instances.modulesManager.installModuleTar': {
          if (start.refuseInstall) return reply(start.refuseInstall);
          const tar = Buffer.from(input.tarBuffer, 'base64');
          state.imported.push(tar);
          state.installed.push(/(\d+\.\d+\.\d+)/.exec(tar.toString())![1]);
          return reply(null);
        }
        case 'instances.connections.add': {
          if (!state.installed.includes(input.versionId)) return fail(`Module version ${input.versionId} isn't installed`);
          const id = `c${nextId++}`;
          const taken = [...state.connections.values()].some((c) => c.label === input.label);
          state.connections.set(id, {
            id, label: taken ? `${input.label}_2` : input.label, moduleId: input.module.type, moduleVersionId: input.versionId, enabled: true, config: {},
          });
          return reply(id);
        }
        case 'instances.connections.setConfig': {
          const c = state.connections.get(input.connectionId)!;
          Object.assign(c, { label: input.label, config: input.config, enabled: input.enabled ?? c.enabled });
          return reply(null);
        }
        case 'instances.connections.setModuleAndVersion': {
          if (!state.installed.includes(input.versionId)) return reply('Module version is not installed');
          state.connections.get(input.connectionId)!.moduleVersionId = input.versionId;
          return reply(null);
        }
        case 'instances.connections.setEnabled':
          state.connections.get(input.connectionId)!.enabled = input.enabled;
          return reply(null);
        default:
          return fail(`No procedure ${p}`);
      }
    });
  });
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/trpc`;
  return { state, url, close: () => new Promise<void>((r) => wss.close(() => r())) };
}

async function modulePackage(version = '1.3.0') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ablecon-companion-'));
  const tgz = path.join(dir, `${MODULE_ID}-${version}.tgz`);
  await writeFile(tgz, `package for ${version}`);
  return tgz;
}

const conn = (over: Partial<FakeConn> = {}): FakeConn => ({
  id: 'c9', label: 'ablecon', moduleId: MODULE_ID, moduleVersionId: '1.2.1', enabled: true, config: { host: '10.0.0.5', port: 8420 }, ...over,
});

test('the plan: import a missing version, add a missing connection, move older ones up, turn them back on', () => {
  assert.deepEqual(planCompanion([], [], '1.3.0'), [{ do: 'install', version: '1.3.0' }, { do: 'add', version: '1.3.0' }]);
  assert.deepEqual(planCompanion(['1.3.0'], [conn({ moduleVersionId: '1.3.0' })], '1.3.0'), [], 'all set: nothing to do');
  assert.deepEqual(planCompanion(['1.2.1', '1.3.0'], [conn()], '1.3.0'), [
    { do: 'upgrade', id: 'c9', label: 'ablecon', from: '1.2.1', version: '1.3.0' },
  ]);
  assert.deepEqual(planCompanion(['1.3.0'], [conn({ moduleVersionId: '1.3.0', enabled: false })], '1.3.0'), [
    { do: 'enable', id: 'c9', label: 'ablecon' },
  ]);
  assert.deepEqual(planCompanion(['1.3.0'], [conn({ moduleVersionId: null })], '1.3.0')[0].do, 'upgrade', 'a connection with no version');
  assert.deepEqual(planCompanion(['1.4.0'], [conn({ moduleVersionId: '1.4.0' })], '1.3.0'), [{ do: 'install', version: '1.3.0' }],
    'a newer module (from a newer Ablecon) is never moved back');
  assert.deepEqual(planCompanion(['1.3.0'], [conn({ moduleVersionId: 'dev', enabled: false })], '1.3.0'), [],
    'a developer copy of the module is left alone');
  assert.match(describeStep({ do: 'upgrade', id: 'c9', label: 'ablecon', from: '1.2.1', version: '1.3.0' }), /moved "ablecon" to module 1\.3\.0 \(was 1\.2\.1\)/);
});

test('a Mac with Companion but no module gets the module and a connection to this Ablecon', async () => {
  const fake = await fakeCompanion();
  try {
    const tgz = await modulePackage();
    const result = await ensureCompanion({ tgz, ablePort: 8431, url: fake.url });
    assert.equal(result.state, 'ok');
    assert.deepEqual(fake.state.imported, [await readFile(tgz)], 'the package Ablecon carries was imported');
    const [c] = [...fake.state.connections.values()];
    assert.deepEqual(
      { label: c.label, moduleId: c.moduleId, version: c.moduleVersionId, enabled: c.enabled, config: c.config },
      { label: 'ablecon', moduleId: MODULE_ID, version: '1.3.0', enabled: true, config: { host: '127.0.0.1', port: 8431 } },
    );
    assert.ok(fake.state.calls.includes('stop'), 'subscriptions are stopped after reading them');

    // Run again (as every minute): nothing more to do.
    fake.state.calls.length = 0;
    const again = await ensureCompanion({ tgz, ablePort: 8431, url: fake.url });
    assert.deepEqual(again.state === 'ok' && again.steps, []);
    assert.ok(!fake.state.calls.some((p) => p.includes('add') || p.includes('install') || p.includes('set')), 'no changes made');
  } finally {
    await fake.close();
  }
});

test('a new Ablecon moves the existing connection to its module, keeping its settings', async () => {
  const fake = await fakeCompanion({ installed: ['1.2.1'], connections: [conn({ enabled: false })] });
  try {
    const result = await ensureCompanion({ tgz: await modulePackage(), ablePort: 8420, url: fake.url });
    assert.equal(result.state, 'ok');
    assert.deepEqual(result.state === 'ok' && result.steps.map((s) => s.do), ['install', 'upgrade', 'enable']);
    assert.deepEqual(fake.state.installed, ['1.2.1', '1.3.0']);
    const c = fake.state.connections.get('c9')!;
    assert.equal(c.moduleVersionId, '1.3.0');
    assert.equal(c.enabled, true);
    assert.deepEqual(c.config, { host: '10.0.0.5', port: 8420 }, 'its address is left as it was');
    assert.equal(fake.state.connections.size, 1, 'no second connection');
  } finally {
    await fake.close();
  }
});

test('a deleted connection comes back; a taken label is kept as Companion named it', async () => {
  const other = conn({ id: 'x1', moduleId: 'generic-osc', label: 'ablecon', moduleVersionId: '2.0.0' });
  const fake = await fakeCompanion({ installed: ['1.3.0'], connections: [other] });
  try {
    await ensureCompanion({ tgz: await modulePackage(), ablePort: 8420, url: fake.url });
    const mine = [...fake.state.connections.values()].find((c) => c.moduleId === MODULE_ID)!;
    assert.equal(mine.label, 'ablecon_2');
    assert.deepEqual(mine.config, { host: '127.0.0.1', port: 8420 });
    assert.equal(fake.state.connections.get('x1')!.label, 'ablecon', 'the other connection is untouched');
  } finally {
    await fake.close();
  }
});

test('nothing changes while Live is playing; it waits for the next try', async () => {
  const fake = await fakeCompanion({ installed: ['1.2.1'], connections: [conn()] });
  try {
    const result = await ensureCompanion({ tgz: await modulePackage(), ablePort: 8420, url: fake.url, busy: () => true });
    assert.equal(result.state, 'waiting');
    assert.equal(fake.state.connections.get('c9')!.moduleVersionId, '1.2.1');
    assert.deepEqual(fake.state.imported, []);
  } finally {
    await fake.close();
  }
});

test('a refused import is reported, not hidden', async () => {
  const fake = await fakeCompanion({ refuseInstall: 'Importing custom modules is only allowed from the local machine.' });
  try {
    await assert.rejects(ensureCompanion({ tgz: await modulePackage(), ablePort: 8420, url: fake.url }), /only allowed from the local machine/);
  } finally {
    await fake.close();
  }
});

test('Companion not installed or not running', async () => {
  const tgz = await modulePackage();
  assert.deepEqual(await ensureCompanion({ tgz, ablePort: 8420, companionDir: '/nowhere/companion' }), { state: 'absent' });
  const fake = await fakeCompanion();
  const url = fake.url;
  await fake.close();
  assert.deepEqual(await ensureCompanion({ tgz, ablePort: 8420, url }), { state: 'not-running', url });
});

test("Companion's address comes from its launcher settings", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ablecon-companion-dir-'));
  assert.equal(await companionUrl(dir), 'ws://127.0.0.1:8000/trpc', 'defaults');
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ http_port: 8888, bind_ip: '0.0.0.0' }));
  assert.equal(await companionUrl(dir), 'ws://127.0.0.1:8888/trpc', 'listening everywhere: use this Mac');
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ http_port: 8000, bind_ip: '192.168.1.20' }));
  assert.equal(await companionUrl(dir), 'ws://192.168.1.20:8000/trpc');
  assert.equal(await companionUrl(path.join(dir, 'missing')), null);
});

test('the app carries the module package from the repo', async () => {
  assert.equal(packageVersion('/a/b/hopechurch-ablecon-1.2.1.tgz'), '1.2.1');
  assert.equal(packageVersion('/a/b/other-1.2.1.tgz'), null);
  const manifest = JSON.parse(await readFile(path.join(root, 'companion-module/companion/manifest.json'), 'utf8'));
  const tgzs = (await readdir(path.join(root, 'companion-module'))).filter((f) => f.endsWith('.tgz'));
  assert.deepEqual(tgzs.map((f) => packageVersion(f)), [manifest.version]);
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.ok(
    pkg.build.extraResources.some((r: { from: string; filter?: string[] }) => r.from === 'companion-module' && r.filter?.includes('*.tgz')),
    'the installer includes companion-module/*.tgz',
  );
});
