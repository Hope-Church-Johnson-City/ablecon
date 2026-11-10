// One-click updates (src/update.ts): finding a newer release, checking the
// download, when it may install, and the script that swaps the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  appBundleFromExe, blockedReason, checkForUpdate, dmgName, downloadVerified, isNewer, parseSums,
  releaseNotes, scriptVersionAt, SWAP_SCRIPT, type UpdateInfo,
} from '../src/update.ts';

const run = promisify(execFile);
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** A fetch that answers from a table of URL → response. */
function fakeFetch(routes: Record<string, () => Response>) {
  const asked: string[] = [];
  const fn = (async (url: string | URL) => {
    asked.push(String(url));
    const route = routes[String(url)];
    return route ? route() : new Response('not found', { status: 404 });
  }) as typeof fetch;
  return Object.assign(fn, { asked });
}

const NOTES = '- Updates install from the Ablecon menu.\n\n---\n\n**Install:** download `Ablecon-1.2.0-arm64.dmg`…';

function release(over: Record<string, unknown> = {}) {
  return {
    tag_name: 'v1.2.0',
    draft: false,
    prerelease: false,
    html_url: 'https://github.com/Hope-Church-Johnson-City/ablecon/releases/tag/v1.2.0',
    body: NOTES,
    assets: ['Ablecon-1.2.0-arm64.dmg', 'Ablecon-1.2.0-x64.dmg', 'SHA256SUMS.txt'].map((name) => ({
      name,
      browser_download_url: `https://dl.example/${name}`,
    })),
    ...over,
  };
}

const API = 'https://api.example/latest';
const feed = (body: unknown, status = 200) => fakeFetch({ [API]: () => Response.json(body, { status }) });

test('versions compare as MAJOR.MINOR.PATCH, not as text', () => {
  assert.equal(isNewer('1.2.0', '1.1.0'), true);
  assert.equal(isNewer('1.10.0', '1.9.3'), true);
  assert.equal(isNewer('2.0.0', '1.99.99'), true);
  assert.equal(isNewer('1.1.0', '1.1.0'), false);
  assert.equal(isNewer('1.0.9', '1.1.0'), false);
  assert.equal(isNewer('1.2', '1.1.0'), false, 'not a full version: ignored');
  assert.equal(isNewer('1.2.0-beta', '1.1.0'), false);
});

test('each Mac gets its own installer', () => {
  assert.equal(dmgName('1.2.0', 'arm64'), 'Ablecon-1.2.0-arm64.dmg');
  assert.equal(dmgName('1.2.0', 'x64'), 'Ablecon-1.2.0-x64.dmg');
});

test('a newer release is offered with its notes, without the install steps', async () => {
  const info = await checkForUpdate({ current: '1.1.0', arch: 'arm64', api: API, fetch: feed(release()) });
  assert.deepEqual(info, {
    version: '1.2.0',
    notes: '- Updates install from the Ablecon menu.',
    url: 'https://github.com/Hope-Church-Johnson-City/ablecon/releases/tag/v1.2.0',
    dmgName: 'Ablecon-1.2.0-arm64.dmg',
    dmgUrl: 'https://dl.example/Ablecon-1.2.0-arm64.dmg',
    sumsUrl: 'https://dl.example/SHA256SUMS.txt',
  });
  const intel = await checkForUpdate({ current: '1.1.0', arch: 'x64', api: API, fetch: feed(release()) });
  assert.equal(intel?.dmgUrl, 'https://dl.example/Ablecon-1.2.0-x64.dmg');
});

test('nothing is offered for the same or an older version, drafts, pre-releases or missing files', async () => {
  const none = async (body: unknown, current = '1.1.0') => checkForUpdate({ current, arch: 'arm64', api: API, fetch: feed(body) });
  assert.equal(await none(release(), '1.2.0'), null, 'same version');
  assert.equal(await none(release(), '1.3.0'), null, 'older release');
  assert.equal(await none(release({ draft: true })), null);
  assert.equal(await none(release({ prerelease: true })), null);
  assert.equal(await none(release({ tag_name: 'nightly' })), null);
  assert.equal(await none(release({ assets: release().assets.filter((a) => a.name !== 'SHA256SUMS.txt') })), null, 'no checksums');
  assert.equal(await none(release({ assets: release().assets.filter((a) => !a.name.includes('arm64')) })), null, 'no installer for this Mac');
  assert.equal(await checkForUpdate({ current: '1.1.0', arch: 'arm64', api: API, fetch: feed({}, 404) }), null, 'no releases yet');
});

test('a failed check says so instead of claiming Ablecon is up to date', async () => {
  await assert.rejects(checkForUpdate({ current: '1.1.0', arch: 'arm64', api: API, fetch: feed({}, 403) }), /403/);
});

test('release notes stop at the install steps; checksums parse', () => {
  assert.equal(releaseNotes('- one\n- two\n\n---\n\n**Install:** …'), '- one\n- two');
  assert.equal(releaseNotes('- only notes\n'), '- only notes');
  const sums = parseSums(`${'a'.repeat(64)}  Ablecon-1.2.0-arm64.dmg\n${'B'.repeat(64)} *Ablecon-1.2.0-x64.dmg\n\njunk\n`);
  assert.equal(sums.get('Ablecon-1.2.0-arm64.dmg'), 'a'.repeat(64));
  assert.equal(sums.get('Ablecon-1.2.0-x64.dmg'), 'b'.repeat(64));
  assert.equal(sums.size, 2);
});

function infoFor(name: string): UpdateInfo {
  return { version: '1.2.0', notes: '', url: '', dmgName: name, dmgUrl: `https://dl.example/${name}`, sumsUrl: 'https://dl.example/SHA256SUMS.txt' };
}

test('the download is kept only when it matches its checksum', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ablecon-update-'));
  const name = 'Ablecon-1.2.0-arm64.dmg';
  const good = Buffer.alloc(300_000, 7);
  const sums = `${sha(good)}  ${name}\n`;
  const progress: number[] = [];
  const ok = fakeFetch({
    'https://dl.example/SHA256SUMS.txt': () => new Response(sums),
    [`https://dl.example/${name}`]: () => new Response(good, { headers: { 'content-length': String(good.length) } }),
  });
  const file = await downloadVerified(infoFor(name), dir, { fetch: ok, onProgress: (f) => progress.push(f) });
  assert.equal(file, path.join(dir, name));
  assert.deepEqual(await readFile(file), good);
  assert.equal(progress.at(-1), 1);

  const tampered = fakeFetch({
    'https://dl.example/SHA256SUMS.txt': () => new Response(sums),
    [`https://dl.example/${name}`]: () => new Response(Buffer.alloc(300_000, 8)),
  });
  await assert.rejects(downloadVerified(infoFor(name), dir, { fetch: tampered }), /doesn't match its checksum/);
  assert.equal(existsSync(file), false, 'a bad download is deleted');

  const noSum = fakeFetch({ 'https://dl.example/SHA256SUMS.txt': () => new Response(`${sha('x')}  other.dmg\n`) });
  await assert.rejects(downloadVerified(infoFor(name), dir, { fetch: noSum }), /no checksum/);
  assert.equal(noSum.asked.length, 1, 'the installer is not downloaded without a checksum to check it against');
});

test('nothing installs while Live is playing or a section jump is waiting', () => {
  assert.match(blockedReason({ position: { playing: true }, pendingJump: null })!, /Live is playing/);
  assert.match(blockedReason({ position: { playing: false }, pendingJump: { at: 64 } })!, /jump is waiting/);
  assert.equal(blockedReason({ position: { playing: false }, pendingJump: null }), null);
});

test('the app finds its own bundle', () => {
  assert.equal(appBundleFromExe('/Applications/Ablecon.app/Contents/MacOS/Ablecon'), '/Applications/Ablecon.app');
  assert.equal(appBundleFromExe('/Users/j/Apps/My Ablecon.app/Contents/MacOS/Ablecon'), '/Users/j/Apps/My Ablecon.app');
  assert.equal(appBundleFromExe('/usr/local/bin/node'), null, 'running from source');
});

test('the Remote Script version is read from handlers.py', async () => {
  assert.match((await scriptVersionAt(path.resolve('remote_script/Ablecon')))!, /^\d+\.\d+\.\d+$/);
  assert.equal(await scriptVersionAt('/nowhere'), null);
});

// ---- the swap script, run for real on folders that stand in for apps --------

async function fakeApps() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ablecon-swap-'));
  const old = path.join(dir, 'Applications', 'Ablecon.app');
  const staged = path.join(dir, 'update', 'Ablecon.app');
  await mkdir(old, { recursive: true });
  await mkdir(staged, { recursive: true });
  await writeFile(path.join(old, 'version'), '1.1.0');
  await writeFile(path.join(staged, 'version'), '1.2.0');
  // Stands in for /usr/bin/open: records what it was asked to open.
  const opener = path.join(dir, 'open.sh');
  await writeFile(opener, `#!/bin/sh\necho "$1" >> "${path.join(dir, 'opened')}"\n`);
  await chmod(opener, 0o755);
  const script = path.join(dir, 'swap.sh');
  await writeFile(script, SWAP_SCRIPT, { mode: 0o755 });
  return { dir, old, staged, opener, script, previous: path.join(dir, 'previous-version') };
}

test('the swap waits for the old app to quit, keeps it as the previous version and opens the new one', async () => {
  const f = await fakeApps();
  const app = spawn('sleep', ['0.5']); // the "running" old app
  const started = Date.now();
  const { stdout } = await run('/bin/sh', [f.script, String(app.pid), f.old, f.staged, f.previous, f.opener]);
  assert.ok(Date.now() - started >= 400, 'waited for the old app to exit');
  assert.equal(await readFile(path.join(f.old, 'version'), 'utf8'), '1.2.0', 'new version in place');
  assert.equal(await readFile(path.join(f.previous, 'Ablecon.app', 'version'), 'utf8'), '1.1.0', 'old version kept');
  assert.equal(existsSync(f.staged), false);
  assert.equal((await readFile(path.join(f.dir, 'opened'), 'utf8')).trim(), f.old);
  assert.match(stdout, /updated/);
});

test('a failed swap puts the old app back and opens it', async () => {
  const f = await fakeApps();
  const missing = path.join(f.dir, 'update', 'Gone.app');
  await assert.rejects(run('/bin/sh', [f.script, '999999', f.old, missing, f.previous, f.opener]));
  assert.equal(await readFile(path.join(f.old, 'version'), 'utf8'), '1.1.0', 'old version back in place');
  assert.deepEqual(await readdir(f.previous), [], 'nothing left in the previous-version folder');
  assert.equal((await readFile(path.join(f.dir, 'opened'), 'utf8')).trim(), f.old);
});
