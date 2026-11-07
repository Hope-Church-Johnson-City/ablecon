// Ties Live, the setlist file and the planning rules together. The web layer
// calls these methods and listens for "state", "position" and "notice".

import { EventEmitter } from 'node:events';
import { parseLocators, type SectionClip } from './locators.ts';
import { barBeats, crossedEnd, endOfSongAction, flowsInto, nextSectionJumpPoint, planKey, planTempo, sectionIndexAt, songAt, splitKeyPlan } from './planning.ts';
import * as setlist from './setlist.ts';
import * as store from './store.ts';
import type { Cue, KeyOp, MixerTrack, Position, SetlistFile, SetlistSettings, Song, TrackInfo } from './types.ts';

/** The parts of LiveClient the controller uses (so tests can pass a stub). */
export interface LiveLink extends EventEmitter {
  connected: boolean;
  liveVersion: string | null;
  call<T = unknown>(method: string, args?: Record<string, unknown>): Promise<T>;
}

export interface KeyStatus {
  semitones: number | null; // what Ablecon last set for this song
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
  private tempoSaving = new Set<string>();
  private oldScriptWarned = false;
  signature: [number, number] = [4, 4];
  /** A "next section" jump waiting for its bar line, if any. */
  pendingJump: { songId: string; sectionIndex: number; name: string; at: number; to: number } | null = null;
  private store: store.StoreFile = store.emptyStore();
  private setIndex = -1; // which stored setlist is open (-1: none yet)
  private tempoOverridden = false; // Ablecon set a tempo, so Live's tempo automation is overridden
  private restoreWarned = false;
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
    this.store = await store.loadStore(this.setlistPath);
    this.file = store.activeSetlist(this.store, -1);
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

  /** Keep `file` as the open set's setlist and write it (and song settings) to disk. */
  private async save(file: SetlistFile): Promise<void> {
    this.file = file;
    const next = store.commit(this.store, this.setIndex, file);
    this.store = next.store;
    this.setIndex = next.index;
    await store.saveStore(this.setlistPath, this.store);
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
      pendingJump: this.pendingJump,
      barBeats: barBeats(this.signature),
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
      const sig = (state as { signature?: [number, number] }).signature;
      if (Array.isArray(sig) && sig.length === 2) this.signature = sig;
      // Tempo automation overridden before Ablecon started (or by an earlier
      // run): hand it back as soon as a song without its own tempo is chosen.
      if ((state as { automationOverridden?: boolean }).automationOverridden) this.tempoOverridden = true;
      const sectionClips = await this.readSectionClips(cueReply.cues, cueReply.songLength);
      const parsed = parseLocators(cueReply.cues, cueReply.songLength, sectionClips);
      this.songs = parsed.songs;
      this.parseWarnings = parsed.warnings;
      if (this.songs.length > 0) {
        // Use the setlist kept for this Live set (or start one for a new set).
        const index = store.pickSet(this.store, this.songs);
        const base = index === this.setIndex && index >= 0 ? this.file : store.activeSetlist(this.store, index);
        this.setIndex = index;
        const { file } = setlist.reconcile(base, this.songs);
        await this.save(store.pruneMissing(store.withSongSettings(file, this.store), this.songs));
        if (this.cuedId && !this.songs.some((s) => s.id === this.cuedId)) this.cuedId = null;
      }
      // Learn the tempo of the song the playhead is already in (it may not move for a while).
      const here = songAt(this.songs, this.position.beats);
      if (here) this.noteTempo(here, this.position);
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

  /** Solo or unsolo one track. Like mutes, this skips the command queue. */
  async setSolo(index: number, name: string, soloed: boolean): Promise<void> {
    const track = this.tracks.find((t) => t.index === index);
    if (!track || track.name !== name) {
      void this.refreshTracks().catch(() => {});
      throw new Error(`Track "${name}" has moved or been renamed in Live; try again.`);
    }
    await this.mixerCall('solo', { track: index, trackName: name, soloed });
    // Soloing changes which other tracks are silent, so read them all back.
    await this.refreshTracks();
  }

  async clearSolos(): Promise<void> {
    await this.mixerCall('clear_solos', {});
    await this.refreshTracks();
  }

  private async mixerCall(method: string, args: Record<string, unknown>): Promise<void> {
    try {
      await this.live.call(method, args);
    } catch (err) {
      if (/unknown method/.test((err as Error).message)) {
        throw new Error('Solo needs the newer Remote Script: choose File → Install Remote Script in Ableton Live…, then restart Live.');
      }
      throw err;
    }
  }

  private onPosition(pos: Position): void {
    const prev = this.position;
    this.position = pos;
    this.emit('position', pos);
    const pj = this.pendingJump;
    if (pj) {
      const arrived = pos.beats >= pj.to - 0.5 && pos.beats < pj.to + 16;
      const abandoned = !pos.playing || pos.beats < prev.beats - 0.5 || pos.beats > pj.at + 4;
      if (arrived || abandoned) {
        this.pendingJump = null;
        this.emit('state');
      }
    }
    const wasIn = songAt(this.songs, prev.beats);
    const nowIn = songAt(this.songs, pos.beats);
    const action = endOfSongAction(prev, pos, wasIn, this.file.settings.endOfSong);
    if (nowIn) this.noteTempo(nowIn, pos);
    if (wasIn && !wasIn.stopAtEnd && crossedEnd(prev, pos, wasIn)) {
      this.onFlow(wasIn);
    } else if (nowIn && nowIn.id !== wasIn?.id) {
      // The playhead moved into a song some other way (a jump, Play, or in
      // Live itself): give it its tempo and, if playing, get the next song ready.
      void this.run(async () => {
        await this.applyTempo(nowIn.id);
        if (pos.playing) await this.prepareFlowNext(nowIn);
      }).catch((err) => this.notice('error', err.message));
    }
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

  /**
   * Remember the tempo Live reports near the start of a song. Sets often
   * change tempo with automation, so Live's current tempo says nothing about
   * the other songs; this keeps each song's running time right.
   */
  private noteTempo(song: Song, pos: Position): void {
    if (pos.beats < song.start || pos.beats - song.start > 16) return;
    const entry = this.entry(song.id);
    if (!entry || this.tempoSaving.has(song.id)) return;
    if (entry.seenTempo != null && Math.abs(entry.seenTempo - pos.tempo) < 0.01) return;
    this.tempoSaving.add(song.id);
    void this.run(() => this.save(setlist.setSeenTempo(this.file, song.id, pos.tempo)))
      .catch(() => {})
      .finally(() => this.tempoSaving.delete(song.id));
  }

  /**
   * Playback ran off the end of a song that has no STOP marker. Keep playing:
   * into the following song, or into a song the user queued instead.
   */
  private onFlow(from: Song): void {
    const into = flowsInto(this.songs, from);
    const queued = this.cuedId && this.cuedId !== from.id && this.cuedId !== into?.id && this.songs.some((s) => s.id === this.cuedId) ? this.cuedId : null;
    void this.run(async () => {
      if (queued) {
        await this.prepare(queued, { jump: true });
      } else if (into) {
        this.cuedId = into.id;
        await this.applyTempo(into.id);
        await this.prepareFlowNext(into);
        this.emit('state');
      }
    }).catch((err) => this.notice('error', err.message));
  }

  /**
   * If `song` runs straight into another song (no STOP marker), transpose that
   * song's audio clips now, while they aren't playing. Pitch devices are left
   * for when the song is cued or started, because they affect every song.
   */
  private async prepareFlowNext(song: Song): Promise<void> {
    const next = flowsInto(this.songs, song);
    if (!next || (this.entry(next.id)?.semitones ?? null) === null) return;
    await this.applyKey(next.id, { clipsOnly: true });
  }

  // ---- tempo and key -----------------------------------------------------------

  /**
   * Give a song its tempo. A song with its own tempo overrides Live's tempo
   * (and with it any tempo automation, which Live does for the whole set). A
   * song without one hands tempo back to the set's automation, so a tempo
   * set for one song only lasts while that song plays.
   */
  private async applyTempo(songId: string): Promise<void> {
    const want = this.entry(songId)?.tempo ?? null;
    if (want === null) {
      if (this.tempoOverridden) await this.restoreTempo();
      return;
    }
    const bpm = planTempo(want, this.position.tempo);
    if (bpm === null) return;
    await this.live.call('tempo', { bpm });
    this.tempoOverridden = true;
    this.position = { ...this.position, tempo: bpm };
  }

  private async restoreTempo(): Promise<void> {
    try {
      await this.live.call('restore_tempo');
      this.tempoOverridden = false;
    } catch (err) {
      if (!/unknown method/.test((err as Error).message)) throw err;
      this.tempoOverridden = false; // don't ask again for every song
      if (!this.restoreWarned) {
        this.restoreWarned = true;
        this.notice('warn', 'To keep song tempos from spreading to other songs, update the Remote Script (File → Install Remote Script in Ableton Live…, then restart Live).');
      }
    }
  }

  /**
   * Plan and apply the key for one song, holding back anything unsafe.
   * With clipsOnly, Pitch devices are not touched (or queued) at all.
   */
  private async applyKey(songId: string, opts: { clipsOnly?: boolean } = {}): Promise<void> {
    const semitones = this.entry(songId)?.semitones ?? null;
    if (semitones === null) return;
    const song = this.song(songId);
    const { tracks } = await this.live.call<{ tracks: TrackInfo[] }>('tracks', { start: song.start, end: song.end });
    const plan = planKey(song, semitones, tracks, this.file.settings.noKeyTag, this.file.settings.sectionsTrack);
    let { now, later } = splitKeyPlan(plan, song, this.position);
    if (opts.clipsOnly) {
      now = now.filter((op) => op.kind === 'clip');
      later = later.filter((op) => op.kind === 'clip');
      if (plan.deviceOps.length > 0) {
        plan.warnings.push('Pitch devices change when this song is cued or started, not when playback runs into it from the song before.');
      }
    }
    const errors = await this.applyOps(now);
    if (later.length > 0) this.pendingKeys.add(songId);
    else this.pendingKeys.delete(songId);
    this.keyStatus.set(songId, {
      semitones: later.length === 0 && errors.length === 0 && !(opts.clipsOnly && plan.deviceOps.length) ? semitones : this.keyStatus.get(songId)?.semitones ?? null,
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
    if (opts.jump) {
      const beats = opts.beats ?? song.start;
      await this.live.call('jump', { beats });
      this.position = { ...this.position, beats };
    }
    await this.prepareFlowNext(song);
    this.emit('state');
  }

  // ---- commands from the UI ------------------------------------------------------

  play(): Promise<void> {
    return this.run(async () => {
      if (this.position.playing) return;
      await this.startAt(this.position.beats);
    });
  }

  /**
   * Start playback exactly at `beats`. Live's own Play starts from its start
   * marker and "continue" from where it last stopped, so neither follows the
   * playhead Ablecon moved; the Remote Script's play_from moves the start
   * marker first. A Remote Script from an older Ablecon lacks play_from: then
   * start and jump once Live reports it's playing (a moment of the wrong
   * audio can be heard, so the user is told to update the script).
   */
  private async startAt(beats: number): Promise<void> {
    try {
      await this.live.call('play_from', { beats });
      this.position = { ...this.position, beats, playing: true }; // Live's report lags a tick
      return;
    } catch (err) {
      if (!/unknown method/.test((err as Error).message)) throw err;
    }
    if (!this.oldScriptWarned) {
      this.oldScriptWarned = true;
      this.notice('warn', 'Update the Remote Script (File → Install Remote Script in Ableton Live…, then restart Live) so songs start cleanly.');
    }
    const playing = this.waitForPlaying(1500);
    await this.live.call('continue');
    await playing;
    await this.live.call('jump', { beats });
    this.position = { ...this.position, beats, playing: true };
  }

  private waitForPlaying(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.live.off('position', check);
        resolve();
      };
      const check = (p: Position) => p.playing && done();
      const timer = setTimeout(done, ms);
      this.live.on('position', check);
    });
  }

  stop(): Promise<void> {
    return this.run(async () => {
      await this.dropPendingJump();
      if (!this.position.playing) {
        // Stop while stopped: back to the start of the current song.
        const song = songAt(this.songs, this.position.beats) ?? (this.cuedId ? this.song(this.cuedId) : null);
        if (song) await this.live.call('jump', { beats: song.start });
        return;
      }
      await this.markStopped();
      // A song was queued while playing: stopping gets it ready.
      const here = songAt(this.songs, this.position.beats);
      if (this.cuedId && this.cuedId !== here?.id && this.songs.some((s) => s.id === this.cuedId)) {
        await this.prepare(this.cuedId, { jump: true });
      }
    });
  }

  /** For tests: stop without the queued-song handling of stop(). */
  markStoppedForTest(): Promise<void> {
    return this.run(() => this.markStopped());
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
      await this.dropPendingJump();
      const song = this.song(songId);
      const beats = sectionIndex === undefined ? song.start : this.sectionOf(song, sectionIndex).start;
      await this.prepare(songId, { jump: true, beats });
      if (!this.position.playing) await this.startAt(beats);
    });
  }

  /**
   * Go to the next section of the current song. Playing: wait for the
   * configured number of bar lines, then jump (the Remote Script does the
   * timing). Stopped: move there now.
   */
  nextSection(): Promise<void> {
    return this.run(async () => {
      const beats = this.position.beats;
      const song = songAt(this.songs, beats) ?? (this.cuedId ? this.song(this.cuedId) : null);
      if (!song) throw new Error('The playhead is not in a song.');
      const here = sectionIndexAt(song, beats);
      const nextIndex = here >= 0 ? here + 1 : song.sections.findIndex((s) => s.start > beats);
      const next = nextIndex >= 0 ? song.sections[nextIndex] : undefined;
      if (!next) throw new Error(`There is no section after this one in "${song.name}".`);
      if (!this.position.playing) {
        await this.live.call('jump', { beats: next.start });
        this.position = { ...this.position, beats: next.start };
        return;
      }
      const bars = this.file.settings.jumpBars;
      const at = nextSectionJumpPoint(beats, bars, barBeats(this.signature), next.start);
      if (at === null) {
        this.notice('info', `${next.name} starts within ${bars} bar${bars === 1 ? '' : 's'} anyway.`);
        return;
      }
      try {
        await this.live.call('jump_at', { at, to: next.start });
      } catch (err) {
        if (/unknown method/.test((err as Error).message)) {
          throw new Error('Next section needs the newer Remote Script: choose File → Install Remote Script in Ableton Live…, then restart Live.');
        }
        throw err;
      }
      this.pendingJump = { songId: song.id, sectionIndex: nextIndex, name: next.name, at, to: next.start };
      this.emit('state');
    });
  }

  /** Cancel a waiting "next section" jump. */
  cancelJump(): Promise<void> {
    return this.run(() => this.dropPendingJump());
  }

  private async dropPendingJump(): Promise<void> {
    if (!this.pendingJump) return;
    this.pendingJump = null;
    this.emit('state');
    try {
      await this.live.call('cancel_jump');
    } catch {
      // older script: nothing was scheduled there
    }
  }

  /** Move to a section; keep playing if Live is playing. */
  jumpToSection(songId: string, sectionIndex: number): Promise<void> {
    return this.run(async () => {
      await this.dropPendingJump();
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
