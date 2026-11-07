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

/** True when the track or one of its groups has any of the comma-separated words in its name. */
export function isTagged(track: Pick<TrackInfo, 'name' | 'parents'>, tags: string): boolean {
  const words = tags.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
  return [track.name, ...track.parents].some((n) => words.some((w) => n.toLowerCase().includes(w)));
}

/**
 * Work out every change needed to put `song` in `semitones`.
 * A clip belongs to a song when it starts inside the song's range.
 */
export function planKey(song: Pick<Song, 'start' | 'end'>, semitones: number, tracks: TrackInfo[], noKeyTag: string, sectionsTrack = ''): KeyPlan {
  const plan: KeyPlan = { semitones, clipOps: [], deviceOps: [], clipsInKey: 0, devicesInKey: 0, warnings: [] };
  const sectionsName = sectionsTrack.trim().toLowerCase();
  for (const track of tracks) {
    if (track.isGroup || isTagged(track, noKeyTag)) continue;
    if (sectionsName && track.name.trim().toLowerCase() === sectionsName) continue; // marker clips, not music
    let midiClips = 0;
    for (const clip of track.clips) {
      const startsInside = clip.start >= song.start && clip.start < song.end;
      if (!clip.isAudio) {
        if (startsInside) midiClips++;
        continue;
      }
      // Clips are matched to songs by where they start. Stems often have a
      // tail that runs past the song's end: that clip belongs to the song it
      // starts in and is transposed as a whole, and the next song leaves it
      // alone. That's expected, so no warning is given for it.
      if (!startsInside) continue;
      if (!clip.warping) {
        plan.warnings.push(`"${clip.name}" on ${track.name} is not warped and can't be transposed. Turn on Warp for it.`);
        continue;
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

/** True when playback ran off the end of `song` between two updates (not a jump, not looping, not stopped). */
export function crossedEnd(prev: Position | null, now: Position, song: Pick<Song, 'start' | 'end'> | null): boolean {
  if (!prev || !song || !prev.playing || !now.playing) return false;
  const wasInside = prev.beats >= song.start && prev.beats < song.end;
  return wasInside && now.beats >= song.end && now.beats - song.end < NATURAL_STEP_BEATS;
}

/**
 * What to do when playback runs off the end of a song. Only songs that end
 * at a STOP marker stop or jump; any other boundary is played straight through.
 */
export function endOfSongAction(prev: Position | null, now: Position, song: Pick<Song, 'start' | 'end' | 'stopAtEnd'> | null, mode: EndOfSong): 'none' | 'stop' | 'next' {
  if (!song?.stopAtEnd || mode === 'continue' || !crossedEnd(prev, now, song)) return 'none';
  return mode;
}

/** The song playback runs into after `song`, when no STOP marker ends it. */
export function flowsInto<T extends Pick<Song, 'start' | 'end' | 'stopAtEnd'>>(songs: T[], song: T): T | null {
  if (song.stopAtEnd) return null;
  return songs.find((s) => Math.abs(s.start - song.end) < 1e-6) ?? null;
}
