import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endOfSongAction, isTagged, planKey, planTempo, songAt, splitKeyPlan } from '../src/planning.ts';
import type { Position, TrackInfo } from '../src/types.ts';

test('tempo is only sent when set and different', () => {
  assert.equal(planTempo(null, 120), null);
  assert.equal(planTempo(120, 120), null);
  assert.equal(planTempo(120.001, 120), null);
  assert.equal(planTempo(72, 120), 72);
});

const audio = (index: number, name: string, start: number, end: number, extra: Partial<TrackInfo['clips'][0]> = {}) =>
  ({ index, name, start, end, isAudio: true, warping: true, pitch: 0, ...extra });

function tracks(): TrackInfo[] {
  return [
    { index: 0, name: 'Click [nokey]', parents: [], isMidi: false, isAudio: true, isGroup: false, pitchDevices: [], clips: [audio(0, 'click', 0, 64)] },
    { index: 1, name: 'Cues', parents: [], isMidi: false, isAudio: true, isGroup: true, pitchDevices: [], clips: [] },
    { index: 2, name: 'Spoken', parents: ['Cues [NoKey]'], isMidi: false, isAudio: true, isGroup: false, pitchDevices: [], clips: [audio(0, 'talk', 0, 8)] },
    { index: 3, name: 'Keys', parents: ['Stems'], isMidi: false, isAudio: true, isGroup: false, pitchDevices: [], clips: [
      audio(0, 'in key already', 0, 16, { pitch: 2 }),
      audio(1, 'needs change', 16, 32),
      audio(2, 'unwarped', 32, 48, { warping: false }),
      audio(3, 'long tail', 48, 80),
    ] },
    { index: 4, name: 'Pad', parents: [], isMidi: false, isAudio: true, isGroup: false, pitchDevices: [], clips: [audio(5, 'from before', -16, 8)] },
    { index: 5, name: 'Synth', parents: [], isMidi: true, isAudio: false, isGroup: false, clips: [], pitchDevices: [
      { index: 2, name: 'Pitch', params: [{ index: 0, name: 'Device On', value: 1, min: 0, max: 1 }, { index: 1, name: 'Pitch', value: 0, min: -48, max: 48 }] },
    ] },
    { index: 6, name: 'Bass MIDI', parents: [], isMidi: true, isAudio: false, isGroup: false, pitchDevices: [],
      clips: [{ index: 0, name: 'bass', start: 0, end: 32, isAudio: false, warping: null, pitch: null }] },
  ];
}

test('tag matching is case-insensitive and inherited from groups', () => {
  assert.ok(isTagged({ name: 'Click [NOKEY]', parents: [] }, '[nokey]'));
  assert.ok(isTagged({ name: 'Spoken', parents: ['Cues [NoKey]'] }, '[nokey]'));
  assert.ok(!isTagged({ name: 'Keys', parents: ['Stems'] }, '[nokey]'));
});

test('key plan transposes warped audio and Pitch devices, skipping tagged tracks', () => {
  const plan = planKey({ start: 0, end: 64 }, 2, tracks(), '[nokey]');
  assert.deepEqual(plan.clipOps, [
    { kind: 'clip', track: 3, trackName: 'Keys', clip: 1, start: 16, pitch: 2 },
    { kind: 'clip', track: 3, trackName: 'Keys', clip: 3, start: 48, pitch: 2 },
  ]);
  assert.deepEqual(plan.deviceOps, [{ kind: 'param', track: 5, trackName: 'Synth', device: 2, param: 1, value: 2 }]);
  assert.equal(plan.clipsInKey, 1);
  const w = plan.warnings.join('\n');
  assert.match(w, /"unwarped" on Keys is not warped/);
  assert.match(w, /"long tail" on Keys runs past the end/);
  assert.match(w, /"from before" on Pad starts before/);
  assert.match(w, /Bass MIDI has no Pitch device/);
  assert.doesNotMatch(w, /click|talk/);
});

test('key 0 resets clips and devices that were moved', () => {
  const t = tracks();
  t[5].pitchDevices[0].params[1].value = 3;
  const plan = planKey({ start: 0, end: 16 }, 0, t, '[nokey]');
  assert.deepEqual(plan.clipOps.map((o) => o.kind === 'clip' && [o.clip, o.pitch]), [[0, 0]]);
  assert.equal(plan.deviceOps.length, 1);
});

test('device values are clamped to the parameter range', () => {
  const t = tracks();
  t[5].pitchDevices[0].params[1].min = -1;
  const plan = planKey({ start: 0, end: 16 }, -5, t, '[nokey]');
  assert.deepEqual(plan.deviceOps.map((o) => o.kind === 'param' && o.value), [-1]);
});

test('nothing sounding is changed while playing', () => {
  const plan = planKey({ start: 0, end: 64 }, 2, tracks(), '[nokey]');
  const stopped = splitKeyPlan(plan, { start: 0, end: 64 }, { beats: 10, playing: false });
  assert.equal(stopped.now.length, 3);
  assert.equal(stopped.later.length, 0);
  const elsewhere = splitKeyPlan(plan, { start: 0, end: 64 }, { beats: 100, playing: true });
  assert.deepEqual(elsewhere.now.map((o) => o.kind), ['clip', 'clip']);
  assert.deepEqual(elsewhere.later.map((o) => o.kind), ['param']);
  const inside = splitKeyPlan(plan, { start: 0, end: 64 }, { beats: 10, playing: true });
  assert.equal(inside.now.length, 0);
  assert.equal(inside.later.length, 3);
});

const pos = (beats: number, playing = true): Position => ({ beats, playing, tempo: 120, loop: { enabled: false, start: 0, length: 4 } });

test('end-of-song fires only when playback runs off the end', () => {
  const song = { start: 0, end: 32 };
  assert.equal(endOfSongAction(pos(31.8), pos(32.1), song, 'stop'), 'stop');
  assert.equal(endOfSongAction(pos(31.8), pos(32.1), song, 'next'), 'next');
  assert.equal(endOfSongAction(pos(31.8), pos(32.1), song, 'continue'), 'none');
  assert.equal(endOfSongAction(pos(31.8), pos(31.9), song, 'stop'), 'none', 'still inside');
  assert.equal(endOfSongAction(pos(10), pos(100), song, 'stop'), 'none', 'a jump, not a play-through');
  assert.equal(endOfSongAction(pos(31.8, false), pos(32.1), song, 'stop'), 'none');
  assert.equal(endOfSongAction(pos(31.8), pos(32.1, false), song, 'stop'), 'none');
  assert.equal(endOfSongAction(null, pos(32.1), song, 'stop'), 'none');
});

test('songAt finds the song under the playhead', () => {
  const songs = [{ start: 0, end: 32 }, { start: 40, end: 72 }];
  assert.equal(songAt(songs, 0), songs[0]);
  assert.equal(songAt(songs, 32), null);
  assert.equal(songAt(songs, 71.9), songs[1]);
});
