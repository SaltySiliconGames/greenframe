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
  smoovplayDir: path.join(process.env.LOCALAPPDATA || '', 'Programs', 'SmoovPlay'),
  startSmoovPlay: true,          // start SmoovPlay with GreenFrame
  smoovplayArgs: ['--display'],  // added to run.py --source tap
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
const smoovplay = {
  dir: config.smoovplayDir,
  python: process.env.GREENFRAME_PYTHON || path.join(config.smoovplayDir, 'runtime', 'python', 'python.exe'),
  app: path.join(config.smoovplayDir, 'app'),
};
const bridgeScript = app.isPackaged
  ? path.join(process.resourcesPath, 'bridge', 'greenframe_bridge.py')
  : path.join(__dirname, '..', 'bridge', 'greenframe_bridge.py');

// ------------------------------------------------------------ child processes

const children = {};

function startChild(name, args, cwd) {
  stopChild(name);
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, `${name}.log`), 'a');
  fs.writeSync(out, `\n===== ${new Date().toISOString()} ${smoovplay.python} ${args.join(' ')}\n`);
  const p = spawn(smoovplay.python, ['-u', ...args], {
    cwd, windowsHide: true, stdio: ['ignore', out, out],
    env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1' }),
  });
  p.on('exit', (code) => {
    if (children[name] === p) delete children[name];
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

function startSmoovPlay() {
  startChild('smoovplay', [path.join(smoovplay.app, 'run.py'), '--source', 'tap', ...config.smoovplayArgs],
    smoovplay.app);
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
          `Looked in: ${smoovplay.dir}\n\nIf it's somewhere else, set "smoovplayDir" in ${configPath} and restart.`,
      });
    } else {
      startBridge();
      if (config.startSmoovPlay) startSmoovPlay();
    }
    createWindow();
  });
  app.on('before-quit', () => { quitting = true; stopChild('smoovplay'); stopChild('bridge'); });
  app.on('window-all-closed', () => app.quit());
}
