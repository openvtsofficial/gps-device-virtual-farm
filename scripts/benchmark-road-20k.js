'use strict';

// Fixture-only packet-plane benchmark. These loops are generated for repeatable
// load testing; they are NOT provider-routed roads or evidence of map realism.

const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const { DeviceFarm } = require('../src/simulator/device-farm');
const { FrameDecoder, buildAck, decodeImeiBcd } = require('../src/simulator/gt06');
const { coordinatesDigest, distanceMeters } = require('../src/road/route-validator');

const DEVICE_COUNT = 20_000;
const ROUTE_COUNT = 300;
const DEFAULT_SOAK_SECONDS = 20;
const MAX_SOAK_SECONDS = 3_600;
const RAMP_RATE_PER_SECOND = 2_000;

function usage() {
  return 'Usage: npm run benchmark:road-20k -- [--seconds 20]\n' +
    'Soak starts after all 20,000 in-memory GT06 sessions are online.\n';
}

function parseSeconds(args) {
  if (args.includes('--help') || args.includes('-h')) return null;
  let value = DEFAULT_SOAK_SECONDS;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--seconds') {
      value = Number(args[++index]);
    } else if (argument.startsWith('--seconds=')) {
      value = Number(argument.slice('--seconds='.length));
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (!Number.isInteger(value) || value < 1 || value > MAX_SOAK_SECONDS) {
    throw new Error(`--seconds must be an integer from 1 to ${MAX_SOAK_SECONDS}`);
  }
  return value;
}

function fixtureRoute(index) {
  const row = Math.floor(index / 20);
  const column = index % 20;
  const latitude = 28.4 + row * 0.03;
  const longitude = 76.9 + column * 0.03;
  const span = 0.014;
  const points = [
    { latitude, longitude },
    { latitude, longitude: longitude + span },
    { latitude: latitude + span, longitude: longitude + span },
    { latitude: latitude + span, longitude },
    { latitude, longitude }
  ];
  const cumulativeMeters = [0];
  for (let point = 1; point < points.length; point += 1) {
    cumulativeMeters.push(cumulativeMeters.at(-1) +
      distanceMeters(points[point - 1], points[point]));
  }
  for (const point of points) Object.freeze(point);
  Object.freeze(points);
  Object.freeze(cumulativeMeters);
  return Object.freeze({
    id: `fixture-${String(index + 1).padStart(3, '0')}`,
    regionId: 'fixture-region',
    family: index % 3 === 0 ? 'local' : index % 3 === 1 ? 'urban' : 'suburban',
    closedLoop: true,
    points,
    cumulativeMeters,
    lengthMeters: cumulativeMeters.at(-1),
    digest: coordinatesDigest(points),
    parkedAnchors: Object.freeze([0, 2])
  });
}

function fixturePack() {
  const routes = Object.freeze(Array.from({ length: ROUTE_COUNT }, (_, index) => fixtureRoute(index)));
  const parkedAnchors = Object.freeze(routes.flatMap((route) => route.parkedAnchors.map((pointIndex) =>
    Object.freeze({ routeId: route.id, pointIndex,
      latitude: route.points[pointIndex].latitude,
      longitude: route.points[pointIndex].longitude }))));
  const digest = createHash('sha256').update('fixture-only-road-20k-v1').digest('hex');
  return Object.freeze({
    digest,
    region: Object.freeze({ id: 'fixture-region', fleetWeight: 1 }),
    routes,
    parkedAnchors
  });
}

function inMemoryAckTransport() {
  const received = {
    logins: 0,
    heartbeats: 0,
    locations: 0,
    malformedFrames: 0,
    imeis: new Set()
  };
  class Socket extends EventEmitter {
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
      const before = this.decoder.malformedFrames;
      for (const frame of this.decoder.feed(packet)) {
        if (frame.protocol === 0x01) {
          received.logins += 1;
          received.imeis.add(decodeImeiBcd(frame.data.subarray(1, 9)));
          setImmediate(() => {
            if (!this.destroyed) this.emit('data', buildAck(0x01, frame.serial));
          });
        } else if (frame.protocol === 0x13) {
          received.heartbeats += 1;
        } else if (frame.protocol === 0x12) {
          received.locations += 1;
        }
      }
      received.malformedFrames += this.decoder.malformedFrames - before;
      return true;
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      setImmediate(() => this.emit('close'));
    }
  }
  return { netModule: { Socket }, received };
}

async function waitForAllOnline(farm, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (farm.stateCounts.ONLINE === DEVICE_COUNT) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Only ${farm.stateCounts.ONLINE}/${DEVICE_COUNT} devices were online before timeout`);
}

async function main() {
  const seconds = parseSeconds(process.argv.slice(2));
  if (seconds === null) {
    process.stdout.write(usage());
    return;
  }

  const pack = fixturePack();
  const transport = inMemoryAckTransport();
  const originalFetch = globalThis.fetch;
  let externalRequests = 0;
  globalThis.fetch = () => {
    externalRequests += 1;
    throw new Error('Fixture-only playback must not fetch public routes');
  };
  const farm = new DeviceFarm({
    host: '127.0.0.1', port: 5023,
    deviceCount: DEVICE_COUNT,
    movingPercent: 25,
    movingIntervalMs: 10_000,
    parkedIntervalMs: 5 * 60_000,
    heartbeatIntervalMs: 60_000,
    connectionRatePerSecond: RAMP_RATE_PER_SECOND,
    movementMode: 'real-road',
    scenarioSeed: 'fixture-road-20k',
    road: {
      selectedRoutePackDigests: [pack.digest],
      requireEnterpriseDiversityGate: true
    }
  }, { netModule: transport.netModule, roadPacks: [pack] });

  let peakRssBytes = 0;
  let schedulerActionErrors = 0;
  farm.on('metrics', (metrics) => {
    peakRssBytes = Math.max(peakRssBytes, metrics.memoryRssBytes);
  });
  farm.on('log', (entry) => {
    if (entry.message === 'Device action failed') schedulerActionErrors += 1;
  });
  const benchmarkStarted = performance.now();
  try {
    farm.start();
    await waitForAllOnline(farm, 60_000);
    const rampMs = performance.now() - benchmarkStarted;
    const before = farm.snapshot();
    const soakStarted = performance.now();
    await new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
    const soakMs = performance.now() - soakStarted;
    const after = farm.snapshot();
    peakRssBytes = Math.max(peakRssBytes, before.memoryRssBytes, after.memoryRssBytes);

    if (after.online !== DEVICE_COUNT || after.errors !== 0 ||
        after.roadRoutesUsed !== ROUTE_COUNT || schedulerActionErrors !== 0 ||
        transport.received.imeis.size !== DEVICE_COUNT ||
        transport.received.malformedFrames !== 0 || externalRequests !== 0) {
      throw new Error('Fixture-only road soak failed its packet-plane integrity checks');
    }
    process.stdout.write(`${JSON.stringify({
      status: 'ok',
      evidence: 'fixture-only in-memory ACK benchmark; not real-road or physical TCP proof',
      devices: DEVICE_COUNT,
      movingDevices: after.movingDevices,
      parkedDevices: after.parkedDevices,
      preparedFixtureRoutes: ROUTE_COUNT,
      selectedRoutesUsed: after.roadRoutesUsed,
      regionCount: after.roadRegions,
      connectionRampPerSecond: RAMP_RATE_PER_SECOND,
      rampMs: Math.round(rampMs),
      soakSecondsRequested: seconds,
      soakSecondsActual: Math.round(soakMs / 100) / 10,
      onlineAtEnd: after.online,
      packetsPerSecondDuringSoak: Math.round((after.packetsSent - before.packetsSent) * 1000 / soakMs),
      locationPacketsDuringSoak: after.locationPackets - before.locationPackets,
      heartbeatPacketsDuringSoak: after.heartbeatPackets - before.heartbeatPackets,
      totalPacketsSent: after.packetsSent,
      decodedLocationPackets: transport.received.locations,
      decodedHeartbeatPackets: transport.received.heartbeats,
      schedulerActionsDuringSoak: after.schedulerActions - before.schedulerActions,
      schedulerWorkMsDuringSoak: Math.round((after.schedulerWorkMs - before.schedulerWorkMs) * 10) / 10,
      schedulerActionErrors,
      peakRssMiB: Math.round(peakRssBytes / 1024 / 1024),
      errors: after.errors,
      reconnects: after.reconnects,
      malformedReceiverFrames: transport.received.malformedFrames,
      externalRouteRequests: externalRequests
    }, null, 2)}\n`);
  } finally {
    await farm.stop();
    globalThis.fetch = originalFetch;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
