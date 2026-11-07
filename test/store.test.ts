import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as st from '../src/store.ts';
import { reconcile } from '../src/setlist.ts';
import type { Song } from '../src/types.ts';

const song = (name: string, start = 0): Song => ({ id: name.toLowerCase(), name, key: null, start, end: start + 8, stopAtEnd: true, sections: [] });
const ids = (f: { entries: Array<{ songId: string }> }) => f.entries.map((e) => e.songId);
const here = path.dirname(fileURLToPath(import.meta.url));

/** What the controller does when a Live set is read. */
function open(store: st.StoreFile, songs: Song[]) {
  const index = st.pickSet(store, songs);
  const { file } = reconcile(st.activeSetlist(store, index), songs);
  const active = st.pruneMissing(st.withSongSettings(file, store), songs);
  return { ...st.commit(store, index, active, new Date().toISOString()), active };
}

test('the old shared setlist: leftovers from other sets disappear, settings stay', async () => {
  const text = await readFile(path.join(here, 'fixtures/legacy-setlist.json'), 'utf8');
  const store = st.parseStore(text);
  assert.equal(store.sets.length, 1);
  assert.equal(store.sets[0].legacy, true);
  assert.equal(store.sets[0].songIds.length, 25);
  const sunday = [song('It Really Is Amazing Grace'), song('King Of Kings', 540), song('How Great Thou Art', 864), song('Christ Is Enough', 1376)];
  const { store: after, active, index } = open(store, sunday);
  assert.equal(index, 0, 'recognised as the same set');
  assert.deepEqual(ids(active), ['it really is amazing grace', 'king of kings', 'how great thou art', 'christ is enough']);
  assert.equal(active.entries[0].tempo, 128, "Amazing Grace's tempo kept");
  assert.equal(active.entries[1].semitones, 0, "King Of Kings' key kept");
  assert.equal(after.sets[0].legacy, undefined, 'converted on first use');
  assert.equal(after.settings.sectionsTrack, 'Sections');
});

test('each Live set keeps its own order; song settings follow the song', () => {
  let store = st.emptyStore();
  const setA = [song('A1'), song('A2', 10), song('Shared', 20), song('A3', 30)];
  const setB = [song('B1'), song('Shared', 10), song('B2', 20), song('B3', 30)];

  let r = open(store, setA);
  store = r.store;
  // Reorder set A and give the shared song a key.
  let a = { ...r.active, entries: [r.active.entries[3], r.active.entries[0], r.active.entries[1], { ...r.active.entries[2], semitones: 2 }] };
  store = st.commit(store, r.index, a).store;

  r = open(store, setB);
  store = r.store;
  assert.equal(r.index, 1, 'next week is a new setlist');
  assert.deepEqual(ids(r.active), ['b1', 'shared', 'b2', 'b3'], 'arrangement order, nothing from set A');
  assert.equal(r.active.entries[1].semitones, 2, 'the shared song keeps its key');

  r = open(store, setA);
  assert.equal(r.index, 0, 'set A recognised again');
  assert.deepEqual(ids(r.active), ['a3', 'a1', 'a2', 'shared'], "set A's order is back");
});

test('renaming or adding a song keeps the same setlist', () => {
  let store = st.emptyStore();
  let r = open(store, [song('One'), song('Two', 10), song('Three', 20), song('Four', 30)]);
  store = st.commit(store, r.index, { ...r.active, entries: [...r.active.entries].reverse() }).store;
  r = open(store, [song('One'), song('Two', 10), song('Three', 20), song('Four!', 30), song('Five', 40)]);
  assert.equal(r.index, 0);
  assert.deepEqual(ids(r.active), ['three', 'two', 'one', 'four!', 'five'], "kept order; the renamed song was dropped (no settings) and new ones added");
});

test('a missing song with a tempo or key stays listed so a rename is noticed', () => {
  let store = st.emptyStore();
  let r = open(store, [song('One'), song('Two', 10), song('Three', 20)]);
  const withKey = { ...r.active, entries: r.active.entries.map((e) => (e.songId === 'two' ? { ...e, semitones: -1 } : e)) };
  store = st.commit(store, r.index, withKey).store;
  r = open(store, [song('One'), song('Too', 10), song('Three', 20)]);
  assert.deepEqual(ids(r.active), ['one', 'two', 'three', 'too']);
});

test('the best-matching set wins, and old sets are trimmed', () => {
  let store = st.emptyStore();
  for (let w = 0; w < 70; w++) store = open(store, [song(`W${w}a`), song(`W${w}b`, 10)]).store;
  assert.equal(store.sets.length, 60);
  assert.ok(!store.sets.some((s) => s.songIds.includes('w0a')), 'the oldest weeks went');
  assert.ok(store.sets.some((s) => s.songIds.includes('w69a')));
});

test('a stored file round-trips and rejects junk', () => {
  let store = st.emptyStore();
  store = open(store, [song('One'), song('Two', 10)]).store;
  const again = st.parseStore(JSON.stringify(store));
  assert.deepEqual(again, store);
  assert.throws(() => st.parseStore('{"version":3}'), /not an Ablecon setlist/);
  const messy = st.parseStore(JSON.stringify({ version: 2, songs: { x: { tempo: 5000, semitones: 3 } }, sets: [{ songIds: ['x', 'x', 7] }], settings: { jumpBars: 3 } }));
  assert.deepEqual(messy.songs.x, { name: 'x', tempo: null, semitones: 3 });
  assert.deepEqual(messy.sets[0].songIds, ['x']);
  assert.equal(messy.settings.jumpBars, 2);
});
