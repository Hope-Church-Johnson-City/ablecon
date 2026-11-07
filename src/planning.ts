// Pure decisions: which tempo/key changes to make and when. No I/O here, so
// all of it is unit-tested without Live.

import type { EndOfSong, KeyOp, Position, Song, TrackInfo } from './types.ts';

// ---- tempo -----------------------------------------------------------------

/** The tempo to send to Live, or null when nothing needs to change. */
export function planTempo(entryTempo: number | null, liveTempo: number): number | null {
  if (entryTempo === null) return null;
  return Math.abs(entryTempo - liveTempo) < 0.005 ? null : entryTempo;
}

// ---- key -------------------------------------------------------------------

export interface KeyPlan {
  semitones: number;
  clipOps: KeyOp[]; // audio clips inside the song's range
  deviceOps: KeyOp[]; // Pitch devices on MIDI tracks (affect the whole timeline)
  clipsInKey: number; // warped clips already at the right pitch
  devicesInKey: number;
  warnings: string[];
}

export function isTagged(track: Pick<TrackInfo, 'name' | 'parents'>, tag: string): boolean {
  const t = tag.toLowerCase();
  return [track.name, ...track.parents].some((n) => n.toLowerCase().includes(t));
}

/**
 * Work out every change needed to put `song` in `semitones`.
 * A clip belongs to a song when it starts inside the song's range.
 */
export function planKey(song: Pick<Song, 'start' | 'end'>, semitones: number, tracks: TrackInfo[], noKeyTag: string): KeyPlan {
  const plan: KeyPlan = { semitones, clipOps: [], deviceOps: [], clipsInKey: 0, devicesInKey: 0, warnings: [] };
  for (const track of tracks) {
    if (track.isGroup || isTagged(track, noKeyTag)) continue;
    let midiClips = 0;
    for (const clip of track.clips) {
      const startsInside = clip.start >= song.start && clip.start < song.end;
      if (!clip.isAudio) {
        if (startsInside) midiClips++;
        continue;
      }
      if (!startsInside) {
        if (clip.start < song.start && clip.end > song.start) {
          plan.warnings.push(`"${clip.name}" on ${track.name} starts before this song, so it was left alone.`);
        }
        continue;
      }
      if (!clip.warping) {
        plan.warnings.push(`"${clip.name}" on ${track.name} is not warped and can't be transposed. Turn on Warp for it.`);
        continue;
      }
      if (clip.end > song.end) {
        plan.warnings.push(`"${clip.name}" on ${track.name} runs past the end of this song; the whole clip is transposed.`);
      }
      if (clip.pitch === semitones) {
        plan.clipsInKey++;
      } else {
        plan.clipOps.push({ kind: 'clip', track: track.index, trackName: track.name, clip: clip.index, start: clip.start, pitch: semitones });
      }
    }
    if (track.isMidi) {
      let controlled = 0;
      for (const device of track.pitchDevices) {
        const param = device.params.find((p) => p.name.toLowerCase() === 'pitch');
        if (!param) continue;
        controlled++;
        const value = Math.max(param.min, Math.min(param.max, semitones));
        if (param.value === value) {
          plan.devicesInKey++;
        } else {
          plan.deviceOps.push({ kind: 'param', track: track.index, trackName: track.name, device: device.index, param: param.index, value });
        }
      }
      if (controlled === 0 && midiClips > 0) {
        plan.warnings.push(`MIDI track ${track.name} has no Pitch device, so it was not transposed.`);
      }
    }
  }
  return plan;
}

/**
 * Decide which planned changes can be made right now. Nothing that is
 * currently sounding is touched:
 *  - stopped: everything is applied;
 *  - playing outside the song: its clips can change (they aren't playing),
 *    but Pitch devices wait, because they affect whatever is playing now;
 *  - playing inside the song: everything waits until Live stops.
 */
export function splitKeyPlan(plan: KeyPlan, song: Pick<Song, 'start' | 'end'>, pos: Pick<Position, 'beats' | 'playing'>): { now: KeyOp[]; later: KeyOp[] } {
  if (!pos.playing) return { now: [...plan.clipOps, ...plan.deviceOps], later: [] };
  const inside = pos.beats >= song.start && pos.beats < song.end;
  if (inside) return { now: [], later: [...plan.clipOps, ...plan.deviceOps] };
  return { now: plan.clipOps, later: plan.deviceOps };
}

// ---- position --------------------------------------------------------------

export function songAt<T extends Pick<Song, 'start' | 'end'>>(songs: T[], beats: number): T | null {
  return songs.find((s) => beats >= s.start && beats < s.end) ?? null;
}

export function sectionIndexAt(song: Song, beats: number): number {
  return song.sections.findIndex((s) => beats >= s.start && beats < s.end);
}

/** How far the playhead may move past a song's end in one update and still count as "played through". */
const NATURAL_STEP_BEATS = 8;

/**
 * What to do when playback runs off the end of a song.
 * Returns 'none' for jumps the user made, when looping, or when stopped.
 */
export function endOfSongAction(prev: Position | null, now: Position, song: Pick<Song, 'start' | 'end'> | null, mode: EndOfSong): 'none' | 'stop' | 'next' {
  if (!prev || !song || !prev.playing || !now.playing || mode === 'continue') return 'none';
  const wasInside = prev.beats >= song.start && prev.beats < song.end;
  const crossed = now.beats >= song.end && now.beats - song.end < NATURAL_STEP_BEATS;
  if (!wasInside || !crossed) return 'none';
  return mode;
}
