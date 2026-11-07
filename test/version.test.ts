import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_SCRIPT_VERSION, isOlderScript } from '../src/controller.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the app expects the Remote Script version it ships with', async () => {
  const py = await readFile(path.join(root, 'remote_script/Ablecon/handlers.py'), 'utf8');
  const m = /SCRIPT_VERSION = "([\d.]+)"/.exec(py);
  assert.ok(m, 'SCRIPT_VERSION found in handlers.py');
  assert.equal(m[1], EXPECTED_SCRIPT_VERSION, 'bump EXPECTED_SCRIPT_VERSION in src/controller.ts with the script');
});

test('older Remote Scripts are recognised', () => {
  assert.equal(isOlderScript('1.4.0'), true);
  assert.equal(isOlderScript('1.3.9'), true);
  assert.equal(isOlderScript('0.9'), true);
  assert.equal(isOlderScript(EXPECTED_SCRIPT_VERSION), false);
  assert.equal(isOlderScript('1.5.0'), false);
  assert.equal(isOlderScript('2.0.0'), false);
  assert.equal(isOlderScript(null), false, 'unknown: no warning');
});
