import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, parseLocators } from '../src/locators.ts';

const cue = (name: string, time: number) => ({ name, time });

test('classifies locator names', () => {
  assert.deepEqual(classify('*Amazing Grace'), { kind: 'song', label: 'Amazing Grace' });
  assert.deepEqual(classify('  * Spaced Out '), { kind: 'song', label: 'Spaced Out' });
  assert.equal(classify('--').kind, 'end');
  assert.equal(classify('// talk here').kind, 'ignore');
  assert.deepEqual(classify('Chorus 2'), { kind: 'section', label: 'Chorus 2' });
  assert.equal(classify('End').kind, 'section'); // "End" is a normal section name
});

test('builds songs and sections from out-of-order locators', () => {
  const { songs, warnings } = parseLocators([
    cue('Chorus', 16), cue('*Song A', 0), cue('Verse', 0), cue('--', 32),
    cue('*Song B', 40), cue('Intro', 40), cue('Outro', 60),
  ], 80);
  assert.deepEqual(warnings, []);
  assert.equal(songs.length, 2);
  assert.deepEqual(songs[0], {
    id: 'song a', name: 'Song A', key: null, start: 0, end: 32,
    sections: [{ name: 'Verse', start: 0, end: 16 }, { name: 'Chorus', start: 16, end: 32 }],
  });
  // last song without "--" runs to the end of the arrangement
  assert.equal(songs[1].end, 80);
  assert.deepEqual(songs[1].sections.map((s) => [s.name, s.end]), [['Intro', 60], ['Outro', 80]]);
});

test('the next song start ends the previous song', () => {
  const { songs } = parseLocators([cue('*A', 0), cue('*B', 16), cue('--', 24)], 0);
  assert.deepEqual(songs.map((s) => [s.name, s.start, s.end]), [['A', 0, 16], ['B', 16, 24]]);
});

test('an end marker at the same beat as the next song closes the first one', () => {
  const { songs } = parseLocators([cue('*B', 16), cue('--', 16), cue('*A', 0), cue('--', 32)], 0);
  assert.deepEqual(songs.map((s) => [s.name, s.start, s.end]), [['A', 0, 16], ['B', 16, 32]]);
});

test('ignores comments and warns about stray locators', () => {
  const { songs, warnings } = parseLocators([
    cue('// pre-roll', 0), cue('Count in', 2), cue('*A', 4), cue('--', 8), cue('Between', 10), cue('--', 12), cue('*', 14),
  ], 20);
  assert.equal(songs.length, 1);
  assert.equal(warnings.length, 4);
  assert.match(warnings.join('\n'), /Count in/);
  assert.match(warnings.join('\n'), /Between/);
  assert.match(warnings.join('\n'), /not inside a song/);
  assert.match(warnings.join('\n'), /no song name/);
});

test('duplicate song names get distinct ids', () => {
  const { songs, warnings } = parseLocators([cue('*Reprise', 0), cue('*Other', 8), cue('*reprise', 16), cue('--', 24)], 0);
  assert.deepEqual(songs.map((s) => s.id), ['reprise', 'other', 'reprise#2']);
  assert.equal(warnings.length, 1);
});

test('warns when the last song has no end and the set length is unknown', () => {
  const { songs, warnings } = parseLocators([cue('*A', 0), cue('Verse', 0), cue('Chorus', 8)], 0);
  assert.equal(songs[0].end, 8);
  assert.match(warnings[0], /no end/);
});

test('zero-length songs are dropped with a warning', () => {
  const { songs, warnings } = parseLocators([cue('*A', 4), cue('*B', 4), cue('--', 8)], 0);
  assert.deepEqual(songs.map((s) => s.name), ['B']);
  assert.match(warnings[0], /no length/);
});

// ---- plain style, as laid out in a real worship set ------------------------------

// Locators and the start of the Sections track, copied from a real set.
const REAL_CUES = [
  cue('It Really Is Amazing Grace (G)', 0), cue('King Of Kings (C)', 540), cue('How Great Thou Art (F)', 864),
  cue('Christ Is Enough (B)', 1376), cue('STOP', 535), cue('STOP', 1368), cue('STOP', 2192),
];
const REAL_SECTION_CLIPS = [
  ['Count Off', 0], ['Intro', 8], ['Verse 1', 40], ['Verse 2', 72], ['Chorus', 104], ['Outro', 520], ['Ending', 527],
  ['Count Off', 540], ['Intro', 548], ['Verse 1', 564], ['Tag', 850], ['Outro', 856],
  ['Count Off', 864], ['Intro', 872], ['Chorus ', 952], ['Interlude', 1352],
  ['Count Off', 1376], ['Inro', 1384],
].map(([name, start]) => ({ name: name as string, start: start as number }));

test('plain style: every locator is a song, STOP ends it, keys come from the name', () => {
  const { songs, warnings, style } = parseLocators(REAL_CUES, 2224, REAL_SECTION_CLIPS);
  assert.equal(style, 'plain');
  assert.deepEqual(warnings, []);
  assert.deepEqual(songs.map((s) => [s.id, s.name, s.start, s.end]), [
    ['it really is amazing grace', 'It Really Is Amazing Grace', 0, 535],
    ['king of kings', 'King Of Kings', 540, 864],
    ['how great thou art', 'How Great Thou Art', 864, 1368],
    ['christ is enough', 'Christ Is Enough', 1376, 2192],
  ]);
  assert.deepEqual(songs.map((s) => s.key), [
    { pitch: 7, minor: false }, { pitch: 0, minor: false }, { pitch: 5, minor: false }, { pitch: 11, minor: false },
  ]);
});

test('plain style: sections come from the Sections track clips inside each song', () => {
  const { songs } = parseLocators(REAL_CUES, 2224, REAL_SECTION_CLIPS);
  assert.deepEqual(songs[0].sections.map((s) => [s.name, s.start, s.end]), [
    ['Count Off', 0, 8], ['Intro', 8, 40], ['Verse 1', 40, 72], ['Verse 2', 72, 104], ['Chorus', 104, 520],
    ['Outro', 520, 527], ['Ending', 527, 535],
  ]);
  // "King Of Kings" ends where "How Great Thou Art" starts (no STOP between them)
  assert.deepEqual(songs[1].sections.at(-1), { name: 'Outro', start: 856, end: 864 });
  assert.equal(songs[2].sections[2].name, 'Chorus', 'clip names are trimmed');
  assert.deepEqual(songs[3].sections.map((s) => s.name), ['Count Off', 'Inro']);
});

test('section locators win over Sections clips; songs without either have no sections', () => {
  const { songs } = parseLocators([cue('*A', 0), cue('Verse', 0), cue('*B', 16), cue('--', 32)], 0, [{ name: 'Clip', start: 4 }, { name: 'Clip B', start: 20 }]);
  assert.deepEqual(songs[0].sections.map((s) => s.name), ['Verse']);
  assert.deepEqual(songs[1].sections.map((s) => s.name), ['Clip B']);
  assert.deepEqual(parseLocators([cue('Solo', 0), cue('STOP', 8)], 0).songs[0].sections, []);
});

test('STOP is an end marker in both styles; End stays a section name in marked style', () => {
  assert.equal(classify('STOP').kind, 'end');
  assert.equal(classify(' stop ', 'plain').kind, 'end');
  assert.equal(classify('End', 'marked').kind, 'section');
  assert.equal(classify('Outro', 'plain').kind, 'song');
});

test('the written key is not part of the song id', () => {
  const a = parseLocators([cue('Oceans (D)', 0), cue('STOP', 8)], 0).songs[0];
  const b = parseLocators([cue('Oceans (Eb)', 0), cue('STOP', 8)], 0).songs[0];
  assert.equal(a.id, b.id);
});
