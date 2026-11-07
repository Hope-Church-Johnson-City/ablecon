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
    id: 'song a', name: 'Song A', start: 0, end: 32,
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
