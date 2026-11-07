// What Ablecon keeps on disk: a setlist (song order) for each Live set it has
// seen, and settings (tempo, key) for each song, shared by every set the song
// appears in.
//
// A Live set is recognised by its songs, because Live doesn't tell a Remote
// Script which file is open. The stored setlist whose songs best match the
// open set is used (so renaming or adding a song keeps the setlist); a set
// with mostly different songs, like next Sunday's, gets a new one.

import { promises as fs } from 'node:fs';
import { DEFAULT_SETTINGS, parseSetlistFile, setSettings, validateSemitones, validateTempo } from './setlist.ts';
import type { SetlistEntry, SetlistFile, SetlistSettings, Song } from './types.ts';

export interface SongSettings {
  name: string;
  tempo: number | null;
  semitones: number | null;
  seenTempo?: number;
}

export interface StoredSet {
  songIds: string[]; // setlist order
  lastUsed: string; // ISO time
  legacy?: boolean; // the single shared setlist from before sets were kept apart
}

export interface StoreFile {
  version: 2;
  songs: Record<string, SongSettings>;
  sets: StoredSet[];
  settings: SetlistSettings;
}

const MAX_SETS = 60;
const SAME_SET = 0.5; // share of songs in common (of both sets together) to count as the same set
const LEGACY_SAME_SET = 0.75; // share of the open set's songs found in the old shared setlist

export function emptyStore(): StoreFile {
  return { version: 2, songs: {}, sets: [], settings: { ...DEFAULT_SETTINGS } };
}

// ---- matching a Live set to a stored setlist ------------------------------------

/** Index of the stored setlist for the open set, or -1 when it's a new set. */
export function pickSet(store: StoreFile, songs: Song[]): number {
  const current = new Set(songs.map((s) => s.id));
  if (current.size === 0) return -1;
  let best = -1;
  let bestScore = 0;
  store.sets.forEach((set, i) => {
    const ids = new Set(set.songIds);
    let common = 0;
    for (const id of current) if (ids.has(id)) common++;
    let score: number;
    if (set.legacy) {
      const share = common / current.size;
      score = share >= LEGACY_SAME_SET ? share : 0;
    } else {
      const union = new Set([...current, ...ids]).size;
      const jaccard = union ? common / union : 0;
      score = jaccard >= SAME_SET ? jaccard : 0;
    }
    const newer = best >= 0 && score === bestScore && set.lastUsed > store.sets[best].lastUsed;
    if (score > bestScore || newer) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

/** The setlist for stored set `index` (-1: empty), with each song's saved settings. */
export function activeSetlist(store: StoreFile, index: number): SetlistFile {
  const ids = index >= 0 ? store.sets[index].songIds : [];
  return withSongSettings({ version: 1, entries: ids.map((id) => ({ songId: id, name: store.songs[id]?.name ?? id, tempo: null, semitones: null })), settings: store.settings }, store);
}

/** Give each entry the tempo and key saved for its song (e.g. from another set). */
export function withSongSettings(file: SetlistFile, store: StoreFile): SetlistFile {
  const entries = file.entries.map((e): SetlistEntry => {
    const saved = store.songs[e.songId];
    if (!saved) return e;
    const out: SetlistEntry = { ...e, tempo: saved.tempo, semitones: saved.semitones };
    if (saved.seenTempo !== undefined) out.seenTempo = saved.seenTempo;
    else delete out.seenTempo;
    return out;
  });
  return { ...file, entries };
}

/**
 * Drop songs that aren't in the open set, unless they have a tempo or key
 * (then they stay, marked missing, in case a locator was renamed).
 */
export function pruneMissing(file: SetlistFile, songs: Song[]): SetlistFile {
  const present = new Set(songs.map((s) => s.id));
  return { ...file, entries: file.entries.filter((e) => present.has(e.songId) || e.tempo !== null || e.semitones !== null) };
}

/**
 * Write the active setlist back into the store: song settings into the
 * shared library, order into stored set `index` (-1 adds a new set).
 */
export function commit(store: StoreFile, index: number, file: SetlistFile, now = new Date().toISOString()): { store: StoreFile; index: number } {
  const songs = { ...store.songs };
  for (const e of file.entries) {
    const s: SongSettings = { name: e.name, tempo: e.tempo, semitones: e.semitones };
    if (e.seenTempo != null) s.seenTempo = e.seenTempo;
    songs[e.songId] = s;
  }
  let sets = store.sets.slice();
  const entry: StoredSet = { songIds: file.entries.map((e) => e.songId), lastUsed: now };
  if (index >= 0 && index < sets.length) {
    sets[index] = entry;
  } else if (entry.songIds.length > 0) {
    sets.push(entry);
    index = sets.length - 1;
  } else {
    index = -1;
  }
  if (sets.length > MAX_SETS) {
    const keep = sets.map((s, i) => ({ s, i })).sort((a, b) => (a.s.lastUsed < b.s.lastUsed ? 1 : -1)).slice(0, MAX_SETS).map((x) => x.i);
    const kept = new Set(keep);
    const active = sets[index];
    sets = sets.filter((_, i) => kept.has(i));
    index = active ? sets.indexOf(active) : -1;
  }
  return { store: { ...store, songs, sets, settings: file.settings }, index };
}

// ---- file I/O ----------------------------------------------------------------

/** Read either the current format or the single shared setlist from before. */
export function parseStore(text: string): StoreFile {
  const data = JSON.parse(text) as Partial<StoreFile> & { entries?: unknown };
  if (data && Array.isArray(data.entries)) {
    const old = parseSetlistFile(text);
    const store: StoreFile = { ...emptyStore(), settings: old.settings };
    for (const e of old.entries) {
      const s: SongSettings = { name: e.name, tempo: e.tempo, semitones: e.semitones };
      if (e.seenTempo != null) s.seenTempo = e.seenTempo;
      store.songs[e.songId] = s;
    }
    if (old.entries.length) store.sets.push({ songIds: old.entries.map((e) => e.songId), lastUsed: new Date(0).toISOString(), legacy: true });
    return store;
  }
  if (!data || data.version !== 2 || typeof data.songs !== 'object' || !Array.isArray(data.sets)) {
    throw new Error('not an Ablecon setlist file');
  }
  const store = emptyStore();
  for (const [id, raw] of Object.entries(data.songs ?? {})) {
    if (!raw || typeof raw !== 'object') continue;
    const s: SongSettings = {
      name: typeof raw.name === 'string' ? raw.name : id,
      tempo: safe(() => validateTempo(raw.tempo)),
      semitones: safe(() => validateSemitones(raw.semitones)),
    };
    const seen = safe(() => validateTempo(raw.seenTempo));
    if (seen !== null) s.seenTempo = seen;
    store.songs[id] = s;
  }
  for (const raw of data.sets) {
    if (!raw || !Array.isArray(raw.songIds)) continue;
    const ids = [...new Set(raw.songIds.filter((x): x is string => typeof x === 'string'))];
    const set: StoredSet = { songIds: ids, lastUsed: typeof raw.lastUsed === 'string' ? raw.lastUsed : new Date(0).toISOString() };
    if (raw.legacy) set.legacy = true;
    store.sets.push(set);
  }
  for (const [k, v] of Object.entries(data.settings ?? {})) {
    try {
      store.settings = setSettings({ version: 1, entries: [], settings: store.settings }, { [k]: v }).settings;
    } catch {
      // keep the default for anything invalid
    }
  }
  return store;
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

export async function loadStore(path: string): Promise<StoreFile> {
  try {
    return parseStore(await fs.readFile(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    throw new Error(`could not read setlist ${path}: ${(err as Error).message}`);
  }
}

export async function saveStore(path: string, store: StoreFile): Promise<void> {
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, path);
}
