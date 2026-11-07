// Checks the real control page, feature by feature, in a hidden window
// against the fake Live (laid out like a worship multitrack set).
//
//   npm run test:ui        (builds first; part of `npm run check`)
//
// Every feature that has been added gets a check here, so a later change
// that breaks it is caught before it's committed. Exits 1 on any failure.

import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const consoleErrors = [];
let fake = null;
let server = null;

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${ok || !detail ? '' : `\n    ${detail}`}`);
}

async function freeUdpPort() {
  const s = dgram.createSocket('udp4');
  await new Promise((r) => s.bind(0, '127.0.0.1', r));
  const { port } = s.address();
  s.close();
  return port;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const livePort = await freeUdpPort();
  fake = spawn('python3', [path.join(root, 'remote_script/fake_live/fake_live_server.py'), '--port', String(livePort)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    fake.stdout.once('data', resolve);
    fake.once('error', reject);
  });

  const { startServer } = await import(pathToFileURL(path.join(root, 'dist/server.js')).href);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ablecon-ui-'));
  server = await startServer({ port: 0, host: '127.0.0.1', livePort, setlistPath: path.join(dir, 'setlist.json'), publicDir: path.join(root, 'public'), log: () => {} });
  server.controller.scanSettleMs = 40;

  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (event) => {
    const level = event.level ?? event.params?.level;
    const message = event.message ?? event.params?.message ?? '';
    if (level === 'error' || level === 3) consoleErrors.push(message);
  });
  await win.loadURL(`http://127.0.0.1:${server.port}/`);
  // Start as a device that has never been used: no saved look or panel settings.
  await win.webContents.executeJavaScript('localStorage.clear()');
  await win.loadURL(`http://127.0.0.1:${server.port}/`);

  // Runs `body` in the page (it can use the page's own state, position and send).
  const page = (body) => win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out: ' + fn.toString()); await wait(25); } };
    // Tap like a person: the element gets focus, then the click (a plain
    // .click() from a script doesn't focus, which hid a real bug once).
    const tap = (el) => { if (!el) throw new Error('nothing to tap'); el.focus(); el.click(); };
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => [...document.querySelectorAll(s)];
    const rows = () => $$('#setlist .song');
    const rowTags = (i) => [...rows()[i].querySelectorAll('.tag')].map((t) => t.textContent);
    const chip = (name, group) => $$(group ? '.tgroup' : '#tracks > .chips .chip').map((g) => group ? (g.querySelector('.gname').textContent === group ? g : null) : g).filter(Boolean)
      .flatMap((g) => group ? [...g.querySelectorAll('.chip')] : [g]).find((c) => c.querySelector('.cname').textContent === name);
    ${body}
  })()`);

  const check = async (name, body) => {
    try {
      const detail = await page(body);
      record(name, detail === true, typeof detail === 'string' ? detail : JSON.stringify(detail));
    } catch (err) {
      record(name, false, String(err.message || err).split('\n')[0]);
    }
  };

  // ---- connection and setlist --------------------------------------------------
  await check('connects to Live and shows it', `
    await until(() => typeof state !== 'undefined' && state && state.connected && state.rows.length === 3);
    return $('#link').classList.contains('on') && $('#linkText').textContent === 'Live fake' || $('#linkText').textContent;`);

  await check('songs come from plain locators with STOP markers', `
    const names = rows().map((r) => r.querySelector('.name').textContent);
    return JSON.stringify(names) === JSON.stringify(['Morning Light', 'River Wide', 'Still Waters']) || names.join(', ');`);

  await check('each song shows its key from the locator name', `
    const keys = [0, 1, 2].map((i) => rowTags(i)[0]);
    return JSON.stringify(keys) === JSON.stringify(['G', 'Bb', 'Em']) || keys.join(', ');`);

  await check('each song shows its tempo, read at its marker without playing', `
    await until(() => state.rows.every((r) => r.seenTempo != null));
    await wait(100);
    const tempos = [0, 1, 2].map((i) => rowTags(i)[1]);
    const ok = JSON.stringify(tempos) === JSON.stringify(['72 BPM', '128 BPM', '68 BPM']);
    return ok && !position.playing && position.beats === 0 || JSON.stringify({ tempos, playing: position.playing, beats: position.beats });`);

  // 135 beats at 72 + 123 at 128 + 132 at 68 = 286.7 s
  await check('the set length uses each song’s tempo', `
    return $('#setLength').textContent === '4:47' || $('#setLength').textContent;`);

  await check('sections come from the Sections track', `
    const names = $$('#sections button').map((b) => b.textContent);
    return JSON.stringify(names) === JSON.stringify(['Count Off', 'Intro', 'Verse 1', 'Chorus', 'Bridge', 'Outro']) || names.join(', ');`);

  await check('Up next says a STOP comes after the song', `
    return /Up next: River Wide · after the STOP/.test($('#upNext').textContent) || $('#upNext').textContent;`);

  // ---- cueing, tempo and key ---------------------------------------------------------
  await check('tapping a song cues it (playhead, title)', `
    tap(rows()[1].querySelector('.main'));
    await until(() => position.beats === 140 && $('#nowTitle').textContent === 'River Wide');
    return true;`);

  await check('Up next says when a song plays straight into the next', `
    await until(() => /Still Waters · plays straight on/.test($('#upNext').textContent));
    return true;`);

  await check('key change shows the new key (Bb → B) and can be turned off', `
    tap($('#editBtn'));
    await wait(50);
    tap(rows()[1].querySelector('[aria-label="Key up"]'));
    await until(() => rowTags(1)[0] === 'Bb → B');
    tap(rows()[1].querySelector('button[title="Stop managing the key of this song"]'));
    await until(() => rowTags(1)[0] === 'Bb');
    return true;`);

  await check('a tempo set in Ablecon is highlighted, and clearing it goes back to the marker tempo', `
    const input = rows()[1].querySelector('input[type=number]');
    input.value = '90'; input.dispatchEvent(new Event('change'));
    await until(() => rows()[1].querySelector('.tag.tempo.set')?.textContent === '90 BPM');
    rows()[1].querySelector('input[type=number]').value = '';
    rows()[1].querySelector('input[type=number]').dispatchEvent(new Event('change'));
    await until(() => !rows()[1].querySelector('.tag.tempo.set') && rowTags(1)[1] === '128 BPM');
    tap($('#editBtn'));
    return true;`);

  await check('Play starts at the cued song, not at the top of the set', `
    tap($('#playBtn'));
    await until(() => position.playing);
    await wait(150);
    const ok = position.beats >= 140 && position.beats < 150;
    tap($('#stopBtn'));
    await until(() => !position.playing);
    return ok || 'playhead at ' + position.beats;`);

  // ---- next section ---------------------------------------------------------------
  await check('Next section waits for a bar line, counts down, and can be cancelled', `
    send('start', { songId: 'river wide', section: 1 });
    await until(() => position.playing && position.beats >= 148);
    tap($('#nextSectionBtn'));
    await until(() => state.pendingJump && /→ Verse in \\d+ beats/.test($('#nextSectionBtn').textContent));
    const target = $('#sections button.target')?.textContent;
    tap($('#nextSectionBtn'));
    await until(() => !state.pendingJump);
    tap($('#stopBtn'));
    await until(() => !position.playing);
    return target === 'Verse' || 'target was ' + target;`);

  // ---- tracks -----------------------------------------------------------------
  await check('tracks: click and guide on top, Sections hidden, current song’s group open', `
    tap(rows()[1].querySelector('.main'));
    await until(() => $('.tgroup.current .gname')?.textContent === 'Rivr Wide' && $('.tgroup.current .tgroup-body'));
    const top = $$('#tracks > .chips .cname').map((c) => c.textContent);
    const others = $$('.tgroup:not(.current)').every((g) => !g.querySelector('.tgroup-body'));
    return JSON.stringify(top) === JSON.stringify(['Click Foundations', 'Guide']) && others || JSON.stringify({ top, others });`);

  await check('M mutes and unmutes a track', `
    tap(chip('Drums', 'Rivr Wide').querySelector('.ms .m'));
    await until(() => chip('Drums', 'Rivr Wide').classList.contains('muted') && $('.tgroup.current .gsum').textContent.includes('1 muted'));
    tap(chip('Drums', 'Rivr Wide').querySelector('.ms .m'));
    await until(() => !chip('Drums', 'Rivr Wide').classList.contains('muted'));
    return true;`);

  await check('S solos a track, others fade, Clear solos clears', `
    tap(chip('AG', 'Rivr Wide').querySelector('.ms .s'));
    await until(() => chip('AG', 'Rivr Wide').classList.contains('soloed') && chip('Bass', 'Rivr Wide').classList.contains('solo-silent'));
    const shown = !$('#clearSolosBtn').classList.contains('hidden');
    tap($('#clearSolosBtn'));
    await until(() => !state.tracks.some((t) => t.soloed) && $('#clearSolosBtn').classList.contains('hidden'));
    return shown || 'Clear solos was not shown';`);

  // ---- looks and warnings ---------------------------------------------------------
  await check('the Ableton look is the default on a new device', `
    const bg = getComputedStyle(document.body).backgroundColor;
    return document.documentElement.dataset.look === 'live' && $('#look').value === 'live' && bg === 'rgb(30, 30, 30)' || JSON.stringify({ look: document.documentElement.dataset.look, select: $('#look').value, bg });`);

  await check('looks can be switched, including the original Stage, and back', `
    const sel = $('#look');
    sel.value = 'blackout'; sel.dispatchEvent(new Event('change'));
    const blackout = document.documentElement.dataset.look === 'blackout' && getComputedStyle(document.body).backgroundColor === 'rgb(0, 0, 0)';
    sel.value = 'stage'; sel.dispatchEvent(new Event('change'));
    const stage = !document.documentElement.dataset.look && getComputedStyle(document.body).backgroundColor === 'rgb(16, 20, 24)';
    sel.value = 'live'; sel.dispatchEvent(new Event('change'));
    const back = document.documentElement.dataset.look === 'live' && localStorage.getItem('ablecon.look') === 'live';
    return blackout && stage && back || JSON.stringify({ blackout, stage, back });`);

  await check('no outdated-Remote-Script warning with the current script', `
    return $('#scriptWarn').classList.contains('hidden') || $('#scriptWarn').textContent;`);

  // ---- phone width -----------------------------------------------------------------
  win.setContentSize(375, 812);
  await sleep(300);
  await check('fits a phone screen (no sideways scrolling)', `
    await wait(100);
    const over = document.documentElement.scrollWidth - window.innerWidth;
    return over <= 1 || 'page is ' + over + 'px too wide';`);

  record('no errors in the page', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
}

async function finish(code) {
  try {
    if (server) await server.close();
  } catch { /* closing anyway */ }
  if (fake) fake.kill();
  app.exit(code);
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (err) {
    record('UI check could not run', false, String(err && err.stack || err));
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  await finish(failed ? 1 : 0);
});
app.on('window-all-closed', () => {});
