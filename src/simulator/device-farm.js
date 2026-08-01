'use strict';

const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const { validateConfig } = require('./config');
const { DeviceSession, SessionState } = require('./device-session');
const { generateImei, movingDeviceCount } = require('./imei');
const { MinHeap } = require('./min-heap');

const MAX_ACTIONS_PER_PUMP = 5_000;
const MAX_PUMP_DELAY_MS = 100;

class DeviceFarm extends EventEmitter {
  constructor(inputConfig, dependencies = {}) {
    super();
    this.config = validateConfig(inputConfig);
    this.netModule = dependencies.netModule;
    this.now = dependencies.now || Date.now;
    this.running = false;
    this.status = 'idle';
    this.sessions = [];
    this.heap = new MinHeap((left, right) => left.at - right.at || left.index - right.index);
    this.pumpTimer = null;
    this.metricsTimer = null;
    this.startedAt = 0;
    this.stoppedAt = 0;
    this.lastSnapshotAt = 0;
    this.lastSnapshotPackets = 0;
    this.lastSnapshotBytes = 0;
    this.stats = this.#newStats();
    this.stateCounts = Object.fromEntries(Object.values(SessionState).map((state) => [state, 0]));
  }

  start() {
    if (this.running) return this.snapshot();
    this.running = true;
    this.status = 'starting';
    this.startedAt = this.now();
    this.lastSnapshotAt = this.startedAt;
    this.stoppedAt = 0;

    const movingCount = movingDeviceCount(this.config.deviceCount, this.config.movingPercent);
    this.stats.totalDevices = this.config.deviceCount;
    this.stats.movingDevices = movingCount;
    this.stats.parkedDevices = this.config.deviceCount - movingCount;

    this.emitLog('info', 'Farm', 'Creating virtual GT06 device population', {
      devices: this.config.deviceCount,
      moving: movingCount,
      parked: this.config.deviceCount - movingCount,
      destination: `${this.config.host}:${this.config.port}`
    });

    if (this.config.deviceCount >= 10_000) {
      this.emitLog('warn', 'Farm', 'Large socket test requested; verify client ephemeral ports and open-file limits');
    }

    const intervalPerConnection = 1_000 / this.config.connectionRatePerSecond;
    this.sessions = new Array(this.config.deviceCount);
    for (let index = 0; index < this.config.deviceCount; index += 1) {
      const session = new DeviceSession({
        index,
        total: this.config.deviceCount,
        imei: generateImei(index),
        moving: index < movingCount,
        farm: this,
        ...(this.netModule ? { netModule: this.netModule } : {})
      });
      this.sessions[index] = session;
      this.stateCounts[SessionState.PENDING] += 1;
      session.schedule(this.startedAt + Math.floor(index * intervalPerConnection));
    }

    this.status = 'running';
    this.emitLog('info', 'Farm', 'Transmission started', {
      connectionRatePerSecond: this.config.connectionRatePerSecond
    });
    this.#schedulePump(0);
    this.metricsTimer = setInterval(() => this.emit('metrics', this.snapshot()), this.config.metricsIntervalMs);
    return this.snapshot();
  }

  async stop() {
    if (!this.running && this.status === 'idle') return this.snapshot();
    this.status = 'stopping';
    this.running = false;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    this.pumpTimer = null;
    this.metricsTimer = null;
    this.heap.clear();

    for (let start = 0; start < this.sessions.length; start += 1_000) {
      const end = Math.min(start + 1_000, this.sessions.length);
      for (let index = start; index < end; index += 1) {
        this.sessions[index].dispose();
      }
      if (end < this.sessions.length) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    this.stoppedAt = this.now();
    this.status = 'idle';
    const finalSnapshot = this.snapshot();
    this.emitLog('info', 'Farm', 'Transmission stopped', {
      packetsSent: finalSnapshot.packetsSent,
      bytesSent: finalSnapshot.bytesSent,
      errors: finalSnapshot.errors
    });
    this.emit('metrics', finalSnapshot);
    return finalSnapshot;
  }

  schedule(session, at, version) {
    if (!this.running) return;
    this.heap.push({
      at,
      version,
      session,
      index: session.index
    });
  }

  setSessionState(previous, next) {
    if (this.stateCounts[previous] > 0) this.stateCounts[previous] -= 1;
    this.stateCounts[next] += 1;
  }

  recordSocketDelta(delta) {
    this.stats.tcpConnected = Math.max(0, this.stats.tcpConnected + delta);
  }

  recordPacket(type, bytes) {
    this.stats.packetsSent += 1;
    this.stats.bytesSent += bytes;
    if (type === 'login') this.stats.loginPackets += 1;
    if (type === 'heartbeat') this.stats.heartbeatPackets += 1;
    if (type === 'location') this.stats.locationPackets += 1;
    if (type === 'commandResponse') this.stats.commandResponses += 1;
  }

  recordAcknowledgement() {
    this.stats.acknowledgements += 1;
  }

  recordBytesReceived(bytes) {
    this.stats.bytesReceived += bytes;
  }

  recordMalformed(count = 1) {
    this.stats.malformedFrames += count;
  }

  recordReconnect() {
    this.stats.reconnects += 1;
  }

  recordError() {
    this.stats.errors += 1;
  }

  logDevice(session, level, message, details) {
    const important = level === 'error' || level === 'warn';
    const sampledImportant = important && (session.index < 10 || this.stats.errors % 100 === 0);
    const sampledInfo = !important && session.index < 5;
    if (this.config.logDetail === 'detailed' || sampledImportant || sampledInfo) {
      this.emitLog(level, `GT06:${session.imei}`, message, details);
    }
  }

  emitLog(level, source, message, details) {
    this.emit('log', {
      timestamp: new Date().toISOString(),
      level,
      source,
      message,
      ...(details ? { details } : {})
    });
  }

  snapshot() {
    const now = this.now();
    const elapsedSinceSnapshot = Math.max(1, now - this.lastSnapshotAt);
    const packetDelta = this.stats.packetsSent - this.lastSnapshotPackets;
    const byteDelta = this.stats.bytesSent - this.lastSnapshotBytes;
    const packetsPerSecond = packetDelta * 1_000 / elapsedSinceSnapshot;
    const bytesPerSecond = byteDelta * 1_000 / elapsedSinceSnapshot;
    this.lastSnapshotAt = now;
    this.lastSnapshotPackets = this.stats.packetsSent;
    this.lastSnapshotBytes = this.stats.bytesSent;

    const memory = process.memoryUsage();
    return {
      ...this.stats,
      status: this.status,
      target: `${this.config.host}:${this.config.port}`,
      online: this.stateCounts[SessionState.ONLINE],
      connecting: this.stateCounts[SessionState.CONNECTING],
      waitingForLoginAck: this.stateCounts[SessionState.LOGIN_SENT],
      backoff: this.stateCounts[SessionState.BACKOFF],
      pending: this.stateCounts[SessionState.PENDING],
      packetsPerSecond: round1(packetsPerSecond),
      bytesPerSecond: Math.round(bytesPerSecond),
      elapsedMs: Math.max(0, (this.stoppedAt || now) - this.startedAt),
      onlinePercent: this.stats.totalDevices === 0
        ? 0
        : round1(this.stateCounts[SessionState.ONLINE] * 100 / this.stats.totalDevices),
      memoryRssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed
    };
  }

  #schedulePump(delay) {
    if (!this.running) return;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = setTimeout(() => this.#pump(), Math.max(0, delay));
  }

  #pump() {
    this.pumpTimer = null;
    if (!this.running) return;

    const started = performance.now();
    const now = this.now();
    let processed = 0;

    while (this.heap.size > 0 && processed < MAX_ACTIONS_PER_PUMP) {
      const next = this.heap.peek();
      if (next.at > now) break;
      this.heap.pop();
      if (next.version !== next.session.scheduleVersion || next.session.disposed) continue;
      try {
        next.session.handleDue(now);
      } catch (error) {
        this.recordError(error);
        this.logDevice(next.session, 'error', 'Device action failed', { message: error.message });
      }
      processed += 1;
    }

    this.stats.schedulerActions += processed;
    this.stats.schedulerWorkMs += performance.now() - started;
    const next = this.heap.peek();
    const delay = processed >= MAX_ACTIONS_PER_PUMP
      ? 0
      : next
        ? Math.min(MAX_PUMP_DELAY_MS, Math.max(1, next.at - this.now()))
        : MAX_PUMP_DELAY_MS;
    this.#schedulePump(delay);
  }

  #newStats() {
    return {
      totalDevices: 0,
      movingDevices: 0,
      parkedDevices: 0,
      tcpConnected: 0,
      packetsSent: 0,
      loginPackets: 0,
      heartbeatPackets: 0,
      locationPackets: 0,
      commandResponses: 0,
      acknowledgements: 0,
      reconnects: 0,
      malformedFrames: 0,
      errors: 0,
      bytesSent: 0,
      bytesReceived: 0,
      schedulerActions: 0,
      schedulerWorkMs: 0
    };
  }
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

module.exports = {
  DeviceFarm,
  MAX_ACTIONS_PER_PUMP
};

