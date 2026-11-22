// The Mac app's window (app/main.js): no separate title bar. The traffic lights sit in the page's own
// top bar, which the page lays out for them when loaded with ?app=mac (checked in scripts/ui-check.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the app window hides its title bar and tells the page it is the Mac app', async () => {
  const main = await readFile(path.join(root, 'app/main.js'), 'utf8');
  assert.match(main, /titleBarStyle: 'hiddenInset'/);
  assert.match(main, /trafficLightPosition: \{ x: \d+, y: \d+ \}/);
  assert.match(main, /win\.loadURL\(`http:\/\/127\.0\.0\.1:\$\{server\.port\}\/\?app=mac`\)/, 'the window loads the page as the Mac app');
  assert.match(main, /enter-full-screen/, 'in full screen the room for the traffic lights is given back');
  assert.match(main, /shell\.openExternal\(`http:\/\/127\.0\.0\.1:\$\{server\.port\}\/`\)/, '"Open in Browser" stays a normal page');
  const html = await readFile(path.join(root, 'public/index.html'), 'utf8');
  assert.match(html, /get\('app'\) === 'mac'/, 'the page switches its top bar before it draws');
});
