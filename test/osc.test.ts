import { test } from 'node:test';
import assert from 'node:assert/strict';
import { argValues, decodeMessage, encodeMessage, float, int, str } from '../src/osc.ts';

test('encodes known bytes (matches the OSC 1.0 spec and the Python side)', () => {
  assert.deepEqual(encodeMessage('/x', [int(1)]), Buffer.from('/x\0\0,i\0\0\0\0\0\x01', 'latin1'));
  // a 4-byte string needs a full extra word of padding for its terminator
  assert.equal(encodeMessage('/ab', [str('abcd')]).length, 4 + 4 + 8);
  assert.equal(encodeMessage('/abc', []).length, 8 + 4);
});

test('round-trips every supported type', () => {
  const buf = encodeMessage('/ablcon/req', [int(-5), float(0.5), { type: 'd', value: 1.25 }, str('héllo ✓'), { type: 'T' }, { type: 'F' }, str('')]);
  assert.equal(buf.length % 4, 0);
  const msg = decodeMessage(buf);
  assert.equal(msg.address, '/ablcon/req');
  assert.deepEqual(argValues(msg), [-5, 0.5, 1.25, 'héllo ✓', true, false, '']);
});

test('float32 precision is enough for beat positions', () => {
  const [beats] = argValues(decodeMessage(encodeMessage('/p', [float(1234.5678)]))) as number[];
  assert.ok(Math.abs(beats - 1234.5678) < 1e-3);
});

test('rejects malformed input', () => {
  assert.throws(() => decodeMessage(Buffer.from('/x\0\0,i\0\0\0\0', 'latin1')), /truncated/);
  assert.throws(() => decodeMessage(Buffer.from('nope\0\0\0\0')), /not an OSC message/);
  assert.throws(() => decodeMessage(Buffer.from('/x\0\0,q\0\0', 'latin1')), /unsupported/);
  assert.throws(() => encodeMessage('x'), /must start/);
  assert.throws(() => encodeMessage('/x', [int(1.5)]), /int32/);
});

test('message with no type tags decodes with no args', () => {
  assert.deepEqual(decodeMessage(Buffer.from('/ping\0\0\0')), { address: '/ping', args: [] });
});
