'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
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
const { movingDeviceCount } = require('../simulator/imei');
const { RoutePackStore, MAX_ACTIVE_ROUTE_POINTS } = require('../road/route-pack-store');
const { ProviderBudget } = require('../road/provider-budget');
const { PublicValhallaProvider } = require('../road/public-valhalla-provider');
const { BundledValhallaProvider } = require('../road/bundled-valhalla-provider');
const { BundledGraphManager } = require('../road/bundled-graph-manager');
const { RoutePreparationCoordinator } = require('../road/route-preparation-coordinator');
const { evaluateCoverage } = require('../road/route-capacity');
const { FileLogger } = require('./file-logger');
const { SettingsStore, pickSettings } = require('./settings-store');
const { SimulatorController } = require('./simulator-controller');
const { resolveRoadPreparationSource } = require('./road-preparation-source');
const { RoadPreparationStatusStore, preparationScope } = require('./road-preparation-status-store');
const { RoadPreparationProgress } = require('./road-preparation-progress');
const { configureChromiumStorage } = require('./chromium-storage');

let mainWindow = null;
let settingsStore = null;
let fileLogger = null;
let simulator = null;
let routePackStore = null;
let routeCoordinator = null;
let preparationStatusStore = null;
let localRouteProvider = null;
let graphManager = null;
let localRouterHealth = { checkedAt: 0, value: { ready: false } };
let preparationController = null;
let preparationPromise = null;
let simulatorStartPending = false;
let roadPackSelectionPending = false;
let shutdownInProgress = false;

function publicRoutePreparationEnabled() {
  return process.env.GPS_FARM_ENABLE_PUBLIC_ROUTES === '1';
}

async function checkLocalRouter({ fresh = false } = {}) {
  if (!localRouteProvider) return { ready: false };
  if (!fresh && Date.now() - localRouterHealth.checkedAt < 10_000) return localRouterHealth.value;
  let value;
  try { value = await localRouteProvider.health(); }
  catch (error) { value = { ready: false, reason: error.message }; }
  localRouterHealth = { checkedAt: Date.now(), value };
  return value;
}

// The interface is English-only; forcing one locale keeps portable builds minimal.
app.commandLine.appendSwitch('lang', 'en-US');
configureChromiumStorage(app);
const ownsInstanceLock = app.requestSingleInstanceLock();
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

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

async function loadSelectedRoadPacks(config, preloadedPacks = null) {
  const digests = config.road.selectedRoutePackDigests;
  if (digests.length === 0) throw new Error('Choose a verified route pack for real-road mode');
  const packs = preloadedPacks || await loadRoadPacksWithinBudget(digests);
  const ids = new Set();
  for (const pack of packs) {
    const selectedRegion = config.road.regions.find((region) => region.id === pack.region.id);
    if (!selectedRegion || ids.has(pack.region.id) ||
        Math.abs(selectedRegion.centerLatitude - pack.region.centerLatitude) > 1e-6 ||
        Math.abs(selectedRegion.centerLongitude - pack.region.centerLongitude) > 1e-6 ||
        Math.abs(selectedRegion.radiusKm - pack.region.radiusKm) > 1e-6 ||
        Math.abs(selectedRegion.fleetWeight - pack.region.fleetWeight) > 1e-6) {
      throw new Error('Selected route packs must contain one current pack for each matching road region');
    }
    ids.add(pack.region.id);
  }
  if (ids.size !== config.road.regions.length) {
    throw new Error('Select one matching verified route pack for every configured region');
  }
  return packs;
}

async function loadRoadPacksWithinBudget(digests) {
  const packs = [];
  let remaining = MAX_ACTIVE_ROUTE_POINTS;
  for (const digest of digests) {
    const pack = await routePackStore.loadPack(digest, undefined, { pointBudget: remaining });
    packs.push(pack);
    remaining -= pack.pointCount;
  }
  return packs;
}

function roadCoverage(config, packs) {
  const movingDevices = movingDeviceCount(config.deviceCount, config.movingPercent);
  return evaluateCoverage(packs, {
    regions: config.road.regions,
    movingDevices,
    parkedDevices: config.deviceCount - movingDevices,
    minSpacingMeters: 250,
    requireContinuousMotion: config.road.requireEnterpriseDiversityGate,
    scenarioSeed: config.scenarioSeed
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
    if (simulatorStartPending || simulator?.worker || preparationController || roadPackSelectionPending) {
      throw new Error('Settings can be changed only while transmission and preparation are idle');
    }
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
    if (simulator.running || simulator.worker || simulatorStartPending) throw new Error('Transmission is already starting or running');
    if (preparationController || roadPackSelectionPending) {
      throw new Error('Finish route preparation or pack selection before transmission');
    }
    simulatorStartPending = true;
    try {
      const config = createRuntimeConfig(input || {});
      let roadContext = null;
      if (config.movementMode === 'real-road') {
        const packs = await loadSelectedRoadPacks(config);
        const coverage = roadCoverage(config, packs);
        if (coverage.regions.some((region) => region.capacity < region.requestedMoving)) {
          throw new Error(`Real-road route capacity is insufficient: ${coverage.deficits.join(' | ')}`);
        }
        if (coverage.parkedPositionCapacity < coverage.requestedParked ||
            coverage.regions.some((region) =>
              region.requestedParked > region.parkedPositionCapacity)) {
          throw new Error(`Real-road parked positions with a 50 m gap are insufficient: ${coverage.deficits.join(' | ')}`);
        }
        if (config.road.requireEnterpriseDiversityGate && !coverage.ready) {
          throw new Error(`Real-road coverage is not ready: ${coverage.deficits.join(' | ')}`);
        }
        if (!coverage.ready) log({ timestamp: new Date().toISOString(), level: 'warn',
          source: 'Road coverage', message: 'Reduced-diversity override selected',
          details: { deficits: coverage.deficits } });
        roadContext = { dataDirectory: app.getPath('userData') };
      }
      await settingsStore.save(publicSettings(config));
      emitToRenderer('simulator:state', { status: 'starting' });
      const metrics = await simulator.start(config, roadContext);
      emitToRenderer('simulator:state', { status: 'running' });
      return metrics;
    } catch (error) {
      emitToRenderer('simulator:state', { status: 'idle', error: error.message });
      throw error;
    } finally {
      simulatorStartPending = false;
    }
  });

  ipcMain.handle('road:coverage', async (event, input = {}) => {
    assertTrusted(event);
    const config = createRuntimeConfig(input);
    const packs = await routePackStore.listPackSummaries(undefined, { includeHistorical: true });
    const selected = [];
    const loadErrors = [];
    let remainingPoints = MAX_ACTIVE_ROUTE_POINTS;
    for (const digest of config.road.selectedRoutePackDigests) {
      try {
        const pack = await routePackStore.loadPack(digest, undefined, { pointBudget: remainingPoints });
        selected.push(pack);
        remainingPoints -= pack.pointCount;
      }
      catch (error) { loadErrors.push(error.message); }
    }
    const coverage = roadCoverage(config, selected);
    const selectedRegionIds = selected.map((pack) => pack.region.id);
    if (new Set(selectedRegionIds).size !== selectedRegionIds.length) {
      coverage.ready = false;
      coverage.status = 'insufficient-coverage';
      coverage.deficits.push('Choose only one route-pack generation per region');
    }
    if (config.road.selectedRoutePackDigests.length > 0 && loadErrors.length === 0) {
      try { await loadSelectedRoadPacks(config, selected); }
      catch (error) {
        loadErrors.push(error.message);
      }
    }
    if (loadErrors.length > 0) {
      coverage.ready = false;
      coverage.status = 'insufficient-coverage';
      coverage.deficits.push(...loadErrors);
    }
    graphManager.setRegions(config.road.regions);
    const localHealth = await checkLocalRouter({ fresh: true });
    const localReady = localHealth.ready === true;
    const bundledAvailable = await graphManager.runtimeAvailable();
    return {
      packs,
      coverage,
      preparationStatus: await preparationStatusStore.read(preparationScope(config)),
      selectionValid: config.road.selectedRoutePackDigests.length === config.road.regions.length &&
        selected.length === config.road.regions.length &&
        new Set(selectedRegionIds).size === selected.length && loadErrors.length === 0,
      localRouterReady: localReady,
      preparationEnabled: bundledAvailable || publicRoutePreparationEnabled(),
      preparationMessage: localReady
        ? 'Local OpenStreetMap routing is ready. Prepare up to 2,000 city and regional routes. Map data and verified routes stay on this computer. © OpenStreetMap contributors.'
        : bundledAvailable
          ? 'The app downloads OpenStreetMap data for your saved region and builds the local road graph on first use. Later builds reuse the local map. Internet and disk space are needed for a new region. © OpenStreetMap contributors.'
        : publicRoutePreparationEnabled()
          ? 'Bundled road routing is unavailable. Public demo preparation is limited to 30 requests.'
          : 'The bundled road engine is unavailable. Reinstall the Windows desktop app.'
    };
  });

  ipcMain.handle('road:select-pack', async (event, digests, options = {}) => {
    assertTrusted(event);
    if (simulator.worker || simulatorStartPending || preparationController || roadPackSelectionPending) {
      throw new Error('Stop transmission or preparation before selecting packs');
    }
    if (!Array.isArray(digests) || digests.length > 8) throw new Error('Choose at most eight route packs');
    roadPackSelectionPending = true;
    try {
      const selectedPacks = await loadRoadPacksWithinBudget(digests);
      if (new Set(selectedPacks.map((pack) => pack.region.id)).size !== selectedPacks.length) {
        throw new Error('Choose only one route-pack generation per region');
      }
      const current = settingsStore.get();
      if (current.road.selectedRoutePackDigests.length > 0 &&
          current.road.selectedRoutePackDigests.join('|') !== digests.join('|') &&
          options.startFresh !== true) {
        throw new Error('Changing route packs starts fresh road positions; confirm the reset first');
      }
      for (const pack of selectedPacks) await routePackStore.selectPack(pack.digest, pack.region.id);
      return settingsStore.save({ road: { ...current.road, selectedRoutePackDigests: digests } });
    } finally {
      roadPackSelectionPending = false;
    }
  });

  ipcMain.handle('road:prepare', async (event, input = {}) => {
    assertTrusted(event);
    if (simulator.worker || simulatorStartPending || preparationController || roadPackSelectionPending) {
      throw new Error('Route preparation needs an idle simulator and route selection');
    }
    const config = createRuntimeConfig({});
    preparationController = new AbortController();
    preparationPromise = (async () => {
      const progress = new RoadPreparationProgress({
        store: preparationStatusStore,
        scope: preparationScope(config, input.targetRouteCount ?? 2000),
        targetRouteCount: input.targetRouteCount ?? 2000,
        attemptBudget: input.maxRequests ?? 4000,
        emit: (event) => emitToRenderer('road:preparation-progress', event),
        onPersistenceError: (error) => log({ timestamp: new Date().toISOString(),
          level: 'warn', source: 'Road preparation',
          message: 'Preparation progress could not be saved',
          details: { error: error.message } })
      });
      try {
        await progress.start();
        graphManager.setRegions(config.road.regions);
        if (input.source === 'local') {
          await graphManager.ensureGraphs(config.road.regions, {
            signal: preparationController.signal,
            onProgress: (event) => progress.update(event)
          });
          localRouterHealth.checkedAt = 0;
          await localRouteProvider.startSession({ signal: preparationController.signal });
        }
        const source = resolveRoadPreparationSource({ input,
          localHealth: await checkLocalRouter({ fresh: true }),
          localProvider: localRouteProvider,
          publicProvider: routeCoordinator.provider,
          publicEnabled: publicRoutePreparationEnabled() });
        const requestedMoving = movingDeviceCount(config.deviceCount, config.movingPercent);
        const result = await routeCoordinator.prepare({
          regions: config.road.regions,
          seed: config.scenarioSeed,
          ...source,
          stopAtUsableRouteCount: input.stopAtUsableRouteCount === true,
          requestedMoving,
          requestedParked: config.deviceCount - requestedMoving,
          requireContinuousMotion: config.road.requireEnterpriseDiversityGate,
          actionId: randomUUID(),
          signal: preparationController.signal,
          onProgress: (event) => progress.update(event)
        });
        await progress.finish(result);
        return result;
      } catch (error) {
        await progress.fail(error, preparationController.signal.aborted || error.name === 'AbortError');
        throw error;
      } finally {
        if (input.source === 'local') await localRouteProvider.stopSession();
      }
    })();
    try {
      return await preparationPromise;
    } finally {
      preparationController = null;
      preparationPromise = null;
    }
  });

  ipcMain.handle('road:cancel-preparation', (event) => {
    assertTrusted(event);
    preparationController?.abort();
    return true;
  });

  ipcMain.handle('simulator:stop', async (event) => {
    assertTrusted(event);
    if (simulatorStartPending) throw new Error('Wait for transmission startup to finish before stopping');
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
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('maximize', () => emitToRenderer('window:maximized', true));
  mainWindow.on('unmaximize', () => emitToRenderer('window:maximized', false));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

app.whenReady().then(async () => {
  if (!ownsInstanceLock) {
    app.quit();
    return;
  }
  app.setName('GPS Device Farm');
  app.setAppUserModelId('com.openvts.gpsdevicefarm');
  Menu.setApplicationMenu(null);
  const userDataDirectory = app.getPath('userData');
  routePackStore = new RoutePackStore(path.join(userDataDirectory, 'road-routes'));
  preparationStatusStore = new RoadPreparationStatusStore(routePackStore.rootDir);
  const providerBudget = new ProviderBudget({ stateFile: path.join(userDataDirectory,
    'road-routes', 'provider-state.json') });
  const provider = new PublicValhallaProvider({ budget: providerBudget,
    enabled: publicRoutePreparationEnabled(),
    appVersion: app.getVersion() });
  const runtimeDir = app.isPackaged
    ? path.join(process.resourcesPath, 'road-engine')
    : path.join(__dirname, '..', '..', 'vendor', 'valhalla', 'runtime');
  const clipperDir = app.isPackaged
    ? path.join(process.resourcesPath, 'road-clipper', 'runtime')
    : path.join(__dirname, '..', '..', 'vendor', 'osmium', 'runtime');
  graphManager = new BundledGraphManager({
    rootDir: path.join(userDataDirectory, 'road-engine'), runtimeDir, clipperDir
  });
  localRouteProvider = new BundledValhallaProvider({
    resolveGraph: (regionId, options) => graphManager.resolveGraph(regionId, options),
    readHealth: (options) => graphManager.readHealth(options)
  });
  routeCoordinator = new RoutePreparationCoordinator({ store: routePackStore, provider });
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
  preparationController?.abort();
  Promise.allSettled([
    Promise.resolve(simulator?.worker ? simulator.stop() : null),
    Promise.resolve(preparationPromise)
  ])
    .then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') log({
          timestamp: new Date().toISOString(), level: 'error', source: 'Application',
          message: 'Shutdown cleanup failed', details: { message: result.reason?.message }
        });
      }
    })
    .finally(async () => {
      await fileLogger?.close();
      app.quit();
    });
});

app.on('window-all-closed', () => app.quit());
