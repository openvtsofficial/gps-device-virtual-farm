'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const { DeviceFarm } = require('../src/simulator/device-farm');
const { FrameDecoder, buildAck } = require('../src/simulator/gt06');

class InMemorySocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.decoder = new FrameDecoder();
  }

  setNoDelay() {}
  setKeepAlive() {}

  connect() {
    setImmediate(() => {
      if (!this.destroyed) this.emit('connect');
    });
  }

  write(packet) {
    if (this.destroyed) throw new Error('Socket is destroyed');
    for (const frame of this.decoder.feed(packet)) {
      setImmediate(() => {
        if (!this.destroyed) this.emit('data', buildAck(frame.protocol, frame.serial));
      });
    }
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    setImmediate(() => this.emit('close'));
  }
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('20,000-device benchmark timed out');
}

async function main() {
  const started = performance.now();
  const farm = new DeviceFarm({
    host: '127.0.0.1',
    port: 5023,
    deviceCount: 20_000,
    movingPercent: 25,
    connectionRatePerSecond: 2_000,
    logDetail: 'summary'
  }, {
    netModule: { Socket: InMemorySocket }
  });

  farm.start();
  await waitFor(() => farm.snapshot().online === 20_000, 20_000);
  const metrics = farm.snapshot();
  assert.equal(metrics.online, 20_000);
  assert.equal(metrics.movingDevices, 5_000);
  assert.equal(metrics.parkedDevices, 15_000);
  assert.equal(metrics.errors, 0);
  await farm.stop();

  process.stdout.write(`${JSON.stringify({
    status: 'ok',
    transport: 'in-memory GT06 ACK transport',
    devicesOnline: metrics.online,
    movingDevices: metrics.movingDevices,
    parkedDevices: metrics.parkedDevices,
    loginPackets: metrics.loginPackets,
    initialLocationPackets: metrics.locationPackets,
    initialHeartbeatPackets: metrics.heartbeatPackets,
    workerRssMb: Math.round(metrics.memoryRssBytes / 1024 / 1024),
    elapsedMs: Math.round(performance.now() - started)
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

