'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const test = require('node:test');
const { RoadCheckpointStore } = require('../src/main/road-checkpoint-store');
const { RoutePackStore } = require('../src/road/route-pack-store');
const { coordinatesDigest, distanceMeters } = require('../src/road/route-validator');
const { DeviceFarm } = require('../src/simulator/device-farm');
const { FrameDecoder, buildAck, decodeImeiBcd } = require('../src/simulator/gt06');

function fixtureRoute(id, latitude, longitude) {
  // A small closed itinerary fixture, with each turn and the return leg kept.
  const points = [
    { latitude, longitude },
    { latitude, longitude: longitude + 0.001 },
    { latitude: latitude + 0.001, longitude: longitude + 0.001 },
    { latitude: latitude + 0.001, longitude },
    { latitude, longitude }
  ];
  const cumulativeMeters = [0];
  for (let index = 1; index < points.length; index += 1) {
    cumulativeMeters.push(cumulativeMeters.at(-1) +
      distanceMeters(points[index - 1], points[index]));
  }
  return {
    id,
    regionId: 'default',
    family: 'urban',
    closedLoop: true,
    points,
    cumulativeMeters,
    lengthMeters: cumulativeMeters.at(-1),
    digest: coordinatesDigest(points),
    parkedAnchors: [0, 2]
  };
}

function createAckTransport({ backpressureImei = null } = {}) {
  const sockets = [];
  class Socket extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.decoder = new FrameDecoder();
      this.frames = [];
      this.imei = null;
      this.backpressureUsed = false;
      sockets.push(this);
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
      let queuedUnderBackpressure = false;
      for (const frame of this.decoder.feed(packet)) {
        this.frames.push(frame);
        if (frame.protocol === 0x01) {
          this.imei = decodeImeiBcd(frame.data.subarray(1, 9));
          setImmediate(() => {
            if (!this.destroyed) this.emit('data', buildAck(0x01, frame.serial));
          });
        }
        if (frame.protocol === 0x12 && this.imei === backpressureImei &&
            !this.backpressureUsed) {
          this.backpressureUsed = true;
          queuedUnderBackpressure = true;
        }
      }
      return !queuedUnderBackpressure;
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      setImmediate(() => this.emit('close'));
    }
  }
  return {
    netModule: { Socket },
    sockets,
    socketFor(imei) { return sockets.find((socket) => socket.imei === imei); }
  };
}

function decodeLocation(frame) {
  assert.equal(frame.protocol, 0x12);
  assert.equal(frame.data.length, 19);
  const courseStatus = frame.data.readUInt16BE(17);
  return {
    latitude: frame.data.readUInt32BE(8) / 1_800_000 * (courseStatus & 0x0400 ? 1 : -1),
    longitude: frame.data.readUInt32BE(12) / 1_800_000 * (courseStatus & 0x0800 ? -1 : 1),
    speedKph: frame.data[16],
    course: courseStatus & 0x03ff,
    valid: Boolean(courseStatus & 0x1000)
  };
}

function distanceToRouteMeters(point, route) {
  let nearest = Infinity;
  for (let index = 1; index < route.points.length; index += 1) {
    const from = route.points[index - 1];
    const to = route.points[index];
    const latitudeScale = 111_320;
    const longitudeScale = latitudeScale * Math.cos(from.latitude * Math.PI / 180);
    const dx = (to.longitude - from.longitude) * longitudeScale;
    const dy = (to.latitude - from.latitude) * latitudeScale;
    const px = (point.longitude - from.longitude) * longitudeScale;
    const py = (point.latitude - from.latitude) * latitudeScale;
    const ratio = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
    nearest = Math.min(nearest, Math.hypot(px - ratio * dx, py - ratio * dy));
  }
  return nearest;
}

function roadConfig(packDigest) {
  return {
    host: '127.0.0.1', port: 5023,
    deviceCount: 8, movingPercent: 25,
    connectionRatePerSecond: 2_000,
    connectTimeoutMs: 500, loginAckTimeoutMs: 500,
    movingIntervalMs: 10_000,
    parkedIntervalMs: 300_000,
    heartbeatIntervalMs: 60_000,
    movementMode: 'real-road',
    scenarioSeed: 'road-integration',
    road: { selectedRoutePackDigests: [packDigest], requireEnterpriseDiversityGate: true }
  };
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for in-memory GT06 flow');
}

test('cached road farm sends road-aligned GT06 points and restores queued progress offline', async (t) => {
  const directory = await fs.mkdtemp(path.join(__dirname, '.road-farm-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  let routeFetches = 0;
  globalThis.fetch = async () => {
    routeFetches += 1;
    throw new Error('Public routing is forbidden during playback');
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const packStore = new RoutePackStore(path.join(directory, 'road-routes'));
  const digest = await packStore.writePack({
    region: {
      id: 'default', centerLatitude: 28.66, centerLongitude: 77.25,
      radiusKm: 20, fleetWeight: 1
    },
    provider: { id: 'test-fixture', costing: 'auto' },
    sourceRequests: 0,
    routes: [
      fixtureRoute('west-tour', 28.61, 77.20),
      fixtureRoute('east-tour', 28.71, 77.30)
    ]
  });
  const pack = await packStore.loadPack(digest);
  const config = roadConfig(digest);
  const firstImei = '358988888800001';
  const transport = createAckTransport({ backpressureImei: firstImei });
  const farm = new DeviceFarm(config, { roadPacks: [pack], netModule: transport.netModule });
  t.after(() => farm.stop());

  farm.start();
  await waitFor(() => farm.snapshot().online === 8 &&
    transport.sockets.every((socket) => socket.frames.some((frame) => frame.protocol === 0x12)));
  assert.equal(farm.snapshot().movingDevices, 2);
  assert.equal(farm.snapshot().parkedDevices, 6);
  assert.equal(farm.snapshot().errors, 0);
  assert.equal(farm.snapshot().roadRoutesUsed, 2);

  for (const session of farm.sessions) {
    const socket = transport.socketFor(session.imei);
    assert.ok(socket);
    assert.equal(socket.frames[0].protocol, 0x01, 'login precedes GPS transmission');
    const locations = socket.frames.filter((frame) => frame.protocol === 0x12);
    assert.ok(locations.length >= 1);
    for (const frame of locations) {
      const decoded = decodeLocation(frame);
      assert.equal(decoded.valid, true);
      assert.ok(distanceToRouteMeters(decoded, session.route.route) < 2,
        `${session.imei} transmitted a point outside its cached route`);
      assert.ok(decoded.course >= 0 && decoded.course < 360);
      if (!session.moving) assert.equal(decoded.speedKph, 0);
    }
  }
  assert.equal(new Set(farm.sessions.slice(0, 2).map((session) =>
    session.route.assignment.routeId)).size, 2);

  const firstSession = farm.sessions[0];
  const firstSocket = transport.socketFor(firstImei);
  assert.equal(firstSocket.backpressureUsed, true);
  assert.equal(firstSession.backpressured, true);
  const queuedState = firstSession.route.checkpoint();
  assert.ok(queuedState.lastQueuedWallUtcMs > 0,
    'socket.write(false) still queued and committed the location');
  assert.ok(Math.abs(queuedState.cursorMeters -
    firstSession.route.assignment.cursorMeters) < 1e-6);

  firstSession.route.lastMotionMs = performance.now() - 10_000;
  firstSession.nextLocationAt = Date.now() - 1;
  firstSocket.emit('drain');
  await waitFor(() => firstSocket.frames.filter((frame) => frame.protocol === 0x12).length >= 2);
  const advancedState = firstSession.route.checkpoint();
  assert.ok(advancedState.cursorMeters > queuedState.cursorMeters);
  const advancedPacket = decodeLocation(firstSocket.frames.filter((frame) => frame.protocol === 0x12).at(-1));
  assert.ok(advancedPacket.speedKph > 0);
  assert.ok(distanceToRouteMeters(advancedPacket, firstSession.route.route) < 2);

  await farm.stop();
  const durableDigest = createHash('sha256').update(digest).digest('hex');
  const checkpointStore = new RoadCheckpointStore(directory, {
    runId: 'road-integration', routePackDigest: durableDigest
  });
  await checkpointStore.save(farm.checkpointStates());
  await checkpointStore.close();
  const reopened = new RoadCheckpointStore(directory, {
    runId: 'road-integration', routePackDigest: durableDigest
  });
  const saved = await reopened.load();
  assert.equal(saved.states.length, 8);
  const restoredFirst = saved.states.find((state) => state.imei === firstImei);
  assert.equal(restoredFirst.cursorMeters, advancedState.cursorMeters);

  const secondTransport = createAckTransport();
  const restarted = new DeviceFarm(config, {
    roadPacks: [await packStore.loadPack(digest)],
    restoredRoadStates: saved.states,
    netModule: secondTransport.netModule
  });
  t.after(() => restarted.stop());
  restarted.start({ deferPump: true });
  assert.ok(Math.abs(restarted.sessions[0].route.checkpoint().cursorMeters -
    restoredFirst.cursorMeters) < 1e-6);
  restarted.activate();
  await waitFor(() => restarted.snapshot().online === 8 &&
    secondTransport.socketFor(firstImei)?.frames.some((frame) => frame.protocol === 0x12));
  const firstAfterRestart = decodeLocation(secondTransport.socketFor(firstImei).frames
    .find((frame) => frame.protocol === 0x12));
  assert.ok(Math.abs(firstAfterRestart.latitude - restoredFirst.lastQueuedLatitude) < 1e-6);
  assert.ok(Math.abs(firstAfterRestart.longitude - restoredFirst.lastQueuedLongitude) < 1e-6);
  assert.equal(firstAfterRestart.speedKph, 0);
  assert.ok(Math.abs(restarted.sessions[0].route.checkpoint().cursorMeters -
    restoredFirst.cursorMeters) < 1e-6);
  assert.equal(routeFetches, 0);
});
