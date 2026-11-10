// Ablecon Mac app (Electron main process).
// Runs the Ablecon server inside the app, shows the control page in a window,
// and installs the Remote Script into Ableton Live's User Library.

import { app, BrowserWindow, clipboard, dialog, Menu, powerSaveBlocker, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { constants as fsConstants, existsSync, openSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.ABLECON_PORT ?? 8420);
const DEFAULT_USER_LIBRARY = path.join(os.homedir(), 'Music', 'Ableton', 'User Library');

let server = null;
let win = null;
let updater = null; // dist/update.js
let availableUpdate = null; // a newer release, once found
let updating = false;

const setlistPath = () => path.join(app.getPath('userData'), 'ablecon-setlist.json');
const bundledScript = () =>
  app.isPackaged ? path.join(process.resourcesPath, 'remote_script', 'Ablecon') : path.join(appRoot, 'remote_script', 'Ablecon');
const installedScript = (userLibrary = DEFAULT_USER_LIBRARY) => path.join(userLibrary, 'Remote Scripts', 'Ablecon');
// The app was called "Ablcon" before; its script folder and setlist are carried over.
const legacyScript = (userLibrary = DEFAULT_USER_LIBRARY) => path.join(userLibrary, 'Remote Scripts', 'Ablcon');
const legacySetlist = () => path.join(app.getPath('appData'), 'Ablcon', 'ablcon-setlist.json');

/** First run after the rename: copy the old setlist so tempos, keys and order are kept. */
async function migrateSetlist() {
  try {
    if (!existsSync(setlistPath()) && existsSync(legacySetlist())) {
      await fs.mkdir(path.dirname(setlistPath()), { recursive: true });
      await fs.copyFile(legacySetlist(), setlistPath());
    }
  } catch (err) {
    console.error('Could not carry over the old setlist:', err);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(start);
}

async function start() {
  await migrateSetlist();
  // Keep timers and the network running when the window is hidden (App Nap
  // would otherwise slow the server down while you use Live).
  powerSaveBlocker.start('prevent-app-suspension');

  const { startServer } = await import(pathToFileURL(path.join(appRoot, 'dist', 'server.js')).href);
  updater = await import(pathToFileURL(path.join(appRoot, 'dist', 'update.js')).href);
  try {
    server = await startServer({
      port: PORT,
      setlistPath: setlistPath(),
      publicDir: path.join(appRoot, 'public'),
      log: (msg) => console.log(msg),
    });
  } catch (err) {
    const busy = err && err.code === 'EADDRINUSE';
    dialog.showErrorBox(
      'Ablecon could not start',
      busy ? `Port ${PORT} is already in use. Is Ablecon already running (perhaps from Terminal)?` : String(err && err.message ? err.message : err),
    );
    app.quit();
    return;
  }

  buildMenu();
  showWindow();
  if (!existsSync(installedScript()) && !process.env.ABLECON_NO_PROMPTS) offerScriptInstall();
  else if (existsSync(legacyScript()) && !process.env.ABLECON_NO_PROMPTS) offerScriptInstall();
  else if (!process.env.ABLECON_NO_PROMPTS) offerScriptUpdate();

  // Look for a newer release shortly after starting, then every 6 hours.
  setTimeout(() => checkForUpdates({ offer: true }), 5000);
  setInterval(() => checkForUpdates({ offer: false }), 6 * 60 * 60 * 1000);
}

function showWindow() {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 380,
    minHeight: 500,
    title: 'Ablecon',
    backgroundColor: '#1e1e1e', // the default (Ableton) look's background
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  win.loadURL(`http://127.0.0.1:${server.port}/`);
  // Links that leave the app open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => (win = null));
}

// ---- Remote Script install --------------------------------------------------

async function offerScriptInstall() {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: 'Install the Ablecon Remote Script into Ableton Live?',
    detail: 'Ablecon talks to Live through a small script that lives in your Live User Library. You can do this later from the File menu.',
    buttons: ['Install', 'Not now'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) installScript();
}

async function chooseUserLibrary() {
  if (existsSync(DEFAULT_USER_LIBRARY)) return DEFAULT_USER_LIBRARY;
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Choose your Live User Library folder',
    message: 'Live’s User Library was not in ~/Music/Ableton. Choose the folder called “User Library” (Live shows its location in Settings → Library).',
    properties: ['openDirectory'],
  });
  return canceled ? null : filePaths[0];
}

async function installScript() {
  try {
    const userLibrary = await chooseUserLibrary();
    if (!userLibrary) return;
    const target = installedScript(userLibrary);
    if (existsSync(target)) {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        message: 'Replace the installed Ablecon Remote Script?',
        detail: target,
        buttons: ['Replace', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response !== 0) return;
      await fs.rm(target, { recursive: true, force: true });
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(bundledScript(), target, {
      recursive: true,
      filter: (src) => !src.includes('__pycache__') && !src.endsWith('.pyc'),
    });
    // The script from before the rename would fight the new one for the same port.
    let removedOld = false;
    const legacy = legacyScript(userLibrary);
    if (existsSync(legacy)) {
      await shell.trashItem(legacy);
      removedOld = true;
    }
    await dialog.showMessageBox({
      type: 'info',
      message: 'Remote Script installed',
      detail:
        'Now restart Live. In Live’s Settings (Preferences in Live 11) open “Link, Tempo & MIDI”, and in an empty Control Surface slot choose “Ablecon”. Leave its Input and Output set to None.' +
        (removedOld ? '\n\nThe old “Ablcon” script was moved to the Trash; if a slot still shows it, set that slot to None.' : '') +
        '\n\nInstalled to:\n' + target,
    });
  } catch (err) {
    dialog.showErrorBox('Could not install the Remote Script', String(err && err.message ? err.message : err));
  }
}

/** After an update: offer the Remote Script this version came with, if Live has an older one. */
async function offerScriptUpdate() {
  const [installed, bundled] = await Promise.all([updater.scriptVersionAt(installedScript()), updater.scriptVersionAt(bundledScript())]);
  if (!installed || !bundled || !updater.isNewer(bundled, installed)) return;
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: `Update the Remote Script in Ableton Live to ${bundled}?`,
    detail: `This version of Ablecon comes with Remote Script ${bundled}; Live has ${installed}. After installing it, restart Live (not during a service).`,
    buttons: ['Install', 'Not now'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) installScript();
}

// ---- updates -------------------------------------------------------------------
// See src/update.ts and "Updating" in README.md. ABLECON_UPDATE_FEED points the
// app at another release feed and installs without asking; it is only for
// testing an update end to end.

const updateFeed = process.env.ABLECON_UPDATE_FEED;
const updateLog = () => path.join(app.getPath('userData'), 'update.log');

/** Each update step goes to update.log, so a failed update can be looked into afterwards. */
function logUpdate(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  fs.appendFile(updateLog(), line).catch(() => {});
  console.log(`Update: ${msg}`);
}

async function checkForUpdates({ offer, interactive = false }) {
  if (updating) return;
  try {
    const found = await updater.checkForUpdate({ current: app.getVersion(), arch: process.arch, api: updateFeed });
    availableUpdate = found;
    server.setUpdate(found);
    buildMenu();
    if (found && updateFeed) return installUpdate(found, { ask: false });
    if (found && (offer || interactive)) return offerUpdate(found);
    if (!found && interactive) {
      await dialog.showMessageBox({ type: 'info', message: 'Ablecon is up to date', detail: `You have Ablecon ${app.getVersion()}, the newest version.` });
    }
  } catch (err) {
    logUpdate(`check failed: ${err && err.message ? err.message : err}`);
    if (interactive) dialog.showErrorBox('Could not check for updates', String(err && err.message ? err.message : err));
  }
}

async function offerUpdate(info) {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: `Ablecon ${info.version} is available`,
    detail: `You have ${app.getVersion()}.\n\n${info.notes}\n\nUpdating quits and reopens Ablecon (phones and tablets reconnect by themselves). It won't install while Live is playing.`,
    buttons: ['Update Now', 'Release Notes', 'Later'],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 0) return installUpdate(info, { ask: true });
  if (response === 1) shell.openExternal(info.url);
}

/** Why this copy of Ablecon can't replace itself, or null. */
async function cannotSelfUpdate(bundle) {
  if (!app.isPackaged || !bundle) return 'Updates install only into the Ablecon app, not when running from source.';
  if (bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) {
    return 'Ablecon is running from the installer or a quarantined folder. Drag Ablecon into Applications, open it from there, and update again.';
  }
  try {
    await fs.access(path.dirname(bundle), fsConstants.W_OK);
    return null;
  } catch {
    return `Ablecon can't write to ${path.dirname(bundle)}, so it can't replace itself there.`;
  }
}

function setProgress(fraction) {
  if (win && !win.isDestroyed()) win.setProgressBar(fraction);
}

async function installUpdate(info, { ask }) {
  if (updating) return;
  const fail = async (message, detail) => {
    logUpdate(`${message}: ${detail}`);
    setProgress(-1);
    updating = false;
    const { response } = await dialog.showMessageBox({ type: 'warning', message, detail, buttons: ['Open Release Page', 'OK'], defaultId: 1, cancelId: 1 });
    if (response === 0) shell.openExternal(info.url);
  };
  const blocked = updater.blockedReason(server.controller);
  if (blocked) return fail(`Ablecon ${info.version} wasn't installed`, blocked);
  const bundle = updater.appBundleFromExe(app.getPath('exe'));
  const cannot = await cannotSelfUpdate(bundle);
  if (cannot) return fail(`Ablecon ${info.version} can't be installed automatically`, `${cannot}\n\nYou can download it from the release page instead.`);

  updating = true;
  logUpdate(`installing ${info.version} over ${app.getVersion()} at ${bundle}`);
  const work = path.join(app.getPath('userData'), 'update');
  const mount = path.join(work, 'mount');
  const staged = path.join(work, path.basename(bundle));
  const run = promisify(execFile);
  try {
    await fs.rm(work, { recursive: true, force: true });
    await fs.mkdir(mount, { recursive: true });
    setProgress(0);
    const dmg = await updater.downloadVerified(info, work, { onProgress: setProgress });
    logUpdate(`downloaded and checked ${info.dmgName}`);
    setProgress(2); // indeterminate while the app is copied out
    await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmg]);
    try {
      await run('/usr/bin/ditto', [path.join(mount, 'Ablecon.app'), staged]);
    } finally {
      await run('/usr/bin/hdiutil', ['detach', mount, '-force']).catch(() => {});
    }
    const { stdout } = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(staged, 'Contents', 'Info.plist')]);
    if (stdout.trim() !== info.version) throw new Error(`the installer holds Ablecon ${stdout.trim()}, not ${info.version}`);
    logUpdate(`copied Ablecon ${info.version} out of the installer`);
    await fs.rm(dmg, { force: true });
  } catch (err) {
    return fail(`Ablecon ${info.version} wasn't installed`, String(err && err.message ? err.message : err));
  }

  // Live may have started while it downloaded.
  const nowBlocked = updater.blockedReason(server.controller);
  if (nowBlocked) return fail(`Ablecon ${info.version} wasn't installed`, `${nowBlocked} (It's downloaded; choose Update again when Live stops.)`);
  if (ask) {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      message: `Install Ablecon ${info.version} now?`,
      detail: 'Ablecon will quit and open again in a few seconds. Phones and tablets reconnect by themselves.',
      buttons: ['Install and Reopen', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) {
      logUpdate('cancelled before installing');
      setProgress(-1);
      updating = false;
      return;
    }
  }
  const script = path.join(work, 'swap.sh');
  await fs.writeFile(script, updater.SWAP_SCRIPT, { mode: 0o755 });
  const log = openSync(updateLog(), 'a');
  const previous = path.join(app.getPath('userData'), 'previous-version');
  logUpdate('quitting so the new version can be put in place');
  spawn('/bin/sh', [script, String(process.pid), bundle, staged, previous], { detached: true, stdio: ['ignore', log, log] }).unref();
  app.quit();
}

// ---- other devices ------------------------------------------------------------

async function showAddresses() {
  const urls = server.urls;
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: 'Open Ablecon on a phone, tablet or laptop',
    detail: `Connect the device to the same network as this Mac, then open:\n\n${urls.join('\n')}`,
    buttons: ['Copy Address', 'Done'],
    defaultId: 1,
  });
  if (response === 0) clipboard.writeText(urls[0]);
}

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        availableUpdate
          ? { label: `Update to Ablecon ${availableUpdate.version}…`, click: () => offerUpdate(availableUpdate) }
          : { label: 'Check for Updates…', click: () => checkForUpdates({ offer: true, interactive: true }) },
        { label: 'Show Previous Version in Finder', click: showPreviousVersion },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'Open on Other Devices…', accelerator: 'CmdOrCtrl+D', click: showAddresses },
        { label: 'Open in Browser', click: () => shell.openExternal(`http://127.0.0.1:${server.port}/`) },
        { type: 'separator' },
        { label: 'Install Remote Script in Ableton Live…', click: installScript },
        { label: 'Show Setlist File in Finder', click: () => (existsSync(setlistPath()) ? shell.showItemInFolder(setlistPath()) : shell.openPath(app.getPath('userData'))) },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** The version before the last update, kept so it can be put back by hand. */
async function showPreviousVersion() {
  const previous = path.join(app.getPath('userData'), 'previous-version', 'Ablecon.app');
  if (existsSync(previous)) return shell.showItemInFolder(previous);
  await dialog.showMessageBox({
    type: 'info',
    message: 'No previous version kept yet',
    detail: 'After an update, the version before it is kept here so it can be put back: quit Ablecon, drag it into Applications and replace the newer one.',
  });
}

// The server keeps running with the window closed, so phones stay connected.
app.on('window-all-closed', () => {});
app.on('activate', () => server && showWindow());
app.on('before-quit', () => {
  if (server) server.close();
});
