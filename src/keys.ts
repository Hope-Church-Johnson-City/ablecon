// Musical keys written in song names, e.g. "How Great Thou Art (F)" or "Oceans (Bm)".

const LETTERS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
// How each pitch class is usually spelled as a key name.
const MAJOR = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];

const SUFFIX = /\s*\(\s*([A-Ga-g])\s*([#b♯♭]?)\s*(m|min|minor)?\s*\)\s*$/;

export interface MusicalKey {
  pitch: number; // 0 = C … 11 = B
  minor: boolean;
}

/** Split "Title (G)" into the title and its key. Names without a key are returned unchanged. */
export function splitKey(name: string): { title: string; key: MusicalKey | null } {
  const m = SUFFIX.exec(name);
  if (!m) return { title: name.trim(), key: null };
  const title = name.slice(0, m.index).trim();
  if (!title) return { title: name.trim(), key: null };
  const accidental = m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0;
  const pitch = (LETTERS[m[1].toUpperCase()] + accidental + 12) % 12;
  return { title, key: { pitch, minor: Boolean(m[3]) } };
}

export function keyName(key: MusicalKey): string {
  return key.minor ? `${MINOR[key.pitch]}m` : MAJOR[key.pitch];
}

export function transposeKey(key: MusicalKey, semitones: number): MusicalKey {
  return { pitch: (((key.pitch + semitones) % 12) + 12) % 12, minor: key.minor };
}
