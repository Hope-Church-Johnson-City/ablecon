// Ablcon Mac app (Electron main process).
// Runs the Ablcon server inside the app, shows the control page in a window,
// and installs the Remote Script into Ableton Live's User Library.

import { app, BrowserWindow, clipboard, dialog, Menu, powerSaveBlocker, shell } from 'electron';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.ABLCON_PORT ?? 8420);
const DEFAULT_USER_LIBRARY = path.join(os.homedir(), 'Music', 'Ableton', 'User Library');

let server = null;
let win = null;

const setlistPath = () => path.join(app.getPath('userData'), 'ablcon-setlist.json');
const bundledScript = () =>
  app.isPackaged ? path.join(process.resourcesPath, 'remote_script', 'Ablcon') : path.join(appRoot, 'remote_script', 'Ablcon');
const installedScript = (userLibrary = DEFAULT_USER_LIBRARY) => path.join(userLibrary, 'Remote Scripts', 'Ablcon');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(start);
}

async function start() {
  // Keep timers and the network running when the window is hidden (App Nap
  // would otherwise slow the server down while you use Live).
  powerSaveBlocker.start('prevent-app-suspension');

  const { startServer } = await import(pathToFileURL(path.join(appRoot, 'dist', 'server.js')).href);
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
      'Ablcon could not start',
      busy ? `Port ${PORT} is already in use. Is Ablcon already running (perhaps from Terminal)?` : String(err && err.message ? err.message : err),
    );
    app.quit();
    return;
  }

  buildMenu();
  showWindow();
  if (!existsSync(installedScript()) && !process.env.ABLCON_NO_PROMPTS) offerScriptInstall();
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
    title: 'Ablcon',
    backgroundColor: '#101418',
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
    message: 'Install the Ablcon Remote Script into Ableton Live?',
    detail: 'Ablcon talks to Live through a small script that lives in your Live User Library. You can do this later from the File menu.',
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
        message: 'Replace the installed Ablcon Remote Script?',
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
    await dialog.showMessageBox({
      type: 'info',
      message: 'Remote Script installed',
      detail:
        'Now restart Live. In Live’s Settings (Preferences in Live 11) open “Link, Tempo & MIDI”, and in an empty Control Surface slot choose “Ablcon”. Leave its Input and Output set to None.\n\nInstalled to:\n' + target,
    });
  } catch (err) {
    dialog.showErrorBox('Could not install the Remote Script', String(err && err.message ? err.message : err));
  }
}

// ---- other devices ------------------------------------------------------------

async function showAddresses() {
  const urls = server.urls;
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: 'Open Ablcon on a phone, tablet or laptop',
    detail: `Connect the device to the same network as this Mac, then open:\n\n${urls.join('\n')}`,
    buttons: ['Copy Address', 'Done'],
    defaultId: 1,
  });
  if (response === 0) clipboard.writeText(urls[0]);
}

function buildMenu() {
  const template = [
    { role: 'appMenu' },
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

// The server keeps running with the window closed, so phones stay connected.
app.on('window-all-closed', () => {});
app.on('activate', () => server && showWindow());
app.on('before-quit', () => {
  if (server) server.close();
});
