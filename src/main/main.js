'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell
} = require('electron');
const { DEFAULT_CONFIG } = require('../simulator/constants');
const { publicSettings, validateConfig } = require('../simulator/config');
const { manifestAsCsv, manifestAsJson } = require('../simulator/imei');
const { FileLogger } = require('./file-logger');
const { SettingsStore, pickSettings } = require('./settings-store');
const { SimulatorController } = require('./simulator-controller');

let mainWindow = null;
let settingsStore = null;
let fileLogger = null;
let simulator = null;
let shutdownInProgress = false;

// The interface is English-only; forcing one locale keeps portable builds minimal.
app.commandLine.appendSwitch('lang', 'en-US');

function emitToRenderer(channel, value) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, value);
  }
}

function log(entry) {
  fileLogger?.write(entry);
  emitToRenderer('simulator:log', entry);
}

function createRuntimeConfig(input) {
  return validateConfig({
    ...DEFAULT_CONFIG,
    ...settingsStore.get(),
    ...pickSettings(input),
    movingPercent: 25,
    movingIntervalMs: 10_000,
    parkedIntervalMs: 5 * 60_000,
    heartbeatIntervalMs: 60_000
  });
}

function assertTrusted(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('Untrusted IPC sender');
  }
}

function registerIpc() {
  ipcMain.handle('settings:get', (event) => {
    assertTrusted(event);
    return settingsStore.get();
  });

  ipcMain.handle('settings:save', async (event, input) => {
    assertTrusted(event);
    const saved = await settingsStore.save(input || {});
    log({
      timestamp: new Date().toISOString(),
      level: 'info',
      source: 'Settings',
      message: 'Settings saved',
      details: { host: saved.host, port: saved.port }
    });
    return saved;
  });

  ipcMain.handle('simulator:start', async (event, input) => {
    assertTrusted(event);
    if (simulator.running) throw new Error('Transmission is already running');
    const config = createRuntimeConfig(input || {});
    await settingsStore.save(publicSettings(config));
    emitToRenderer('simulator:state', { status: 'starting' });
    try {
      const metrics = await simulator.start(config);
      emitToRenderer('simulator:state', { status: 'running' });
      return metrics;
    } catch (error) {
      emitToRenderer('simulator:state', { status: 'idle', error: error.message });
      throw error;
    }
  });

  ipcMain.handle('simulator:stop', async (event) => {
    assertTrusted(event);
    emitToRenderer('simulator:state', { status: 'stopping' });
    const metrics = await simulator.stop();
    emitToRenderer('simulator:state', { status: 'idle' });
    return metrics;
  });

  ipcMain.handle('imei:export', async (event, input = {}) => {
    assertTrusted(event);
    const config = createRuntimeConfig(input);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export virtual device IMEIs',
      defaultPath: `gt06-imeis-${config.deviceCount}-${timestamp}.csv`,
      filters: [
        { name: 'CSV spreadsheet', extensions: ['csv'] },
        { name: 'JSON data', extensions: ['json'] }
      ]
    });
    if (result.canceled || !result.filePath) return { canceled: true };

    const isJson = path.extname(result.filePath).toLowerCase() === '.json';
    const content = isJson
      ? manifestAsJson(config.deviceCount, config.movingPercent)
      : manifestAsCsv(config.deviceCount, config.movingPercent);
    await fs.writeFile(result.filePath, content, { encoding: 'utf8', mode: 0o600 });
    log({
      timestamp: new Date().toISOString(),
      level: 'info',
      source: 'Export',
      message: 'IMEI list exported',
      details: { devices: config.deviceCount, format: isJson ? 'json' : 'csv' }
    });
    return { canceled: false, filePath: result.filePath };
  });

  ipcMain.handle('logs:show', (event) => {
    assertTrusted(event);
    shell.showItemInFolder(fileLogger.filePath);
    return true;
  });

  ipcMain.handle('app:info', (event) => {
    assertTrusted(event);
    return {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch
    };
  });

  ipcMain.handle('app:open-external', async (event, url) => {
    assertTrusted(event);
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      await shell.openExternal(url);
    }
    return true;
  });

  ipcMain.on('window:minimize', (event) => {
    assertTrusted(event);
    mainWindow.minimize();
  });
  ipcMain.on('window:toggle-maximize', (event) => {
    assertTrusted(event);
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  });
  ipcMain.on('window:close', (event) => {
    assertTrusted(event);
    app.quit();
  });
}

function createWindow() {
  let iconPath;
  if (process.platform === 'win32') {
    iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'build', 'icon.ico')
      : path.join(__dirname, '..', '..', 'build', 'icon.ico');
  } else {
    iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'build', 'icon.png')
      : path.join(__dirname, '..', '..', 'build', 'icon.png');
  }

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 940,
    minHeight: 680,
    frame: false,
    show: false,
    icon: iconPath,
    backgroundColor: '#f4f5f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', async () => {
    mainWindow.show();
    const screenshotPath = process.env.GPS_FARM_QA_SCREENSHOT;
    if (screenshotPath) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      const image = await mainWindow.webContents.capturePage();
      await fs.writeFile(path.resolve(screenshotPath), image.toPNG());
      app.quit();
    }
  });
  mainWindow.on('maximize', () => emitToRenderer('window:maximized', true));
  mainWindow.on('unmaximize', () => emitToRenderer('window:maximized', false));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

app.whenReady().then(async () => {
  app.setName('GPS Device Farm');
  app.setAppUserModelId('com.openvts.gpsdevicefarm');
  Menu.setApplicationMenu(null);
  const userDataDirectory = app.getPath('userData');
  settingsStore = new SettingsStore(userDataDirectory);
  fileLogger = new FileLogger(userDataDirectory);
  await Promise.all([settingsStore.load(), fileLogger.init()]);

  simulator = new SimulatorController({
    onLog: (entry) => log(entry),
    onMetrics: (metrics) => emitToRenderer('simulator:metrics', metrics),
    onFatal: (error) => {
      log({
        timestamp: new Date().toISOString(),
        level: 'error',
        source: 'Worker',
        message: 'Simulation worker failed',
        details: { message: error.message }
      });
      emitToRenderer('simulator:state', { status: 'idle', error: error.message });
    }
  });

  createWindow();
  registerIpc();
  log({
    timestamp: new Date().toISOString(),
    level: 'info',
    source: 'Application',
    message: 'GPS Device Farm opened',
    details: { version: app.getVersion(), platform: process.platform }
  });
});

app.on('before-quit', (event) => {
  if (shutdownInProgress) return;
  event.preventDefault();
  shutdownInProgress = true;
  Promise.resolve(simulator?.worker ? simulator.stop() : null)
    .catch((error) => log({
      timestamp: new Date().toISOString(),
      level: 'error',
      source: 'Application',
      message: 'Shutdown cleanup failed',
      details: { message: error.message }
    }))
    .finally(async () => {
      await fileLogger?.close();
      app.quit();
    });
});

app.on('window-all-closed', () => app.quit());
