// The Companion (Stream Deck) module: its logic on its own, and the real
// module class under a stand-in for Companion, talking to the real Ablecon
// server and the fake Live.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer } from '../src/server.ts';
import { FakeLive, demoSet } from './fakeLive.ts';
import AbleconInstance from '../companion-module/src/main.js';
import { checks, commandFor, focusRow, keyLabel, upNext, variableDefinitions, variableValues } from '../companion-module/src/logic.js';
import { presetDefinitions } from '../companion-module/src/definitions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting: ' + check.toString());
    await sleep(10);
  }
}

// ---- logic ------------------------------------------------------------------------

const row = (name, start, end, extra = {}) => ({
  songId: name.toLowerCase(), name, missing: false, start, end, stopAtEnd: true, tempo: null, seenTempo: null,
  semitones: null, originalKey: null, playedKey: null, sections: [], ...extra,
});
const sampleState = () => ({
  connected: true,
  cuedId: null,
  pendingJump: null,
  totalSeconds: 300,
  tracks: [
    { index: 0, name: 'Click Foundations', parents: [], isGroup: false, muted: true, soloed: false },
    { index: 1, name: 'Drums', parents: ['Song A'], isGroup: false, muted: false, soloed: true },
    { index: 2, name: 'Drums', parents: ['Song B'], isGroup: false, muted: false, soloed: false },
  ],
  rows: [
    row('Song A', 0, 32, { originalKey: 'G', playedKey: 'A', semitones: 2, seenTempo: 120, stopAtEnd: false,
      sections: [{ name: 'Intro', start: 0, end: 8 }, { name: 'Verse', start: 8, end: 32 }] }),
    row('Gone', 0, 0, { missing: true }),
    row('Song B', 32, 64, { tempo: 90, sections: [{ name: 'Chorus', start: 32, end: 64 }] }),
    row('Song C', 70, 80),
  ],
});
const pos = (beats, playing = false, extra = {}) => ({ beats, playing, tempo: 120, loop: { enabled: false, start: 0, length: 4 }, ...extra });

test('module logic: current song, sections, up next and variables', () => {
  const s = sampleState();
  assert.equal(focusRow(s, pos(10)).name, 'Song A');
  assert.equal(focusRow(s, pos(66)).name, 'Song A', 'between songs: the first song');
  s.cuedId = 'song c';
  assert.equal(focusRow(s, pos(66)).name, 'Song C', 'between songs: the cued one');
  assert.equal(upNext(s, pos(10, true)).name, 'Song C', 'a queued song wins');
  s.cuedId = null;
  assert.equal(upNext(s, pos(10, true)).name, 'Song B', 'plays straight on (no STOP)');
  assert.equal(keyLabel(s.rows[0]), 'G → A');

  const v = variableValues(s, pos(10, true), true);
  assert.equal(v.song_name, 'Song A');
  assert.equal(v.song_number, 1);
  assert.equal(v.song_count, 3, 'songs missing from the set are not counted');
  assert.equal(v.song_key, 'G → A');
  assert.equal(v.song_tempo, 120);
  assert.equal(v.section_name, 'Verse');
  assert.equal(v.next_section_name, '');
  assert.equal(v.up_next, 'Song B');
  assert.equal(v.elapsed, '0:05');
  assert.equal(v.remaining, '0:11');
  assert.equal(v.set_length, '5:00');
  assert.equal(v.transport, 'Playing');
  assert.equal(v.connected, 'Yes');
  assert.equal(v.song_2, 'Song B');
  assert.equal(v.song_4, '');
  assert.equal(v.section_1, 'Intro');
  assert.equal(variableValues(s, pos(10), false).connected, 'No');
  assert.equal(variableValues(s, pos(40), true).song_tempo, 90, "a song's own tempo wins");

  s.pendingJump = { songId: 'song a', sectionIndex: 1, name: 'Verse', at: 8, to: 8 };
  assert.equal(variableValues(s, pos(4.5, true), true).jump_countdown, 'Verse in 4');

  const defs = variableDefinitions();
  for (const k of Object.keys(v)) assert.ok(defs[k], `variable ${k} is defined`);
  assert.equal(variableValues(null, null, false).song_name, '', 'works before Ablecon connects');
});

test('module logic: feedbacks', () => {
  const s = sampleState();
  s.cuedId = 'song c';
  const p = pos(10, true, { loop: { enabled: true, start: 8, length: 24 } });
  assert.equal(checks.playing(s, p), true);
  assert.equal(checks.song_active(s, p, true, { number: 1 }), true);
  assert.equal(checks.song_active(s, p, true, { number: 2 }), false);
  assert.equal(checks.song_up_next(s, p, true, { number: 3 }), true);
  assert.equal(checks.section_active(s, p, true, { number: 2 }), true);
  assert.equal(checks.section_looping(s, p, true, { number: 2 }), true);
  assert.equal(checks.section_looping(s, p, true, { number: 1 }), false);
  assert.equal(checks.track_muted(s, p, true, { name: 'click foundations', group: '' }), true);
  assert.equal(checks.track_soloed(s, p, true, { name: 'Drums', group: 'Song A' }), true);
  assert.equal(checks.track_soloed(s, p, true, { name: 'Drums', group: 'Song B' }), false);
  assert.equal(checks.any_solo(s), true);
  assert.equal(checks.live_connected(s, p, false), false);
});

test('module logic: button presses map to Ablecon commands', () => {
  assert.deepEqual(commandFor('cue_song', { number: 3 }), ['cueNumber', { number: 3 }]);
  assert.deepEqual(commandFor('mute_track', { name: 'Guide', group: '', mode: 'on' }), ['muteByName', { name: 'Guide', group: '', mode: 'on' }]);
  assert.deepEqual(commandFor('next_section', { tapToCancel: true }, { pendingJump: null }), ['nextSection', {}]);
  assert.deepEqual(commandFor('next_section', { tapToCancel: true }, { pendingJump: { at: 8 } }), ['cancelJump', {}], 'a second press cancels');
  assert.deepEqual(commandFor('next_section', { tapToCancel: false }, { pendingJump: { at: 8 } }), ['nextSection', {}]);
  assert.throws(() => commandFor('explode', {}), /unknown action/);
});

test('presets: every button uses a real action and feedback, and the connection label', () => {
  const { structure, presets } = presetDefinitions('mydeck');
  const ids = structure.flatMap((s) => s.definitions);
  assert.equal(new Set(ids).size, ids.length, 'no preset listed twice');
  for (const id of ids) assert.ok(presets[id], `preset ${id} exists`);
  const actionIds = new Set(['play', 'stop', 'toggle_play', 'next_song', 'previous_song', 'cue_song', 'start_song', 'next_section', 'cancel_jump', 'jump_section', 'loop_section', 'loop_off', 'mute_track', 'solo_track', 'clear_solos', 'reread']);
  for (const p of Object.values(presets)) {
    for (const a of p.steps[0].down) assert.ok(actionIds.has(a.actionId), `action ${a.actionId}`);
    for (const f of p.feedbacks) assert.ok(checks[f.feedbackId], `feedback ${f.feedbackId}`);
  }
  assert.match(presets.song_1.style.text, /\$\(mydeck:song_1\)/);
});

test("presets: buttons come without Companion's top bar (no page/button number on the key)", () => {
  const { presets } = presetDefinitions('mydeck');
  for (const [id, p] of Object.entries(presets)) assert.equal(p.style.show_topbar, false, `${id} hides the top bar`);
});

// ---- the real module under a stand-in Companion -------------------------------------------

/** Records what the module tells Companion, like Companion's own connection host does. */
function fakeCompanion(label = 'ablecon') {
  const host = {
    statuses: [],
    variables: {},
    definitions: {},
    feedbackChecks: 0,
    context: {
      _isInstanceContext: true,
      id: 'test-connection',
      label,
      upgradeScripts: [],
      sharedUdpSocketHandlers: new Map(),
      saveConfig() {},
      updateStatus(status, message) { host.statuses.push([status, message]); },
      oscSend() {},
      recordAction() {},
      setActionDefinitions(d) { host.definitions.actions = d; },
      subscribeActions() {},
      unsubscribeActions() {},
      setFeedbackDefinitions(d) { host.definitions.feedbacks = d; },
      unsubscribeFeedbacks() {},
      checkFeedbacks() { host.feedbackChecks++; },
      checkAllFeedbacks() { host.feedbackChecks++; },
      checkFeedbacksById() { host.feedbackChecks++; },
      setPresetDefinitions(structure, presets) { host.definitions.presets = { structure, presets }; },
      setCompositeElementDefinitions() {},
      setVariableDefinitions(d) { host.definitions.variables = d; },
      setVariableValues(values) { Object.assign(host.variables, values); },
      getVariableValue(id) { return host.variables[id]; },
      sharedUdpSocketJoin: async () => 'x',
      sharedUdpSocketLeave: async () => {},
      sharedUdpSocketSend: async () => {},
    },
    press(actionId, options = {}) {
      return host.definitions.actions[actionId].callback({ actionId, options, id: 'a', controlId: 'c' }, {});
    },
    feedback(feedbackId, options = {}) {
      return host.definitions.feedbacks[feedbackId].callback({ feedbackId, options, id: 'f', controlId: 'c', previousOptions: null }, {});
    },
  };
  return host;
}

async function setup(Instance = AbleconInstance) {
  const fake = new FakeLive(demoSet());
  const livePort = await fake.start();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ablecon-companion-'));
  const server = await startServer({ port: 0, host: '127.0.0.1', livePort, setlistPath: path.join(dir, 's.json'), publicDir: path.join(root, 'public'), log: () => {} });
  server.controller.scanSettleMs = 5;
  const companion = fakeCompanion();
  const module = new Instance(companion.context);
  await module.init({ host: '127.0.0.1', port: server.port }, true, undefined);
  const done = async () => {
    await module.destroy();
    await server.close();
    fake.close();
  };
  return { fake, server, companion, module, done };
}

test('the module connects, fills its variables and buttons control Live', async () => {
  const { fake, companion, done } = await setup();
  try {
    assert.ok(companion.definitions.actions.next_section, 'actions defined');
    assert.ok(companion.definitions.feedbacks.song_active, 'feedbacks defined');
    assert.ok(companion.definitions.presets.structure.length >= 5, 'presets defined');
    assert.ok(companion.definitions.variables.song_name, 'variables defined');
    await until(() => companion.variables.song_count === 2 && companion.variables.connected === 'Yes');
    assert.equal(companion.statuses.at(-1)[0], 'ok');
    assert.equal(companion.variables.song_1, 'First');
    assert.equal(companion.variables.song_name, 'First');

    await companion.press('cue_song', { number: 2 });
    assert.equal(fake.set.beats, 40);
    await until(() => companion.variables.song_name === 'Second');
    assert.equal(companion.feedback('song_active', { number: 2 }), true);
    assert.equal(companion.feedback('song_active', { number: 1 }), false);

    await companion.press('toggle_play');
    assert.equal(fake.set.playing, true);
    await until(() => companion.feedback('playing') === true);
    await companion.press('next_section', { tapToCancel: true });
    await until(() => companion.variables.jump_countdown !== '');
    assert.equal(companion.feedback('jump_pending'), true);
    await companion.press('next_section', { tapToCancel: true }); // second press cancels
    await until(() => companion.feedback('jump_pending') === false);
    await companion.press('stop');
    assert.equal(fake.set.playing, false);

    await companion.press('mute_track', { name: 'Keys', group: '', mode: 'toggle' });
    assert.ok(fake.muted.has(1));
    await until(() => companion.feedback('track_muted', { name: 'Keys', group: '' }) === true);
    await companion.press('next_song'); // Second is the last song: refused, nothing breaks
    assert.equal(fake.set.beats, 40);
    assert.ok(companion.feedbackChecks > 0, 'feedbacks were re-checked as Ablecon changed');
  } finally {
    await done();
  }
});

test('the module shows when Ablecon is unreachable and reconnects by itself', async () => {
  const fake = new FakeLive(demoSet());
  const livePort = await fake.start();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ablecon-companion-'));
  const companion = fakeCompanion();
  const module = new AbleconInstance(companion.context);
  // Pick a port, then start Ablecon there only after the module has tried and failed.
  const probe = await startServer({ port: 0, host: '127.0.0.1', livePort, setlistPath: path.join(dir, 's.json'), publicDir: path.join(root, 'public'), log: () => {} });
  const port = probe.port;
  await probe.close();
  let server = null;
  try {
    await module.init({ host: '127.0.0.1', port }, true, undefined);
    await until(() => companion.statuses.some(([s]) => s === 'connection_failure'));
    assert.equal(companion.variables.connected, 'No');
    server = await startServer({ port, host: '127.0.0.1', livePort, setlistPath: path.join(dir, 's.json'), publicDir: path.join(root, 'public'), log: () => {} });
    await until(() => companion.statuses.at(-1)[0] === 'ok' && companion.variables.connected === 'Yes', 6000);
  } finally {
    await module.destroy();
    if (server) await server.close();
    fake.close();
  }
});

// ---- packaging for Companion's "Import module package" (MIT licence) -------------------------

test('the module is MIT licensed and packages for Companion; the packaged module works', async () => {
  const moduleDir = path.join(root, 'companion-module');
  const pkg = JSON.parse(await readFile(path.join(moduleDir, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(moduleDir, 'companion/manifest.json'), 'utf8'));
  assert.equal(pkg.license, 'MIT');
  assert.equal(manifest.license, 'MIT', 'Companion only packages MIT/GPL modules');
  assert.match(await readFile(path.join(moduleDir, 'LICENSE'), 'utf8'), /^MIT License/);

  // Build exactly as `npm run companion:package` does, then unpack the result like Companion would.
  execFileSync('node', [path.join(root, 'scripts/companion-package.mjs')], { cwd: root, stdio: 'ignore' });
  const tgz = path.join(moduleDir, `${manifest.id}-${manifest.version}.tgz`);

  // The package is kept in the repo, for this version only, and matches the module (from Brant).
  // The build leaves the file untouched when its contents are the same, so any change here means the
  // package in git is out of date: commit it (the pre-commit hook rebuilds and stages it).
  assert.deepEqual((await readdir(moduleDir)).filter((f) => f.endsWith('.tgz')), [path.basename(tgz)], 'only the current version is kept');
  const tracked = execFileSync('git', ['ls-files', '--', path.relative(root, tgz)], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(tracked, path.relative(root, tgz), `${path.basename(tgz)} is in the repo (git add it)`);
  assert.equal(
    execFileSync('git', ['diff', '--name-only', '--', path.relative(root, tgz)], { cwd: root, encoding: 'utf8' }).trim(),
    '',
    `${path.basename(tgz)} in git doesn't match the module: git add it`,
  );
  const out = await mkdtemp(path.join(os.tmpdir(), 'ablecon-pkg-'));
  execFileSync('tar', ['-xzf', tgz, '-C', out]);
  const dir = path.join(out, manifest.id);
  const files = (await readdir(dir, { recursive: true })).sort();
  for (const f of ['LICENSE', 'main.js', 'companion/manifest.json', 'companion/HELP.md']) assert.ok(files.includes(f), `${f} in the package`);
  const packed = JSON.parse(await readFile(path.join(dir, 'companion/manifest.json'), 'utf8'));
  assert.equal(packed.version, manifest.version);
  assert.equal(packed.license, 'MIT');

  // The packaged (bundled) module needs nothing else installed, and drives Ablecon like the source does.
  const { default: Packaged } = await import(pathToFileURL(path.join(dir, 'main.js')).href);
  const { fake, companion, done } = await setup(Packaged);
  try {
    await until(() => companion.variables.song_count === 2 && companion.variables.connected === 'Yes');
    await companion.press('cue_song', { number: 2 });
    assert.equal(fake.set.beats, 40);
    await until(() => companion.feedback('song_active', { number: 2 }) === true);
  } finally {
    await done();
  }
});
