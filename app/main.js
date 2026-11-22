// GreenFrame: Xbox Remote Play in its own window, with every video frame handed to SmoovPlay for frame generation.
//
//   Xbox ─WebRTC─▶ this window (xbox.com/play) ─frames─▶ GreenFrame bridge ─shared memory─▶ SmoovPlay
//
// On launch it starts the bridge (bridge/greenframe_bridge.py) and SmoovPlay (`run.py --source tap --display`),
// both with SmoovPlay's own bundled Python, and stops them on exit.
'use strict';
const { app, BrowserWindow, Menu, shell, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const bridgeLink = require('./bridge-link');

// Keep the stream, sound and controller running while SmoovPlay's window covers this one.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const PLAY_URL = process.env.GREENFRAME_URL || 'https://www.xbox.com/play'; // override: testing
const PARTITION = 'persist:greenframe';
const SIGN_IN_HOSTS = /(^|\.)(xbox\.com|live\.com|microsoft\.com|microsoftonline\.com|msauth\.net|msftauth\.net|xboxlive\.com|live\.net)$/i;

const userData = app.getPath('userData');
const logDir = path.join(userData, 'logs');
const configPath = path.join(userData, 'config.json');
const DEFAULT_CONFIG = {
  smoovplayDir: '',               // blank: found automatically (SmoovPlay's Apps & features entry, else the default folder)
  startSmoovPlay: true,          // start SmoovPlay with GreenFrame
  smoovplayArgs: ['--display'],  // added to run.py --source tap
  minimiseWhilePlaying: true,    // minimise GreenFrame while SmoovPlay shows the picture
  port: 47820,
};

function loadConfig() {
  try {
    return Object.assign({}, DEFAULT_CONFIG, JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } catch (e) {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return Object.assign({}, DEFAULT_CONFIG);
  }
}
const config = loadConfig();
function saveConfig() {
  try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch (e) { /* best-effort */ }
}
// Where SmoovPlay is: the folder set in config.json if it holds SmoovPlay, else the one SmoovPlay's setup recorded
// for Apps & features (any folder since SmoovPlay 0.3.10), else the default install folder.
const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SmoovPlay';
function regValue(name) {
  if (process.platform !== 'win32') return '';
  try {
    const out = require('child_process').execFileSync('reg', ['query', UNINSTALL_KEY, '/v', name],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`));
    return m ? m[1].trim() : '';
  } catch (e) { return ''; }
}
const isSmoovPlay = (dir) => !!dir && fs.existsSync(path.join(dir, 'runtime', 'python', 'python.exe'))
  && fs.existsSync(path.join(dir, 'app', 'framegen', 'tap.py'));
function findSmoovPlay() {
  const candidates = [config.smoovplayDir, regValue('InstallLocation'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'SmoovPlay')];
  return candidates.find(isSmoovPlay) || candidates.find(Boolean) || '';
}
const smoovplayDir = findSmoovPlay();
const smoovplay = {
  dir: smoovplayDir,
  version: regValue('DisplayVersion'),
  python: process.env.GREENFRAME_PYTHON || path.join(smoovplayDir, 'runtime', 'python', 'python.exe'),
  app: path.join(smoovplayDir, 'app'),
};

// SmoovPlay 0.3.4 tells a 30 fps game's new frames from repeats by the picture on compressed streams like
// GreenFrame's; before that, by frame size, which misread Xbox streams often. Say so once per old version.
function olderThan(v, want) {
  const a = String(v).split('.').map(Number), b = want.split('.').map(Number);
  for (let i = 0; i < b.length; i++) { if ((a[i] || 0) !== b[i]) return (a[i] || 0) < b[i]; }
  return false;
}
function checkSmoovPlayVersion() {
  if (!smoovplay.version || !olderThan(smoovplay.version, '0.3.4') || config.warnedOldSmoovPlay === smoovplay.version) {
    return;
  }
  config.warnedOldSmoovPlay = smoovplay.version;
  saveConfig();
  const r = dialog.showMessageBoxSync({
    type: 'info', title: 'GreenFrame', buttons: ['Open SmoovPlay releases', 'Later'], defaultId: 0, cancelId: 1,
    message: `SmoovPlay ${smoovplay.version} is installed; 0.3.4 or newer works better with Xbox`,
    detail: 'Newer SmoovPlay tells a 30 fps game\'s new frames from repeats by the picture, which reads Xbox ' +
      'Remote Play streams far more reliably. Update SmoovPlay from its Releases page (your settings are kept).',
  });
  if (r === 0) shell.openExternal('https://github.com/smoovplay/smoovplay/releases');
}
const bridgeScript = app.isPackaged
  ? path.join(process.resourcesPath, 'bridge', 'greenframe_bridge.py')
  : path.join(__dirname, '..', 'bridge', 'greenframe_bridge.py');

// ------------------------------------------------------------ child processes

const children = {};

// Starts a Python child, logging its output to logs/<name>.log; onLine (optional) sees each line of it.
function startChild(name, args, cwd, onLine, onExit) {
  stopChild(name);
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, `${name}.log`), 'a');
  fs.writeSync(out, `\n===== ${new Date().toISOString()} ${smoovplay.python} ${args.join(' ')}\n`);
  const p = spawn(smoovplay.python, ['-u', ...args], {
    cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1' }),
  });
  let partial = '';
  const take = (chunk) => {
    try { fs.writeSync(out, chunk); } catch (e) { /* log is best-effort */ }
    if (!onLine) return;
    const lines = (partial + chunk.toString('utf8')).split(/\r?\n/);
    partial = lines.pop();
    for (const l of lines) onLine(l);
  };
  p.stdout.on('data', take);
  p.stderr.on('data', take);
  p.on('exit', (code) => {
    try { fs.closeSync(out); } catch (e) { /* already closed */ }
    if (children[name] === p) delete children[name];
    if (onExit) onExit(code);
    updateMenu();
    if (name === 'bridge' && !quitting) {
      dialog.showErrorBox('GreenFrame', `The bridge stopped (code ${code}). See ${path.join(logDir, 'bridge.log')}.`);
    }
  });
  p.on('error', (e) => dialog.showErrorBox('GreenFrame', `Couldn't start ${name}: ${e.message}`));
  children[name] = p;
  updateMenu();
  return p;
}

function stopChild(name) {
  const p = children[name];
  if (!p) return;
  delete children[name];
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(p.pid), '/T', '/F'], () => {});
  else p.kill();
}

function startBridge() {
  const extra = (process.env.GREENFRAME_BRIDGE_ARGS || '').split(' ').filter(Boolean); // testing
  startChild('bridge', [bridgeScript, '--port', String(config.port), ...extra], path.dirname(bridgeScript));
}

// While SmoovPlay shows the picture, GreenFrame gets out of the way (like SmoovPlay's "Minimise chiaki-ng" for the
// PS5): minimised, still streaming, playing sound and reading the controller. Back when SmoovPlay closes.
// Streamed to a handheld (Steam Deck) through Apollo or Sunshine: they tell the app the client's frame rate. SmoovPlay
// then draws at that rate (60, 90 or 120; a Deck OLED asks for 90) and full screen on the stream's virtual display,
// whatever's saved for the desktop.
function streamArgs() {
  const fps = parseFloat(process.env.APOLLO_CLIENT_FPS || process.env.SUNSHINE_CLIENT_FPS || '');
  if (!(fps > 0)) return [];
  const hz = [60, 90, 120].reduce((a, b) => (Math.abs(b - fps) < Math.abs(a - fps) ? b : a));
  return ['--hz', String(hz), '--fullscreen'];
}

function startSmoovPlay() {
  const extra = streamArgs();
  if (extra.length) log('page', `[GreenFrame] streaming to ${process.env.APOLLO_CLIENT_NAME || 'a Moonlight client'}: SmoovPlay ${extra.join(' ')}`);
  startChild('smoovplay', [path.join(smoovplay.app, 'run.py'), '--source', 'tap', ...config.smoovplayArgs, ...extra],
    smoovplay.app,
    (line) => { if (/^\[run\] playing\b/.test(line)) smoovplayShowing(true); },
    () => smoovplayShowing(false));
}

let minimisedForSmoovPlay = false;
function smoovplayShowing(on) {
  if (!win) return;
  if (on && config.minimiseWhilePlaying && !win.isMinimized()) {
    log('page', '[GreenFrame] SmoovPlay is showing the picture: minimising GreenFrame');
    minimisedForSmoovPlay = true;
    win.minimize();
  } else if (!on && minimisedForSmoovPlay) {
    minimisedForSmoovPlay = false;
    if (!quitting) win.restore();
  }
}

// ------------------------------------------------------------ the window

let win = null;
let quitting = false;

function browserUA(ua) {
  // Look like Edge, not Electron, so xbox.com offers remote play.
  const chrome = (ua.match(/Chrome\/([\d.]+)/) || [])[1] || '140.0.0.0';
  return ua.replace(/ (Electron|greenframe|GreenFrame)\/[\w.-]+/gi, '') + ` Edg/${chrome}`;
}

function createWindow() {
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(browserUA(ses.getUserAgent()));
  win = new BrowserWindow({
    width: 1600, height: 900, backgroundColor: '#0e0e0e', title: 'GreenFrame',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegrationInSubFrames: true, // the hook also runs in frames, in case the player lives in one
      backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (SIGN_IN_HOSTS.test(new URL(url).hostname)) {
        return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { partition: PARTITION } } };
      }
    } catch (e) { /* not a URL */ }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('console-message', (e, level, message) => {
    if (String(message).includes('[GreenFrame]')) log('page', message);
  });
  win.loadURL(PLAY_URL);
  if (process.env.GREENFRAME_TEST_MINIMISE_AT) { // testing: what SmoovPlay's "playing" does, a few seconds in
    setTimeout(() => { minimisedForSmoovPlay = true; win.minimize(); win.hide(); log('page', '[GreenFrame] TEST hidden'); },
      1000 * Number(process.env.GREENFRAME_TEST_MINIMISE_AT));
  }
  win.on('closed', () => { win = null; });
}

function log(name, msg) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, `${name}.log`), `${new Date().toISOString()} ${msg}\n`);
  } catch (e) { /* logging is best-effort */ }
}

function updateMenu() {
  const running = (n) => (children[n] ? ' (running)' : '');
  const menu = Menu.buildFromTemplate([
    {
      label: 'GreenFrame',
      submenu: [
        { label: 'Back to Xbox Remote Play', click: () => win && win.loadURL(PLAY_URL) },
        { label: 'Reload', accelerator: 'F5', click: () => win && win.reload() },
        { type: 'separator' },
        { label: `Start SmoovPlay${running('smoovplay')}`, accelerator: 'Ctrl+Shift+S', click: startSmoovPlay },
        { label: 'Stop SmoovPlay', enabled: !!children.smoovplay, click: () => stopChild('smoovplay') },
        { label: `Restart bridge${running('bridge')}`, click: startBridge },
        { label: 'Minimise GreenFrame while SmoovPlay is showing', type: 'checkbox', checked: !!config.minimiseWhilePlaying,
          click: (item) => { config.minimiseWhilePlaying = item.checked; saveConfig(); } },
        { type: 'separator' },
        { label: 'Open logs folder', click: () => shell.openPath(logDir) },
        { label: 'Open settings (config.json)', click: () => shell.openPath(configPath) },
        { label: 'Developer tools', accelerator: 'Ctrl+Shift+I', click: () => win && win.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: 'Full screen', accelerator: 'F11', click: () => win && win.setFullScreen(!win.isFullScreen()) },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
  ]);
  Menu.setApplicationMenu(menu);
}

// ------------------------------------------------------------ start / stop

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    updateMenu();
    bridgeLink.setup(config.port, (msg) => log('page', `[GreenFrame] ${msg}`));
    if (process.env.GREENFRAME_PYTHON) {
      startBridge(); // testing: no SmoovPlay
    } else if (!fs.existsSync(smoovplay.python) || !fs.existsSync(path.join(smoovplay.app, 'framegen', 'tap.py'))) {
      dialog.showMessageBoxSync({
        type: 'warning', title: 'GreenFrame',
        message: "SmoovPlay wasn't found",
        detail: `GreenFrame needs SmoovPlay (github.com/smoovplay/smoovplay) installed, with its frame tap.\n\n` +
          `Looked in: ${smoovplay.dir || 'its Apps & features entry and the default folder'}\n\n` +
          `If it's somewhere else, set "smoovplayDir" in ${configPath} and restart.`,
      });
    } else {
      log('page', `[GreenFrame] SmoovPlay ${smoovplay.version || '(version unknown)'} in ${smoovplay.dir}`);
      startBridge();
      if (config.startSmoovPlay) startSmoovPlay();
      checkSmoovPlayVersion();
    }
    createWindow();
  });
  app.on('before-quit', () => { quitting = true; stopChild('smoovplay'); stopChild('bridge'); });
  app.on('window-all-closed', () => app.quit());
}
