'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');
const { RoadCheckpointStore } = require('../src/main/road-checkpoint-store');
const { SimulatorController } = require('../src/main/simulator-controller');
const { RoutePackStore } = require('../src/road/route-pack-store');
const { coordinatesDigest, distanceMeters } = require('../src/road/route-validator');
const { FrameDecoder, buildAck, decodeImeiBcd } = require('../src/simulator/gt06');

function fixtureRoute() {
  // A closed, validated geometry fixture. Its coordinates do not assert that
  // the path is an actual public road; this test verifies cached playback.
  const points = [
    { latitude: 28.610, longitude: 77.200 },
    { latitude: 28.610, longitude: 77.202 },
    { latitude: 28.612, longitude: 77.202 },
    { latitude: 28.612, longitude: 77.200 },
    { latitude: 28.610, longitude: 77.200 }
  ];
  const cumulativeMeters = [0];
  for (let index = 1; index < points.length; index += 1) {
    cumulativeMeters.push(cumulativeMeters.at(-1) +
      distanceMeters(points[index - 1], points[index]));
  }
  return {
    id: 'fixture-loop', regionId: 'default', family: 'urban',
    closedLoop: true, points, cumulativeMeters,
    lengthMeters: cumulativeMeters.at(-1),
    digest: coordinatesDigest(points),
    parkedAnchors: [0, 2]
  };
}

function decodeLocation(frame) {
  assert.equal(frame.protocol, 0x12);
  const courseStatus = frame.data.readUInt16BE(17);
  return {
    latitude: frame.data.readUInt32BE(8) / 1_800_000 * (courseStatus & 0x0400 ? 1 : -1),
    longitude: frame.data.readUInt32BE(12) / 1_800_000 * (courseStatus & 0x0800 ? -1 : 1),
    speedKph: frame.data[16],
    valid: Boolean(courseStatus & 0x1000)
  };
}

async function createReceiver() {
  const connections = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    const record = { imei: null, logins: 0, locations: [], heartbeats: 0 };
    connections.push(record);
    const decoder = new FrameDecoder();
    socket.on('data', (bytes) => {
      for (const frame of decoder.feed(bytes)) {
        if (frame.protocol === 0x01) {
          record.imei = decodeImeiBcd(frame.data.subarray(1, 9));
          record.logins += 1;
          socket.write(buildAck(0x01, frame.serial));
        } else if (frame.protocol === 0x12) {
          record.locations.push(decodeLocation(frame));
        } else if (frame.protocol === 0x13) {
          record.heartbeats += 1;
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
    connections,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for local GT06 receiver');
}

function checkpointIdentity(seed, packDigest) {
  return {
    runId: createHash('sha256').update(`${seed}|${packDigest}`).digest('hex').slice(0, 32),
    routePackDigest: createHash('sha256').update(packDigest).digest('hex')
  };
}

test('worker loads cached pack and resumes a moving IMEI after clean stop',
  { timeout: 5_000 }, async (t) => {
    const dataDirectory = await fs.mkdtemp(path.join(__dirname, '.road-worker-'));
    const receiver = await createReceiver();
    const logs = [];
    const controller = new SimulatorController({ onLog: (entry) => logs.push(entry) });
    t.after(async () => {
      await controller.stop().catch(() => {});
      await receiver.close();
      await fs.rm(dataDirectory, { recursive: true, force: true });
    });

    const packStore = new RoutePackStore(path.join(dataDirectory, 'road-routes'));
    const packDigest = await packStore.writePack({
      region: { id: 'default', centerLatitude: 28.611, centerLongitude: 77.201,
        radiusKm: 5, fleetWeight: 1 },
      routes: [fixtureRoute()],
      provider: { id: 'offline-fixture', costing: 'auto' },
      sourceRequests: 0
    });
    const scenarioSeed = 'worker-offline-checkpoint';
    const config = {
      host: '127.0.0.1', port: receiver.port,
      deviceCount: 1, movingPercent: 100,
      connectionRatePerSecond: 1_000,
      connectTimeoutMs: 500, loginAckTimeoutMs: 500,
      movingIntervalMs: 100, parkedIntervalMs: 300_000,
      heartbeatIntervalMs: 60_000, metricsIntervalMs: 100,
      movementMode: 'real-road', scenarioSeed,
      road: { selectedRoutePackDigests: [packDigest],
        requireEnterpriseDiversityGate: true }
    };
    const identity = checkpointIdentity(scenarioSeed, packDigest);

    const started = await controller.start(config, { dataDirectory });
    assert.equal(started.movingDevices, 1);
    assert.equal(started.roadRoutesUsed, 1);
    const initialStore = new RoadCheckpointStore(dataDirectory, identity);
    const initial = await initialStore.load();
    assert.equal(initial.generation, 1);
    const firstCursor = initial.states[0].cursorMeters;
    await waitFor(() => receiver.connections[0]?.locations.length >= 5);
    assert.equal(receiver.connections[0].imei, '358988888800001');
    assert.ok(receiver.connections[0].locations.every((point) => point.valid));

    const firstStop = await controller.stop();
    assert.equal(firstStop.online, 0);
    const savedStore = new RoadCheckpointStore(dataDirectory, identity);
    const saved = await savedStore.load();
    assert.ok(saved.generation >= 2, 'clean stop wrote a new checkpoint generation');
    const progress = saved.states[0];
    assert.ok(progress.cursorMeters > firstCursor, 'moving cursor advanced on the cached path');
    assert.equal(progress.imei, '358988888800001');
    assert.equal(progress.routePackDigest, packDigest);

    await controller.start(config, { dataDirectory });
    await waitFor(() => receiver.connections[1]?.locations.length >= 1);
    const firstAfterRestart = receiver.connections[1].locations[0];
    assert.equal(receiver.connections[1].imei, progress.imei);
    assert.ok(Math.abs(firstAfterRestart.latitude - progress.lastQueuedLatitude) < 1e-6);
    assert.ok(Math.abs(firstAfterRestart.longitude - progress.lastQueuedLongitude) < 1e-6);
    assert.equal(firstAfterRestart.speedKph, 0);
    assert.equal(firstAfterRestart.valid, true);
    assert.equal(logs.filter((entry) => entry.source === 'Checkpoint' &&
      entry.level === 'error').length, 0);
    await controller.stop();
  });
