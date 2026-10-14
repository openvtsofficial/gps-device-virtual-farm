'use strict';

// Fixture-only preparation benchmark. It exercises planning, validation,
// persistence and resume without downloading a map or launching Valhalla.
// The straight-line fixture geometry is not evidence of real-road accuracy.

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { RoutePackStore } = require('../src/road/route-pack-store');
const { RoutePreparationCoordinator } = require('../src/road/route-preparation-coordinator');
const { distanceMeters } = require('../src/road/route-validator');

const REGION = Object.freeze({ id: 'fixture-metro', centerLatitude: 28.6139,
  centerLongitude: 77.209, radiusKm: 30, fleetWeight: 1 });
const SEED = 'fixture-preparation-call-count-v1';

function integerOption(args, name, fallback, minimum, maximum) {
  const prefix = `--${name}=`;
  const option = args.find((argument) => argument.startsWith(prefix));
  const value = option ? Number(option.slice(prefix.length)) : fallback;
  if (args.filter((argument) => argument.startsWith(prefix)).length > 1 ||
      !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${prefix}<integer> must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function encodeNumber(number) {
  let value = number < 0 ? -number * 2 - 1 : number * 2;
  let encoded = '';
  while (value >= 32) {
    encoded += String.fromCharCode((32 | (value % 32)) + 63);
    value = Math.floor(value / 32);
  }
  return encoded + String.fromCharCode(value + 63);
}

function encodePolyline6(points) {
  let latitude = 0;
  let longitude = 0;
  let encoded = '';
  for (const point of points) {
    const nextLatitude = Math.round(point.latitude * 1e6);
    const nextLongitude = Math.round(point.longitude * 1e6);
    encoded += encodeNumber(nextLatitude - latitude) + encodeNumber(nextLongitude - longitude);
    latitude = nextLatitude;
    longitude = nextLongitude;
  }
  return encoded;
}

function interpolatedLeg(from, to) {
  // Keep every fixture segment beneath the production 2 km geometry limit.
  const steps = Math.max(1, Math.ceil(distanceMeters(from, to) / 500));
  const points = Array.from({ length: steps + 1 }, (_, index) => ({
    latitude: Math.round((from.latitude + (to.latitude - from.latitude) * index / steps) * 1e6) / 1e6,
    longitude: Math.round((from.longitude + (to.longitude - from.longitude) * index / steps) * 1e6) / 1e6
  }));
  let meters = 0;
  for (let index = 1; index < points.length; index += 1) {
    meters += distanceMeters(points[index - 1], points[index]);
  }
  return { shape: encodePolyline6(points), summary: { length: meters / 1000 } };
}

function fixtureResponse(candidate) {
  return { trip: { legs: candidate.locations.slice(1).map((destination, index) =>
    interpolatedLeg(candidate.locations[index], destination)) } };
}

function fixtureProvider(counters) {
  return {
    id: 'fixture-valhalla', endpointFamily: 'fixture-local-cli', bulkAllowed: true,
    async health() {
      counters.healthCalls += 1;
      return { ready: true, version: 'fixture-graph-v1', tilesetLastModified: 1 };
    },
    async fetchRoute(candidate) {
      counters.routeDigests.push(candidate.digest);
      // Deterministic candidate failure exercises the durable skip list.
      if (counters.routeDigests.length % 11 === 0) {
        const error = new Error('Fixture candidate has no routable road');
        error.status = 400;
        throw error;
      }
      return fixtureResponse(candidate);
    },
    async fetchRoadClasses() {
      counters.traceCalls += 1;
      return { localShare: 0.5, classMeters: { residential: 500, primary: 500 },
        classCounts: { residential: 1, primary: 1 } };
    }
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('Usage: npm run benchmark:road-preparation -- ' +
      '[--target=2000] [--attempts=15]\n' +
      'Runs two resumable fixture actions and one cache-only action. No network or map is used.\n');
    return;
  }
  if (args.some((argument) => !/^--(?:target|attempts)=/.test(argument))) {
    throw new Error(`Unknown benchmark option: ${args.find((argument) => !/^--(?:target|attempts)=/.test(argument))}`);
  }
  const targetRouteCount = integerOption(args, 'target', 2000, 1, 2500);
  const attemptsPerAction = integerOption(args, 'attempts', 15, 1, 2500);
  if (targetRouteCount <= attemptsPerAction) {
    throw new Error('--target must exceed --attempts so the second action measures resume');
  }
  const benchmarkRoot = path.join(process.cwd(), '.runtime', 'benchmarks');
  await fs.mkdir(benchmarkRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(benchmarkRoot, 'road-preparation-'));
  const counters = { routeDigests: [], traceCalls: 0, healthCalls: 0 };
  const provider = fixtureProvider(counters);
  const store = new RoutePackStore(path.join(directory, 'routes'));
  const options = { regions: [REGION], seed: SEED, requestedMoving: 0,
    requestedParked: 0, targetRouteCount, maxRequests: attemptsPerAction, provider };
  const snapshots = [];
  const memoryMiB = () => {
    const usage = process.memoryUsage();
    return { rss: Math.round(usage.rss / 1024 / 1024),
      heapUsed: Math.round(usage.heapUsed / 1024 / 1024),
      external: Math.round(usage.external / 1024 / 1024) };
  };
  const run = async (label, requestBudget) => {
    const before = { routes: counters.routeDigests.length,
      traces: counters.traceCalls, health: counters.healthCalls };
    if (global.gc) global.gc();
    const memoryBefore = memoryMiB();
    const started = performance.now();
    let savedEvents = 0;
    const memoryAtSaves = [];
    const coordinator = new RoutePreparationCoordinator({ store, provider });
    const result = await coordinator.prepare({ ...options, maxRequests: requestBudget,
      onProgress: (event) => {
        if (event.phase === 'saved') {
          savedEvents += 1;
          memoryAtSaves.push(memoryMiB());
        }
      } });
    const elapsedMs = Math.round(performance.now() - started);
    const memoryAfter = memoryMiB();
    if (global.gc) global.gc();
    const memoryAfterGc = global.gc ? memoryMiB() : null;
    const snapshot = { label, elapsedMs,
      status: result.status, attempts: result.attempts,
      accepted: result.accepted, rejected: result.rejected,
      routeCount: result.routeCount,
      routeCalls: counters.routeDigests.length - before.routes,
      traceCalls: counters.traceCalls - before.traces,
      healthCalls: counters.healthCalls - before.health,
      savedEvents, memoryBeforeMiB: memoryBefore,
      memoryAfterMiB: memoryAfter,
      ...(memoryAfterGc ? { memoryAfterGcMiB: memoryAfterGc } : {}),
      peakRssAtSaveMiB: Math.max(0, ...memoryAtSaves.map((memory) => memory.rss)),
      peakHeapAtSaveMiB: Math.max(0, ...memoryAtSaves.map((memory) => memory.heapUsed)) };
    assert.equal(snapshot.routeCalls, result.attempts,
      `${label}: every counted fixture attempt needs exactly one route call`);
    assert.ok(snapshot.traceCalls <= snapshot.routeCalls,
      `${label}: tracing must not exceed fixture route calls`);
    assert.ok(snapshot.healthCalls <= snapshot.routeCalls + 1,
      `${label}: graph health must not be checked repeatedly for one candidate`);
    snapshots.push(snapshot);
    return snapshot;
  };
  try {
    const first = await run('initial', attemptsPerAction);
    assert.ok(first.routeCount > 0 && first.savedEvents > 0,
      'the first action must persist a usable route pack');
    assert.notEqual(first.status, 'ready',
      'the first action must leave work for a resumed action');
    const second = await run('resumed-after-restart', attemptsPerAction);
    assert.ok(second.routeCount >= first.routeCount,
      'a resumed action must preserve previously accepted routes');
    assert.ok(second.routeCalls > 0, 'a resumed action must continue preparation');
    assert.equal(new Set(counters.routeDigests).size, counters.routeDigests.length,
      'accepted and rejected candidates must not be sent twice across actions');
    const cache = await run('cache-only-after-restart', 0);
    assert.equal(cache.routeCalls, 0, 'cache-only action must make no route calls');
    assert.equal(cache.traceCalls, 0, 'cache-only action must make no trace calls');
    assert.equal(cache.routeCount, second.routeCount,
      'cache-only action must read the last persisted route pack');
    process.stdout.write(`${JSON.stringify({ status: 'ok',
      evidence: 'fixture-only preparation benchmark; no real-road or internet proof',
      targetRouteCount, attemptsPerAction, actions: snapshots,
      totalUniqueRouteCalls: counters.routeDigests.length,
      totalTraceCalls: counters.traceCalls,
      totalHealthCalls: counters.healthCalls,
      rssMiBAtEnd: Math.round(process.memoryUsage().rss / 1024 / 1024)
    }, null, 2)}\n`);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
