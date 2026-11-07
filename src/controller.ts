// Ties Live, the setlist file and the planning rules together. The web layer
// calls these methods and listens for "state", "position" and "notice".

import { EventEmitter } from 'node:events';
import { parseLocators, type SectionClip } from './locators.ts';
import { endOfSongAction, planKey, planTempo, songAt, splitKeyPlan } from './planning.ts';
import * as setlist from './setlist.ts';
import type { Cue, KeyOp, MixerTrack, Position, SetlistFile, SetlistSettings, Song, TrackInfo } from './types.ts';

/** The parts of LiveClient the controller uses (so tests can pass a stub). */
export interface LiveLink extends EventEmitter {
  connected: boolean;
  liveVersion: string | null;
  call<T = unknown>(method: string, args?: Record<string, unknown>): Promise<T>;
}

export interface KeyStatus {
  semitones: number | null; // what Ablcon last set for this song
  pending: boolean; // some changes wait until Live stops
  warnings: string[];
  error: string | null;
}

export interface Notice {
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface ControllerEvents {
  state: [];
  position: [Position];
  notice: [Notice];
}

const STOPPED: Position = { beats: 0, playing: false, tempo: 120, loop: { enabled: false, start: 0, length: 0 } };

export class Controller extends EventEmitter<ControllerEvents> {
  private readonly live: LiveLink;
  private readonly setlistPath: string;
  file: SetlistFile = setlist.emptySetlist();
  songs: Song[] = [];
  parseWarnings: string[] = [];
  position: Position = { ...STOPPED };
  cuedId: string | null = null;
  keyStatus = new Map<string, KeyStatus>();
  private pendingKeys = new Set<string>();
  private flushing = false;
  tracks: MixerTrack[] = [];
  private mixerRead = 0; // newest track-list read; older replies are dropped
  private queue: Promise<unknown> = Promise.resolve();

  constructor(live: LiveLink, setlistPath: string) {
    super();
    this.live = live;
    this.setlistPath = setlistPath;
    live.on('connection', (up: boolean) => {
      if (up) void this.refresh().catch((err) => this.notice('error', `Could not read the Live set: ${err.message}`));
      this.emit('state');
    });
    live.on('changed', (what: string) => {
      if (what === 'cues') void this.refresh().catch(() => {});
      if (what === 'tracks') void this.refreshTracks().catch(() => {});
    });
    live.on('position', (pos: Position) => this.onPosition(pos));
  }

  async init(): Promise<void> {
    this.file = await setlist.loadSetlist(this.setlistPath);
  }

  // ---- helpers ---------------------------------------------------------------

  /** Run commands one at a time so two button presses never interleave. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  private notice(level: Notice['level'], text: string): void {
    this.emit('notice', { level, text });
  }

  private song(songId: string): Song {
    const song = this.songs.find((s) => s.id === songId);
    if (!song) throw new Error(`"${songId}" is not in the Live set (check its locator)`);
    return song;
  }

  private entry(songId: string) {
    return this.file.entries.find((e) => e.songId === songId) ?? null;
  }

  private async save(file: SetlistFile): Promise<void> {
    this.file = file;
    await setlist.saveSetlist(this.setlistPath, file);
    this.emit('state');
  }

  snapshot() {
    const { rows, totalSeconds } = setlist.setlistRows(this.file, this.songs, this.position.tempo);
    return {
      connected: this.live.connected,
      liveVersion: this.live.liveVersion,
      rows: rows.map((r) => ({ ...r, key: this.keyStatus.get(r.songId) ?? null })),
      totalSeconds,
      warnings: this.parseWarnings,
      tracks: this.tracks,
      settings: this.file.settings,
      cuedId: this.cuedId,
      position: this.position,
    };
  }

  /** Next playable setlist entry after `songId`, or null at the end. */
  nextSongId(songId: string): string | null {
    const ids = this.file.entries.map((e) => e.songId);
    for (let i = ids.indexOf(songId) + 1; i > 0 && i < ids.length; i++) {
      if (this.songs.some((s) => s.id === ids[i])) return ids[i];
    }
    return null;
  }

  // ---- reading Live ----------------------------------------------------------

  refresh(): Promise<void> {
    return this.run(async () => {
      const [cueReply, state] = await Promise.all([
        this.live.call<{ cues: Cue[]; songLength: number }>('cues'),
        this.live.call<Position>('state'),
      ]);
      this.position = { ...this.position, ...state };
      const sectionClips = await this.readSectionClips(cueReply.cues, cueReply.songLength);
      const parsed = parseLocators(cueReply.cues, cueReply.songLength, sectionClips);
      this.songs = parsed.songs;
      this.parseWarnings = parsed.warnings;
      const { file, changed } = setlist.reconcile(this.file, this.songs);
      if (changed) await this.save(file);
      else this.file = file;
      await this.refreshTracks();
      this.emit('state');
    });
  }

  /** Clips on the sections track (by name, see Settings), or none if the set has no such track. */
  private async readSectionClips(cues: Cue[], songLength: number): Promise<SectionClip[]> {
    const wanted = this.file.settings.sectionsTrack.trim().toLowerCase();
    if (!wanted) return [];
    const end = Math.max(songLength, ...cues.map((c) => c.time)) + 1;
    const { tracks } = await this.live.call<{ tracks: TrackInfo[] }>('tracks', { start: 0, end });
    const track = tracks.find((t) => !t.isGroup && t.name.trim().toLowerCase() === wanted);
    return track ? track.clips.map((c) => ({ name: c.name, start: c.start })) : [];
  }

  /**
   * Re-read the track list and mute states. Mixer work skips the command
   * queue on purpose: a mute must not wait behind a slow key change.
   */
  async refreshTracks(): Promise<void> {
    const read = ++this.mixerRead;
    const { tracks } = await this.live.call<{ tracks: MixerTrack[] }>('mixer');
    if (read !== this.mixerRead) return;
    this.tracks = tracks;
    this.emit('state');
  }

  /** Mute or unmute one track. `name` guards against the track list having changed. */
  async setMute(index: number, name: string, muted: boolean): Promise<void> {
    const track = this.tracks.find((t) => t.index === index);
    if (!track || track.name !== name) {
      void this.refreshTracks().catch(() => {});
      throw new Error(`Track "${name}" has moved or been renamed in Live; try again.`);
    }
    await this.live.call('mute', { track: index, trackName: name, muted });
    this.mixerRead++; // a read already in flight would be stale now
    this.tracks = this.tracks.map((t) => (t.index === index ? { ...t, muted } : t));
    this.emit('state');
  }

  private onPosition(pos: Position): void {
    const prev = this.position;
    this.position = pos;
    this.emit('position', pos);
    const wasIn = songAt(this.songs, prev.beats);
    const action = endOfSongAction(prev, pos, wasIn, this.file.settings.endOfSong);
    if (action !== 'none' && wasIn) {
      // A song the user queued wins over the next one in the setlist.
      const queued = this.cuedId && this.cuedId !== wasIn.id && this.songs.some((s) => s.id === this.cuedId);
      const next = queued ? this.cuedId : this.nextSongId(wasIn.id);
      void this.run(async () => {
        if (action === 'stop') {
          await this.markStopped();
          if (next) await this.prepare(next, { jump: true });
        } else if (next) {
          await this.prepare(next, { jump: true });
        } else {
          await this.markStopped();
        }
      }).catch((err) => this.notice('error', err.message));
    }
    if (!pos.playing && this.pendingKeys.size > 0 && !this.flushing) {
      this.flushing = true;
      void this.run(() => this.flushPendingKeys())
        .catch((err) => this.notice('error', err.message))
        .finally(() => (this.flushing = false));
    }
  }

  // ---- tempo and key -----------------------------------------------------------

  private async applyTempo(songId: string): Promise<void> {
    const bpm = planTempo(this.entry(songId)?.tempo ?? null, this.position.tempo);
    if (bpm === null) return;
    await this.live.call('tempo', { bpm });
    this.position = { ...this.position, tempo: bpm };
  }

  /** Plan and apply the key for one song, holding back anything unsafe. */
  private async applyKey(songId: string): Promise<void> {
    const semitones = this.entry(songId)?.semitones ?? null;
    if (semitones === null) return;
    const song = this.song(songId);
    const { tracks } = await this.live.call<{ tracks: TrackInfo[] }>('tracks', { start: song.start, end: song.end });
    const plan = planKey(song, semitones, tracks, this.file.settings.noKeyTag, this.file.settings.sectionsTrack);
    const { now, later } = splitKeyPlan(plan, song, this.position);
    const errors = await this.applyOps(now);
    if (later.length > 0) this.pendingKeys.add(songId);
    else this.pendingKeys.delete(songId);
    this.keyStatus.set(songId, {
      semitones: later.length === 0 && errors.length === 0 ? semitones : this.keyStatus.get(songId)?.semitones ?? null,
      pending: later.length > 0,
      warnings: plan.warnings,
      error: errors.length ? errors.join('; ') : null,
    });
    if (later.length > 0) this.notice('info', `Key for "${song.name}" will finish applying when Live stops.`);
    if (errors.length) this.notice('error', `Some key changes failed: ${errors[0]}`);
    this.emit('state');
  }

  private async applyOps(ops: KeyOp[]): Promise<string[]> {
    if (ops.length === 0) return [];
    const { results } = await this.live.call<{ results: Array<{ ok: boolean; error?: string }> }>('apply', { ops });
    return results.filter((r) => !r.ok).map((r) => r.error ?? 'unknown error');
  }

  private async flushPendingKeys(): Promise<void> {
    if (this.position.playing) return;
    // The cued song goes last: Pitch devices are shared by every song, so the
    // song about to play must be the one that sets them.
    const ids = [...this.pendingKeys].sort((a, b) => Number(a === this.cuedId) - Number(b === this.cuedId));
    for (const id of ids) {
      if (this.songs.some((s) => s.id === id)) await this.applyKey(id);
      else this.pendingKeys.delete(id);
    }
  }

  /** Make `songId` the cued song: set tempo and key, optionally move the playhead. */
  private async prepare(songId: string, opts: { jump: boolean; beats?: number }): Promise<void> {
    const song = this.song(songId);
    this.cuedId = songId;
    await this.applyTempo(songId);
    await this.applyKey(songId);
    if (opts.jump) await this.live.call('jump', { beats: opts.beats ?? song.start });
    this.emit('state');
  }

  // ---- commands from the UI ------------------------------------------------------

  play(): Promise<void> {
    return this.run(async () => {
      await this.live.call('play');
    });
  }

  stop(): Promise<void> {
    return this.run(async () => {
      if (!this.position.playing) {
        // Stop while stopped: back to the start of the current song.
        const song = songAt(this.songs, this.position.beats) ?? (this.cuedId ? this.song(this.cuedId) : null);
        if (song) await this.live.call('jump', { beats: song.start });
        return;
      }
      await this.markStopped();
    });
  }

  /** Stop Live and treat it as stopped right away (the position update lags). */
  private async markStopped(): Promise<void> {
    await this.live.call('stop');
    this.position = { ...this.position, playing: false };
  }

  /** Select a song. Stopped: the playhead moves there. Playing: it's queued. */
  cue(songId: string): Promise<void> {
    return this.run(async () => {
      if (this.position.playing) {
        const song = this.song(songId);
        this.cuedId = songId;
        await this.applyKey(songId); // only safe parts happen now
        this.notice('info', `"${song.name}" is up next.`);
        this.emit('state');
      } else {
        await this.prepare(songId, { jump: true });
      }
    });
  }

  /** Jump to a song (or one of its sections) and play. */
  start(songId: string, sectionIndex?: number): Promise<void> {
    return this.run(async () => {
      const song = this.song(songId);
      const beats = sectionIndex === undefined ? song.start : this.sectionOf(song, sectionIndex).start;
      await this.prepare(songId, { jump: true, beats });
      if (!this.position.playing) await this.live.call('play');
    });
  }

  /** Move to a section; keep playing if Live is playing. */
  jumpToSection(songId: string, sectionIndex: number): Promise<void> {
    return this.run(async () => {
      const song = this.song(songId);
      const section = this.sectionOf(song, sectionIndex);
      const current = songAt(this.songs, this.position.beats);
      if (current?.id === songId) await this.live.call('jump', { beats: section.start });
      else await this.prepare(songId, { jump: true, beats: section.start });
    });
  }

  /** Loop a section, or turn the loop off if that section is already looping. */
  toggleLoop(songId: string, sectionIndex: number): Promise<void> {
    return this.run(async () => {
      const section = this.sectionOf(this.song(songId), sectionIndex);
      const { loop } = this.position;
      const same = loop.enabled && Math.abs(loop.start - section.start) < 1e-3 && Math.abs(loop.length - (section.end - section.start)) < 1e-3;
      if (same) {
        await this.live.call('loop', { enabled: false });
        return;
      }
      await this.live.call('loop', { start: section.start, length: section.end - section.start, enabled: true });
      const inside = this.position.beats >= section.start && this.position.beats < section.end;
      if (!inside && !this.position.playing) await this.live.call('jump', { beats: section.start });
    });
  }

  loopOff(): Promise<void> {
    return this.run(async () => {
      await this.live.call('loop', { enabled: false });
    });
  }

  private sectionOf(song: Song, index: number) {
    const section = song.sections[index];
    if (!section) throw new Error(`"${song.name}" has no section ${index + 1}`);
    return section;
  }

  // ---- setlist editing -------------------------------------------------------

  move(from: number, to: number): Promise<void> {
    return this.run(() => this.save(setlist.moveEntry(this.file, from, to)));
  }

  reorder(songIds: string[]): Promise<void> {
    return this.run(() => this.save(setlist.reorder(this.file, songIds)));
  }

  remove(songId: string): Promise<void> {
    return this.run(async () => {
      if (this.songs.some((s) => s.id === songId)) throw new Error('only songs missing from the Live set can be removed');
      await this.save(setlist.removeEntry(this.file, songId));
    });
  }

  setTempo(songId: string, tempo: unknown): Promise<void> {
    return this.run(async () => {
      await this.save(setlist.setTempo(this.file, songId, tempo));
      const current = songAt(this.songs, this.position.beats);
      if (!this.position.playing && (current?.id === songId || this.cuedId === songId)) await this.applyTempo(songId);
    });
  }

  setKey(songId: string, semitones: unknown): Promise<void> {
    return this.run(async () => {
      await this.save(setlist.setSemitones(this.file, songId, semitones));
      this.keyStatus.delete(songId);
      this.pendingKeys.delete(songId);
      this.emit('state');
    });
  }

  /** Apply a song's key now (the safe parts, if Live is playing). */
  applyKeyNow(songId: string): Promise<void> {
    return this.run(() => this.applyKey(songId));
  }

  updateSettings(patch: Partial<SetlistSettings>): Promise<void> {
    return this.run(async () => {
      const before = this.file.settings.sectionsTrack;
      await this.save(setlist.setSettings(this.file, patch));
      if (this.file.settings.sectionsTrack !== before && this.live.connected) {
        void this.refresh().catch((err) => this.notice('error', err.message));
      }
    });
  }
}
