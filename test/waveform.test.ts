import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildSongWaveform,
  clipSecondsAt,
  EnvelopeCache,
  envelopeFromSamples,
  inWaveform,
  warpBeatToSeconds,
  wavSamples,
  Waveforms,
  type AudioClipInfo,
  type AudioTrackInfo,
  type Envelope,
} from '../src/waveform.ts';

// Warp markers as Live reported them for a King Of Kings stem (beats → seconds in the file).
const kingMarkers = [
  { beat: 0, seconds: 0 },
  { beat: 286, seconds: 252.35 },
  { beat: 288, seconds: 254.23 },
];

function clip(over: Partial<AudioClipInfo> = {}): AudioClipInfo {
  return {
    name: 'stem', start: 0, end: 16, file: '/a.wav', warping: true, startMarker: 0, endMarker: 16,
    looping: false, loopStart: 0, loopEnd: 16, muted: false,
    warpMarkers: [{ beat: 0, seconds: 0 }, { beat: 16, seconds: 8 }], // recorded at 120 BPM
    ...over,
  };
}

function track(name: string, clips: AudioClipInfo[], over: Partial<AudioTrackInfo> = {}): AudioTrackInfo {
  return { index: 0, name, parents: [], muted: false, clips, ...over };
}

/** An envelope at 10 slices a second from a list of levels. */
const env = (levels: number[]): Envelope => ({ rate: 10, data: Float32Array.from(levels) });

test('warp markers map clip beats to seconds, in between and beyond them', () => {
  assert.equal(warpBeatToSeconds(kingMarkers, 0), 0);
  assert.ok(Math.abs(warpBeatToSeconds(kingMarkers, 143)! - 126.175) < 1e-9);
  assert.ok(Math.abs(warpBeatToSeconds(kingMarkers, 287)! - 253.29) < 1e-9);
  assert.ok(Math.abs(warpBeatToSeconds(kingMarkers, 290)! - 256.11) < 1e-9); // past the last marker
  assert.ok(Math.abs(warpBeatToSeconds(kingMarkers, -2)! + 2 * (252.35 / 286)) < 1e-9); // before the first
  assert.equal(warpBeatToSeconds([{ beat: 0, seconds: 0 }], 4), null);
});

test('a clip that starts partway into its file (Live split the stem) reads from there', () => {
  // Second half of a split stem in the real set: placed at 818, its audio starts at clip beat 246.
  const second = clip({ start: 818, end: 850, startMarker: 246, warpMarkers: kingMarkers });
  assert.ok(Math.abs(clipSecondsAt(second, 818, 68)! - warpBeatToSeconds(kingMarkers, 246)!) < 1e-9);
  assert.ok(Math.abs(clipSecondsAt(second, 858, 68)! - warpBeatToSeconds(kingMarkers, 286)!) < 1e-9);
});

test('unwarped clips play at their own speed, and looped clips repeat', () => {
  const free = clip({ warping: false, start: 8, startMarker: 1.5 });
  assert.equal(clipSecondsAt(free, 8, 120), 1.5);
  assert.equal(clipSecondsAt(free, 12, 120), 3.5); // 4 beats at 120 BPM = 2 s
  const loop = clip({ looping: true, loopStart: 0, loopEnd: 4, end: 32 });
  assert.equal(clipSecondsAt(loop, 6, 120), clipSecondsAt(loop, 2, 120));
});

test('stems are mixed and lined up with the song (quiet half, then loud half)', () => {
  // 16 beats at 120 BPM = 8 s: silent for 4 s, then loud.
  const levels = [...Array(40).fill(0), ...Array(40).fill(0.5)];
  const envelopes = new Map([['/a.wav', env(levels)], ['/b.wav', env(levels)]]);
  const tracks = [track('Bass', [clip()]), track('Keys', [clip({ file: '/b.wav' })])];
  const wave = buildSongWaveform({ start: 0, end: 16 }, tracks, envelopes, { perBeat: 1, bpm: 120, include: () => true });
  assert.equal(wave.peaks.length, 16);
  assert.deepEqual(wave.peaks.slice(0, 7), Array(7).fill(0));
  assert.deepEqual(wave.peaks.slice(9), Array(7).fill(1));
});

test('the mix adds stems like sound does: two equal stems are louder than one', () => {
  const one = env(Array(80).fill(0.3));
  const loud = env([...Array(40).fill(0.3), ...Array(40).fill(0.3)]);
  const envelopes = new Map([['/a.wav', one], ['/b.wav', loud]]);
  // Bass plays the whole song, Keys only the second half.
  const tracks = [track('Bass', [clip()]), track('Keys', [clip({ file: '/b.wav', start: 8, startMarker: 8 })])];
  const wave = buildSongWaveform({ start: 0, end: 16 }, tracks, envelopes, { perBeat: 1, bpm: 120, include: () => true });
  assert.ok(Math.abs(wave.peaks[2] - 1 / Math.SQRT2) < 0.01);
  assert.equal(wave.peaks[12], 1);
});

test('muted tracks, muted clips, left-out tracks and missing audio are not in the waveform', () => {
  const loud = env(Array(80).fill(0.5));
  const envelopes = new Map([['/a.wav', loud]]);
  const opts = { perBeat: 1, bpm: 120, include: (t: AudioTrackInfo) => t.name !== 'Click' };
  const silent = (tracks: AudioTrackInfo[]) => buildSongWaveform({ start: 0, end: 16 }, tracks, envelopes, opts).peaks.every((p) => p === 0);
  assert.ok(silent([track('Bass', [clip()], { muted: true })]));
  assert.ok(silent([track('Bass', [clip({ muted: true })])]));
  assert.ok(silent([track('Click', [clip()])]));
  assert.ok(silent([track('Bass', [clip({ file: '/missing.wav' })])]));
  assert.ok(silent([track('Bass', [clip({ file: null })])]));
  assert.ok(!silent([track('Bass', [clip()])]));
});

test('only the part of a clip inside the song counts', () => {
  const envelopes = new Map([['/a.wav', env(Array(200).fill(0.5))]]);
  const tracks = [track('Bass', [clip({ start: 12, end: 40, warpMarkers: [{ beat: 0, seconds: 0 }, { beat: 40, seconds: 20 }] })])];
  const wave = buildSongWaveform({ start: 0, end: 16 }, tracks, envelopes, { perBeat: 1, bpm: 120, include: () => true });
  assert.equal(wave.peaks.length, 16);
  assert.deepEqual(wave.peaks.slice(0, 12), Array(12).fill(0));
  assert.deepEqual(wave.peaks.slice(12), Array(4).fill(1));
});

test('click, guide and the Sections track are left out (also by group name)', () => {
  assert.equal(inWaveform({ name: 'Click Foundations', parents: [] }, 'Sections'), false);
  assert.equal(inWaveform({ name: 'Guide', parents: [] }, 'Sections'), false);
  assert.equal(inWaveform({ name: 'Sections', parents: [] }, 'Sections'), false);
  assert.equal(inWaveform({ name: 'Cues', parents: ['Click & Guide'] }, 'Sections'), false);
  assert.equal(inWaveform({ name: 'Drums', parents: ['King Of Kings'] }, 'Sections'), true);
  assert.equal(inWaveform({ name: 'Keys [nokey]', parents: [] }, 'Sections'), true); // not pitched, but heard
});

function wav(samples: number[], rate: number): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => buf.writeInt16LE(s, 44 + i * 2));
  return buf;
}

test('WAV samples are read and reduced to peak levels', () => {
  const samples = wavSamples(wav([0, 100, -16384, 0, 0, 0, 32767, 0], 8));
  assert.deepEqual([...samples], [0, 100, -16384, 0, 0, 0, 32767, 0]);
  const e = envelopeFromSamples(samples, 8, 2);
  assert.equal(e.rate, 2);
  assert.deepEqual([...e.data], [0.5, 32767 / 32768]);
  assert.throws(() => wavSamples(Buffer.from('not audio at all, really not')), /not a WAV/);
});

test('audio files are read with afconvert and remembered on disk', { skip: !existsSync('/usr/bin/afconvert') && 'needs macOS afconvert' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ablecon-wave-test-'));
  try {
    const rate = 8000;
    const samples = Array.from({ length: rate * 2 }, (_, i) => (i < rate ? 0 : Math.round(16000 * Math.sin(i / 3))));
    const file = path.join(dir, 'stem.wav');
    await fs.writeFile(file, wav(samples, rate));
    const cacheDir = path.join(dir, 'cache');
    const first = await new EnvelopeCache(cacheDir).get(file);
    assert.ok(Math.abs(first.data.length / first.rate - 2) < 0.05);
    const at = (t: number) => first.data[Math.floor(t * first.rate)];
    assert.ok(at(0.5) < 0.01, `quiet second reads ${at(0.5)}`);
    assert.ok(at(1.5) > 0.4, `loud second reads ${at(1.5)}`);
    assert.equal((await fs.readdir(cacheDir)).length, 1);
    // A new cache (as after a restart) uses the saved copy without reading the audio again.
    execFileSync('/bin/chmod', ['000', file]);
    try {
      const again = await new EnvelopeCache(cacheDir).get(file);
      assert.deepEqual([...again.data], [...first.data]);
    } finally {
      execFileSync('/bin/chmod', ['644', file]);
    }
    await assert.rejects(new EnvelopeCache(cacheDir).get(path.join(dir, 'missing.m4a')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('waveforms are built in the background for every song, and only rebuilt when the stems change', async () => {
  let calls = 0;
  let clips: AudioTrackInfo[] = [track('Bass', [clip()])];
  const live = {
    connected: true,
    async call<T>(method: string): Promise<T> {
      assert.equal(method, 'audio_clips');
      calls++;
      return { tracks: clips } as T;
    },
  };
  const cache = { get: async (f: string) => (f === '/a.wav' ? env(Array(80).fill(0.5)) : Promise.reject(new Error('missing'))) };
  let ready = 0;
  const waves = new Waveforms(live, cache, () => ready++);
  const settle = () => new Promise((r) => setTimeout(r, 20));
  waves.update([{ id: 'a', start: 0, end: 16, bpm: 120 }, { id: 'b', start: 16, end: 32, bpm: 120 }], 'Sections');
  await settle();
  assert.equal(ready, 2);
  assert.deepEqual(Object.keys(waves.versions()).sort(), ['a', 'b']);
  assert.equal(waves.get('a')!.peaks.length, 16 * 4);
  const before = waves.versions().a;
  waves.update([{ id: 'a', start: 0, end: 16, bpm: 120 }], 'Sections');
  await settle();
  assert.equal(ready, 2, 'unchanged stems are not rebuilt');
  assert.equal(waves.get('b'), null, 'a song no longer in the set is dropped');
  clips = [track('Bass', [clip()]), track('Keys', [clip()])];
  waves.update([{ id: 'a', start: 0, end: 16, bpm: 120 }], 'Sections');
  await settle();
  assert.equal(ready, 3);
  assert.notEqual(waves.versions().a, before);
  assert.ok(calls >= 4);
});

test('an old Remote Script or unreadable audio just means no waveform', async () => {
  const oldScript = { connected: true, call: async () => Promise.reject(new Error('unknown method "audio_clips"')) };
  const waves = new Waveforms(oldScript, { get: async () => env([1]) }, () => assert.fail('nothing should be ready'));
  waves.update([{ id: 'a', start: 0, end: 16, bpm: 120 }], 'Sections');
  const offline = { connected: true, call: async <T>() => ({ tracks: [track('Bass', [clip()])] }) as T };
  const noAudio = new Waveforms(offline, { get: async () => Promise.reject(new Error('iCloud file not downloaded')) }, () => assert.fail('nothing should be ready'));
  noAudio.update([{ id: 'a', start: 0, end: 16, bpm: 120 }], 'Sections');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(waves.get('a'), null);
  assert.equal(noAudio.get('a'), null);
});
