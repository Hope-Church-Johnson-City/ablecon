// A song's waveform: all its stems mixed into one loudness outline, lined up
// with the arrangement (bars and sections) using Live's warp markers.
//
// The audio is read with macOS's built-in `afconvert` (it reads the .m4a/AAC,
// WAV, AIFF and MP3 files multitrack sets use) into a small low-rate mono
// copy, then reduced to an envelope that is cached on disk, so each file is
// only ever read once.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface WarpMarker {
  beat: number; // clip beat time
  seconds: number; // position in the audio file
}

/** One arrangement audio clip, as the Remote Script's audio_clips reports it. */
export interface AudioClipInfo {
  name: string;
  start: number; // arrangement beats
  end: number;
  file: string | null;
  warping: boolean;
  startMarker: number | null; // clip beat (warped) at the clip's start
  endMarker: number | null;
  looping: boolean;
  loopStart: number | null;
  loopEnd: number | null;
  muted: boolean;
  warpMarkers: WarpMarker[];
}

export interface AudioTrackInfo {
  index: number;
  name: string;
  parents: string[];
  muted: boolean;
  clips: AudioClipInfo[];
}

/** An audio file reduced to its loudness: peak level per slice, `rate` slices per second. */
export interface Envelope {
  rate: number;
  data: Float32Array; // 0..1
}

export interface SongWaveform {
  start: number; // beats
  end: number;
  perBeat: number; // values per beat
  peaks: number[]; // 0..1, one per 1/perBeat beat
}

// ---- timing -------------------------------------------------------------------

/** Seconds into the file for a clip beat, from the warp markers (straight lines between them). */
export function warpBeatToSeconds(markers: WarpMarker[], beat: number): number | null {
  if (markers.length < 2) return null;
  let i = markers.findIndex((m) => m.beat > beat);
  if (i === -1) i = markers.length - 1; // past the last marker: carry on along the last segment
  if (i === 0) i = 1; // before the first: along the first segment
  const a = markers[i - 1];
  const b = markers[i];
  if (b.beat === a.beat) return a.seconds;
  return a.seconds + ((beat - a.beat) * (b.seconds - a.seconds)) / (b.beat - a.beat);
}

/**
 * Seconds into the clip's audio file that play at arrangement beat `beat`,
 * or null if that can't be worked out. `bpm` is used for unwarped clips.
 */
export function clipSecondsAt(clip: AudioClipInfo, beat: number, bpm: number): number | null {
  let clipBeat = (clip.startMarker ?? 0) + (beat - clip.start);
  if (clip.looping && clip.loopStart !== null && clip.loopEnd !== null && clip.loopEnd > clip.loopStart && clipBeat >= clip.loopEnd) {
    const len = clip.loopEnd - clip.loopStart;
    clipBeat = clip.loopStart + ((clipBeat - clip.loopStart) % len);
  }
  if (clip.warping) return warpBeatToSeconds(clip.warpMarkers, clipBeat);
  // Unwarped audio plays at its own speed: count seconds from the clip's start.
  return (clip.startMarker ?? 0) + ((beat - clip.start) * 60) / bpm;
}

// ---- mixing ---------------------------------------------------------------------

function peakBetween(env: Envelope, t0: number, t1: number): number {
  let i0 = Math.floor(Math.min(t0, t1) * env.rate);
  let i1 = Math.ceil(Math.max(t0, t1) * env.rate);
  i0 = Math.max(0, i0);
  i1 = Math.min(env.data.length, Math.max(i1, i0 + 1));
  let peak = 0;
  for (let i = i0; i < i1; i++) if (env.data[i] > peak) peak = env.data[i];
  return peak;
}

/**
 * Mix the stems of one song into a waveform. `include` decides which tracks
 * count (click, guide and the Sections track are left out by the caller).
 */
export function buildSongWaveform(
  song: { start: number; end: number },
  tracks: AudioTrackInfo[],
  envelopes: Map<string, Envelope>,
  opts: { perBeat: number; bpm: number; include: (track: AudioTrackInfo) => boolean },
): SongWaveform {
  const count = Math.max(1, Math.ceil((song.end - song.start) * opts.perBeat));
  const energy = new Float64Array(count);
  for (const track of tracks) {
    if (track.muted || !opts.include(track)) continue;
    for (const clip of track.clips) {
      if (clip.muted || !clip.file) continue;
      const env = envelopes.get(clip.file);
      if (!env) continue;
      const from = Math.max(clip.start, song.start);
      const to = Math.min(clip.end, song.end);
      for (let i = Math.floor((from - song.start) * opts.perBeat); i < count; i++) {
        const b0 = song.start + i / opts.perBeat;
        const b1 = b0 + 1 / opts.perBeat;
        if (b0 >= to) break;
        if (b1 <= from) continue;
        const t0 = clipSecondsAt(clip, Math.max(b0, from), opts.bpm);
        const t1 = clipSecondsAt(clip, Math.min(b1, to), opts.bpm);
        if (t0 === null || t1 === null) continue;
        const p = peakBetween(env, t0, t1);
        energy[i] += p * p; // add loudness like signals do (power)
      }
    }
  }
  const levels = Array.from(energy, (e) => Math.sqrt(e));
  // Scale to the song's loud parts, ignoring the odd spike.
  const sorted = levels.filter((x) => x > 0).sort((a, b) => a - b);
  const top = sorted.length ? sorted[Math.floor(sorted.length * 0.99)] : 1;
  const peaks = levels.map((x) => Math.round(Math.min(1, x / (top || 1)) * 1000) / 1000);
  return { start: song.start, end: song.end, perBeat: opts.perBeat, peaks };
}

// ---- reading audio files ----------------------------------------------------------

const DECODE_RATE = 2000; // samples per second in the temporary mono copy
const ENVELOPE_RATE = 200; // loudness slices per second kept

/** Read 16-bit little-endian mono PCM out of a WAV file's data chunk. */
export function wavSamples(buf: Buffer): Int16Array {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'data') {
      const bytes = Math.min(size, buf.length - offset - 8);
      const copy = Buffer.from(buf.subarray(offset + 8, offset + 8 + bytes - (bytes % 2)));
      return new Int16Array(copy.buffer, copy.byteOffset, copy.length / 2);
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('WAV file has no data');
}

export function envelopeFromSamples(samples: Int16Array, sampleRate: number, rate = ENVELOPE_RATE): Envelope {
  const step = Math.max(1, Math.round(sampleRate / rate));
  const data = new Float32Array(Math.ceil(samples.length / step));
  for (let i = 0; i < data.length; i++) {
    let peak = 0;
    const end = Math.min(samples.length, (i + 1) * step);
    for (let j = i * step; j < end; j++) {
      const v = Math.abs(samples[j]);
      if (v > peak) peak = v;
    }
    data[i] = peak / 32768;
  }
  return { rate: sampleRate / step, data };
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed: ${err.trim() || code}`))));
  });
}

/** Reads audio files into envelopes, remembering them on disk so each file is read once. */
export class EnvelopeCache {
  private readonly dir: string;
  private memory = new Map<string, Promise<Envelope>>();
  private active = 0;
  private waiting: Array<() => void> = [];

  private readonly maxParallel: number;

  constructor(dir: string, maxParallel = 2) {
    this.dir = dir;
    this.maxParallel = maxParallel;
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxParallel) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  get(file: string): Promise<Envelope> {
    let p = this.memory.get(file);
    if (!p) {
      p = this.load(file);
      this.memory.set(file, p);
      p.catch(() => this.memory.delete(file)); // allow a retry later (e.g. the file was offline)
    }
    return p;
  }

  private async load(file: string): Promise<Envelope> {
    const stat = await fs.stat(file);
    const key = createHash('sha1').update(`${file}|${stat.size}|${stat.mtimeMs}|${ENVELOPE_RATE}`).digest('hex');
    const cached = path.join(this.dir, `${key}.env`);
    try {
      const buf = await fs.readFile(cached);
      const rate = buf.readFloatLE(0);
      const data = new Float32Array(buf.buffer.slice(buf.byteOffset + 4, buf.byteOffset + buf.length));
      return { rate, data };
    } catch {
      // not cached yet
    }
    return this.slot(async () => {
      const tmp = path.join(os.tmpdir(), `ablecon-wave-${process.pid}-${key}.wav`);
      try {
        await run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', `LEI16@${DECODE_RATE}`, '-c', '1', file, tmp]);
        const env = envelopeFromSamples(wavSamples(await fs.readFile(tmp)), DECODE_RATE);
        await fs.mkdir(this.dir, { recursive: true });
        const out = Buffer.alloc(4 + env.data.byteLength);
        out.writeFloatLE(env.rate, 0);
        Buffer.from(env.data.buffer, env.data.byteOffset, env.data.byteLength).copy(out, 4);
        await fs.writeFile(cached, out);
        return env;
      } finally {
        await fs.rm(tmp, { force: true });
      }
    });
  }
}

// ---- building waveforms for the songs in the set ----------------------------------

/** Tracks never part of the song's sound: the click and spoken guide. */
export const NOT_IN_WAVEFORM = ['click', 'guide'];

export function inWaveform(track: Pick<AudioTrackInfo, 'name' | 'parents'>, sectionsTrack: string): boolean {
  const names = [track.name, ...track.parents].map((n) => n.toLowerCase());
  if (sectionsTrack.trim() && track.name.trim().toLowerCase() === sectionsTrack.trim().toLowerCase()) return false;
  return !names.some((n) => NOT_IN_WAVEFORM.some((w) => n.includes(w)));
}

interface WaveLink {
  connected: boolean;
  call<T = unknown>(method: string, args?: Record<string, unknown>): Promise<T>;
}

export interface WaveSong {
  id: string;
  start: number;
  end: number;
  bpm: number; // for unwarped clips
}

/**
 * Keeps a waveform for every song in the open set. `update` is cheap to call
 * often; the work happens one song at a time in the background.
 */
export class Waveforms {
  private ready = new Map<string, { version: string; wave: SongWaveform }>();
  private running = false;
  private wanted: { songs: WaveSong[]; sectionsTrack: string } | null = null;

  private readonly live: WaveLink;
  private readonly cache: Pick<EnvelopeCache, 'get'>;
  private readonly onReady: () => void;
  private readonly perBeat: number;

  constructor(live: WaveLink, cache: Pick<EnvelopeCache, 'get'>, onReady: () => void, perBeat = 4) {
    this.live = live;
    this.cache = cache;
    this.onReady = onReady;
    this.perBeat = perBeat;
  }

  get(songId: string): SongWaveform | null {
    return this.ready.get(songId)?.wave ?? null;
  }

  /** songId → version, so the page knows when to fetch a new one. */
  versions(): Record<string, string> {
    return Object.fromEntries([...this.ready].map(([id, r]) => [id, r.version]));
  }

  update(songs: WaveSong[], sectionsTrack: string): void {
    this.wanted = { songs, sectionsTrack };
    if (!this.running) void this.work();
  }

  private async work(): Promise<void> {
    this.running = true;
    try {
      while (this.wanted) {
        const { songs, sectionsTrack } = this.wanted;
        this.wanted = null;
        for (const id of [...this.ready.keys()]) if (!songs.some((s) => s.id === id)) this.ready.delete(id);
        for (const song of songs) {
          if (this.wanted || !this.live.connected) break; // newer song list: start over with it
          try {
            await this.build(song, sectionsTrack);
          } catch {
            // An old Remote Script, or audio that can't be read: no waveform for this song.
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async build(song: WaveSong, sectionsTrack: string): Promise<void> {
    const { tracks } = await this.live.call<{ tracks: AudioTrackInfo[] }>('audio_clips', { start: song.start, end: song.end });
    const used = tracks.filter((t) => !t.muted && inWaveform(t, sectionsTrack));
    const version = createHash('sha1').update(JSON.stringify([song, sectionsTrack, used, this.perBeat])).digest('hex').slice(0, 12);
    if (this.ready.get(song.id)?.version === version) return;
    const envelopes = new Map<string, Envelope>();
    for (const file of new Set(used.flatMap((t) => t.clips.map((c) => c.file)).filter((f): f is string => !!f))) {
      try {
        envelopes.set(file, await this.cache.get(file));
      } catch {
        // missing or unreadable file: leave it out
      }
    }
    if (envelopes.size === 0) return;
    const wave = buildSongWaveform(song, used, envelopes, { perBeat: this.perBeat, bpm: song.bpm, include: () => true });
    this.ready.set(song.id, { version, wave });
    this.onReady();
  }
}
