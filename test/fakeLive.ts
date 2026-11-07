// An in-process stand-in for the Remote Script: a UDP server that speaks the
// Ablcon protocol and keeps a tiny model of a Live set.

import dgram from 'node:dgram';
import { argValues, decodeMessage, encodeMessage, float, int, str } from '../src/osc.ts';
import type { Cue, KeyOp, TrackInfo } from '../src/types.ts';

export interface FakeSet {
  cues: Cue[];
  songLength: number;
  tempo: number;
  playing: boolean;
  beats: number;
  loop: { enabled: boolean; start: number; length: number };
  tracks: TrackInfo[]; // clips listed with their full extent; filtered per request
}

export class FakeLive {
  set: FakeSet;
  calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  chunkSize = 6000;
  muted = new Set<number>(); // track indexes muted in the fake mixer
  soloed = new Set<number>();
  // Like Live: "play" starts at the start marker and "continue" where playback last
  // stopped. Moving the playhead while stopped changes neither, unless the script
  // can move the start marker (Song.start_time), which Ablcon's script does on jump.
  startMarker = 0;
  stopPosition = 0;
  oldScript = false; // imitate the Remote Script from before play_from existed
  silent = false; // when true, requests are ignored (simulates Live not running)
  ignore = new Set<string>(); // methods to leave unanswered
  private socket = dgram.createSocket('udp4');
  private client: { address: string; port: number } | null = null;
  port = 0;

  constructor(set: FakeSet) {
    this.set = set;
  }

  async start(): Promise<number> {
    this.socket.on('message', (buf, rinfo) => this.onMessage(buf, rinfo));
    await new Promise<void>((resolve) => this.socket.bind(0, '127.0.0.1', resolve));
    this.port = this.socket.address().port;
    return this.port;
  }

  private closed = false;

  close(): void {
    this.closed = true;
    this.socket.close();
  }

  methods(): string[] {
    return this.calls.map((c) => c.method).filter((m) => m !== 'ping');
  }

  /** Send a position update the way the Remote Script does every tick. */
  pushPosition(): void {
    if (!this.client || this.closed) return;
    const s = this.set;
    const msg = encodeMessage('/ablcon/pos', [float(s.beats), int(s.playing ? 1 : 0), float(s.tempo), int(s.loop.enabled ? 1 : 0), float(s.loop.start), float(s.loop.length)]);
    this.socket.send(msg, this.client.port, this.client.address);
  }

  /** Live reports position changes on its next tick. */
  private autoPush(): void {
    setTimeout(() => this.pushPosition(), 5);
  }

  pushChanged(what: string): void {
    if (!this.client || this.closed) return;
    this.socket.send(encodeMessage('/ablcon/changed', [str(what)]), this.client.port, this.client.address);
  }

  private onMessage(buf: Buffer, rinfo: dgram.RemoteInfo): void {
    if (this.silent) return;
    const msg = decodeMessage(buf);
    if (msg.address !== '/ablcon/req') return;
    this.client = { address: rinfo.address, port: rinfo.port };
    const [id, method, rawArgs] = argValues(msg) as [number, string, string];
    const args = JSON.parse(rawArgs || '{}') as Record<string, unknown>;
    if (this.ignore.has(method)) return;
    this.calls.push({ method, args });
    let body: unknown;
    try {
      body = { ok: true, result: this.handle(method, args) };
    } catch (err) {
      body = { ok: false, error: (err as Error).message };
    }
    const text = JSON.stringify(body);
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += this.chunkSize) chunks.push(text.slice(i, i + this.chunkSize));
    chunks.forEach((chunk, part) => {
      this.socket.send(encodeMessage('/ablcon/res', [int(id), int(part), int(chunks.length), str(chunk)]), rinfo.port, rinfo.address);
    });
  }

  private handle(method: string, args: Record<string, unknown>): unknown {
    const s = this.set;
    switch (method) {
      case 'ping': return { script: 'ablcon', version: 'test', live: '12.0.0' };
      case 'state': return { beats: s.beats, playing: s.playing, tempo: s.tempo, loop: s.loop };
      case 'cues': return { cues: s.cues, songLength: s.songLength };
      case 'play': s.beats = this.startMarker; s.playing = true; this.autoPush(); return true;
      case 'continue': s.beats = this.stopPosition; s.playing = true; this.autoPush(); return true;
      case 'stop':
        if (s.playing) this.stopPosition = s.beats;
        s.playing = false;
        this.autoPush();
        return true;
      case 'jump':
        if (!s.playing && !this.oldScript) this.startMarker = Number(args.beats);
        s.beats = Number(args.beats);
        this.autoPush();
        return { startMarker: !s.playing && !this.oldScript };
      case 'play_from':
        if (this.oldScript) throw new Error("unknown method 'play_from'");
        if (!s.playing) this.startMarker = Number(args.beats);
        s.beats = Number(args.beats);
        s.playing = true;
        this.autoPush();
        return { method: 'start_marker' };
      case 'tempo': s.tempo = Number(args.bpm); return true;
      case 'loop':
        if (args.start !== undefined) s.loop = { ...s.loop, start: Number(args.start), length: Number(args.length) };
        s.loop.enabled = Boolean(args.enabled);
        return true;
      case 'tracks': {
        const start = Number(args.start);
        const end = Number(args.end);
        return { tracks: s.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.end > start && c.start < end) })) };
      }
      case 'apply':
        return { results: (args.ops as KeyOp[]).map((op) => this.apply(op)) };
      case 'mixer':
        return { tracks: s.tracks.map((t) => ({
          index: t.index, name: t.name, parents: t.parents, isGroup: t.isGroup,
          muted: this.muted.has(t.index),
          ...(this.oldScript ? {} : { soloed: this.soloed.has(t.index) }),
          mutedViaSolo: this.soloed.size > 0 && !this.soloed.has(t.index),
        })) };
      case 'solo': {
        if (this.oldScript) throw new Error("unknown method 'solo'");
        const t = s.tracks[Number(args.track)];
        if (!t || t.name !== args.trackName) throw new Error('track was renamed or moved');
        if (args.soloed) this.soloed.add(t.index);
        else this.soloed.delete(t.index);
        return { soloed: Boolean(args.soloed) };
      }
      case 'clear_solos': {
        if (this.oldScript) throw new Error("unknown method 'clear_solos'");
        const cleared = this.soloed.size;
        this.soloed.clear();
        return { cleared };
      }
      case 'mute': {
        const t = s.tracks[Number(args.track)];
        if (!t || t.name !== args.trackName) throw new Error('track was renamed or moved');
        if (args.muted) this.muted.add(t.index);
        else this.muted.delete(t.index);
        return { muted: Boolean(args.muted) };
      }
      case 'explode':
        throw new Error('boom');
      default:
        throw new Error(`unknown method '${method}'`);
    }
  }

  private apply(op: KeyOp): { ok: boolean; error?: string } {
    const track = this.set.tracks[op.track];
    if (!track || track.name !== op.trackName) return { ok: false, error: 'track moved' };
    if (op.kind === 'clip') {
      const clip = track.clips.find((c) => c.index === op.clip);
      if (!clip) return { ok: false, error: 'no clip' };
      clip.pitch = op.pitch;
    } else {
      const param = track.pitchDevices.find((d) => d.index === op.device)?.params.find((p) => p.index === op.param);
      if (!param) return { ok: false, error: 'no param' };
      param.value = op.value;
    }
    return { ok: true };
  }
}

/** A small set: two songs, a tagged click track, stems and a synth. */
export function demoSet(): FakeSet {
  const pitch = () => [{ index: 0, name: 'Pitch', params: [{ index: 0, name: 'Device On', value: 1, min: 0, max: 1 }, { index: 1, name: 'Pitch', value: 0, min: -48, max: 48 }] }];
  return {
    cues: [
      { name: '*First', time: 0 },
      { name: 'Verse', time: 0 },
      { name: 'Chorus', time: 16 },
      { name: '--', time: 32 },
      { name: '*Second', time: 40 },
      { name: 'Verse', time: 40 },
      { name: 'Chorus', time: 56 },
    ],
    songLength: 72,
    tempo: 120,
    playing: false,
    beats: 0,
    loop: { enabled: false, start: 0, length: 4 },
    tracks: [
      { index: 0, name: 'Click [nokey]', parents: [], isMidi: false, isAudio: true, isGroup: false, pitchDevices: [],
        clips: [{ index: 0, name: 'click', start: 0, end: 72, isAudio: true, warping: true, pitch: 0 }] },
      { index: 1, name: 'Keys', parents: [], isMidi: false, isAudio: true, isGroup: false, pitchDevices: [],
        clips: [
          { index: 0, name: 'Keys 1', start: 0, end: 32, isAudio: true, warping: true, pitch: 0 },
          { index: 1, name: 'Keys 2', start: 40, end: 72, isAudio: true, warping: true, pitch: 0 },
        ] },
      { index: 2, name: 'Synth', parents: [], isMidi: true, isAudio: false, isGroup: false, pitchDevices: pitch(),
        clips: [{ index: 0, name: 'synth', start: 40, end: 72, isAudio: false, warping: null, pitch: null }] },
    ],
  };
}
