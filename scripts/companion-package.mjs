#!/usr/bin/env node
// Builds the Companion module package, companion-module/<id>-<version>.tgz, which is kept in the
// repo (from Brant: always build it and store it in the repo). `npm run companion:package` runs
// this; so does the pre-commit hook, which then stages the file.
//
// Companion's build stamps the time into the .tgz, so two builds of the same module differ byte for
// byte. When the new build holds exactly the same files as the one already there, the old file is
// put back unchanged, so git only sees a change when the module itself changed. Packages for other
// versions are removed: the repo holds only the current one.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'companion-module');
const manifest = JSON.parse(await readFile(path.join(moduleDir, 'companion/manifest.json'), 'utf8'));
const name = `${manifest.id}-${manifest.version}.tgz`;
const file = path.join(moduleDir, name);

/** Every file in a .tgz as relative path → contents. */
async function contents(tgz) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ablecon-companion-'));
  try {
    execFileSync('tar', ['-xzf', tgz, '-C', dir]);
    const files = new Map();
    for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (!e.isFile()) continue;
      const full = path.join(e.parentPath, e.name);
      files.set(path.relative(dir, full), await readFile(full));
    }
    return files;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function same(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (!b.has(k) || !v.equals(b.get(k))) return false;
  return true;
}

const before = existsSync(file) ? await readFile(file) : null;
let oldFiles = null;
if (before) {
  const tmp = path.join(await mkdtemp(path.join(os.tmpdir(), 'ablecon-companion-')), name);
  await writeFile(tmp, before);
  oldFiles = await contents(tmp);
  await rm(path.dirname(tmp), { recursive: true, force: true });
}

execFileSync('npm', ['run', 'package', '--silent'], { cwd: moduleDir, stdio: ['ignore', 'ignore', 'inherit'] });

let status;
if (oldFiles && same(oldFiles, await contents(file))) {
  await writeFile(file, before);
  status = 'unchanged';
} else {
  status = before ? 'updated' : 'created';
}

for (const f of await readdir(moduleDir)) {
  if (f.endsWith('.tgz') && f !== name) {
    await rm(path.join(moduleDir, f));
    console.log(`removed companion-module/${f} (an older version)`);
  }
}
console.log(`companion-module/${name}: ${status}`);
