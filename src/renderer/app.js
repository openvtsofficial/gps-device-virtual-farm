'use strict';

const api = window.deviceFarm;
const MAX_TERMINAL_LINES = 500;

const elements = Object.fromEntries([
  'settingsButton', 'editTargetButton', 'settingsModal', 'settingsForm',
  'closeSettingsButton', 'cancelSettingsButton', 'hostInput', 'portInput',
  'latitudeInput', 'longitudeInput', 'connectionRateInput', 'logDetailInput',
  'deviceCount', 'movingCount', 'parkedCount', 'targetValue', 'startButton',
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
  elements.deviceCount.value = value.deviceCount;
  elements.targetValue.textContent = `${value.host}:${value.port}`;
  calculateComposition();
}

function readSettingsForm() {
  return {
    host: elements.hostInput.value.trim(),
    port: Number(elements.portInput.value),
    baseLatitude: Number(elements.latitudeInput.value),
    baseLongitude: Number(elements.longitudeInput.value),
    connectionRatePerSecond: Number(elements.connectionRateInput.value),
    logDetail: elements.logDetailInput.value,
    deviceCount: clampInteger(elements.deviceCount.value, 1, 50_000, 100)
  };
}

function showSettings() {
  if (running || busy) return;
  elements.settingsModal.hidden = false;
  requestAnimationFrame(() => elements.hostInput.focus());
}

function hideSettings() {
  elements.settingsModal.hidden = true;
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

function setControls() {
  const locked = running || busy;
  elements.deviceCount.disabled = locked;
  elements.settingsButton.disabled = locked;
  elements.editTargetButton.disabled = locked;
  elements.startButton.disabled = locked;
  elements.exportButton.disabled = busy;
  elements.stopButton.disabled = !running || busy;
}

async function startSimulation() {
  if (!api || running || busy) return;
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

elements.deviceCount.addEventListener('input', calculateComposition);
elements.settingsButton.addEventListener('click', showSettings);
elements.editTargetButton.addEventListener('click', showSettings);
elements.closeSettingsButton.addEventListener('click', hideSettings);
elements.cancelSettingsButton.addEventListener('click', hideSettings);
elements.settingsModal.addEventListener('click', (event) => {
  if (event.target === elements.settingsModal) hideSettings();
});
elements.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    settings = await api.saveSettings(readSettingsForm());
    elements.targetValue.textContent = `${settings.host}:${settings.port}`;
    hideSettings();
    showToast('Settings saved');
  } catch (error) {
    showToast(error.message || 'Settings could not be saved', true);
  }
});
elements.startButton.addEventListener('click', startSimulation);
elements.stopButton.addEventListener('click', stopSimulation);
elements.exportButton.addEventListener('click', exportImeis);
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

  Promise.all([api.getSettings(), api.getAppInfo()])
    .then(([savedSettings, appInfo]) => {
      applySettings(savedSettings);
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

