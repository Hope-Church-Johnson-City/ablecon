// scripts/release.sh: the release notes come from this version's CHANGELOG entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, constants, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/release.sh');
const run = promisify(execFile);

test('npm run release runs scripts/release.sh, which can be run', async () => {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.release, 'scripts/release.sh');
  await access(script, constants.X_OK);
});

test('the release notes are the current version\'s changelog entry and how to install', async () => {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const log = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
  const entry = log.split(/^## /m).find((part) => part.startsWith(pkg.version + '\n'))!;
  const firstLine = entry.split('\n').slice(1).find((line) => line.trim())!;
  const { stdout } = await run(script, ['--notes']);
  assert.equal(stdout.split('\n')[0], firstLine, 'notes start with the entry, without blank lines first');
  assert.ok(!stdout.includes('## '), 'no other version\'s entry is included');
  assert.ok(stdout.includes(`Ablecon-${pkg.version}-arm64.dmg`) && stdout.includes(`Ablecon-${pkg.version}-x64.dmg`));
  assert.ok(!/\n\n\n/.test(stdout), 'no runs of blank lines');
});

test('release.sh refuses options it doesn\'t know', async () => {
  await assert.rejects(run(script, ['--publish-now']), (err: { code?: number }) => err.code === 2);
});
