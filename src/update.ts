// One-click updates for the Mac app (app/main.js uses this from dist/update.js).
//
// The app asks GitHub for the church repo's latest release. If it's newer, the
// app offers it; on "Update Now" it downloads this Mac's installer, checks it
// against the release's SHA256SUMS.txt, copies the new Ablecon.app out of it,
// and quits. A small shell script then waits for the old app to exit, moves it
// aside (kept as the previous version), moves the new one into its place and
// opens it. Nothing is installed while Live is playing or a jump is waiting.
// See "Updating" in README.md.

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { SEMVER } from './version.ts';

export const RELEASES_API = 'https://api.github.com/repos/Hope-Church-Johnson-City/ablecon/releases/latest';
export const SUMS_NAME = 'SHA256SUMS.txt';

export interface UpdateInfo {
  version: string; // e.g. "1.2.0"
  notes: string; // the release notes (the CHANGELOG entry, without the install steps)
  url: string; // the release page
  dmgName: string; // this Mac's installer
  dmgUrl: string;
  sumsUrl: string;
}

type Fetch = typeof globalThis.fetch;

const parts = (v: string) => v.split('.').map(Number);

/** True when `candidate` is a later MAJOR.MINOR.PATCH than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  if (!SEMVER.test(candidate) || !SEMVER.test(current)) return false;
  const [a, b] = [parts(candidate), parts(current)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The installer for this Mac: "arm64" (Apple Silicon) or "x64" (Intel). */
export function dmgName(version: string, arch: string): string {
  return `Ablecon-${version}-${arch === 'arm64' ? 'arm64' : 'x64'}.dmg`;
}

/** SHA256SUMS.txt ("<hex>  <file>" per line) as file name → lower-case hex. */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m) sums.set(m[2], m[1].toLowerCase());
  }
  return sums;
}

/** The release notes people should read: everything before the install steps. */
export function releaseNotes(body: string): string {
  return body.split(/\n-{3,}\s*\n/)[0].trim();
}

interface ReleaseJson {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  body?: string | null;
  html_url?: string;
  assets?: Array<{ name: string; browser_download_url: string }>;
}

/**
 * The latest release if it's newer than `current` and has this Mac's installer
 * and the checksums; otherwise null. Throws when GitHub can't be reached.
 */
export async function checkForUpdate(opts: { current: string; arch: string; fetch?: Fetch; api?: string }): Promise<UpdateInfo | null> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const res = await fetchFn(opts.api ?? RELEASES_API, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': `Ablecon/${opts.current}` },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) return null; // no releases yet
  if (!res.ok) throw new Error(`GitHub answered ${res.status} when asked for the latest release`);
  const rel = (await res.json()) as ReleaseJson;
  if (rel.draft || rel.prerelease) return null;
  const version = String(rel.tag_name ?? '').replace(/^v/, '');
  if (!isNewer(version, opts.current)) return null;
  const name = dmgName(version, opts.arch);
  const dmg = rel.assets?.find((a) => a.name === name);
  const sums = rel.assets?.find((a) => a.name === SUMS_NAME);
  if (!dmg || !sums) return null;
  return {
    version,
    notes: releaseNotes(rel.body ?? ''),
    url: rel.html_url ?? '',
    dmgName: name,
    dmgUrl: dmg.browser_download_url,
    sumsUrl: sums.browser_download_url,
  };
}

/**
 * Downloads the installer into `dir` and checks it against SHA256SUMS.txt.
 * Resolves with its path; throws (and deletes it) if anything doesn't match.
 */
export async function downloadVerified(
  info: UpdateInfo,
  dir: string,
  opts: { fetch?: Fetch; onProgress?: (fraction: number) => void } = {},
): Promise<string> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const sumsRes = await fetchFn(info.sumsUrl, { signal: AbortSignal.timeout(30000) });
  if (!sumsRes.ok) throw new Error(`couldn't download ${SUMS_NAME} (${sumsRes.status})`);
  const expected = parseSums(await sumsRes.text()).get(info.dmgName);
  if (!expected) throw new Error(`${SUMS_NAME} has no checksum for ${info.dmgName}`);

  await mkdir(dir, { recursive: true });
  const file = path.join(dir, info.dmgName);
  const res = await fetchFn(info.dmgUrl, { signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!res.ok || !res.body) throw new Error(`couldn't download ${info.dmgName} (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = createHash('sha256');
  const out = createWriteStream(file);
  let got = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
      if (total && opts.onProgress) opts.onProgress(Math.min(1, got / total));
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    await rm(file, { force: true });
    throw err;
  }
  const actual = hash.digest('hex');
  if (actual !== expected) {
    await rm(file, { force: true });
    throw new Error(`${info.dmgName} doesn't match its checksum, so it wasn't installed`);
  }
  return file;
}

/** Why an update can't be installed right now, or null when it can. */
export function blockedReason(c: { position: { playing: boolean }; pendingJump: unknown }): string | null {
  if (c.position.playing) return 'Live is playing. Stop Live first, then update.';
  if (c.pendingJump) return 'A section jump is waiting. Cancel it or let it happen, then update.';
  return null;
}

/** "/Applications/Ablecon.app/Contents/MacOS/Ablecon" → "/Applications/Ablecon.app". */
export function appBundleFromExe(exe: string): string | null {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(exe);
  return m ? m[1] : null;
}

/** SCRIPT_VERSION from a Remote Script's handlers.py, or null. */
export async function scriptVersionAt(scriptDir: string): Promise<string | null> {
  try {
    const py = await readFile(path.join(scriptDir, 'handlers.py'), 'utf8');
    return /SCRIPT_VERSION = "([^"]+)"/.exec(py)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The script that swaps the app once it has quit. Arguments:
 *   <pid of the old app> <old .app> <new .app> <folder for the previous version> [open command]
 * If either move fails, the old app is put back and opened again.
 */
export const SWAP_SCRIPT = `#!/bin/sh
pid="$1"; old="$2"; new="$3"; backup="$4"; open="\${5:-/usr/bin/open}"
echo "$(date '+%Y-%m-%d %H:%M:%S') installing $new over $old"
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 600 ]; then echo "Ablecon didn't quit within a minute; update not installed"; exit 1; fi
  sleep 0.1
done
mkdir -p "$backup"
prev="$backup/$(basename "$old")"
rm -rf "$prev"
if ! mv "$old" "$prev"; then
  echo "couldn't move the old app aside; update not installed"
  "$open" "$old"; exit 1
fi
if ! mv "$new" "$old"; then
  echo "couldn't move the new app into place; putting the old one back"
  mv "$prev" "$old"; "$open" "$old"; exit 1
fi
xattr -dr com.apple.quarantine "$old" 2>/dev/null
"$open" "$old"
echo "updated; the previous version is in $prev"
`;
