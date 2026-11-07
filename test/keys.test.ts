import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyName, splitKey, transposeKey } from '../src/keys.ts';

test('reads a key written at the end of a song name', () => {
  assert.deepEqual(splitKey('How Great Thou Art (F)'), { title: 'How Great Thou Art', key: { pitch: 5, minor: false } });
  assert.deepEqual(splitKey('Oceans (Bm)').key, { pitch: 11, minor: true });
  assert.deepEqual(splitKey('Song (F#)').key, { pitch: 6, minor: false });
  assert.deepEqual(splitKey('Song (Bb)').key, { pitch: 10, minor: false });
  assert.deepEqual(splitKey('Song ( c# minor )').key, { pitch: 1, minor: true });
});

test('leaves names without a key alone', () => {
  assert.deepEqual(splitKey('Build My Life (Live)'), { title: 'Build My Life (Live)', key: null });
  assert.deepEqual(splitKey('Plain'), { title: 'Plain', key: null });
  assert.deepEqual(splitKey('(G)'), { title: '(G)', key: null });
});

test('transposes and spells keys the usual way', () => {
  const g = splitKey('x (G)').key!;
  assert.equal(keyName(transposeKey(g, 2)), 'A');
  assert.equal(keyName(transposeKey(g, -2)), 'F');
  assert.equal(keyName(transposeKey(g, 3)), 'Bb');
  assert.equal(keyName(transposeKey(g, -1)), 'F#');
  assert.equal(keyName(transposeKey(splitKey('x (B)').key!, 2)), 'Db');
  assert.equal(keyName(transposeKey(splitKey('x (Em)').key!, 4)), 'G#m');
  assert.equal(keyName(transposeKey(g, 12)), 'G');
});
