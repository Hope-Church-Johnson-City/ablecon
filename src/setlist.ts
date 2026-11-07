// The setlist: an ordering of songs (plus tempo and key per song) kept in a
// JSON file, separate from the Live set, so reordering never edits the set.

import { promises as fs } from 'node:fs';
import { keyName, transposeKey } from './keys.ts';
import type { EndOfSong, SetlistEntry, SetlistFile, SetlistSettings, Song } from './types.ts';

export const DEFAULT_SETTINGS: SetlistSettings = { endOfSong: 'stop', noKeyTag: '[nokey], click, guide', sectionsTrack: 'Sections' };
const END_MODES: EndOfSong[] = ['stop', 'next', 'continue'];

export function emptySetlist(): SetlistFile {
  return { version: 1, entries: [], settings: { ...DEFAULT_SETTINGS } };
}

/**
 * Lines the saved setlist up with the songs found in Live. Saved order wins;
 * songs Live has that the setlist lacks are added at the end in arrangement
 * order; entries whose song disappeared stay (shown as missing) so a typo in
 * a locator doesn't throw away their tempo and key.
 */
export function reconcile(file: SetlistFile, songs: Song[]): { file: SetlistFile; changed: boolean } {
  const byId = new Map(songs.map((s) => [s.id, s]));
  let changed = false;
  const seen = new Set<string>();
  const entries: SetlistEntry[] = [];
  for (const entry of file.entries) {
    if (seen.has(entry.songId)) {
      changed = true; // drop duplicate rows
      continue;
    }
    seen.add(entry.songId);
    const song = byId.get(entry.songId);
    if (song && song.name !== entry.name) {
      entries.push({ ...entry, name: song.name });
      changed = true;
    } else {
      entries.push(entry);
    }
  }
  for (const song of songs) {
    if (!seen.has(song.id)) {
      entries.push({ songId: song.id, name: song.name, tempo: null, semitones: null });
      changed = true;
    }
  }
  return { file: { ...file, entries }, changed };
}

export function moveEntry(file: SetlistFile, from: number, to: number): SetlistFile {
  const n = file.entries.length;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= n || to < 0 || to >= n) {
    throw new Error(`cannot move entry ${from} to ${to}`);
  }
  const entries = file.entries.slice();
  const [item] = entries.splice(from, 1);
  entries.splice(to, 0, item);
  return { ...file, entries };
}

/** Replace the order with the given list of song ids (must be a permutation). */
export function reorder(file: SetlistFile, songIds: string[]): SetlistFile {
  const byId = new Map(file.entries.map((e) => [e.songId, e]));
  if (songIds.length !== file.entries.length || new Set(songIds).size !== songIds.length || !songIds.every((id) => byId.has(id))) {
    throw new Error('new order must list every setlist entry exactly once');
  }
  return { ...file, entries: songIds.map((id) => byId.get(id)!) };
}

export function removeEntry(file: SetlistFile, songId: string): SetlistFile {
  return { ...file, entries: file.entries.filter((e) => e.songId !== songId) };
}

function updateEntry(file: SetlistFile, songId: string, patch: Partial<SetlistEntry>): SetlistFile {
  if (!file.entries.some((e) => e.songId === songId)) throw new Error(`no setlist entry for "${songId}"`);
  return { ...file, entries: file.entries.map((e) => (e.songId === songId ? { ...e, ...patch } : e)) };
}

export function validateTempo(tempo: unknown): number | null {
  if (tempo === null || tempo === undefined || tempo === '') return null;
  const n = Number(tempo);
  if (!Number.isFinite(n) || n < 20 || n > 999) throw new Error('tempo must be between 20 and 999 BPM');
  return Math.round(n * 100) / 100;
}

export function validateSemitones(semitones: unknown): number | null {
  if (semitones === null || semitones === undefined || semitones === '') return null;
  const n = Number(semitones);
  if (!Number.isInteger(n) || n < -12 || n > 12) throw new Error('key change must be a whole number from -12 to +12');
  return n;
}

export function setTempo(file: SetlistFile, songId: string, tempo: unknown): SetlistFile {
  return updateEntry(file, songId, { tempo: validateTempo(tempo) });
}

export function setSemitones(file: SetlistFile, songId: string, semitones: unknown): SetlistFile {
  return updateEntry(file, songId, { semitones: validateSemitones(semitones) });
}

/** Remember the tempo Live plays a song at, so the set length is right even with tempo automation. */
export function setSeenTempo(file: SetlistFile, songId: string, bpm: number): SetlistFile {
  if (!Number.isFinite(bpm) || bpm < 20 || bpm > 999) return file;
  const rounded = Math.round(bpm * 100) / 100;
  return { ...file, entries: file.entries.map((e) => (e.songId === songId ? { ...e, seenTempo: rounded } : e)) };
}

export function setSettings(file: SetlistFile, patch: Partial<SetlistSettings>): SetlistFile {
  const settings = { ...file.settings };
  if (patch.endOfSong !== undefined) {
    if (!END_MODES.includes(patch.endOfSong)) throw new Error(`end-of-song mode must be one of ${END_MODES.join(', ')}`);
    settings.endOfSong = patch.endOfSong;
  }
  if (patch.noKeyTag !== undefined) {
    const words = String(patch.noKeyTag).split(',').map((w) => w.trim()).filter(Boolean);
    if (words.length === 0) throw new Error('list at least one word for tracks that should never be transposed');
    settings.noKeyTag = words.join(', ');
  }
  if (patch.sectionsTrack !== undefined) {
    settings.sectionsTrack = String(patch.sectionsTrack).trim();
  }
  return { ...file, settings };
}

// ---- durations -------------------------------------------------------------

export function songSeconds(song: Song, bpm: number): number {
  return ((song.end - song.start) * 60) / bpm;
}

export interface SetlistRow extends SetlistEntry {
  missing: boolean;
  originalKey: string | null; // e.g. "G", from the locator name
  stopAtEnd: boolean; // ends at a STOP marker (false: plays straight on into the next song)
  playedKey: string | null; // originalKey moved by semitones, e.g. "A
  start: number | null;
  end: number | null;
  sections: Song['sections'];
  seconds: number | null;
}

export function setlistRows(file: SetlistFile, songs: Song[], liveTempo: number): { rows: SetlistRow[]; totalSeconds: number } {
  const byId = new Map(songs.map((s) => [s.id, s]));
  let total = 0;
  const rows = file.entries.map((entry): SetlistRow => {
    const song = byId.get(entry.songId);
    if (!song) return { ...entry, missing: true, stopAtEnd: true, originalKey: null, playedKey: null, start: null, end: null, sections: [], seconds: null };
    const seconds = songSeconds(song, entry.tempo ?? entry.seenTempo ?? liveTempo);
    total += seconds;
    const originalKey = song.key ? keyName(song.key) : null;
    const playedKey = song.key ? keyName(transposeKey(song.key, entry.semitones ?? 0)) : null;
    return { ...entry, missing: false, stopAtEnd: song.stopAtEnd, originalKey, playedKey, start: song.start, end: song.end, sections: song.sections, seconds };
  });
  return { rows, totalSeconds: total };
}

// ---- file I/O --------------------------------------------------------------

export function parseSetlistFile(text: string): SetlistFile {
  const data = JSON.parse(text) as Partial<SetlistFile>;
  if (!data || typeof data !== 'object' || !Array.isArray(data.entries)) throw new Error('setlist file has no "entries" list');
  const entries: SetlistEntry[] = data.entries
    .filter((e): e is SetlistEntry => !!e && typeof e.songId === 'string')
    .map((e) => ({
      songId: e.songId,
      name: typeof e.name === 'string' ? e.name : e.songId,
      tempo: safe(() => validateTempo(e.tempo)),
      semitones: safe(() => validateSemitones(e.semitones)),
      ...seen(e.seenTempo),
    }));
  let file: SetlistFile = { version: 1, entries, settings: { ...DEFAULT_SETTINGS } };
  const saved: Partial<SetlistSettings> = { ...(data.settings ?? {}) };
  if (saved.noKeyTag === '[nokey]') delete saved.noKeyTag; // the old default; use the new one
  for (const [k, v] of Object.entries(saved)) {
    try {
      file = setSettings(file, { [k]: v });
    } catch {
      // keep the default for anything invalid
    }
  }
  return file;
}

/** Only keep a remembered tempo when it is valid, so files without one stay unchanged. */
function seen(value: unknown): { seenTempo?: number } {
  const bpm = safe(() => validateTempo(value));
  return bpm === null ? {} : { seenTempo: bpm };
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

export async function loadSetlist(path: string): Promise<SetlistFile> {
  try {
    return parseSetlistFile(await fs.readFile(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptySetlist();
    throw new Error(`could not read setlist ${path}: ${(err as Error).message}`);
  }
}

export async function saveSetlist(path: string, file: SetlistFile): Promise<void> {
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, path); // atomic replace, so a crash never leaves half a file
}
