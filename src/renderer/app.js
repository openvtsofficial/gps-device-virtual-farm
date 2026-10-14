'use strict';

const api = window.deviceFarm;
const MAX_TERMINAL_LINES = 500;

const elements = Object.fromEntries([
  'settingsButton', 'editTargetButton', 'settingsModal', 'settingsForm',
  'closeSettingsButton', 'cancelSettingsButton', 'hostInput', 'portInput',
  'latitudeInput', 'longitudeInput', 'connectionRateInput', 'logDetailInput',
  'movementModeInput', 'scenarioSeedInput', 'roadRadiusInput', 'roadRegionsInput', 'roadDiversityGateInput',
  'roadControls', 'roadMaintenanceDetails', 'roadInlineStatus', 'roadInlineStatusText',
  'roadReadiness', 'roadCoverage', 'routePackSelect', 'roadSetupHelp',
  'prepareRoadButton', 'cancelPreparationButton', 'useSavedRoutesButton', 'roadSourceNote',
  'roadPreparationPanel', 'roadPreparationBadge', 'roadMapStep', 'roadGraphStep',
  'roadRoutesStep', 'preparationProgress', 'roadStageProgress', 'roadStageProgressLabel',
  'roadStageProgressValue', 'roadStageTrack', 'roadStageBar', 'roadRouteCount',
  'roadRouteTrack', 'roadRouteBar', 'roadRoutePercent', 'roadFleetReadiness', 'roadAttemptCount',
  'roadAcceptedCount', 'roadSkippedCount', 'roadPreparationSearch',
  'roadPreparationMix', 'roadPreparationEta',
  'roadPreparationAdvice', 'roadPreparationSavedNote',
  'deviceCount', 'movingCount', 'parkedCount', 'targetValue', 'startButton',
  'roadStartHelp', 'roadStartHelpText', 'openRoadSetupButton',
  'stopButton', 'exportButton', 'runtimeStatus', 'runtimeStatusText',
  'onlineMetric', 'onlineTotal', 'onlineProgress', 'onlinePercent',
  'connectedMetric', 'connectionSubtext', 'packetRateMetric', 'packetTotalMetric',
  'bandwidthMetric', 'bytesTotalMetric', 'reconnectMetric', 'backoffMetric',
  'errorMetric', 'malformedMetric', 'elapsedMetric', 'memoryMetric',
  'loginMetric', 'locationMetric', 'heartbeatMetric', 'ackMetric',
  'terminalPanel', 'terminalOutput', 'terminalLineCount', 'openLogButton',
  'clearTerminalButton', 'expandTerminalButton', 'collapseTerminalButton',
  'minimizeButton', 'maximizeButton', 'maximizeIcon', 'closeButton',
  'appVersion', 'toast'
].map((id) => [id, document.getElementById(id)]));

let settings = null;
let running = false;
let busy = false;
let terminalLines = 0;
let toastTimer = null;
let preparingRoads = false;
let roadPreparationEnabled = false;
let localRouterReady = false;
let roadPackInventory = null;
let roadCoverageResult = null;
let roadCoverageError = null;
let roadSelectionValid = false;
let roadCoverageRequest = 0;
let roadCoverageTimer = null;
let preparationStopRequested = false;
let useSavedRoutesAfterPause = false;
let roadRetryTimer = null;
let roadDownloadMeter = null;
let roadPreparation = { state: 'idle', status: null, stage: null, phase: null,
  routeCount: 0, targetRouteCount: 2000, attempts: 0, accepted: 0, rejected: 0,
  estimatedRemainingMs: null, composition: null };

function calculateComposition() {
  const total = clampInteger(elements.deviceCount.value, 1, 50_000, 100);
  const moving = Math.ceil(total * 0.25);
  elements.movingCount.textContent = formatInteger(moving);
  elements.parkedCount.textContent = formatInteger(total - moving);
  elements.onlineTotal.textContent = `/ ${formatInteger(total)}`;
}

function applySettings(value) {
  settings = value;
  elements.hostInput.value = value.host;
  elements.portInput.value = value.port;
  elements.latitudeInput.value = value.baseLatitude;
  elements.longitudeInput.value = value.baseLongitude;
  elements.connectionRateInput.value = value.connectionRatePerSecond;
  elements.logDetailInput.value = value.logDetail;
  elements.movementModeInput.value = value.movementMode || 'synthetic';
  elements.scenarioSeedInput.value = value.scenarioSeed || 'default';
  elements.roadRadiusInput.value = value.road?.radiusKm || 50;
  elements.roadDiversityGateInput.checked = value.road?.requireEnterpriseDiversityGate !== false;
  elements.roadRegionsInput.value = value.road?.regionMode === 'multi'
    ? JSON.stringify(value.road.regions, null, 2) : '';
  elements.deviceCount.value = value.deviceCount;
  elements.targetValue.textContent = `${value.host}:${value.port}`;
  calculateComposition();
  elements.roadMaintenanceDetails.hidden = true;
  elements.roadInlineStatus.hidden = value.movementMode !== 'real-road';
  roadCoverageResult = null;
  roadCoverageError = null;
  roadSelectionValid = false;
  localRouterReady = false;
  setControls();
}

function readSettingsForm() {
  const regionsText = elements.roadRegionsInput.value.trim();
  let regions = [];
  if (regionsText) {
    try { regions = JSON.parse(regionsText); }
    catch { throw new Error('Multiple regions must be a valid JSON array'); }
  }
  return {
    host: elements.hostInput.value.trim(),
    port: Number(elements.portInput.value),
    baseLatitude: Number(elements.latitudeInput.value),
    baseLongitude: Number(elements.longitudeInput.value),
    connectionRatePerSecond: Number(elements.connectionRateInput.value),
    logDetail: elements.logDetailInput.value,
    deviceCount: clampInteger(elements.deviceCount.value, 1, 50_000, 100),
    movementMode: elements.movementModeInput.value,
    scenarioSeed: elements.scenarioSeedInput.value.trim(),
    road: {
      ...settings.road,
      regionMode: regionsText ? 'multi' : 'single',
      radiusKm: Number(elements.roadRadiusInput.value),
      regions,
      requireEnterpriseDiversityGate: elements.roadDiversityGateInput.checked
    }
  };
}

function showSettings() {
  if (running || busy) return;
  elements.settingsModal.hidden = false;
  if (settings?.movementMode === 'real-road' && !preparingRoads) refreshRoadCoverage();
  requestAnimationFrame(() => elements.hostInput.focus());
}

function hideSettings() {
  elements.settingsModal.hidden = true;
}

function showRoadMaintenance() {
  if (running || busy || preparingRoads) return;
  showSettings();
}

function setStatus(status, message) {
  elements.runtimeStatus.className = `runtime-status ${status}`;
  const labels = {
    idle: 'Ready',
    starting: 'Starting…',
    running: 'Transmitting',
    stopping: 'Stopping…'
  };
  elements.runtimeStatusText.textContent = message || labels[status] || status;
}

function preparationStage(value) {
  const stage = value?.stage;
  if (['map', 'download', 'map-data'].includes(stage)) return 'map';
  if (['graph', 'road-graph'].includes(stage)) return 'graph';
  if (['routes', 'route', 'catalog', 'saving', 'complete'].includes(stage)) return 'routes';
  if (['map-index', 'map-select', 'download', 'downloaded'].includes(value?.phase)) return 'map';
  if (['clip', 'clipped', 'merge', 'merged', 'build', 'graph-ready'].includes(value?.phase)) return 'graph';
  if (['cache', 'request', 'rejected', 'accepted', 'saved', 'blocked'].includes(value?.phase)) return 'routes';
  return null;
}

function preparationLabel(value, stage) {
  if (preparationStopRequested && preparingRoads) return 'Pausing and saving verified routes…';
  if (preparingRoads && retrySecondsRemaining(value) > 0) {
    return `A temporary road-engine error occurred. Retrying in ${retrySecondsRemaining(value)} seconds; saved routes remain available.`;
  }
  if (!preparingRoads) {
    if (value.state === 'ready') return 'The optional route-library goal is complete.';
    if (value.state === 'usable') return 'An early-use route library was saved. Check current fleet readiness below; you can add routes later.';
    if (value.state === 'canceled') return 'Build paused. Verified routes are saved locally.';
    if (value.state === 'interrupted') return 'The previous build was interrupted. Continue from saved routes.';
    if (value.state === 'failed') return preparationReason(value) || 'The route build stopped after an error.';
    if (value.status === 'candidates-exhausted') return 'Search finished before reaching the optional library goal. Verified routes remain saved.';
    if (value.status === 'search-stalled') {
      return `Search paused after ${formatInteger(value.attemptsSinceAccepted || 500)} attempts without a new verified route.`;
    }
    if (value.status === 'request-limit') return 'This build pass reached its attempt limit.';
    if (value.state === 'blocked') return preparationReason(value) || 'The route build needs attention.';
    if (value.routeCount > 0) return 'Saved routes are available. Check fleet capacity, or continue expanding the library.';
    return 'Download roads for the saved region and build a local route library.';
  }
  if (value.phase === 'rejected') {
    return value.reason === 'overlapping-corridor'
      ? 'Skipped an overlapping route; searching for a distinct road path.'
      : 'Skipped an unusable route; searching for another path.';
  }
  if (value.phase === 'accepted') return 'Verified a distinct route on the local road graph.';
  if (value.phase === 'saved') return 'Saved newly verified routes to the local library.';
  if (value.phase === 'cache') return 'Checking saved routes before continuing.';
  if (value.phase === 'request') return 'Testing city, suburban and intercity road combinations.';
  if (value.phase === 'blocked') return preparationReason(value) || 'Waiting for the road engine to recover.';
  if (stage === 'map') return value.message || 'Finding and downloading the regional OpenStreetMap extract.';
  if (stage === 'graph') return value.message || 'Building a local routing graph for the saved region.';
  return value.message || 'Starting local route preparation…';
}

function formatApproximateTime(milliseconds) {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr`;
  return `${Math.round(hours / 24)} days`;
}

function retrySecondsRemaining(value) {
  if (!value?.retryAt) return 0;
  const retryAt = typeof value.retryAt === 'number' ? value.retryAt : Date.parse(value.retryAt);
  return Number.isFinite(retryAt) ? Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)) : 0;
}

function preparationReason(value) {
  const reason = value?.reason;
  return ({ 'provider-unavailable': 'The local road engine is temporarily unavailable.',
    'road-attributes-unavailable': 'Road-class verification is temporarily unavailable.',
    'graph-changed': 'The road graph changed during preparation. Continue using the current graph.',
    'rate-limited': 'The routing source has asked the app to slow down.',
    'BUDGET_EXHAUSTED': 'The request budget for this pass was reached.' })[reason] || reason || '';
}

function scheduleRoadRetryTick() {
  clearTimeout(roadRetryTimer);
  if (!preparingRoads || retrySecondsRemaining(roadPreparation) <= 0) return;
  roadRetryTimer = setTimeout(() => {
    renderRoadPreparation();
    scheduleRoadRetryTick();
  }, 1000);
}

function catalogRouteCount(packs, selectedDigests) {
  const selected = new Set(selectedDigests || []);
  const latestByRegion = new Map();
  for (const pack of packs || []) {
    if (pack.integrity === 'corrupt' || !selected.has(pack.digest)) continue;
    const current = latestByRegion.get(pack.regionId);
    if (!current || pack.routeCount > current.routeCount) latestByRegion.set(pack.regionId, pack);
  }
  return [...latestByRegion.values()].reduce((total, pack) => total + (pack.routeCount || 0), 0);
}

function renderRoadPreparation() {
  const visible = settings?.movementMode === 'real-road';
  elements.roadPreparationPanel.hidden = !visible;
  if (!visible) return;
  const value = roadPreparation;
  const state = preparingRoads ? 'running' : value.state || 'idle';
  const stage = preparationStage(value);
  const routeCount = Math.max(0, Number(value.routeCount) || 0);
  const savedRouteCount = Math.max(0, Number(value.savedRouteCount ?? (preparingRoads ? 0 : routeCount)) || 0);
  const target = Math.max(1, Number(value.targetRouteCount) || 2000);
  const percent = Math.min(100, Math.floor(routeCount / target * 100));
  const selectedPacks = settings.road?.selectedRoutePackDigests || [];
  const fleetReady = !preparingRoads && selectedPacks.length > 0 && roadStartBlocker() === null;
  const fleetChecked = !preparingRoads && selectedPacks.length > 0 &&
    roadCoverageResult && roadSelectionValid;
  elements.roadPreparationPanel.dataset.state = state;
  elements.roadPreparationBadge.textContent = fleetReady ? 'Ready to transmit' : preparingRoads
    ? preparationStopRequested ? 'Saving'
      : retrySecondsRemaining(value) > 0 ? 'Retrying'
        : ({ map: 'Downloading', graph: 'Building graph', routes: 'Verifying routes' })[stage] || 'Starting'
    : ({ ready: 'Goal reached', usable: fleetChecked ? 'More coverage needed' : 'Checking fleet', canceled: 'Paused',
      interrupted: 'Interrupted', blocked: 'Needs attention', failed: 'Error',
      incomplete: 'Routes saved' })[state] || (routeCount ? 'Routes saved' : 'Not started');
  const stageOrder = ['map', 'graph', 'routes'];
  for (const [index, element] of [elements.roadMapStep, elements.roadGraphStep, elements.roadRoutesStep].entries()) {
    const currentIndex = stageOrder.indexOf(stage);
    element.dataset.state = state === 'ready' ? 'done' : currentIndex < 0 ? '' : index < currentIndex
      ? 'done' : index === currentIndex && preparingRoads ? 'active' : '';
  }
  const detail = preparationLabel(value, stage);
  if (elements.preparationProgress.textContent !== detail) elements.preparationProgress.textContent = detail;
  elements.roadRouteCount.textContent = `${formatInteger(routeCount)} / ${formatInteger(target)}`;
  elements.roadRouteBar.style.width = `${percent}%`;
  elements.roadRouteTrack.setAttribute('aria-valuemax', String(target));
  elements.roadRouteTrack.setAttribute('aria-valuenow', String(Math.min(routeCount, target)));
  elements.roadRoutePercent.textContent = `${percent}% of optional goal · transmission can start sooner when saved routes support this fleet`;
  const coverage = roadCoverageResult;
  if (preparingRoads) {
    elements.roadFleetReadiness.textContent = savedRouteCount > 0
      ? `${formatInteger(savedRouteCount)} routes saved locally. Pause to check whether they support the current fleet.`
      : 'Saving the first verified routes. Fleet capacity will be checked when you pause.';
  } else if (fleetReady && coverage) {
    elements.roadFleetReadiness.textContent = `Ready for this fleet: ${formatInteger(coverage.requestedMoving || 0)} moving and ${formatInteger(coverage.requestedParked || 0)} parked vehicles. The 2,000-route goal is optional.`;
  } else if (selectedPacks.length > 0 && coverage && roadSelectionValid) {
    const capacityShort = coverage.usableMovingCapacityEstimate < coverage.requestedMoving ||
      coverage.parkedPositionCapacity < coverage.requestedParked ||
      coverage.regions?.some((region) => region.capacity < region.requestedMoving ||
        region.parkedPositionCapacity < region.requestedParked);
    elements.roadFleetReadiness.textContent = `Selected routes support ${formatInteger(coverage.usableMovingCapacityEstimate || 0)} / ${formatInteger(coverage.requestedMoving || 0)} moving and ${formatInteger(coverage.parkedPositionCapacity || 0)} / ${formatInteger(coverage.requestedParked || 0)} parked vehicles. ` +
      (capacityShort ? 'Add routes or lower the device count to start.'
        : `Route diversity still needs work: ${coverage.deficits?.[0] || 'add more distinct routes'}.`);
  } else if (routeCount > 0) {
    elements.roadFleetReadiness.textContent = selectedPacks.length > 0
      ? 'Checking selected routes against this fleet…'
      : 'Verified routes are saved. Select the latest pack in road settings to check this fleet, or add more routes later.';
  } else {
    elements.roadFleetReadiness.textContent = 'You can start before 2,000 routes once saved packs support the configured fleet.';
  }
  elements.roadFleetReadiness.dataset.state = fleetReady ? 'ready' : 'pending';
  elements.roadAttemptCount.textContent = formatInteger(value.attempts || 0) +
    (Number.isInteger(value.attemptBudget) && value.attemptBudget > 0 ? ` / ${formatInteger(value.attemptBudget)}` : '');
  elements.roadAcceptedCount.textContent = formatInteger(value.accepted || 0);
  elements.roadSkippedCount.textContent = formatInteger(value.rejected || 0);
  const metricsQualifier = preparingRoads ? 'this run' : 'last run';
  for (const [element, label] of [
    [elements.roadAttemptCount, 'Attempts'], [elements.roadAcceptedCount, 'Verified'],
    [elements.roadSkippedCount, 'Skipped']]) {
    element.previousElementSibling.textContent = `${label} ${metricsQualifier}`;
  }
  const searchDetails = [];
  if (Number.isInteger(value.planningRound) && value.planningRound > 0) {
    searchDetails.push(`Search round ${formatInteger(value.planningRound)}` +
      (Number.isInteger(value.planningRoundLimit) && value.planningRoundLimit > 0
        ? ` of ${formatInteger(value.planningRoundLimit)}` : ''));
  }
  if (Number.isInteger(value.remainingCandidates) && value.remainingCandidates >= 0) {
    searchDetails.push(`${formatInteger(value.remainingCandidates)} unused combinations remain in this round`);
  } else if (Number.isInteger(value.candidateCount) && value.candidateCount > 0) {
    searchDetails.push(`${formatInteger(value.candidateCount)} combinations planned`);
  }
  if (Number.isInteger(value.savedRouteCount) && value.savedRouteCount < routeCount) {
    searchDetails.push(`${formatInteger(value.savedRouteCount)} saved locally; new routes save at the next checkpoint`);
  }
  if (preparingRoads && Number.isInteger(value.attemptsSinceAccepted) &&
      value.attemptsSinceAccepted >= 50) {
    searchDetails.push(`${formatInteger(value.attemptsSinceAccepted)} attempts since the last new route`);
  }
  elements.roadPreparationSearch.hidden = searchDetails.length === 0;
  elements.roadPreparationSearch.textContent = searchDetails.join(' · ');

  const composition = value.composition;
  const intercityRequired = (settings.road?.regions || []).some((region) => region.radiusKm >= 50) ||
    (settings.road?.regionMode !== 'multi' && settings.road?.radiusKm >= 50);
  elements.roadPreparationMix.hidden = !composition || target < 100;
  if (composition && target >= 100) {
    elements.roadPreparationMix.textContent = `Optional library mix · City ${formatInteger(composition.cityRoutes || 0)}/${formatInteger(Math.ceil(target * .4))}` +
      ` · Suburban/regional ${formatInteger(composition.regionalRoutes || 0)}/${formatInteger(Math.ceil(target * .15))}` +
      (intercityRequired ? ` · Intercity ${formatInteger(composition.intercityRoutes || 0)}/${formatInteger(Math.ceil(target * .05))}` : '');
  }

  const bytes = Number(value.bytes);
  const totalBytes = Number(value.totalBytes);
  const hasDownloadProgress = preparingRoads && stage === 'map' &&
    Number.isFinite(bytes) && Number.isFinite(totalBytes) && totalBytes > 0;
  elements.roadStageProgress.hidden = !preparingRoads || stage === 'routes' || !stage;
  if (!elements.roadStageProgress.hidden) {
    elements.roadStageProgress.dataset.indeterminate = String(!hasDownloadProgress);
    elements.roadStageProgressLabel.textContent = stage === 'map' ? 'Current map download' : 'Road graph build';
    elements.roadStageProgressValue.textContent = hasDownloadProgress
      ? `${formatBytes(bytes)} / ${formatBytes(totalBytes)}` : 'Working…';
    elements.roadStageBar.style.width = hasDownloadProgress
      ? `${Math.min(100, Math.round(bytes / totalBytes * 100))}%` : '';
    if (hasDownloadProgress) {
      elements.roadStageTrack.setAttribute('aria-valuemin', '0');
      elements.roadStageTrack.setAttribute('aria-valuemax', String(totalBytes));
      elements.roadStageTrack.setAttribute('aria-valuenow', String(Math.min(bytes, totalBytes)));
      elements.roadStageTrack.removeAttribute('aria-valuetext');
    } else {
      elements.roadStageTrack.removeAttribute('aria-valuenow');
      elements.roadStageTrack.setAttribute('aria-valuetext', stage === 'map' ? 'Finding map data' : 'Building road graph');
    }
  }

  const estimate = Number(value.estimatedRemainingMs);
  if (preparingRoads && retrySecondsRemaining(value) > 0) {
    elements.roadPreparationEta.textContent = `Automatic retry in ${retrySecondsRemaining(value)} seconds` +
      (Number.isInteger(value.retryAttempt) && Number.isInteger(value.maxRetryAttempts)
        ? ` · attempt ${value.retryAttempt} of ${value.maxRetryAttempts}` : '') + '.';
  } else if (preparingRoads && routeCount >= target) {
    elements.roadPreparationEta.textContent = 'Optional route count met. Time to complete its road mix cannot be estimated yet.';
  } else if (preparingRoads && stage === 'routes' && Number.isFinite(estimate) && estimate > 0) {
    elements.roadPreparationEta.textContent = `Estimated time to optional library goal: about ${formatApproximateTime(estimate)} at the current verified-route rate. This can change.`;
  } else if (preparingRoads && stage === 'routes') {
    elements.roadPreparationEta.textContent = (value.attempts || 0) >= 50 && (value.accepted || 0) < 3
      ? 'Time remaining: cannot estimate from the current route yield.'
      : 'Time remaining: estimating after more routes are verified…';
  } else if (preparingRoads && stage === 'map' && Number.isFinite(value.estimatedDownloadRemainingMs) &&
      value.estimatedDownloadRemainingMs > 0 && roadDownloadMeter &&
      Date.now() - roadDownloadMeter.lastProgressAt < 15_000) {
    elements.roadPreparationEta.textContent = `Current map file: about ${formatApproximateTime(value.estimatedDownloadRemainingMs)} remaining. Road graph and route verification follow.`;
  } else if (preparingRoads) {
    elements.roadPreparationEta.textContent = 'Route estimate will appear after map and graph preparation.';
  } else {
    elements.roadPreparationEta.textContent = state === 'ready' ? 'Optional library goal completed.'
      : ['candidates-exhausted', 'search-stalled'].includes(value.status)
        ? 'Time remaining: no reliable estimate for this road region.'
        : 'Time remaining: unavailable while the build is stopped.';
  }

  let advice = '';
  if (!preparingRoads && value.selectionError) {
    advice = `Routes were saved, but the new pack could not be selected: ${value.selectionError}. Open road settings and choose the latest pack.`;
  } else if (!preparingRoads && value.status === 'candidates-exhausted') {
    advice = `${value.statusDetail || 'All available combinations for this road graph were checked.'} ${fleetReady ? 'Current saved routes remain ready for transmission. ' : ''}Change the base point or radius in Settings to search a different road area.`;
  } else if (!preparingRoads && value.status === 'search-stalled') {
    advice = `${value.statusDetail || 'The last search found no new distinct route after many attempts.'} ${fleetReady ? 'Current saved routes remain ready for transmission. ' : ''}Change the base point or radius in Settings before rebuilding.`;
  } else if (!preparingRoads && value.status === 'request-limit') {
    advice = 'This pass stopped at its attempt limit. Continue to search unused combinations; saved routes will not be rebuilt.';
  } else if (!preparingRoads && ['route-limit', 'geometry-limit'].includes(value.status)) {
    advice = 'The local catalog reached its storage limit. Review the saved region and route target before continuing.';
  } else if (!preparingRoads && ['failed', 'blocked', 'interrupted'].includes(state)) {
    advice = preparationReason(value) || 'Check the connection and available disk space, then retry. Routes already saved remain available.';
  } else if (!preparingRoads && routeCount >= target && state !== 'ready') {
    advice = 'The optional route count is met; its city and longer-route mix still needs work. Check fleet readiness above to transmit now.';
  }
  elements.roadPreparationAdvice.hidden = !advice;
  elements.roadPreparationAdvice.textContent = advice;
  elements.roadPreparationSavedNote.textContent = preparingRoads
    ? 'Pausing saves verified routes and checks this fleet’s capacity.'
    : 'Add routes later when needed. Selecting a newer pack assigns fresh road positions for the same IMEIs on the next run.';
}

function mergeRoadPreparation(progress, { restore = false } = {}) {
  if (!progress || typeof progress !== 'object') return;
  const previousStage = preparationStage(roadPreparation);
  const next = { ...roadPreparation };
  for (const [key, value] of Object.entries(progress)) {
    if (value !== undefined) next[key] = value;
  }
  if (progress.phase && progress.stage === undefined) {
    const inferredStage = preparationStage({ phase: progress.phase });
    if (inferredStage) next.stage = inferredStage;
  }
  if (restore && next.state === 'running') next.state = 'interrupted';
  if ((preparationStage(next) !== previousStage ||
      ['map-index', 'map-select', 'download'].includes(progress.phase)) &&
      progress.bytes === undefined) {
    next.bytes = null;
    next.totalBytes = null;
    next.estimatedDownloadRemainingMs = null;
    if (progress.phase === 'download' || progress.phase === 'map-select') roadDownloadMeter = null;
  }
  if (preparingRoads && next.phase === 'download' && Number.isFinite(progress.bytes) &&
      Number.isFinite(progress.totalBytes) && progress.totalBytes > 0) {
    const key = `${progress.extractName || ''}:${progress.sourceIndex || 1}`;
    const now = Date.now();
    if (!roadDownloadMeter || roadDownloadMeter.key !== key || progress.bytes < roadDownloadMeter.startBytes) {
      roadDownloadMeter = { key, startBytes: progress.bytes, startedAt: now, lastBytes: progress.bytes,
        lastProgressAt: now };
    }
    if (progress.bytes > roadDownloadMeter.lastBytes) {
      roadDownloadMeter.lastBytes = progress.bytes;
      roadDownloadMeter.lastProgressAt = now;
    }
    const elapsed = now - roadDownloadMeter.startedAt;
    const transferred = progress.bytes - roadDownloadMeter.startBytes;
    next.estimatedDownloadRemainingMs = elapsed >= 5000 && transferred >= 1024 ** 2 &&
      now - roadDownloadMeter.lastProgressAt < 15_000 && progress.bytes < progress.totalBytes
      ? (progress.totalBytes - progress.bytes) * elapsed / transferred : null;
  } else if (preparationStage(next) !== 'map') {
    roadDownloadMeter = null;
    next.estimatedDownloadRemainingMs = null;
  }
  roadPreparation = next;
  renderRoadPreparation();
  scheduleRoadRetryTick();
}

function preparationResultState(status) {
  if (status === 'ready') return 'ready';
  if (status === 'usable') return 'usable';
  if (status === 'canceled') return 'canceled';
  if (['candidates-exhausted', 'search-stalled', 'request-limit', 'incomplete'].includes(status)) return 'incomplete';
  if (['rate-limited', 'provider-unavailable', 'road-attributes-unavailable',
    'graph-changed', 'BUDGET_EXHAUSTED', 'PROVIDER_DISABLED', 'PROVIDER_COOLDOWN'].includes(status)) return 'blocked';
  return status ? 'blocked' : 'incomplete';
}

function setControls() {
  const locked = running || busy || preparingRoads;
  const roadBlocker = roadStartBlocker();
  const fleetReady = settings?.movementMode === 'real-road' && roadBlocker === null;
  const preparationStatus = roadPreparation.status;
  const needsRegionChange = roadPreparation.resumeAvailable === false &&
    ['candidates-exhausted', 'search-stalled', 'route-limit', 'geometry-limit'].includes(preparationStatus);
  elements.deviceCount.disabled = locked;
  elements.settingsButton.disabled = running || busy;
  elements.editTargetButton.disabled = locked;
  elements.startButton.disabled = locked || Boolean(roadBlocker);
  elements.startButton.title = roadBlocker || '';
  elements.exportButton.disabled = busy;
  elements.stopButton.disabled = !running || busy;
  elements.routePackSelect.disabled = locked;
  elements.prepareRoadButton.disabled = locked || (!roadPreparationEnabled && !needsRegionChange);
  elements.prepareRoadButton.hidden = preparingRoads;
  elements.cancelPreparationButton.hidden = !preparingRoads;
  elements.cancelPreparationButton.disabled = preparationStopRequested;
  elements.useSavedRoutesButton.hidden = !preparingRoads ||
    Math.max(0, Number(roadPreparation.savedRouteCount) || 0) === 0;
  elements.useSavedRoutesButton.disabled = preparationStopRequested;
  elements.settingsForm.querySelector('[type="submit"]').disabled = preparingRoads;
  elements.roadStartHelp.hidden = !roadBlocker || settings?.movementMode !== 'real-road';
  elements.roadStartHelpText.textContent = roadBlocker || '';
  elements.openRoadSetupButton.disabled = locked;
  elements.roadSetupHelp.textContent = roadSetupInstructions();
  let preparationAction = 'Build local routes';
  if (needsRegionChange) preparationAction = 'Adjust road region';
  else if (fleetReady && (roadPreparation.routeCount || 0) < (roadPreparation.targetRouteCount || 2000)) {
    preparationAction = 'Add more routes (optional)';
  } else if (['blocked', 'failed'].includes(roadPreparation.state)) preparationAction = 'Retry route build';
  else if (['canceled', 'interrupted'].includes(roadPreparation.state)) {
    preparationAction = (roadPreparation.routeCount || 0) > 0
      ? 'Continue route build' : 'Resume road preparation';
  } else if (roadPreparation.state === 'ready') preparationAction = 'Recheck route library';
  else if (!localRouterReady && (roadPreparation.routeCount || 0) === 0) {
    preparationAction = 'Download roads and build routes';
  } else if ((roadPreparation.routeCount || 0) > 0) preparationAction = 'Prepare routes for this fleet';
  elements.prepareRoadButton.textContent = preparationAction;
  if (settings?.movementMode === 'real-road') {
    const status = preparingRoads ? 'preparing'
      : roadCoverageError ? 'blocked'
        : !roadCoverageResult ? 'checking' : roadBlocker ? 'blocked' : 'ready';
    elements.roadInlineStatus.className = `road-inline-status ${status}`;
    elements.roadInlineStatusText.textContent = {
      preparing: preparationStopRequested ? 'Saving routes before pause…' : 'Preparing local road routes…',
      checking: 'Checking local roads…',
      blocked: roadCoverageError ? 'Road data check failed' : 'Road routes need attention',
      ready: 'Ready to transmit with saved routes'
    }[status];
  }
  renderRoadPreparation();
}

function roadStartBlocker() {
  if (settings?.movementMode !== 'real-road') return null;
  const selected = settings.road?.selectedRoutePackDigests || [];
  if (selected.length === 0) return 'Select saved route packs for this fleet, or prepare routes from your chosen region.';
  if (roadCoverageError) return `Route library check failed: ${roadCoverageError}`;
  if (!roadCoverageResult) return 'Checking selected road routes before starting…';
  if (!roadSelectionValid) return 'Prepare verified road routes for every configured region.';
  const coverage = roadCoverageResult;
  const requiredRegions = settings.road?.regions?.length || 1;
  if (selected.length !== requiredRegions || coverage.regions?.some((region) => region.routeCount === 0)) {
    return 'Prepare verified road routes for every configured region.';
  }
  const hardCapacityDeficit = coverage.usableMovingCapacityEstimate < coverage.requestedMoving ||
    coverage.parkedPositionCapacity < coverage.requestedParked ||
    coverage.regions?.some((region) => region.capacity < region.requestedMoving ||
      region.parkedPositionCapacity < region.requestedParked);
  if (hardCapacityDeficit) {
    return `Saved routes support ${formatInteger(coverage.usableMovingCapacityEstimate || 0)} / ${formatInteger(coverage.requestedMoving || 0)} moving and ${formatInteger(coverage.parkedPositionCapacity || 0)} / ${formatInteger(coverage.requestedParked || 0)} parked vehicles. Add routes or lower the device count.`;
  }
  if (settings.road?.requireEnterpriseDiversityGate && !coverage.ready) {
    return `Road diversity needs attention: ${coverage.deficits?.[0] || 'add more verified routes for this fleet'}`;
  }
  return null;
}

function roadSetupInstructions() {
  if (settings?.movementMode !== 'real-road') return '';
  const selected = settings.road?.selectedRoutePackDigests || [];
  if (selected.length > 0) return roadStartBlocker() || 'Verified route packs selected. Ready to transmit; you can add routes later.';
  if (roadPackInventory === null) return 'Checking the local route library…';
  if (roadPackInventory.some((pack) => pack.integrity !== 'corrupt')) {
    return 'Select one verified pack for each configured region. Routes stay pinned until you change the selection.';
  }
  if (roadPreparationEnabled) {
    if (localRouterReady) return 'Build a verified local road catalog from the saved region settings.';
    return 'No verified road routes are installed. Press Prepare road routes, then review the coverage result.';
  }
  return 'The bundled road engine is unavailable. Reinstall the Windows desktop app.';
}

async function refreshRoadCoverage() {
  if (!api || !settings) return;
  const request = ++roadCoverageRequest;
  roadCoverageResult = null;
  roadCoverageError = null;
  roadSelectionValid = false;
  setControls();
  try {
    const result = await api.getRoadCoverage({ deviceCount: Number(elements.deviceCount.value) });
    if (request !== roadCoverageRequest) return;
    roadPackInventory = result.packs || [];
    const selected = new Set(settings.road?.selectedRoutePackDigests || []);
    elements.routePackSelect.replaceChildren();
    if (roadPackInventory.length === 0) {
      const empty = document.createElement('option');
      empty.textContent = 'No prepared route packs';
      empty.disabled = true;
      elements.routePackSelect.append(empty);
    }
    for (const pack of roadPackInventory) {
      const option = document.createElement('option');
      option.value = pack.digest;
      option.textContent = pack.integrity === 'corrupt'
        ? `${pack.regionId} · corrupt pack · ${pack.digest.slice(0, 10)}`
        : `${pack.regionId} · ${pack.routeCount} routes · ${pack.digest.slice(0, 10)}`;
      option.disabled = pack.integrity === 'corrupt';
      option.selected = selected.has(pack.digest);
      elements.routePackSelect.append(option);
    }
    const coverage = result.coverage || {};
    roadCoverageResult = coverage;
    roadSelectionValid = result.selectionValid === true;
    elements.roadCoverage.textContent =
      `${coverage.distinctRouteCount || 0} distinct routes selected · moving capacity ${coverage.usableMovingCapacityEstimate || 0}/${coverage.requestedMoving || 0} · parked positions ≥50 m apart ${coverage.parkedPositionCapacity || 0}/${coverage.requestedParked || 0} · ${coverage.coveredZoneCount || 0}/${coverage.requiredZoneCount || 0} zones` +
      (coverage.deficits?.length ? ` · ${coverage.deficits[0]}` : '');
    elements.prepareRoadButton.title = result.preparationMessage || '';
    elements.roadSourceNote.textContent = result.preparationMessage || '';
    roadPreparationEnabled = result.preparationEnabled === true;
    localRouterReady = result.localRouterReady === true;
    elements.roadReadiness.textContent = roadStartBlocker() === null
      ? 'Ready for this fleet'
      : selected.size > 0 ? 'Fleet needs more coverage' : 'Select saved routes';
    if (!preparingRoads) {
      if (result.preparationStatus) {
        mergeRoadPreparation(result.preparationStatus, { restore: true });
      } else {
        const routeCount = catalogRouteCount(roadPackInventory,
          settings.road?.selectedRoutePackDigests);
        roadPreparation = { state: routeCount ? 'incomplete' : 'idle', status: null,
          stage: null, phase: null, routeCount, targetRouteCount: 2000,
          attempts: 0, accepted: 0, rejected: 0, estimatedRemainingMs: null,
          composition: null, bytes: null, totalBytes: null };
      }
    }
    setControls();
  } catch (error) {
    if (request !== roadCoverageRequest) return;
    roadPreparationEnabled = false;
    localRouterReady = false;
    roadCoverageError = error.message || 'Could not inspect route packs';
    roadSelectionValid = false;
    elements.roadReadiness.textContent = 'Coverage unavailable';
    elements.roadCoverage.textContent = roadCoverageError;
    elements.roadSourceNote.textContent = '';
    setControls();
  }
}

function scheduleRoadCoverageRefresh() {
  clearTimeout(roadCoverageTimer);
  if (settings?.movementMode === 'real-road') {
    roadCoverageTimer = setTimeout(refreshRoadCoverage, 350);
  }
}

async function selectRoadPacks() {
  if (!api || !settings || running || busy || preparingRoads) return;
  busy = true;
  setControls();
  try {
    const digests = Array.from(elements.routePackSelect.selectedOptions, (option) => option.value);
    const previous = settings.road?.selectedRoutePackDigests || [];
    const changed = previous.length > 0 && previous.join('|') !== digests.join('|');
    if (changed && !window.confirm('Changing route packs starts fresh road positions for the same IMEIs. Continue?')) {
      await refreshRoadCoverage();
      return;
    }
    settings = await api.selectRoutePack(digests, { startFresh: changed });
    await refreshRoadCoverage();
  } catch (error) {
    showToast(error.message || 'Route pack selection failed', true);
    await refreshRoadCoverage();
  } finally {
    busy = false;
    setControls();
  }
}

async function prepareRoadRoutes() {
  if (!api || running || busy || preparingRoads) return;
  try {
    const form = readSettingsForm();
    const savedRegions = settings.road?.regionMode === 'multi' ? settings.road.regions : [];
    if (form.movementMode !== settings.movementMode ||
        form.baseLatitude !== settings.baseLatitude ||
        form.baseLongitude !== settings.baseLongitude ||
        form.road.radiusKm !== settings.road?.radiusKm ||
        form.road.regionMode !== settings.road?.regionMode ||
        JSON.stringify(form.road.regions) !== JSON.stringify(savedRegions)) {
      throw new Error('Save location and road settings before preparing routes.');
    }
  } catch (error) {
    showToast(error.message || 'Save road settings before preparing routes.', true);
    return;
  }
  const requestedDeviceCount = clampInteger(elements.deviceCount.value, 1, 50_000, 100);
  const stopAtUsableRouteCount = roadStartBlocker() !== null ||
    requestedDeviceCount !== settings.deviceCount;
  preparingRoads = true;
  preparationStopRequested = false;
  useSavedRoutesAfterPause = false;
  roadDownloadMeter = null;
  roadPreparation = { ...roadPreparation, state: 'running', status: null,
    stage: 'map', phase: 'map-index', message: 'Finding map data for your saved region…',
    attempts: 0, accepted: 0, rejected: 0, estimatedRemainingMs: null,
    bytes: null, totalBytes: null, selectionError: null, reason: null };
  setControls();
  try {
    if (requestedDeviceCount !== settings.deviceCount) {
      settings = await api.saveSettings({ deviceCount: requestedDeviceCount });
    }
    const result = await api.prepareRoadRoutes({ source: 'local', targetRouteCount: 2000,
      stopAtUsableRouteCount });
    mergeRoadPreparation({ ...result, state: preparationResultState(result.status),
      stage: 'routes', phase: result.status, estimatedRemainingMs: null,
      bytes: null, totalBytes: null });
    settings = await api.getSettings();
    const packDigests = result.packDigests || [];
    const configuredRegions = settings.road?.regions?.length || 1;
    let selectionError = null;
    let newPackSelected = false;
    if (packDigests.length === configuredRegions &&
        (settings.road?.selectedRoutePackDigests || []).join('|') !== packDigests.join('|')) {
      try {
        const replacesSelectedPack = (settings.road?.selectedRoutePackDigests || []).length > 0;
        settings = await api.selectRoutePack(packDigests, {
          startFresh: replacesSelectedPack
        });
        newPackSelected = replacesSelectedPack;
      } catch (error) {
        selectionError = error.message || 'Automatic route pack selection failed';
      }
    }
    applySettings(settings);
    await refreshRoadCoverage();
    if (selectionError) mergeRoadPreparation({ selectionError });
    if (useSavedRoutesAfterPause && !selectionError) {
      showToast(roadStartBlocker() === null
        ? 'Saved routes are ready. You can start transmission now.'
        : 'Saved routes were checked. Add routes or lower the device count to support this fleet.');
    } else if (newPackSelected && !selectionError) {
      showToast('More routes selected. Vehicle road positions will be reassigned on the next transmission.');
    }
  } catch (error) {
    const message = (error.message || 'Route preparation failed')
      .replace(/^Error invoking remote method 'road:prepare': Error: /, '');
    if (preparationStopRequested || error.name === 'AbortError' || /\babort(ed)?\b/i.test(message)) {
      mergeRoadPreparation({ state: 'canceled', status: 'canceled', reason: null,
        estimatedRemainingMs: null });
    } else {
      mergeRoadPreparation({ state: 'failed', status: 'failed', reason: message,
        estimatedRemainingMs: null });
      showToast(message, true);
    }
  } finally {
    preparingRoads = false;
    preparationStopRequested = false;
    useSavedRoutesAfterPause = false;
    roadDownloadMeter = null;
    scheduleRoadRetryTick();
    setControls();
  }
}

async function startSimulation() {
  if (!api || running || busy) return;
  const roadBlocker = roadStartBlocker();
  if (roadBlocker) {
    showRoadMaintenance();
    showToast(roadBlocker, true);
    return;
  }
  busy = true;
  setStatus('starting');
  setControls();
  try {
    const config = {
      ...settings,
      deviceCount: clampInteger(elements.deviceCount.value, 1, 50_000, 100)
    };
    settings = await api.saveSettings(config);
    const metrics = await api.start(config);
    running = true;
    setStatus('running');
    updateMetrics(metrics);
  } catch (error) {
    setStatus('idle');
    showToast(error.message || 'Unable to start transmission', true);
  } finally {
    busy = false;
    setControls();
  }
}

async function stopSimulation() {
  if (!api || !running || busy) return;
  busy = true;
  setStatus('stopping');
  setControls();
  try {
    const metrics = await api.stop();
    if (metrics) updateMetrics(metrics);
  } catch (error) {
    showToast(error.message || 'Unable to stop transmission', true);
  } finally {
    running = false;
    busy = false;
    setStatus('idle');
    setControls();
  }
}

async function exportImeis() {
  if (!api || busy) return;
  try {
    const result = await api.exportImeis({
      ...settings,
      deviceCount: clampInteger(elements.deviceCount.value, 1, 50_000, 100)
    });
    if (!result.canceled) showToast('IMEI list exported successfully');
  } catch (error) {
    showToast(error.message || 'IMEI export failed', true);
  }
}

function updateMetrics(metrics) {
  if (!metrics) return;
  const total = metrics.totalDevices || clampInteger(elements.deviceCount.value, 1, 50_000, 100);
  elements.onlineMetric.textContent = formatInteger(metrics.online || 0);
  elements.onlineTotal.textContent = `/ ${formatInteger(total)}`;
  elements.onlineProgress.style.width = `${Math.min(100, metrics.onlinePercent || 0)}%`;
  elements.onlinePercent.textContent = `${metrics.onlinePercent || 0}% login acknowledged`;
  elements.connectedMetric.textContent = formatInteger(metrics.tcpConnected || 0);
  elements.connectionSubtext.textContent = `${formatInteger(metrics.waitingForLoginAck || 0)} awaiting login ACK`;
  elements.packetRateMetric.textContent = formatDecimal(metrics.packetsPerSecond || 0);
  elements.packetTotalMetric.textContent = `${formatInteger(metrics.packetsSent || 0)} packets sent`;
  elements.bandwidthMetric.textContent = `${formatBytes(metrics.bytesPerSecond || 0)}/s`;
  elements.bytesTotalMetric.textContent = `${formatBytes(metrics.bytesSent || 0)} total`;
  elements.reconnectMetric.textContent = formatInteger(metrics.reconnects || 0);
  elements.backoffMetric.textContent = `${formatInteger(metrics.backoff || 0)} waiting`;
  elements.errorMetric.textContent = formatInteger(metrics.errors || 0);
  elements.malformedMetric.textContent = `${formatInteger(metrics.malformedFrames || 0)} malformed frames`;
  elements.elapsedMetric.textContent = formatDuration(metrics.elapsedMs || 0);
  elements.memoryMetric.textContent = formatBytes(metrics.memoryRssBytes || 0);
  elements.loginMetric.textContent = formatInteger(metrics.loginPackets || 0);
  elements.locationMetric.textContent = formatInteger(metrics.locationPackets || 0);
  elements.heartbeatMetric.textContent = formatInteger(metrics.heartbeatPackets || 0);
  elements.ackMetric.textContent = formatInteger(metrics.acknowledgements || 0);
}

function appendLog(entry) {
  const empty = elements.terminalOutput.querySelector('.terminal-empty');
  if (empty) empty.remove();
  const line = document.createElement('div');
  line.className = 'log-line';
  const time = new Date(entry.timestamp || Date.now()).toLocaleTimeString([], { hour12: false });
  const details = entry.details ? ` ${safeStringify(entry.details)}` : '';
  line.innerHTML = '';
  line.append(
    makeSpan('log-time', time),
    makeSpan(`log-level ${entry.level || 'info'}`, String(entry.level || 'info').toUpperCase()),
    makeSpan('log-source', entry.source || 'Application'),
    makeSpan('log-message', `${entry.message || ''}${details}`)
  );
  elements.terminalOutput.append(line);
  terminalLines += 1;
  while (elements.terminalOutput.children.length > MAX_TERMINAL_LINES) {
    elements.terminalOutput.firstElementChild.remove();
    terminalLines -= 1;
  }
  elements.terminalLineCount.textContent = `${terminalLines} ${terminalLines === 1 ? 'line' : 'lines'}`;
  elements.terminalOutput.scrollTop = elements.terminalOutput.scrollHeight;
}

function clearTerminal() {
  elements.terminalOutput.replaceChildren();
  const empty = document.createElement('div');
  empty.className = 'terminal-empty';
  empty.textContent = 'Terminal cleared. New events will appear here.';
  elements.terminalOutput.append(empty);
  terminalLines = 0;
  elements.terminalLineCount.textContent = '0 lines';
}

function toggleTerminalExpanded() {
  elements.terminalPanel.classList.remove('collapsed');
  elements.terminalPanel.classList.toggle('expanded');
}

function toggleTerminalCollapsed() {
  elements.terminalPanel.classList.remove('expanded');
  elements.terminalPanel.classList.toggle('collapsed');
}

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast${isError ? ' error' : ''}`;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 4_000);
}

function makeSpan(className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

function safeStringify(value) {
  try { return JSON.stringify(value); } catch { return '[unserializable details]'; }
}

function formatInteger(value) {
  return new Intl.NumberFormat().format(Math.round(Number(value) || 0));
}

function formatDecimal(value) {
  const number = Number(value) || 0;
  return number >= 100 ? formatInteger(number) : number.toFixed(number < 10 ? 1 : 0);
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

elements.deviceCount.addEventListener('input', () => {
  calculateComposition();
  if (settings?.movementMode === 'real-road') {
    roadCoverageResult = null;
    roadSelectionValid = false;
    setControls();
    scheduleRoadCoverageRefresh();
  }
});
elements.settingsButton.addEventListener('click', showSettings);
elements.editTargetButton.addEventListener('click', showSettings);
elements.closeSettingsButton.addEventListener('click', hideSettings);
elements.cancelSettingsButton.addEventListener('click', hideSettings);
elements.settingsModal.addEventListener('click', (event) => {
  if (event.target === elements.settingsModal) hideSettings();
});
elements.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (preparingRoads) return;
  try {
    const next = readSettingsForm();
    if (settings.movementMode !== 'real-road' && next.movementMode === 'real-road' &&
        !window.confirm('Starting real-road mode places devices on verified cached roads. Their previous synthetic positions cannot be carried onto those roads. Continue?')) return;
    if (settings.movementMode === 'real-road' && settings.scenarioSeed !== next.scenarioSeed &&
        !window.confirm('Changing the scenario seed starts fresh road positions for the same IMEIs. Continue?')) return;
    settings = await api.saveSettings(next);
    elements.targetValue.textContent = `${settings.host}:${settings.port}`;
    applySettings(settings);
    await refreshRoadCoverage();
    hideSettings();
    showToast('Settings saved');
  } catch (error) {
    showToast(error.message || 'Settings could not be saved', true);
  }
});
elements.startButton.addEventListener('click', startSimulation);
elements.stopButton.addEventListener('click', stopSimulation);
elements.exportButton.addEventListener('click', exportImeis);
elements.routePackSelect.addEventListener('change', selectRoadPacks);
elements.prepareRoadButton.addEventListener('click', () => {
  if (roadPreparation.resumeAvailable === false &&
      ['candidates-exhausted', 'search-stalled', 'route-limit', 'geometry-limit'].includes(roadPreparation.status)) {
    showSettings();
    (settings.road?.regionMode === 'multi' ? elements.roadRegionsInput : elements.roadRadiusInput).focus();
    return;
  }
  prepareRoadRoutes();
});
async function pauseRoadPreparation(checkSavedRoutes = false) {
  if (!api || !preparingRoads || preparationStopRequested) return;
  useSavedRoutesAfterPause = checkSavedRoutes;
  preparationStopRequested = true;
  setControls();
  try { await api.cancelPreparation(); }
  catch (error) {
    preparationStopRequested = false;
    useSavedRoutesAfterPause = false;
    setControls();
    showToast(error.message || 'Could not pause route preparation', true);
  }
}
elements.cancelPreparationButton.addEventListener('click', () => pauseRoadPreparation());
elements.useSavedRoutesButton.addEventListener('click', () => pauseRoadPreparation(true));
elements.openRoadSetupButton.addEventListener('click', () => {
  showRoadMaintenance();
});
elements.clearTerminalButton.addEventListener('click', clearTerminal);
elements.expandTerminalButton.addEventListener('click', toggleTerminalExpanded);
elements.collapseTerminalButton.addEventListener('click', toggleTerminalCollapsed);
elements.openLogButton.addEventListener('click', () => api?.showLogFile());
elements.minimizeButton.addEventListener('click', () => api?.minimizeWindow());
elements.maximizeButton.addEventListener('click', () => api?.toggleMaximizeWindow());
elements.closeButton.addEventListener('click', () => api?.closeWindow());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !elements.settingsModal.hidden) hideSettings();
});
document.addEventListener('click', (event) => {
  if (event.target.tagName === 'A' && event.target.href) {
    event.preventDefault();
    api?.openExternal(event.target.href);
  }
});

if (api) {
  api.onMetrics(updateMetrics);
  api.onLog(appendLog);
  api.onState((state) => {
    if (state.status === 'idle' && running && state.error) running = false;
    setStatus(state.status || 'idle');
    if (state.error) showToast(state.error, true);
    setControls();
  });
  api.onWindowMaximized((maximized) => {
    elements.maximizeButton.title = maximized ? 'Restore' : 'Maximize';
    elements.maximizeButton.setAttribute('aria-label', maximized ? 'Restore window' : 'Maximize window');
  });
  api.onRoadPreparationProgress((progress) => {
    if (!preparingRoads) return;
    mergeRoadPreparation({ ...progress, state: 'running' });
    setControls();
  });

  Promise.all([api.getSettings(), api.getAppInfo()])
    .then(([savedSettings, appInfo]) => {
      applySettings(savedSettings);
      refreshRoadCoverage();
      elements.appVersion.textContent = `v${appInfo.version}`;
      setControls();
    })
    .catch((error) => showToast(error.message || 'Application initialization failed', true));
} else {
  setStatus('idle', 'Desktop bridge unavailable');
  elements.startButton.disabled = true;
  appendLog({
    level: 'error',
    source: 'Renderer',
    message: 'Electron preload bridge was not found'
  });
}

