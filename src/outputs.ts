// Track outputs ("Audio To" in Live) and output presets.
//
// A preset is a set of outputs by track name, so it works in every Live set: "Bass → 5" routes
// every track called Bass, whichever song's group it's in. The master track is stored as
// "#master". Names are matched ignoring case and spaces at either end.

import type { MixerTrack, OutputPreset, TrackOutput } from './types.ts';

export const MASTER_KEY = '#master';
/** In a preset: "where this track normally goes": its group if it's in one, otherwise the master. */
export const NORMAL = '#normal';
/** The master track's name as an output: "Main" in Live 12, "Master" before. */
export const MAIN_NAMES = ['Main', 'Master'];

/**
 * The outputs worth offering for a track: the audio interface, the master, its own group and
 * "Sends Only". (Live also lists every other track, for recording one into another, and MIDI
 * tracks list MIDI ports; those aren't outputs to pick here.) Empty for a track that can't go to
 * the audio interface, such as a MIDI track with no instrument.
 */
export function usefulTypes(t: Pick<MixerTrack, 'parents'>, types: string[] | undefined, external: string | null): string[] {
  const offered = types ?? [];
  if (!external || !offered.includes(external)) return [];
  return offered.filter((x) => x === external || MAIN_NAMES.includes(x) || x === 'Sends Only'
    || (t.parents.length > 0 && (x === 'Group' || x === t.parents[0])));
}

/** Is this output the track's normal place (its group, or the master for a track outside groups)? */
export function isNormalOutput(t: Pick<MixerTrack, 'parents' | 'output'>): boolean {
  const type = t.output?.type;
  if (!type) return false;
  // Live 12 names a group's output after the group, and the master "Main" (Live 11: "Master").
  return t.parents.length ? type === 'Group' || type === t.parents[0] : MAIN_NAMES.includes(type);
}

/** The type that sends a track to its normal place, from the types Live offers it. */
export function normalType(t: Pick<MixerTrack, 'parents'>, types: string[] | undefined): string | null {
  const offered = types ?? [];
  if (t.parents.length) return offered.find((x) => x === 'Group' || x === t.parents[0]) ?? null;
  return offered.find((x) => MAIN_NAMES.includes(x)) ?? null;
}

export function presetKey(name: string): string {
  return name.trim().toLowerCase();
}

/** The output a preset entry stands for, as Live would show it. */
function sameOutput(a: TrackOutput | undefined, b: { type: string; channel: string | null }, external: string | null): boolean {
  if (!a || a.type !== b.type) return false;
  // A channel only matters on the audio interface; elsewhere (Master, Group) Live picks it.
  return b.type !== external || a.channel === b.channel;
}

/**
 * The current outputs as a preset. Where several tracks share a name (a Bass in every song's
 * group) and go to different places, a track moved away from its normal place wins (moving one
 * song's Bass to Out 5 means "Bass → 5"); among those, the most common output.
 */
export function presetFromTracks(
  name: string,
  tracks: MixerTrack[],
  master: TrackOutput | null,
  external: string | null,
): OutputPreset {
  const counts = new Map<string, Map<string, { output: { type: string; channel: string | null }; n: number }>>();
  for (const t of tracks) {
    if (!t.output?.type) continue;
    const output = isNormalOutput(t)
      ? { type: NORMAL, channel: null }
      : { type: t.output.type, channel: t.output.type === external ? t.output.channel : null };
    const key = presetKey(t.name);
    const byOutput = counts.get(key) ?? new Map();
    const id = `${output.type}\u0000${output.channel ?? ''}`;
    const entry = byOutput.get(id) ?? { output, n: 0 };
    entry.n++;
    byOutput.set(id, entry);
    counts.set(key, byOutput);
  }
  const outputs: OutputPreset['outputs'] = {};
  for (const [key, byOutput] of counts) {
    const all = [...byOutput.values()];
    const moved = all.filter((e) => e.output.type !== NORMAL);
    outputs[key] = (moved.length ? moved : all).sort((a, b) => b.n - a.n)[0].output;
  }
  if (master?.type) outputs[MASTER_KEY] = { type: master.type, channel: master.channel };
  return { name: name.trim(), outputs };
}

export interface OutputChange {
  track: number; // -1: the master
  name: string;
  type: string;
  channel: string | null;
}

/**
 * What applying a preset changes: only tracks it names whose output differs. `typesOf` gives the
 * output types Live offers a track (to find its group).
 */
export function planPreset(
  preset: OutputPreset,
  tracks: MixerTrack[],
  master: TrackOutput | null,
  external: string | null,
  typesOf: (index: number) => string[] | undefined = () => undefined,
): OutputChange[] {
  const changes: OutputChange[] = [];
  for (const t of tracks) {
    const want = preset.outputs[presetKey(t.name)];
    if (!want || !t.output) continue;
    if (want.type === NORMAL) {
      if (isNormalOutput(t)) continue;
      const type = normalType(t, typesOf(t.index));
      if (type) changes.push({ track: t.index, name: t.name, type, channel: null });
      continue;
    }
    if (!sameOutput(t.output, want, external)) {
      changes.push({ track: t.index, name: t.name, type: want.type, channel: want.type === external ? want.channel : null });
    }
  }
  const m = preset.outputs[MASTER_KEY];
  if (m && master && !sameOutput(master, m, external)) changes.push({ track: -1, name: 'Master', type: m.type, channel: m.channel });
  return changes;
}

/** A short label for an output: "Out 5", "Out 3/4", or Live's name ("Master", "Group"). */
export function outputLabel(o: TrackOutput | null | undefined, external: string | null): string {
  if (!o?.type) return '–';
  if (o.type === NORMAL) return 'Normal';
  if (o.type === external) return o.channel ? `Out ${o.channel}` : o.type;
  return o.type;
}
