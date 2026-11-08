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

// ---- semantic versioning (see "Versions" in CLAUDE.md) ---------------------------------

const json = async (rel: string) => JSON.parse(await readFile(path.join(root, rel), 'utf8'));

test('Ablecon has a semantic version, and the page is told it', async () => {
  const { APP_VERSION, SEMVER } = await import('../src/version.ts');
  const pkg = await json('package.json');
  assert.match(pkg.version, SEMVER, 'package.json "version" is MAJOR.MINOR.PATCH');
  assert.equal(APP_VERSION, pkg.version);
  const lock = await json('package-lock.json');
  assert.equal(lock.version, pkg.version, 'package-lock.json version matches (npm version <x.y.z> --no-git-tag-version)');
  assert.equal(lock.packages[''].version, pkg.version);
});

test('the changelog starts with the current version', async () => {
  const pkg = await json('package.json');
  const log = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
  const first = /^## (\S+)/m.exec(log);
  assert.ok(first, 'CHANGELOG.md has a "## x.y.z" entry');
  assert.equal(first[1], pkg.version, 'add a CHANGELOG.md entry for the new version at the top');
  const listed = [...log.matchAll(/^## (\S+)/gm)].map((m) => m[1].split('.').map(Number));
  for (let i = 1; i < listed.length; i++) {
    const [a, b] = [listed[i - 1], listed[i]];
    const newer = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    assert.ok(newer > 0, `changelog entries go newest first (${a.join('.')} before ${b.join('.')})`);
  }
});

test('the Remote Script and the Stream Deck module have semantic versions too', async () => {
  const { SEMVER } = await import('../src/version.ts');
  const py = await readFile(path.join(root, 'remote_script/Ablecon/handlers.py'), 'utf8');
  assert.match(/SCRIPT_VERSION = "([^"]+)"/.exec(py)![1], SEMVER);
  const mod = await json('companion-module/package.json');
  const manifest = await json('companion-module/companion/manifest.json');
  assert.match(mod.version, SEMVER);
  assert.equal(manifest.version, mod.version, 'companion manifest.json and package.json versions match');
});
