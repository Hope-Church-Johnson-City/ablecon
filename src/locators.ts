// Turns Live's arrangement locators into songs and sections.
//
// Naming rule (see README "Naming your locators"):
//   *Title     starts a song called "Title" (a space after * is allowed)
//   --         ends the current song (optional; otherwise the next song ends it)
//   // text    is ignored (notes to yourself)
//   anything else is a section of the song it falls in.

import type { Cue, Section, Song } from './types.ts';

export interface ParseResult {
  songs: Song[];
  warnings: string[];
}

type Kind = 'song' | 'end' | 'ignore' | 'section';

export function classify(name: string): { kind: Kind; label: string } {
  const text = name.trim();
  if (text.startsWith('//')) return { kind: 'ignore', label: text };
  if (text === '--') return { kind: 'end', label: '' };
  if (text.startsWith('*')) return { kind: 'song', label: text.slice(1).trim() };
  return { kind: 'section', label: text };
}

const ORDER: Record<Kind, number> = { end: 0, song: 1, section: 2, ignore: 3 };

export function songIdFor(name: string, occurrence: number): string {
  const base = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return occurrence > 1 ? `${base}#${occurrence}` : base;
}

/**
 * @param cues locators as Live reports them (any order)
 * @param setEnd the end of the arrangement in beats, used to close a final
 *               song that has no `--` marker
 */
export function parseLocators(cues: Cue[], setEnd: number): ParseResult {
  const warnings: string[] = [];
  const items = cues
    .map((cue, i) => ({ ...classify(cue.name), time: cue.time, raw: cue.name, i }))
    .sort((a, b) => a.time - b.time || ORDER[a.kind] - ORDER[b.kind] || a.i - b.i);

  const songs: Song[] = [];
  const seen = new Map<string, number>();
  let current: (Song & { sectionStarts: Array<{ name: string; start: number }> }) | null = null;

  const close = (end: number) => {
    if (!current) return;
    current.end = end;
    current.sections = current.sectionStarts.map((s, i, all): Section => ({
      name: s.name,
      start: s.start,
      end: i + 1 < all.length ? all[i + 1].start : end,
    }));
    if (current.end <= current.start) {
      warnings.push(`Song "${current.name}" has no length and was skipped.`);
    } else {
      const { sectionStarts: _ignored, ...song } = current;
      songs.push(song);
    }
    current = null;
  };

  for (const item of items) {
    switch (item.kind) {
      case 'ignore':
        break;
      case 'end':
        if (!current) warnings.push(`End marker "--" at beat ${fmt(item.time)} is not inside a song.`);
        close(item.time);
        break;
      case 'song': {
        close(item.time);
        if (!item.label) {
          warnings.push(`Locator "*" at beat ${fmt(item.time)} has no song name and was ignored.`);
          break;
        }
        const key = songIdFor(item.label, 1);
        const n = (seen.get(key) ?? 0) + 1;
        seen.set(key, n);
        if (n > 1) warnings.push(`Song name "${item.label}" is used ${n} times; the setlist tells them apart by order.`);
        current = { id: songIdFor(item.label, n), name: item.label, start: item.time, end: item.time, sections: [], sectionStarts: [] };
        break;
      }
      case 'section':
        if (!current) {
          warnings.push(`Locator "${item.raw}" at beat ${fmt(item.time)} is not inside a song and was ignored.`);
        } else {
          current.sectionStarts.push({ name: item.label, start: item.time });
        }
        break;
    }
  }

  if (current) {
    const lastSong: Song = current;
    const lastMark = Math.max(lastSong.start, ...current.sectionStarts.map((s) => s.start));
    if (setEnd > lastMark) {
      close(setEnd);
    } else {
      warnings.push(`The last song "${lastSong.name}" has no end; add a "--" locator where it ends.`);
      close(lastMark > lastSong.start ? lastMark : lastSong.start);
    }
  }
  return { songs, warnings };
}

function fmt(beats: number): string {
  return String(Math.round(beats * 100) / 100);
}
