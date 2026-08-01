'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { DeviceFarm } = require('../src/simulator/device-farm');
const { FrameDecoder, buildAck, decodeImeiBcd } = require('../src/simulator/gt06');

async function createGt06Server({ acknowledgeLogin = true } = {}) {
  const received = {
    connections: 0,
    logins: 0,
    heartbeats: 0,
    locations: 0,
    imeis: new Set()
  };
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    received.connections += 1;
    const decoder = new FrameDecoder();
    socket.on('data', (chunk) => {
      for (const frame of decoder.feed(chunk)) {
        if (frame.protocol === 0x01) {
          received.logins += 1;
          received.imeis.add(decodeImeiBcd(frame.data.subarray(1, 9)));
          if (acknowledgeLogin) socket.write(buildAck(0x01, frame.serial));
        } else if (frame.protocol === 0x13) {
          received.heartbeats += 1;
          socket.write(buildAck(0x13, frame.serial));
        } else if (frame.protocol === 0x12) {
          received.locations += 1;
          socket.write(buildAck(0x12, frame.serial));
        }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    received,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

function testConfig(port, overrides = {}) {
  return {
    host: '127.0.0.1',
    port,
    deviceCount: 8,
    baseLatitude: 28.6139,
    baseLongitude: 77.209,
    movingPercent: 25,
    movingIntervalMs: 100,
    parkedIntervalMs: 200,
    heartbeatIntervalMs: 100,
    connectionRatePerSecond: 1_000,
    connectTimeoutMs: 500,
    loginAckTimeoutMs: 150,
    maxLoginAttempts: 2,
    reconnectBaseMs: 100,
    reconnectMaxMs: 500,
    metricsIntervalMs: 100,
    logDetail: 'summary',
    ...overrides
  };
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for condition');
}

test('farm completes real TCP login and scheduled location flow', async (t) => {
  const mock = await createGt06Server();
  const farm = new DeviceFarm(testConfig(mock.port));
  t.after(async () => {
    await farm.stop();
    await mock.close();
  });

  farm.start();
  await waitFor(() => farm.snapshot().online === 8);
  await new Promise((resolve) => setTimeout(resolve, 260));
  const metrics = farm.snapshot();

  assert.equal(metrics.totalDevices, 8);
  assert.equal(metrics.movingDevices, 2);
  assert.equal(metrics.parkedDevices, 6);
  assert.equal(metrics.online, 8);
  assert.equal(metrics.tcpConnected, 8);
  assert.equal(mock.received.imeis.size, 8);
  assert.equal(mock.received.imeis.has('358988888800001'), true);
  assert.ok(mock.received.locations >= 16);
  assert.ok(mock.received.heartbeats >= 16);
  assert.equal(metrics.errors, 0);
});

test('farm does not mark a device online without a login ACK', async (t) => {
  const mock = await createGt06Server({ acknowledgeLogin: false });
  const farm = new DeviceFarm(testConfig(mock.port, { deviceCount: 1 }));
  t.after(async () => {
    await farm.stop();
    await mock.close();
  });

  farm.start();
  await waitFor(() => farm.snapshot().reconnects >= 1, 3_000);
  const metrics = farm.snapshot();
  assert.equal(metrics.online, 0);
  assert.ok(metrics.loginPackets >= 2);
  assert.ok(mock.received.logins >= 2);
});

