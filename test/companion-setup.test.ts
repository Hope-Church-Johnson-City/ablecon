// Setting up and keeping up the Stream Deck module in Companion (src/companion.ts), against a
// stand-in Companion that answers the same tRPC calls over a WebSocket as Companion 5.1 does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import {
  buttonPageTarget, companionUrl, describeStep, ensureCompanion, MODULE_ID, packageVersion, planCompanion,
  type CompanionConnection, type CompanionPage,
} from '../src/companion.ts';

// The module's own action and feedback lists (plain JS, in the module's folder).
const { actionDefinitions, feedbackDefinitions } = (await import('../companion-module/src/definitions.js' as string)) as {
  actionDefinitions: (run: () => void) => Record<string, unknown>;
  feedbackDefinitions: (check: () => boolean) => Record<string, unknown>;
};

const root = path.resolve(import.meta.dirname, '..');
const BUTTONS = path.join(root, 'companion-module', 'ablecon-buttons.companionconfig');

/** A page as Companion keeps it: name, keys (row → column → control id), and for the stand-in, the
 * connection ids the keys' actions and feedbacks use. */
interface FakePage {
  name: string;
  controls: Record<number, Record<number, string>>;
  usesConnections?: string[];
}

/** Companion's fresh page 1: only its page-up, page-number and page-down keys. */
const freshPage = (): FakePage => ({ name: 'PAGE', controls: { 0: { 0: 'nav1' }, 1: { 0: 'nav2' }, 2: { 0: 'nav3' } } });

interface FakeConn extends CompanionConnection {
  moduleId: string;
  config: Record<string, unknown>;
}

/** A stand-in Companion: just the module and connection calls Ablecon makes. */
async function fakeCompanion(start: { installed?: string[]; connections?: FakeConn[]; refuseInstall?: string; pages?: FakePage[] } = {}) {
  const state = {
    installed: [...(start.installed ?? [])],
    connections: new Map((start.connections ?? []).map((c) => [c.id, { ...c }])),
    pages: start.pages ?? [freshPage()],
    imported: [] as Buffer[],
    calls: [] as string[],
  };
  let upload: { id: string; data: Buffer } | null = null;
  let pending: { page: { name: string; controls: Record<string, Record<string, unknown>> }; instances: Record<string, unknown> } | null = null;
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
        case 'pages.watch':
          return reply({
            type: 'init',
            order: state.pages.map((_, i) => `p${i}`),
            pages: Object.fromEntries(state.pages.map((pg, i) => [`p${i}`, { id: `p${i}`, name: pg.name, controls: pg.controls }])),
          });
        case 'importExport.prepareImport.start':
          if (upload) return fail('Session already exists or size is invalid');
          upload = { id: 'u1', data: Buffer.alloc(input.size) };
          return reply('u1');
        case 'importExport.prepareImport.uploadChunk': {
          const u = upload;
          if (u?.id !== input.sessionId) return fail('Invalid session or offset');
          Buffer.from(input.data, 'base64').copy(u!.data, input.offset);
          return reply(1);
        }
        case 'importExport.prepareImport.complete': {
          const data = upload!.data;
          upload = null;
          if (createHash('sha1').update(data).digest('hex') !== input.expectedChecksum) return fail('Checksum mismatch');
          const obj = JSON.parse(data.toString('utf8'));
          if (obj.type !== 'page') return reply(['Not a page export', null]);
          pending = obj;
          return reply([null, { type: 'page' }]);
        }
        case 'importExport.importSinglePage': {
          if (!pending) return fail('No in-progress import object');
          const remap = input.connectionIdRemapping as Record<string, string>;
          // Which connections the imported keys end up using (Companion rewrites each action's id).
          const used = new Set<string>();
          const ids = JSON.stringify(pending.page.controls).matchAll(/"connectionId":"([^"]+)"/g);
          for (const [, id] of ids) used.add(remap[id] ?? `new:${id}`);
          const controls: FakePage['controls'] = {};
          for (const [row, cols] of Object.entries(pending.page.controls)) {
            for (const col of Object.keys(cols)) (controls[Number(row)] ??= {})[Number(col)] = `imported-${row}-${col}`;
          }
          const page: FakePage = { name: pending.page.name, controls, usesConnections: [...used] };
          if (input.targetPage === -1) state.pages.push(page);
          else state.pages[input.targetPage - 1] = page;
          return reply(remap);
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

// ---- the Stream Deck button page ---------------------------------------------------------

const page = (number: number, name: string, controls: CompanionPage['controls'] = {}): CompanionPage => ({ number, name, controls });
const navOnly = { 0: { 0: 'a' }, 1: { 0: 'b' }, 2: { 0: 'c' } };

test('the plan: the button page comes with a new connection, or on request, never twice', () => {
  const fresh = [page(1, 'PAGE', navOnly)];
  assert.deepEqual(planCompanion(['1.3.0'], [], '1.3.0', fresh).at(-1), { do: 'buttons', page: 1 }, 'a fresh Companion: page 1');
  assert.deepEqual(planCompanion(['1.3.0'], [conn({ moduleVersionId: '1.3.0' })], '1.3.0', fresh), [],
    'an Ablecon connection was already there: its own buttons are kept');
  assert.deepEqual(planCompanion(['1.3.0'], [conn({ moduleVersionId: '1.3.0' })], '1.3.0', fresh, true), [{ do: 'buttons', page: 1 }], 'asked for');
  assert.deepEqual(planCompanion(['1.3.0'], [], '1.3.0', [page(1, 'PAGE', navOnly), page(2, ' ablecon ')]).map((s) => s.do), ['add'],
    'a page called Ablecon is already there');
  assert.equal(buttonPageTarget([page(1, 'PAGE', { ...navOnly, 0: { 0: 'a', 3: 'mine' } })]), null, 'a page with keys on it is never replaced');
  assert.equal(buttonPageTarget([page(1, 'PAGE'), page(2, 'PAGE')]), null, 'more than one page: a new page at the end');
  assert.equal(buttonPageTarget([page(1, 'Mine', { 0: { 0: null as unknown as string } })]), 1, 'empty spots are empty');
  assert.match(describeStep({ do: 'buttons', page: null }), /added the Stream Deck buttons as page at the end/);
  assert.match(describeStep({ do: 'buttons', page: 1 }), /as page 1 \("Ablecon"\)/);
});

test('a fresh Companion gets the module, a connection and the buttons on page 1, once', async () => {
  const fake = await fakeCompanion();
  try {
    const tgz = await modulePackage();
    const result = await ensureCompanion({ tgz, ablePort: 8420, url: fake.url, buttons: BUTTONS });
    assert.equal(result.state, 'ok');
    assert.deepEqual(result.state === 'ok' && result.steps.map((s) => s.do), ['install', 'add', 'buttons']);
    assert.equal(result.state === 'ok' && result.buttonPage, true);
    const [c] = [...fake.state.connections.values()];
    assert.equal(fake.state.pages.length, 1, 'page 1 was used, not a new page');
    assert.equal(fake.state.pages[0].name, 'Ablecon');
    assert.deepEqual(fake.state.pages[0].usesConnections, [c.id], "every key uses this Mac's new Ablecon connection");
    assert.equal(Object.values(fake.state.pages[0].controls).flatMap((r) => Object.keys(r)).length, 14);

    fake.state.calls.length = 0;
    const again = await ensureCompanion({ tgz, ablePort: 8420, url: fake.url, buttons: BUTTONS });
    assert.deepEqual(again.state === 'ok' && again.steps, [], 'the next minute: nothing to do');
    assert.ok(!fake.state.calls.some((p) => p.startsWith('importExport')), 'no second import');
  } finally {
    await fake.close();
  }
});

test("a Companion that already had Ablecon keeps its own buttons unless asked; then they're a new page at the end", async () => {
  const mine: FakePage = { name: 'Worship', controls: { 0: { 0: 'x', 1: 'y' } } };
  const fake = await fakeCompanion({ installed: ['1.3.0'], connections: [conn({ moduleVersionId: '1.3.0' })], pages: [mine] });
  try {
    const tgz = await modulePackage();
    const result = await ensureCompanion({ tgz, ablePort: 8420, url: fake.url, buttons: BUTTONS });
    assert.deepEqual(result.state === 'ok' && [result.steps, result.buttonPage], [[], false], 'nothing added; no Ablecon page');
    assert.equal(fake.state.pages.length, 1);

    const asked = await ensureCompanion({ tgz, ablePort: 8420, url: fake.url, buttons: BUTTONS, addButtons: true });
    assert.deepEqual(asked.state === 'ok' && asked.steps, [{ do: 'buttons', page: null }]);
    assert.deepEqual(fake.state.pages[0], mine, 'their page is untouched');
    assert.equal(fake.state.pages[1].name, 'Ablecon');
    assert.deepEqual(fake.state.pages[1].usesConnections, ['c9'], 'the keys use the existing connection');

    const twice = await ensureCompanion({ tgz, ablePort: 8420, url: fake.url, buttons: BUTTONS, addButtons: true });
    assert.deepEqual(twice.state === 'ok' && twice.steps, [], 'asked again: the page is there already');
    assert.equal(fake.state.pages.length, 2);
  } finally {
    await fake.close();
  }
});

test('without a button page to give (or while Live plays), no page is added', async () => {
  const fake = await fakeCompanion();
  try {
    const tgz = await modulePackage();
    const waiting = await ensureCompanion({ tgz, ablePort: 8420, url: fake.url, buttons: BUTTONS, busy: () => true });
    assert.equal(waiting.state, 'waiting');
    assert.equal(fake.state.pages[0].name, 'PAGE');
    const result = await ensureCompanion({ tgz, ablePort: 8420, url: fake.url });
    assert.deepEqual(result.state === 'ok' && result.steps.map((s) => s.do), ['install', 'add']);
    assert.equal(fake.state.pages[0].name, 'PAGE');
  } finally {
    await fake.close();
  }
});

test("the button page in the repo: Jeremy's 15-key layout, using only what the module offers", async () => {
  const exported = JSON.parse(await readFile(BUTTONS, 'utf8'));
  assert.equal(exported.type, 'page');
  assert.equal(exported.page.name, 'Ablecon');
  const instances = Object.entries(exported.instances) as Array<[string, { moduleId: string }]>;
  assert.deepEqual(instances.map(([, c]) => c.moduleId), [MODULE_ID], 'one connection: Ablecon');

  const actions = Object.keys(actionDefinitions(() => {}));
  const feedbacks = Object.keys(feedbackDefinitions(() => false));
  const layout: string[] = [];
  for (const row of ['0', '1', '2']) {
    for (const col of ['0', '1', '2', '3', '4']) {
      const key = exported.page.controls[row]?.[col];
      if (!key) {
        layout.push('-');
        continue;
      }
      const down = Object.values(key.steps as Record<string, { action_sets: { down: Array<{ definitionId: string; connectionId: string; options: Record<string, { value: unknown }> }> } }>)
        .flatMap((st) => st.action_sets.down);
      for (const a of down) {
        assert.ok(actions.includes(a.definitionId), `${row}/${col}: the module has the action ${a.definitionId}`);
        assert.equal(a.connectionId, instances[0][0]);
      }
      for (const f of key.feedbacks as Array<{ definitionId: string; connectionId: string }>) {
        assert.ok(feedbacks.includes(f.definitionId), `${row}/${col}: the module has the feedback ${f.definitionId}`);
        assert.equal(f.connectionId, instances[0][0]);
      }
      const [a] = down;
      layout.push(a.definitionId === 'cue_song' ? `song ${a.options.number.value}` : a.definitionId);
    }
  }
  assert.deepEqual(layout, [
    'song 1', 'song 2', 'song 3', 'song 4', 'song 5',
    'song 6', 'song 7', 'song 8', 'song 9', 'song 10',
    'toggle_play', 'stop', 'next_song', 'next_section', '-',
  ]);
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.ok(
    pkg.build.extraResources.some((r: { from: string; filter?: string[] }) => r.from === 'companion-module' && r.filter?.includes('*.companionconfig')),
    'the installer includes the button page',
  );
});
