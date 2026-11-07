import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as sl from '../src/setlist.ts';
import type { SetlistFile, Song } from '../src/types.ts';

const song = (id: string, start: number, end: number): Song => ({ id, name: id.toUpperCase(), start, end, sections: [] });
const songs = [song('a', 0, 32), song('b', 40, 72), song('c', 80, 96)];
const ids = (f: SetlistFile | { entries: Array<{ songId: string }> }) => f.entries.map((e) => e.songId);

test('a new setlist follows arrangement order', () => {
  const { file, changed } = sl.reconcile(sl.emptySetlist(), songs);
  assert.ok(changed);
  assert.deepEqual(ids(file), ['a', 'b', 'c']);
  assert.deepEqual(file.entries[0], { songId: 'a', name: 'A', tempo: null, semitones: null });
});

test('saved order wins; new songs go to the end; missing songs are kept', () => {
  const saved: SetlistFile = { ...sl.emptySetlist(), entries: [
    { songId: 'c', name: 'C', tempo: 90, semitones: 2 },
    { songId: 'gone', name: 'Gone', tempo: null, semitones: -1 },
    { songId: 'a', name: 'old name', tempo: null, semitones: null },
  ] };
  const { file, changed } = sl.reconcile(saved, songs);
  assert.ok(changed);
  assert.deepEqual(ids(file), ['c', 'gone', 'a', 'b']);
  assert.equal(file.entries[2].name, 'A'); // name refreshed from Live
  assert.equal(file.entries[0].tempo, 90);
  const { rows } = sl.setlistRows(file, songs, 120);
  assert.deepEqual(rows.map((r) => r.missing), [false, true, false, false]);
});

test('reconcile reports no change when nothing changed', () => {
  const first = sl.reconcile(sl.emptySetlist(), songs).file;
  assert.equal(sl.reconcile(first, songs).changed, false);
});

test('move and reorder', () => {
  const file = sl.reconcile(sl.emptySetlist(), songs).file;
  assert.deepEqual(ids(sl.moveEntry(file, 0, 2)), ['b', 'c', 'a']);
  assert.deepEqual(ids(sl.moveEntry(file, 2, 0)), ['c', 'a', 'b']);
  assert.deepEqual(ids(file), ['a', 'b', 'c'], 'original is not mutated');
  assert.throws(() => sl.moveEntry(file, 0, 3));
  assert.deepEqual(ids(sl.reorder(file, ['b', 'a', 'c'])), ['b', 'a', 'c']);
  assert.throws(() => sl.reorder(file, ['a', 'b']));
  assert.throws(() => sl.reorder(file, ['a', 'a', 'b']));
});

test('tempo and key validation', () => {
  const file = sl.reconcile(sl.emptySetlist(), songs).file;
  assert.equal(sl.setTempo(file, 'a', '72.5').entries[0].tempo, 72.5);
  assert.equal(sl.setTempo(file, 'a', '').entries[0].tempo, null);
  assert.throws(() => sl.setTempo(file, 'a', 5));
  assert.equal(sl.setSemitones(file, 'b', -12).entries[1].semitones, -12);
  assert.equal(sl.setSemitones(file, 'b', null).entries[1].semitones, null);
  assert.throws(() => sl.setSemitones(file, 'b', 13));
  assert.throws(() => sl.setSemitones(file, 'b', 1.5));
  assert.throws(() => sl.setSemitones(file, 'nope', 1));
});

test('settings validation', () => {
  const file = sl.emptySetlist();
  assert.equal(sl.setSettings(file, { endOfSong: 'next' }).settings.endOfSong, 'next');
  assert.throws(() => sl.setSettings(file, { endOfSong: 'explode' as never }));
  assert.throws(() => sl.setSettings(file, { noKeyTag: '  ' }));
});

test('durations use each song\'s tempo, else Live\'s', () => {
  let file = sl.reconcile(sl.emptySetlist(), songs).file;
  file = sl.setTempo(file, 'a', 60); // 32 beats at 60 = 32 s
  const { rows, totalSeconds } = sl.setlistRows(file, songs, 120); // b: 32 beats = 16 s, c: 16 beats = 8 s
  assert.deepEqual(rows.map((r) => r.seconds), [32, 16, 8]);
  assert.equal(totalSeconds, 56);
});

test('save and load round-trip; bad values in the file are dropped', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ablcon-'));
  const file = path.join(dir, 'setlist.json');
  assert.deepEqual(await sl.loadSetlist(file), sl.emptySetlist(), 'missing file = empty setlist');
  let data = sl.reconcile(sl.emptySetlist(), songs).file;
  data = sl.setSemitones(sl.moveEntry(data, 2, 0), 'c', 3);
  await sl.saveSetlist(file, data);
  assert.deepEqual(await sl.loadSetlist(file), data);
  assert.ok((await readFile(file, 'utf8')).endsWith('\n'));

  await writeFile(file, JSON.stringify({ entries: [{ songId: 'x', tempo: 'fast', semitones: 40 }, { nope: 1 }], settings: { endOfSong: 'bad' } }));
  const loaded = await sl.loadSetlist(file);
  assert.deepEqual(loaded.entries, [{ songId: 'x', name: 'x', tempo: null, semitones: null }]);
  assert.equal(loaded.settings.endOfSong, 'stop');

  await writeFile(file, '{not json');
  await assert.rejects(sl.loadSetlist(file), /could not read setlist/);
});
