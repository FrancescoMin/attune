const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const media = require('./media');

// CMF / Nothing earbuds RFCOMM service class IDs used by ear (web).
const SPP_UUID = 'aeac4a03-dff5-498f-843a-34487cf133eb';
const FASTPAIR_UUID = 'df21fe2c-2515-4fdb-8886-f12c4d67927c';

// Web Serial over Bluetooth RFCOMM is enabled by default in Chromium 117+
// (Electron 33 ships Chromium 130), so no extra feature flag is required.

let mainWindow = null;
let popoverWindow = null;
let popoverBlurAt = 0;
let tray = null;

let popoverState = {
  connected: false,
  connecting: false,
  modelName: null,
  codename: 'espeon',
  color: 'orange',
  accent: '#ff6a1a',
  accentDim: '#b8480f',
  battery: { l: null, r: null, c: null, chg: { l: false, r: false, c: false } },
  anc: 1,
  eq: 0,
  bass: { enabled: false, level: 1 },
  lowLat: false,
  caps: { bass: true, presets: true }
};

// --- App settings (persisted) -------------------------------------------------------
const settingsPath = () => path.join(app.getPath('userData'), 'attune-settings.json');
let settings = { closeToTray: true, githubRepo: 'RocketSpot/attune', openAtLogin: false, popoverMode: 'quick' };
function applyLoginItem() {
  try { app.setLoginItemSettings({ openAtLogin: !!settings.openAtLogin, path: process.execPath }); } catch (_) {}
}
function trayTip(b) {
  if (!b) return 'Attune';
  const parts = [];
  if (b.l != null) parts.push('L ' + b.l + '%');
  if (b.r != null) parts.push('R ' + b.r + '%');
  if (b.c != null) parts.push('Case ' + b.c + '%');
  return parts.length ? 'Attune — ' + parts.join(' · ') : 'Attune';
}
function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')) }; } catch (_) {}
}
function saveSettings() {
  try { fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2)); } catch (_) {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 740,
    minWidth: 900,
    minHeight: 680,
    backgroundColor: '#0d0d0d',
    frame: false,
    titleBarStyle: 'hidden',
    show: false,
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icons', 'app_256.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  const ses = mainWindow.webContents.session;

  // Smart Tuning backend (system media detection, genre lookup, Spotify).
  media.register(mainWindow);

  // --- Web Serial permission wiring -------------------------------------------------
  // Grant the 'serial' permission so navigator.serial works without a prompt.
  ses.setPermissionCheckHandler((wc, permission) => {
    return permission === 'serial' || permission === 'serial-port';
  });

  // Persist/allow device access for serial (and bluetooth, used for RFCOMM discovery).
  ses.setDevicePermissionHandler((details) => {
    return details.deviceType === 'serial' || details.deviceType === 'bluetooth';
  });

  // When the renderer calls navigator.serial.requestPort(), Chromium asks us which
  // port to hand back. We auto-select the paired Bluetooth port that exposes the
  // CMF/Nothing RFCOMM service, falling back to the first Bluetooth/serial port.
  ses.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();

    const isOurs = (p) => {
      const id = (p.bluetoothServiceClassId || '').toLowerCase();
      return id === SPP_UUID || id === FASTPAIR_UUID;
    };

    let chosen =
      portList.find(isOurs) ||
      portList.find((p) => !!p.bluetoothServiceClassId) ||
      portList[0];

    // Let the renderer surface what we found / didn't find.
    try {
      webContents.send('serial:portlist', {
        ports: portList.map((p) => ({
          portId: p.portId,
          portName: p.portName,
          displayName: p.displayName,
          bluetoothServiceClassId: p.bluetoothServiceClassId || null
        })),
        chosen: chosen ? chosen.portId : null
      });
    } catch (_) {}

    callback(chosen ? chosen.portId : '');
  });

  ses.on('serial-port-added', (event, port) => {
    try { mainWindow.webContents.send('serial:added', port.portName || port.displayName || ''); } catch (_) {}
  });

  // Open external links (e.g. GitHub) in the system browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Forward renderer console + load failures to the main process stdout
  // (useful when launched from a terminal for debugging).
  mainWindow.webContents.on('console-message', (_e, level, message, line, src) => {
    console.log(`[renderer] ${message}`);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[did-fail-load] ${code} ${desc} ${url}`);
  });
  mainWindow.webContents.on('preload-error', (_e, p, err) => {
    console.error(`[preload-error] ${p}: ${err}`);
  });

  const q = {};
  if (process.env.CMF_DEMO) q.demo = '1';
  if (process.env.CMF_BLUE) q.blue = '1';
  const loadOpts = Object.keys(q).length ? { query: q } : undefined;
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), loadOpts);

  // Close button → minimize to tray (run in background) unless quitting / disabled.
  mainWindow.on('close', (e) => {
    if (settings.closeToTray && !app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      return false;
    }
  });

  createTray();

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Smoke test: optionally capture a screenshot, then auto-quit.
    if (process.env.CMF_SMOKE || process.env.CMF_SHOT) {
      const delay = process.env.CMF_SHOT ? 1600 : 4000;
      setTimeout(async () => {
        if (process.env.CMF_SHOT) {
          try {
            if (process.env.CMF_SCROLL) {
              await mainWindow.webContents.executeJavaScript(
                `document.getElementById('control-view').scrollTop = ${parseInt(process.env.CMF_SCROLL, 10) || 0}`
              );
              await new Promise((r) => setTimeout(r, 300));
            }
            const img = await mainWindow.webContents.capturePage();
            require('fs').writeFileSync(process.env.CMF_SHOT, img.toPNG());
            console.log('[shot] saved ' + process.env.CMF_SHOT);
          } catch (e) { console.error('[shot] failed', e); }
        }
        console.log('[smoke] window rendered OK, quitting');
        app.quit();
      }, delay);
    }
  });
  mainWindow.on('closed', () => {
    media.dispose();
    mainWindow = null;
    if (popoverWindow && !popoverWindow.isDestroyed()) {
      try { popoverWindow.destroy(); } catch (_) {}
      popoverWindow = null;
    }
  });
}

function showMainWindow() {
  if (!mainWindow) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

const MODE_CFG = {
  quick: { file: 'popover.html', w: 340, h: 380, minW: 280, minH: 220, maxW: 520, maxH: 680, hideOnBlur: true },
  mini:  { file: 'mini.html',    w: 256, h: 196, minW: 140, minH: 96,  maxW: 420, maxH: 400, hideOnBlur: false }
};
const modeGeom = {
  quick: { w: 340, h: 380, x: null, y: null, userMoved: false, userResized: false },
  mini:  { w: 256, h: 196, x: null, y: null, userMoved: false, userResized: false }
};
let activePopoverMode = null;
let popoverProgrammatic = false;

function normalizeMode(m) { return m === 'mini' ? 'mini' : 'quick'; }

function positionPopover(mode) {
  if (!popoverWindow || popoverWindow.isDestroyed() || !tray) return;
  const m = normalizeMode(mode || activePopoverMode);
  const g = modeGeom[m];
  const tb = tray.getBounds();
  const disp = screen.getDisplayNearestPoint({ x: tb.x || 0, y: tb.y || 0 });
  const wa = disp.workArea;
  const [curW, curH] = popoverWindow.getSize();

  let x = Math.round((tb.x || wa.x + wa.width - 40) + (tb.width || 0) / 2 - curW / 2);
  x = Math.max(wa.x + 10, Math.min(x, wa.x + wa.width - curW - 10));

  let y;
  if (tb.y && tb.y > wa.y + wa.height / 2) {
    y = Math.min(tb.y - curH - 8, wa.y + wa.height - curH - 10);
  } else if (tb.y) {
    y = Math.max(tb.y + (tb.height || 0) + 8, wa.y + 10);
  } else {
    y = wa.y + wa.height - curH - 10;
  }
  y = Math.max(wa.y + 10, Math.min(y, wa.y + wa.height - curH - 10));

  popoverProgrammatic = true;
  popoverWindow.setPosition(x, y, false);
  popoverProgrammatic = false;
  g.x = x;
  g.y = y;
}

function applyModeGeometry(mode) {
  if (!popoverWindow || popoverWindow.isDestroyed()) return;
  const cfg = MODE_CFG[mode];
  const g = modeGeom[mode];
  popoverProgrammatic = true;
  popoverWindow.setMinimumSize(100, 100);
  popoverWindow.setMaximumSize(1200, 1200);
  popoverWindow.setSize(g.w, g.h, false);
  popoverWindow.setMinimumSize(cfg.minW, cfg.minH);
  popoverWindow.setMaximumSize(cfg.maxW, cfg.maxH);
  if (g.userMoved && g.x != null && g.y != null) {
    popoverWindow.setPosition(g.x, g.y, false);
  }
  popoverProgrammatic = false;
  if (!g.userMoved) positionPopover(mode);
}

function createPopover(mode) {
  const m = normalizeMode(mode);
  const cfg = MODE_CFG[m];
  const g = modeGeom[m];

  if (popoverWindow && !popoverWindow.isDestroyed()) {
    if (activePopoverMode !== m) {
      activePopoverMode = m;
      applyModeGeometry(m);
      popoverWindow.loadFile(path.join(__dirname, '..', 'renderer', cfg.file));
    }
    return popoverWindow;
  }

  activePopoverMode = m;
  popoverWindow = new BrowserWindow({
    width: g.w,
    height: g.h,
    minWidth: cfg.minW,
    minHeight: cfg.minH,
    maxWidth: cfg.maxW,
    maxHeight: cfg.maxH,
    frame: false,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#0c0c0c',
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  popoverWindow.loadFile(path.join(__dirname, '..', 'renderer', cfg.file));

  popoverWindow.on('move', () => {
    if (popoverProgrammatic || !popoverWindow || !popoverWindow.isVisible()) return;
    const gm = modeGeom[normalizeMode(activePopoverMode)];
    const [x, y] = popoverWindow.getPosition();
    gm.userMoved = true;
    gm.x = x;
    gm.y = y;
  });
  popoverWindow.on('resize', () => {
    if (popoverProgrammatic || !popoverWindow || !popoverWindow.isVisible()) return;
    const gm = modeGeom[normalizeMode(activePopoverMode)];
    const [w, h] = popoverWindow.getSize();
    gm.userResized = true;
    gm.w = w;
    gm.h = h;
  });

  popoverWindow.on('blur', () => {
    const curCfg = MODE_CFG[normalizeMode(activePopoverMode)];
    if (!curCfg.hideOnBlur) return;
    if (popoverWindow && !popoverWindow.isDestroyed() && popoverWindow.isVisible()) {
      popoverBlurAt = Date.now();
      popoverWindow.hide();
    }
  });
  popoverWindow.on('closed', () => { popoverWindow = null; activePopoverMode = null; });
  return popoverWindow;
}

function showPopover(mode) {
  const m = normalizeMode(mode || settings.popoverMode);
  if (settings.popoverMode !== m) {
    settings.popoverMode = m;
    saveSettings();
  }
  const win = createPopover(m);
  const present = () => {
    if (!win || win.isDestroyed()) return;
    try { win.webContents.send('popover:state', popoverState); } catch (_) {}
    if (!modeGeom[m].userMoved) positionPopover(m);
    win.show();
    win.focus();
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', present);
  else present();
}

function togglePopover() {
  if (popoverWindow && !popoverWindow.isDestroyed() && popoverWindow.isVisible()) {
    popoverWindow.hide();
    return;
  }
  if (Date.now() - popoverBlurAt < 250) return;
  showPopover(settings.popoverMode);
}

function createTray() {
  if (tray) return;
  let img = nativeImage.createFromPath(path.join(__dirname, '..', 'renderer', 'assets', 'icons', 'app_256.png'));
  try { img = img.resize({ width: 16, height: 16 }); } catch (_) {}
  tray = new Tray(img);
  tray.setToolTip('Attune — CMF Buds Pro 2');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mini Controls', click: () => showPopover('mini') },
    { label: 'Quick Controls', click: () => showPopover('quick') },
    { label: 'Show Attune', click: showMainWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
  tray.on('click', togglePopover);
}

// --- Window control IPC (custom frameless titlebar) ---------------------------------
ipcMain.on('win:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('win:close', () => mainWindow && mainWindow.close());
ipcMain.handle('app:version', () => app.getVersion());

// --- Settings + feedback IPC --------------------------------------------------------
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_e, patch) => {
  settings = { ...settings, ...(patch || {}) };
  saveSettings();
  if (patch && 'openAtLogin' in patch) applyLoginItem();
  return settings;
});
ipcMain.on('tray:battery', (_e, b) => { if (tray) { try { tray.setToolTip(trayTip(b)); } catch (_) {} } });

// --- Tray popover IPC ---------------------------------------------------------------
ipcMain.on('popover:state', (_e, state) => {
  if (!state || typeof state !== 'object') return;
  popoverState = { ...popoverState, ...state };
  if (popoverWindow && !popoverWindow.isDestroyed()) {
    try { popoverWindow.webContents.send('popover:state', popoverState); } catch (_) {}
  }
});
ipcMain.handle('popover:getState', () => popoverState);
ipcMain.on('popover:resize', (_e, h) => {
  const m = normalizeMode(activePopoverMode);
  const cfg = MODE_CFG[m];
  const g = modeGeom[m];
  if (g.userResized) return;
  const next = Math.max(cfg.minH, Math.min(cfg.maxH, Math.round(Number(h) || cfg.h)));
  if (next === g.h) return;
  g.h = next;
  if (popoverWindow && !popoverWindow.isDestroyed()) {
    const [curW] = popoverWindow.getSize();
    popoverProgrammatic = true;
    popoverWindow.setSize(curW, g.h, false);
    popoverProgrammatic = false;
    if (popoverWindow.isVisible() && !g.userMoved) positionPopover(m);
  }
});
ipcMain.on('popover:action', (_e, action) => {
  if (!action || typeof action !== 'object') return;
  if (action.type === 'switch-mode') {
    showPopover(action.mode);
    return;
  }
  if (action.type === 'open-main') {
    if (popoverWindow && !popoverWindow.isDestroyed()) popoverWindow.hide();
    showMainWindow();
    return;
  }
  if (action.type === 'close') {
    if (popoverWindow && !popoverWindow.isDestroyed()) popoverWindow.hide();
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('popover:action', action); } catch (_) {}
  }
});
ipcMain.handle('feedback:save', (_e, entry) => {
  try {
    const p = path.join(app.getPath('userData'), 'attune-feedback.txt');
    const block = `\n[${(entry && entry.ts) || ''}] (${(entry && entry.category) || 'feedback'}) v${app.getVersion()}\n${(entry && entry.text) || ''}\n${'-'.repeat(48)}\n`;
    fs.appendFileSync(p, block);
    return { ok: true, path: p };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});
ipcMain.handle('feedback:open', () => {
  const p = path.join(app.getPath('userData'), 'attune-feedback.txt');
  try { if (!fs.existsSync(p)) fs.writeFileSync(p, 'Attune feedback log\n'); shell.openPath(p); return true; } catch (_) { return false; }
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => { loadSettings(); applyLoginItem(); createWindow(); });

  app.on('before-quit', () => {
    app.isQuitting = true;
    media.dispose();
    if (popoverWindow && !popoverWindow.isDestroyed()) { try { popoverWindow.destroy(); } catch (_) {} popoverWindow = null; }
    if (tray) { try { tray.destroy(); } catch (_) {} tray = null; }
  });

  app.on('window-all-closed', () => {
    // With close-to-tray the window only truly closes on quit; quit then.
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showMainWindow();
  });
}
