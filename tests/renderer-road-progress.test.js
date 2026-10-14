'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');

function rendererHarness() {
  const elements = new Map();
  const createElement = () => ({
    textContent: '', value: '', hidden: false, disabled: false,
    dataset: {}, style: {}, className: '', selectedOptions: [],
    listeners: {}, focused: false,
    previousElementSibling: { textContent: '' },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    setAttribute() {}, removeAttribute() {},
    querySelector() { return createElement(); },
    replaceChildren() {}, append() {}, focus() { this.focused = true; }
  });
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement());
      return elements.get(id);
    },
    addEventListener() {}, createElement
  };
  const api = {
    onMetrics() {}, onLog() {}, onState() {}, onWindowMaximized() {},
    onRoadPreparationProgress() {},
    getRoadCoverage: () => new Promise(() => {}),
    getSettings: () => new Promise(() => {}),
    getAppInfo: () => new Promise(() => {})
  };
  const context = vm.createContext({
    window: { deviceFarm: api }, document, console,
    setTimeout, clearTimeout, requestAnimationFrame() {}
  });
  vm.runInContext(source, context, { filename: 'app.js' });
  context.testSettings = {
    host: '127.0.0.1', port: 7510, baseLatitude: 28.6139,
    baseLongitude: 77.209, connectionRatePerSecond: 100,
    logDetail: 'summary', movementMode: 'real-road',
    scenarioSeed: 'test', deviceCount: 3000,
    road: { radiusKm: 50, regionMode: 'single', regions: [],
      selectedRoutePackDigests: [], requireEnterpriseDiversityGate: true }
  };
  vm.runInContext('applySettings(testSettings)', context);
  return { context, element: (id) => elements.get(id) };
}

test('restored exhausted catalog shows partial progress and region action', () => {
  const { context, element } = rendererHarness();
  vm.runInContext(`mergeRoadPreparation({ state: 'blocked', status: 'candidates-exhausted',
    resumeAvailable: false, stage: 'complete', routeCount: 169, targetRouteCount: 2000,
    attempts: 1282, accepted: 169, rejected: 1113, planningRound: 64,
    planningRoundLimit: 64, remainingCandidates: 0,
    composition: { cityRoutes: 122, regionalRoutes: 47, intercityRoutes: 24 } });
    setControls();`, context);
  assert.match(element('roadRouteCount').textContent, /^169 \/ 2,000$/);
  assert.equal(element('roadRouteBar').style.width, '8%');
  assert.equal(element('prepareRoadButton').textContent, 'Adjust road region');
  element('settingsModal').hidden = true;
  element('prepareRoadButton').listeners.click();
  assert.equal(element('settingsModal').hidden, false);
  assert.equal(element('roadRadiusInput').focused, true);
  assert.match(element('roadPreparationAdvice').textContent, /Change the base point or radius/);
  assert.match(element('roadPreparationMix').textContent, /City 122\/800/);
  assert.notEqual(element('roadPreparationBadge').textContent, 'Target complete');
});

test('active route progress shows measured ETA and resumable cancellation control', () => {
  const { context, element } = rendererHarness();
  vm.runInContext(`preparingRoads = true;
    mergeRoadPreparation({ state: 'running', stage: 'routes', phase: 'accepted',
      routeCount: 200, savedRouteCount: 175, targetRouteCount: 2000,
      attempts: 40, accepted: 8, rejected: 32, attemptBudget: 4000,
      estimatedRemainingMs: 30 * 60 * 1000 });
    setControls();`, context);
  assert.equal(element('roadRouteBar').style.width, '10%');
  assert.match(element('roadPreparationEta').textContent, /about 30 min/);
  assert.match(element('roadPreparationSearch').textContent, /175 saved locally/);
  assert.equal(element('cancelPreparationButton').hidden, false);
  assert.equal(element('prepareRoadButton').hidden, true);
  vm.runInContext('preparingRoads = false; scheduleRoadRetryTick();', context);
});

test('canceled preparation offers continuation without a completion estimate', () => {
  const { context, element } = rendererHarness();
  vm.runInContext(`mergeRoadPreparation({ state: 'canceled', status: 'canceled',
    stage: 'complete', routeCount: 169, targetRouteCount: 2000,
    estimatedRemainingMs: null, resumeAvailable: true });
    setControls();`, context);
  assert.equal(element('prepareRoadButton').textContent, 'Continue route build');
  assert.match(element('roadPreparationEta').textContent, /unavailable while the build is stopped/);
  assert.match(element('preparationProgress').textContent, /saved locally/);
});

test('coverage refresh restores terminal recovery guidance after restart', async () => {
  const { context, element } = rendererHarness();
  context.window.deviceFarm.getRoadCoverage = async () => ({
    packs: [], coverage: { status: 'not-ready' }, selectionValid: false,
    preparationEnabled: true, localRouterReady: true,
    preparationStatus: { state: 'blocked', status: 'search-stalled',
      resumeAvailable: false, stage: 'complete', routeCount: 169,
      targetRouteCount: 2000, attempts: 500, accepted: 0, rejected: 500 }
  });
  await vm.runInContext('refreshRoadCoverage()', context);
  assert.equal(element('prepareRoadButton').textContent, 'Adjust road region');
  assert.match(element('roadPreparationAdvice').textContent, /Change the base point or radius/);
  assert.match(element('roadRouteCount').textContent, /^169 \/ 2,000$/);
});

function partialCoverage({ movingCapacity = 750, parkedCapacity = 2250, ready = true } = {}) {
  return {
    packs: [{ regionId: 'default', digest: 'pack-a', routeCount: 500, integrity: 'verified' }],
    coverage: {
      status: ready ? 'ready' : 'reduced-diversity', ready,
      distinctRouteCount: 500, coveredZoneCount: 3, requiredZoneCount: 3,
      requestedMoving: 750, requestedParked: 2250,
      usableMovingCapacityEstimate: movingCapacity,
      parkedPositionCapacity: parkedCapacity,
      regions: [{ routeCount: 500, capacity: movingCapacity, requestedMoving: 750,
        parkedPositionCapacity: parkedCapacity, requestedParked: 2250 }],
      deficits: ready ? [] : ['default: needs more moving and parked positions']
    },
    selectionValid: true, preparationEnabled: true, localRouterReady: true,
    preparationStatus: { state: 'usable', status: 'usable', stage: 'complete',
      routeCount: 500, savedRouteCount: 500, targetRouteCount: 2000,
      resumeAvailable: true }
  };
}

test('500-route pack can start when actual fleet capacity and diversity are ready', async () => {
  const { context, element } = rendererHarness();
  vm.runInContext("settings.road.selectedRoutePackDigests = ['pack-a']", context);
  context.window.deviceFarm.getRoadCoverage = async () => partialCoverage();
  await vm.runInContext('refreshRoadCoverage()', context);
  assert.equal(element('startButton').disabled, false);
  assert.equal(element('roadPreparationBadge').textContent, 'Ready to transmit');
  assert.equal(element('prepareRoadButton').textContent, 'Add more routes (optional)');
  assert.equal(element('roadRouteBar').style.width, '25%');
  assert.match(element('roadFleetReadiness').textContent, /Ready for this fleet: 750 moving and 2,250 parked/);
  let prepareOptions;
  context.window.deviceFarm.prepareRoadRoutes = (options) => {
    prepareOptions = options;
    return new Promise(() => {});
  };
  vm.runInContext('prepareRoadRoutes()', context);
  assert.equal(prepareOptions.stopAtUsableRouteCount, false);
});

test('500 routes stay blocked when moving or parked capacity is short', async () => {
  const { context, element } = rendererHarness();
  vm.runInContext("settings.road.selectedRoutePackDigests = ['pack-a']", context);
  context.window.deviceFarm.getRoadCoverage = async () =>
    partialCoverage({ movingCapacity: 200, parkedCapacity: 800, ready: false });
  await vm.runInContext('refreshRoadCoverage()', context);
  assert.equal(element('startButton').disabled, true);
  assert.equal(element('roadPreparationBadge').textContent, 'More coverage needed');
  assert.match(element('roadFleetReadiness').textContent, /200 \/ 750 moving and 800 \/ 2,250 parked/);
  assert.match(element('roadStartHelpText').textContent, /Add routes or lower the device count/);
  assert.equal(element('prepareRoadButton').textContent, 'Prepare routes for this fleet');
});

test('initial build requests the early-use milestone and exposes saved-route pause', () => {
  const { context, element } = rendererHarness();
  let prepareOptions;
  context.window.deviceFarm.prepareRoadRoutes = (options) => {
    prepareOptions = options;
    return new Promise(() => {});
  };
  context.window.deviceFarm.cancelPreparation = async () => true;
  vm.runInContext('prepareRoadRoutes()', context);
  assert.equal(prepareOptions.stopAtUsableRouteCount, true);
  assert.equal(element('useSavedRoutesButton').hidden, true);
  vm.runInContext("mergeRoadPreparation({ stage: 'routes', routeCount: 120, savedRouteCount: 100 }); setControls();", context);
  assert.equal(element('useSavedRoutesButton').hidden, false);
  assert.match(element('roadFleetReadiness').textContent, /100 routes saved locally/);
  element('useSavedRoutesButton').listeners.click();
  assert.equal(element('useSavedRoutesButton').disabled, true);
  assert.equal(vm.runInContext('useSavedRoutesAfterPause', context), true);
});

test('pause and check saves result, selects its pack, then enables transmission', async () => {
  const { context, element } = rendererHarness();
  let finishPreparation;
  let selected;
  context.window.deviceFarm.prepareRoadRoutes = () => new Promise((resolve) => {
    finishPreparation = resolve;
  });
  context.window.deviceFarm.getSettings = async () => context.testSettings;
  context.window.deviceFarm.selectRoutePack = async (digests, options) => {
    selected = { digests, options };
    return { ...context.testSettings, road: {
      ...context.testSettings.road, selectedRoutePackDigests: digests
    } };
  };
  context.window.deviceFarm.getRoadCoverage = async () => partialCoverage();
  context.window.deviceFarm.cancelPreparation = async () => {
    finishPreparation({ status: 'canceled', routeCount: 500, savedRouteCount: 500,
      targetRouteCount: 2000, packDigests: ['pack-a'] });
    return true;
  };
  const preparation = vm.runInContext('prepareRoadRoutes()', context);
  vm.runInContext("mergeRoadPreparation({ stage: 'routes', routeCount: 500, savedRouteCount: 500 }); setControls();", context);
  element('useSavedRoutesButton').listeners.click();
  await preparation;
  assert.deepEqual(Array.from(selected.digests), ['pack-a']);
  assert.equal(selected.options.startFresh, false);
  assert.equal(element('startButton').disabled, false);
  assert.match(element('toast').textContent, /Saved routes are ready/);
  vm.runInContext('clearTimeout(toastTimer)', context);
});
