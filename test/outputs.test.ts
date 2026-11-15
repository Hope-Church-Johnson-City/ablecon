// Track outputs ("Audio To") and output presets: the pure logic, then the controller against the
// fake Live over real UDP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LiveClient } from '../src/liveClient.ts';
import { Controller } from '../src/controller.ts';
import { MASTER_KEY, NORMAL, outputLabel, planPreset, presetFromTracks, usefulTypes } from '../src/outputs.ts';
import { loadStore, parseStore } from '../src/store.ts';
import type { MixerTrack, TrackInfo } from '../src/types.ts';
import { FakeLive, demoSet } from './fakeLive.ts';

const EXT = 'Ext. Out';

function mt(index: number, name: string, type: string, channel: string | null, parents: string[] = []): MixerTrack {
  return { index, name, parents, isGroup: false, muted: false, soloed: false, mutedViaSolo: false, output: { type, channel } };
}

// ---- the logic -------------------------------------------------------------------------

test('a preset records each track name\'s output and the master; the most common output wins', () => {
  const tracks = [
    mt(0, 'Click', EXT, '1'),
    mt(1, 'Guide', EXT, '2'),
    mt(2, 'Bass', EXT, '5', ['Song A']),
    mt(3, 'Bass', EXT, '5', ['Song B']),
    mt(4, ' BASS ', 'Group', 'Track In', ['Song C']), // still in its group: the moved ones win
    mt(6, 'Drums', EXT, '6', ['Song A']), // moved in one song only: still counts
    mt(7, 'Drums', 'Group', 'Track In', ['Song B']),
    mt(8, 'Drums', 'Group', 'Track In', ['Song C']),
    mt(5, 'Keys', 'Group', 'Track In', ['Song A']),
  ];
  const p = presetFromTracks('  No bass player ', tracks, { type: EXT, channel: '3/4' }, EXT);
  assert.equal(p.name, 'No bass player');
  assert.deepEqual(p.outputs, {
    click: { type: EXT, channel: '1' },
    guide: { type: EXT, channel: '2' },
    bass: { type: EXT, channel: '5' },
    keys: { type: NORMAL, channel: null }, // its group: "normal place"
    drums: { type: EXT, channel: '6' },
    [MASTER_KEY]: { type: EXT, channel: '3/4' },
  });
});

test('applying a preset changes only the named tracks whose output differs, in every group', () => {
  const preset = { name: 'No bass player', outputs: { bass: { type: EXT, channel: '5' }, click: { type: EXT, channel: '1' }, [MASTER_KEY]: { type: EXT, channel: '3/4' } } };
  const tracks = [
    mt(0, 'Click', EXT, '1'), // already right
    mt(1, 'Bass', 'Group', 'Track In', ['Song A']),
    mt(2, 'bass', EXT, '6', ['Song B']),
    mt(3, 'Keys', 'Group', 'Track In', ['Song A']), // not in the preset: untouched
  ];
  assert.deepEqual(planPreset(preset, tracks, { type: EXT, channel: '1/2' }, EXT), [
    { track: 1, name: 'Bass', type: EXT, channel: '5' },
    { track: 2, name: 'bass', type: EXT, channel: '5' },
    { track: -1, name: 'Master', type: EXT, channel: '3/4' },
  ]);
  const back = { name: 'Bass player', outputs: { bass: { type: NORMAL, channel: null } } };
  const types = (i: number) => (i === 1 || i === 2 ? ['Group', EXT, 'Sends Only', 'Master'] : [EXT, 'Sends Only', 'Master']);
  assert.deepEqual(planPreset(back, tracks, null, EXT, types), [{ track: 2, name: 'bass', type: 'Group', channel: null }],
    'each Bass goes back to its own group; one already there isn\'t touched');
});

test('tracks with the same name inside and outside groups each keep their normal place', () => {
  // A loose Keys goes to the master, a Keys in a song's group to the group: both are "normal".
  const tracks = [mt(1, 'Keys', 'Master', 'Track In'), mt(6, 'Keys', 'Group', 'Track In', ['First'])];
  const p = presetFromTracks('Full band', tracks, null, EXT);
  assert.deepEqual(p.outputs.keys, { type: NORMAL, channel: null });
  assert.deepEqual(planPreset(p, tracks, null, EXT), [], 'applying it moves neither');
  // Live may name the group itself instead of "Group".
  const named = [mt(6, 'Keys', 'First', 'Track In', ['First']), mt(7, 'Keys', 'Master', 'Track In', ['First'])];
  assert.deepEqual(planPreset(p, named, null, EXT, () => ['First', EXT, 'Master']), [{ track: 7, name: 'Keys', type: 'First', channel: null }]);
});

test('Live 12\'s names: the master is "Main" and a group\'s output is the group\'s name', () => {
  const tracks = [mt(1, 'Keys', 'Main', ''), mt(6, 'Keys', 'Center', '', ['Center']), mt(7, 'Bass', EXT, '5', ['Center'])];
  const p = presetFromTracks('Live 12', tracks, null, EXT);
  assert.deepEqual(p.outputs.keys, { type: NORMAL, channel: null }, 'Main and the own group are both normal');
  const moved = [mt(1, 'Keys', EXT, '1'), mt(6, 'Keys', EXT, '1', ['Center'])];
  const types = (i: number) => (i === 6 ? [EXT, 'Main', 'Center', 'Bass', 'Sends Only'] : [EXT, 'Main', 'Bass', 'Sends Only']);
  assert.deepEqual(planPreset(p, moved, null, EXT, types), [
    { track: 1, name: 'Keys', type: 'Main', channel: null },
    { track: 6, name: 'Keys', type: 'Center', channel: null },
  ]);
});

test('only useful outputs are offered: never every other track, nothing for a MIDI-only track', () => {
  const real = [EXT, 'Main', 'Glorious Day', 'Guide', 'Loop', 'Bass', 'AG', 'Sends Only']; // as Live 12 lists them
  assert.deepEqual(usefulTypes({ parents: ['Glorious Day'] }, real, EXT), [EXT, 'Main', 'Glorious Day', 'Sends Only']);
  assert.deepEqual(usefulTypes({ parents: [] }, [EXT, 'Main', 'Guide', 'Sends Only'], EXT), [EXT, 'Main', 'Sends Only']);
  assert.deepEqual(usefulTypes({ parents: [] }, ['Ablecon Output (IAC Driver (Bus 1))', 'No Output'], EXT), [], 'the Sections MIDI track');
  assert.deepEqual(usefulTypes({ parents: [] }, real, null), [], 'an older Remote Script');
});

test('outputs are labelled the way the page shows them', () => {
  assert.equal(outputLabel({ type: EXT, channel: '5' }, EXT), 'Out 5');
  assert.equal(outputLabel({ type: EXT, channel: '3/4' }, EXT), 'Out 3/4');
  assert.equal(outputLabel({ type: 'Group', channel: 'Track In' }, EXT), 'Group');
  assert.equal(outputLabel(undefined, EXT), '–');
});

test('presets are kept in the setlist file; malformed ones are left out', () => {
  const text = JSON.stringify({
    version: 2, songs: {}, sets: [], settings: {},
    outputPresets: [
      { name: 'Full band', outputs: { bass: { type: 'Group', channel: null }, '#master': { type: EXT, channel: '3/4' } } },
      { name: 'full band', outputs: {} }, // same name again
      { name: '', outputs: {} },
      { name: 'Odd', outputs: { bass: { type: '' }, keys: 'Out 1', guide: { type: EXT, channel: '2' } } },
      'nonsense',
    ],
  });
  const store = parseStore(text);
  assert.deepEqual(store.outputPresets, [
    { name: 'Full band', outputs: { bass: { type: 'Group', channel: null }, '#master': { type: EXT, channel: '3/4' } } },
    { name: 'Odd', outputs: { guide: { type: EXT, channel: '2' } } },
  ]);
  assert.equal(parseStore(JSON.stringify({ version: 2, songs: {}, sets: [], settings: {} })).outputPresets, undefined);
});

// ---- the controller against the fake Live ---------------------------------------------------

/** demoSet plus a group per song with a Bass in each, like a multitrack set. */
function bandSet() {
  const set = demoSet();
  const add = (name: string, parents: string[], isGroup = false) => {
    const t: TrackInfo = { index: set.tracks.length, name, parents, isMidi: false, isAudio: true, isGroup, pitchDevices: [], clips: [] };
    set.tracks.push(t);
  };
  add('Guide', []);
  add('First', [], true);
  add('Bass', ['First']);
  add('Keys', ['First']);
  add('Second', [], true);
  add('Bass', ['Second']);
  return set;
}

async function setup(opts: { oldScript?: boolean } = {}) {
  const fake = new FakeLive(bandSet());
  fake.oldScript = !!opts.oldScript;
  const port = await fake.start();
  const client = new LiveClient({ port, timeoutMs: 500, heartbeatMs: 60_000 });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ablecon-out-'));
  const setlistPath = path.join(dir, 'setlist.json');
  const controller = new Controller(client, setlistPath);
  controller.scanSettleMs = 5;
  await controller.init();
  await client.start();
  const until = async (check: () => boolean) => {
    const end = Date.now() + 3000;
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  await until(() => controller.tracks.length > 0);
  const done = () => { client.stop(); fake.close(); };
  return { fake, controller, setlistPath, done, until };
}

test('the controller shows each track\'s output, the master\'s and what they can be set to', async () => {
  const { controller, done, until } = await setup();
  try {
    await until(() => controller.outputChoices !== null);
    const snap = controller.snapshot();
    assert.deepEqual(snap.masterOutput, { type: EXT, channel: '1/2' });
    // As Live 12 reports it: "Main", and a group's output named after the group.
    assert.deepEqual(snap.tracks.find((t) => t.name === 'Guide')!.output, { type: 'Main', channel: '' });
    assert.deepEqual(snap.tracks[5].output, { type: 'First', channel: '' });
    assert.equal(snap.outputChoices!.external, EXT);
    assert.deepEqual(snap.outputChoices!.channels.slice(0, 5), ['1/2', '3/4', '5/6', '7/8', '1']);
    assert.deepEqual(snap.outputChoices!.types[5].slice(0, 3), [EXT, 'Main', 'First']);
    assert.deepEqual(usefulTypes(snap.tracks[5], snap.outputChoices!.types[5], EXT), [EXT, 'Main', 'First', 'Sends Only']);
  } finally {
    done();
  }
});

test('a track\'s output and the master\'s can be changed, and a moved track is refused', async () => {
  const { fake, controller, done } = await setup();
  try {
    await controller.setOutput(0, 'Click [nokey]', EXT, '1');
    assert.deepEqual(fake.outputOf(0), { type: EXT, channel: '1' });
    assert.deepEqual(controller.tracks[0].output, { type: EXT, channel: '1' }, 'the page sees it at once');
    await controller.setOutput(-1, 'Master', EXT, '3/4');
    assert.deepEqual(fake.outputOf(-1), { type: EXT, channel: '3/4' });
    assert.deepEqual(controller.masterOutput, { type: EXT, channel: '3/4' });
    await assert.rejects(controller.setOutput(0, 'Keys', EXT, '2'), /moved or been renamed/);
    assert.deepEqual(fake.outputOf(0), { type: EXT, channel: '1' }, 'nothing changed');
  } finally {
    done();
  }
});

test('save a preset, change things, apply it: every Bass and the master go back; it\'s kept on disk', async () => {
  const { fake, controller, setlistPath, done } = await setup();
  try {
    // Dante 8x8 as at church: click 1, guide 2, master 3/4, no bass player so Bass on 5.
    await controller.setOutput(0, 'Click [nokey]', EXT, '1');
    await controller.setOutput(3, 'Guide', EXT, '2');
    await controller.setOutput(-1, 'Master', EXT, '3/4');
    await controller.setOutput(5, 'Bass', EXT, '5');
    await controller.setOutput(8, 'Bass', EXT, '5');
    await controller.saveOutputPreset('No bass player');
    // With the bass player back, the Basses go to their groups again.
    await controller.setOutput(5, 'Bass', 'First', null);
    await controller.setOutput(8, 'Bass', 'Second', null);
    await controller.saveOutputPreset('Bass player');
    assert.deepEqual(controller.snapshot().outputPresets.map((p) => p.name), ['No bass player', 'Bass player']);

    await controller.setOutput(-1, 'Master', EXT, '1/2');
    const res = await controller.applyOutputPreset('no bass player'); // any case
    assert.deepEqual(res, { changed: 3, failed: [] });
    assert.deepEqual(fake.outputOf(5), { type: EXT, channel: '5' });
    assert.deepEqual(fake.outputOf(8), { type: EXT, channel: '5' });
    assert.deepEqual(fake.outputOf(-1), { type: EXT, channel: '3/4' });
    assert.deepEqual(fake.outputOf(6), { type: 'First', channel: '' }, 'Keys left as it was');

    const before = fake.calls.filter((c) => c.method === 'set_output').length;
    assert.deepEqual(await controller.applyOutputPreset('No bass player'), { changed: 0, failed: [] }, 'nothing to do twice');
    assert.equal(fake.calls.filter((c) => c.method === 'set_output').length, before);

    await controller.applyOutputPreset('Bass player');
    assert.deepEqual(fake.outputOf(5), { type: 'First', channel: '' }, 'each Bass back to its own group');
    assert.deepEqual(fake.outputOf(8), { type: 'Second', channel: '' });

    const saved = await loadStore(setlistPath);
    assert.deepEqual(saved.outputPresets!.map((p) => p.name), ['No bass player', 'Bass player']);
    assert.deepEqual(saved.outputPresets![0].outputs.bass, { type: EXT, channel: '5' });
    assert.match(await readFile(setlistPath, 'utf8'), /"outputPresets"/);

    await controller.saveOutputPreset('NO BASS PLAYER'); // same name replaces it
    assert.equal(controller.outputPresets.length, 2);
    await controller.deleteOutputPreset('Bass player');
    assert.deepEqual(controller.outputPresets.map((p) => p.name), ['NO BASS PLAYER']);
    await assert.rejects(controller.applyOutputPreset('Bass player'), /no output preset/);
    await assert.rejects(controller.saveOutputPreset('   '), /name/);
  } finally {
    done();
  }
});

test('with an older Remote Script, outputs say to update it and nothing else breaks', async () => {
  const { controller, done } = await setup({ oldScript: true });
  try {
    assert.equal(controller.outputChoices, null);
    assert.equal(controller.masterOutput, null);
    await assert.rejects(controller.setOutput(0, 'Click [nokey]', EXT, '1'), /newer Remote Script/);
    await assert.rejects(controller.saveOutputPreset('X'), /newer Remote Script/);
    await controller.setMute(1, 'Keys', true); // mutes still work
    assert.equal(controller.tracks[1].muted, true);
  } finally {
    done();
  }
});
