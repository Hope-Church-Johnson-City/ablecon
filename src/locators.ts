// Turns Live's arrangement locators (and optionally a "Sections" track) into
// songs and sections. See README "Naming your locators".
//
// Two styles are understood:
//
// Marked style (used as soon as any locator name starts with "*"):
//   *Title          starts a song
//   anything else   is a section of the song it falls in
//
// Plain style (no locator starts with "*"):
//   every locator   starts a song, named after the locator
//
// In both styles:
//   -- or STOP      ends the current song (optional; otherwise the next song ends it)
//   // text         is ignored
//   "(G)", "(Bm)"…  at the end of a song name is read as the song's original key
//
// Sections can also come from the clips on a sections track: each clip that
// starts inside a song becomes a section named after the clip. They are used
// for songs that have no section locators.

import { splitKey } from './keys.ts';
import type { Cue, Section, Song } from './types.ts';

export interface ParseResult {
  songs: Song[];
  warnings: string[];
  style: 'marked' | 'plain';
}

/** A clip on the sections track. */
export interface SectionClip {
  name: string;
  start: number;
}

type Kind = 'song' | 'end' | 'ignore' | 'section';

const END_NAMES = new Set(['--', 'stop']);

export function classify(name: string, style: 'marked' | 'plain' = 'marked'): { kind: Kind; label: string } {
  const text = name.trim();
  if (text.startsWith('//')) return { kind: 'ignore', label: text };
  if (END_NAMES.has(text.toLowerCase())) return { kind: 'end', label: '' };
  if (text.startsWith('*')) return { kind: 'song', label: text.slice(1).trim() };
  return style === 'plain' ? { kind: 'song', label: text } : { kind: 'section', label: text };
}

export function detectStyle(cues: Cue[]): 'marked' | 'plain' {
  return cues.some((c) => c.name.trim().startsWith('*')) ? 'marked' : 'plain';
}

const ORDER: Record<Kind, number> = { end: 0, song: 1, section: 2, ignore: 3 };

/** Setlist key for a song: its title without the "(key)" suffix, so changing the written key keeps the entry. */
export function songIdFor(name: string, occurrence: number): string {
  const base = splitKey(name).title.toLowerCase().replace(/\s+/g, ' ');
  return occurrence > 1 ? `${base}#${occurrence}` : base;
}

/**
 * @param cues locators as Live reports them (any order)
 * @param setEnd end of the arrangement in beats, used to close a final song with no end marker
 * @param sectionClips clips on the sections track, if the set has one
 */
export function parseLocators(cues: Cue[], setEnd: number, sectionClips: SectionClip[] = []): ParseResult {
  const style = detectStyle(cues);
  const warnings: string[] = [];
  const items = cues
    .map((cue, i) => ({ ...classify(cue.name, style), time: cue.time, raw: cue.name, i }))
    .sort((a, b) => a.time - b.time || ORDER[a.kind] - ORDER[b.kind] || a.i - b.i);

  const songs: Song[] = [];
  const seen = new Map<string, number>();
  let current: (Song & { sectionStarts: Array<{ name: string; start: number }> }) | null = null;

  const close = (end: number) => {
    if (!current) return;
    const song = current;
    current = null;
    song.end = end;
    if (song.end <= song.start) {
      warnings.push(`Song "${song.name}" has no length and was skipped.`);
      return;
    }
    let starts = song.sectionStarts;
    if (starts.length === 0) {
      starts = sectionClips
        .filter((c) => c.start >= song.start && c.start < song.end)
        .sort((a, b) => a.start - b.start)
        .map((c) => ({ name: c.name.trim() || 'Section', start: c.start }));
    }
    const sections = starts.map((s, i, all): Section => ({
      name: s.name,
      start: s.start,
      end: i + 1 < all.length ? all[i + 1].start : song.end,
    })).filter((s) => s.end > s.start);
    songs.push({ id: song.id, name: song.name, key: song.key, start: song.start, end: song.end, sections });
  };

  for (const item of items) {
    switch (item.kind) {
      case 'ignore':
        break;
      case 'end':
        if (!current) warnings.push(`End marker "${item.raw.trim()}" at beat ${fmt(item.time)} is not inside a song.`);
        close(item.time);
        break;
      case 'song': {
        close(item.time);
        if (!item.label) {
          warnings.push(`Locator "*" at beat ${fmt(item.time)} has no song name and was ignored.`);
          break;
        }
        const { title, key } = splitKey(item.label);
        const n = (seen.get(songIdFor(title, 1)) ?? 0) + 1;
        seen.set(songIdFor(title, 1), n);
        if (n > 1) warnings.push(`Song name "${title}" is used ${n} times; the setlist tells them apart by order.`);
        current = { id: songIdFor(title, n), name: title, key, start: item.time, end: item.time, sections: [], sectionStarts: [] };
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
    const last: Song & { sectionStarts: Array<{ start: number }> } = current;
    const lastMark = Math.max(last.start, ...last.sectionStarts.map((s) => s.start));
    if (setEnd > lastMark) {
      close(setEnd);
    } else {
      warnings.push(`The last song "${last.name}" has no end; add a "STOP" or "--" locator where it ends.`);
      close(lastMark);
    }
  }
  return { songs, warnings, style };
}

function fmt(beats: number): string {
  return String(Math.round(beats * 100) / 100);
}
