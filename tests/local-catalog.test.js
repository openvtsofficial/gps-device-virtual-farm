'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { RoutePackStore } = require('../src/road/route-pack-store');
const { RoutePreparationCoordinator, catalogTargetReady } = require('../src/road/route-preparation-coordinator');
const { distanceMeters, coordinatesDigest, validateValhallaRoute } = require('../src/road/route-validator');
const { generateCandidates } = require('../src/road/candidate-planner');
const { createNoveltyIndex, novelty } = require('../src/road/diversity-evaluator');
const { evaluateCoverage } = require('../src/road/route-capacity');

const region = { id: 'metro', centerLatitude: 28.6139, centerLongitude: 77.209,
  radiusKm: 50, fleetWeight: 1 };

test('a wide metro catalog needs genuine 80 km intercity routes for its mix', () => {
  assert.equal(catalogTargetReady(2000, 2000,
    { cityRoutes: 800, regionalRoutes: 300, intercityRoutes: 0 }, [region]), false);
  assert.equal(catalogTargetReady(2000, 2000,
    { cityRoutes: 800, regionalRoutes: 300, intercityRoutes: 100 }, [region]), true);
  assert.equal(catalogTargetReady(2000, 2000,
    { cityRoutes: 800, regionalRoutes: 300, intercityRoutes: 0 },
    [{ ...region, radiusKm: 20 }]), true);
});

function encodeNumber(number) {
  let integer = number < 0 ? -number * 2 - 1 : number * 2;
  let result = '';
  while (integer >= 32) {
    result += String.fromCharCode((32 | (integer % 32)) + 63);
    integer = Math.floor(integer / 32);
  }
  return result + String.fromCharCode(integer + 63);
}

function encodePolyline6(points) {
  let lat = 0;
  let lon = 0;
  let result = '';
  for (const point of points) {
    const nextLat = Math.round(point.latitude * 1e6);
    const nextLon = Math.round(point.longitude * 1e6);
    result += encodeNumber(nextLat - lat) + encodeNumber(nextLon - lon);
    lat = nextLat;
    lon = nextLon;
  }
  return result;
}

function interpolate(from, to) {
  const count = Math.max(1, Math.ceil(distanceMeters(from, to) / 150));
  return Array.from({ length: count + 1 }, (_, index) => ({
    latitude: Math.round((from.latitude + (to.latitude - from.latitude) * index / count) * 1e6) / 1e6,
    longitude: Math.round((from.longitude + (to.longitude - from.longitude) * index / count) * 1e6) / 1e6
  }));
}

function fakeDirections(candidate) {
  const legs = [];
  for (let i = 1; i < candidate.locations.length; i += 1) {
    const points = interpolate(candidate.locations[i - 1], candidate.locations[i]);
    let meters = 0;
    for (let j = 1; j < points.length; j += 1) meters += distanceMeters(points[j - 1], points[j]);
    legs.push({ shape: encodePolyline6(points), summary: { length: meters / 1000 } });
  }
  return { trip: { legs } };
}

function existingLoop() {
  const points = [];
  const center = { latitude: region.centerLatitude, longitude: region.centerLongitude };
  const east = { latitude: center.latitude, longitude: center.longitude + 0.18 };
  const north = { latitude: center.latitude + 0.16, longitude: center.longitude };
  for (const [from, to] of [[center, east], [east, north], [north, center]]) {
    const segment = interpolate(from, to);
    points.push(...(points.length ? segment.slice(1) : segment));
  }
  const cumulativeMeters = [0];
  for (let i = 1; i < points.length; i += 1) {
    cumulativeMeters.push(cumulativeMeters.at(-1) + distanceMeters(points[i - 1], points[i]));
  }
  return { id: 'existing-metro-loop', regionId: region.id, family: 'local',
    closedLoop: true, points, cumulativeMeters, lengthMeters: cumulativeMeters.at(-1),
    digest: coordinatesDigest(points), parkedAnchors: [0], legEndIndices: [points.length - 1] };
}

function compactLoop(index, spread) {
  const row = Math.floor(index / 25);
  const column = index % 25;
  const step = spread ? 0.025 : 0.0002;
  const latitude = Math.round((region.centerLatitude + (row - 10) * step) * 1e6) / 1e6;
  const longitude = Math.round((region.centerLongitude + (column - 12) * step) * 1e6) / 1e6;
  const span = spread ? 0.002 : 0.001;
  const points = [
    { latitude, longitude },
    { latitude, longitude: longitude + span },
    { latitude: latitude + span, longitude: longitude + span },
    { latitude: latitude + span, longitude },
    { latitude, longitude }
  ];
  const cumulativeMeters = [0];
  for (let i = 1; i < points.length; i += 1) {
    cumulativeMeters.push(cumulativeMeters.at(-1) + distanceMeters(points[i - 1], points[i]));
  }
  return { id: `compact-${index}`, regionId: region.id, family: 'local',
    closedLoop: true, points, cumulativeMeters, lengthMeters: cumulativeMeters.at(-1),
    digest: coordinatesDigest(points), parkedAnchors: [0, 2], legEndIndices: [4],
    roadClassSummary: { localShare: 0.6,
      classMeters: { residential: cumulativeMeters.at(-1) },
      classCounts: { residential: 4 } } };
}

async function compactCatalog(store, count, spread) {
  const digest = await store.writePack({ region,
    routes: Array.from({ length: count }, (_, index) => compactLoop(index, spread)),
    provider: { id: 'valhalla-local', endpointFamily: 'http://127.0.0.1:8002',
      graphVersion: 'fixture', tilesetLastModified: 1 } });
  return store.loadPack(digest);
}

test('local catalog stops at a saved 500-route fleet-ready milestone and can later continue', async (t) => {
  const directory = await fs.mkdtemp(path.join(__dirname, '.gps-local-milestone-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new RoutePackStore(path.join(directory, 'road-routes'));
  const baseline = await compactCatalog(store, 499, true);
  assert.equal(evaluateCoverage([baseline], { regions: [region] }).ready, true);
  let calls = 0;
  const provider = retryFixtureProvider(async (candidate) => {
    calls += 1;
    return fakeDirections(candidate);
  });
  const coordinator = new RoutePreparationCoordinator({ store, provider });
  const events = [];
  const options = { regions: [region], seed: 'usable-milestone', targetRouteCount: 2000,
    requestedMoving: 0, requestedParked: 0 };
  const first = await coordinator.prepare({ ...options, stopAtUsableRouteCount: true,
    maxRequests: 10, onProgress: (event) => events.push(event) });
  assert.equal(first.status, 'usable');
  assert.equal(first.minimumUsableRouteCount, 500);
  assert.equal(first.savedRouteCount, first.routeCount);
  assert.ok(first.routeCount >= 500);
  assert.equal(first.coverage.ready, true);
  assert.equal(first.resumeAvailable, true);
  assert.match(first.statusDetail, /transmit and add more routes later/);
  assert.ok(events.some((event) => event.phase === 'usable' &&
    event.savedRouteCount >= 500 && event.minimumUsableRouteCount === 500));
  assert.equal((await store.loadPack(first.packDigests[0])).routes.length, first.routeCount);
  const beforeResume = calls;
  const resumed = await coordinator.prepare({ ...options, maxRequests: 1 });
  assert.equal(resumed.status, 'request-limit');
  assert.equal(resumed.attempts, 1);
  assert.equal(calls, beforeResume + 1, 'an Add more pass searches beyond the milestone');
});

test('500 routes need fleet capacity, while relaxed diversity can use a clustered catalog', async (t) => {
  const directory = await fs.mkdtemp(path.join(__dirname, '.gps-local-milestone-capacity-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new RoutePackStore(path.join(directory, 'road-routes'));
  const baseline = await compactCatalog(store, 500, false);
  assert.equal(evaluateCoverage([baseline], { regions: [region] }).ready, false);
  let calls = 0;
  const coordinator = new RoutePreparationCoordinator({ store,
    provider: retryFixtureProvider(async (candidate) => {
      calls += 1;
      return fakeDirections(candidate);
    }) });
  const options = { regions: [region], seed: 'usable-capacity', targetRouteCount: 2000,
    stopAtUsableRouteCount: true, maxRequests: 0 };
  const strict = await coordinator.prepare({ ...options, requireContinuousMotion: true });
  assert.equal(strict.status, 'incomplete');
  const relaxed = await coordinator.prepare({ ...options, requireContinuousMotion: false });
  assert.equal(relaxed.status, 'usable');
  assert.equal(relaxed.attempts, 0);
  const insufficient = await coordinator.prepare({ ...options, requestedMoving: 5000 });
  assert.equal(insufficient.status, 'incomplete');
  assert.ok(insufficient.coverage.usableMovingCapacityEstimate < 5000);
  assert.equal(calls, 0);
});

test('local preparation continues beyond fleet readiness toward its route-count target', async (t) => {
  const directory = await fs.mkdtemp(path.join(__dirname, '.gps-local-catalog-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new RoutePackStore(path.join(directory, 'road-routes'));
  const baselineDigest = await store.writePack({ region, routes: [existingLoop()],
    provider: { id: 'valhalla-local', endpointFamily: 'http://127.0.0.1:8002',
      graphVersion: 'fixture', tilesetLastModified: 1 } });
  const baseline = await store.loadPack(baselineDigest);
  assert.equal(evaluateCoverage([baseline], { regions: [region] }).ready, true);
  let calls = 0;
  const provider = {
    id: 'valhalla-local', bulkAllowed: true, endpointFamily: 'http://127.0.0.1:8002',
    health: async () => ({ ready: true, version: 'fixture', tilesetLastModified: 1 }),
    fetchRoute: async (candidate) => { calls += 1; return fakeDirections(candidate); },
    fetchRoadClasses: async () => ({ localShare: 0.6,
      classMeters: { residential: 600, primary: 400 }, classCounts: { residential: 3, primary: 1 } })
  };
  const coordinator = new RoutePreparationCoordinator({ store, provider });
  const progressEvents = [];
  const result = await coordinator.prepare({ regions: [region], seed: 'local-catalog',
    targetRouteCount: 2, maxRequests: 5,
    onProgress: (event) => progressEvents.push(event) });
  assert.equal(result.status, 'ready');
  assert.equal(result.routeCount, 2);
  assert.equal(result.accepted, 1);
  assert.equal(result.coverage.acceptedRouteCount, 2);
  assert.ok(calls >= 1);
  assert.ok(progressEvents.some((event) => event.phase === 'accepted' &&
    event.composition?.cityRoutes >= 1));
  const newPack = await store.loadPack(result.packDigests[0]);
  assert.equal(newPack.routes.length, 2);
  assert.equal(newPack.routes[1].provider, 'valhalla-local');
  assert.equal(newPack.routes[1].roadClassSummary.localShare, 0.6);
  assert.equal((await store.loadPack(baselineDigest)).routes.length, 1);
});

function retryFixtureProvider(fetchRoute) {
  return {
    id: 'valhalla-local', bulkAllowed: true, endpointFamily: 'http://127.0.0.1:8002',
    health: async () => ({ ready: true, version: 'fixture', tilesetLastModified: 1 }),
    fetchRoute,
    fetchRoadClasses: async () => ({ localShare: 0.6,
      classMeters: { residential: 600, primary: 400 },
      classCounts: { residential: 3, primary: 1 } })
  };
}

test('local routing retries two transient 503 failures before accepting the same candidate', async (t) => {
  const directory = await fs.mkdtemp(path.join(__dirname, '.gps-local-retry-success-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new RoutePackStore(path.join(directory, 'road-routes'));
  const requested = [];
  const retryEvents = [];
  const provider = retryFixtureProvider(async (candidate) => {
    requested.push(candidate.digest);
    if (requested.length < 3) {
      throw Object.assign(new Error('temporary service outage'), { status: 503 });
    }
    return fakeDirections(candidate);
  });
  const result = await new RoutePreparationCoordinator({ store, provider }).prepare({
    regions: [region], seed: 'local-retry-success', targetRouteCount: 1,
    maxRequests: 3,
    onProgress: (progress) => {
      if (progress.phase === 'retrying') retryEvents.push(progress);
    }
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.attempts, 3);
  assert.equal(result.accepted, 1);
  assert.equal(result.routeCount, 1);
  assert.equal(new Set(requested).size, 1, 'a transient failure retries the current candidate');
  assert.deepEqual(retryEvents.map((event) => event.retryAttempt), [2, 3]);
  assert.ok(retryEvents.every((event) => event.retryInMs >= 0 &&
    event.maxRetryAttempts === 3 && typeof event.reason === 'string'));
});

test('local routing never retries a deterministic HTTP 400 candidate failure', async (t) => {
  const directory = await fs.mkdtemp(path.join(__dirname, '.gps-local-retry-400-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new RoutePackStore(path.join(directory, 'road-routes'));
  const requested = [];
  const retryEvents = [];
  const provider = retryFixtureProvider(async (candidate) => {
    requested.push(candidate.digest);
    throw Object.assign(new Error('No drivable road near waypoint'), { status: 400 });
  });
  const result = await new RoutePreparationCoordinator({ store, provider }).prepare({
    regions: [region], seed: 'local-retry-400', targetRouteCount: 1,
    maxRequests: 3,
    onProgress: (progress) => {
      if (progress.phase === 'retrying') retryEvents.push(progress);
    }
  });
  assert.equal(result.attempts, 3);
  assert.equal(result.rejected, 3);
  assert.equal(result.routeCount, 0);
  assert.equal(new Set(requested).size, 3, 'each request uses a new candidate');
  assert.deepEqual(retryEvents, []);
});

test('canceling a local retry wait stops promptly without another route call', async (t) => {
  const directory = await fs.mkdtemp(path.join(__dirname, '.gps-local-retry-cancel-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new RoutePackStore(path.join(directory, 'road-routes'));
  const controller = new AbortController();
  let calls = 0;
  let retryNotified = false;
  let retryNotifiedAt = 0;
  const provider = retryFixtureProvider(async () => {
    calls += 1;
    throw Object.assign(new Error('temporary service outage'), { status: 503 });
  });
  const result = await new RoutePreparationCoordinator({ store, provider }).prepare({
    regions: [region], seed: 'local-retry-cancel', targetRouteCount: 1,
    maxRequests: 3, signal: controller.signal,
    onProgress: (progress) => {
      if (progress.phase === 'retrying') {
        retryNotified = true;
        retryNotifiedAt = Date.now();
        controller.abort();
      }
    }
  });
  assert.equal(retryNotified, true);
  assert.equal(result.status, 'canceled');
  assert.equal(result.attempts, 1);
  assert.equal(calls, 1);
  assert.ok(Date.now() - retryNotifiedAt < 900, 'abort should interrupt the one-second backoff');
});

test('local retry never exceeds the request budget and remains resumable', async (t) => {
  const directory = await fs.mkdtemp(path.join(__dirname, '.gps-local-retry-budget-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new RoutePackStore(path.join(directory, 'road-routes'));
  const requested = [];
  const provider = retryFixtureProvider(async (candidate) => {
    requested.push(candidate.digest);
    if (requested.length < 3) {
      throw Object.assign(new Error('temporary service outage'), { status: 503 });
    }
    return fakeDirections(candidate);
  });
  const coordinator = new RoutePreparationCoordinator({ store, provider });
  const options = { regions: [region], seed: 'local-retry-budget', targetRouteCount: 1 };
  const first = await coordinator.prepare({ ...options, maxRequests: 2 });
  assert.equal(first.status, 'request-limit');
  assert.equal(first.attempts, 2);
  assert.equal(first.routeCount, 0);
  assert.equal(requested.length, 2);
  const resumed = await coordinator.prepare({ ...options, maxRequests: 1 });
  assert.equal(resumed.status, 'ready');
  assert.equal(resumed.attempts, 1);
  assert.equal(resumed.routeCount, 1);
  assert.equal(requested[2], requested[0], 'a transient failure remains eligible on resume');
});

test('an exhausted saved proposal round advances and resumes new local geography', async (t) => {
  const directory = await fs.mkdtemp(path.join(__dirname, '.gps-local-rounds-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new RoutePackStore(path.join(directory, 'road-routes'));
  const seed = 'replenish-resume';
  const previous = generateCandidates([region], { seed, limit: 5000 });
  const next = generateCandidates([region], { seed, limit: 2000, round: 1 });
  const digestJson = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const scope = digestJson({ id: 'valhalla-local', endpointFamily: 'http://127.0.0.1:8002',
    graphVersion: 'fixture', tilesetLastModified: 1 });
  const jobFile = path.join(store.rootDir, 'jobs', 'preparation-state.json');
  await fs.mkdir(path.dirname(jobFile), { recursive: true });
  await fs.writeFile(jobFile, JSON.stringify({ schemaVersion: 2, scope,
    attempted: previous.map((candidate) => candidate.digest) }));
  const requested = [];
  const progress = [];
  const provider = {
    id: 'valhalla-local', bulkAllowed: true, endpointFamily: 'http://127.0.0.1:8002',
    health: async () => ({ ready: true, version: 'fixture', tilesetLastModified: 1 }),
    fetchRoute: async (candidate) => {
      requested.push(candidate.digest);
      throw Object.assign(new Error('No road at requested waypoint'), { status: 400 });
    }
  };
  const coordinator = new RoutePreparationCoordinator({ store, provider });
  const options = { regions: [region], seed, targetRouteCount: 2000, maxRequests: 1,
    onProgress: (event) => progress.push(event) };
  const first = await coordinator.prepare(options);
  assert.equal(first.status, 'request-limit');
  assert.equal(first.planningRound, 2);
  assert.equal(first.attemptBudget, 1);
  assert.equal(first.candidateCount, 2000);
  assert.equal(first.remainingCandidates, 1999);
  assert.equal(first.resumeAvailable, true);
  assert.equal(requested[0], next[0].digest);
  assert.ok(progress.some((event) => event.phase === 'planned' &&
    event.planningRound === 2 && event.remainingCandidates === 2000));
  assert.ok(progress.every((event) => Number.isInteger(event.savedRouteCount) &&
    Number.isInteger(event.attemptBudget)));
  const state = JSON.parse(await fs.readFile(jobFile, 'utf8'));
  assert.ok(Object.values(state.planningRounds).includes(1));
  const resumed = await coordinator.prepare(options);
  assert.equal(resumed.planningRound, 2);
  assert.equal(requested[1], next[1].digest);
  assert.notEqual(requested[0], requested[1]);
});

test('low-yield preparation explores new rounds before pausing and persists the search cursor', async (t) => {
  const directory = await fs.mkdtemp(path.join(__dirname, '.gps-local-stalled-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new RoutePackStore(path.join(directory, 'road-routes'));
  const seed = 'low-yield';
  const requests = [];
  let graphRevision = 1;
  const provider = {
    id: 'valhalla-local', bulkAllowed: true, endpointFamily: 'http://127.0.0.1:8002',
    health: async () => ({ ready: true, version: 'fixture', tilesetLastModified: graphRevision }),
    fetchRoute: async (candidate) => {
      requests.push(candidate.digest);
      throw Object.assign(new Error('No drivable road near waypoint'), { status: 400 });
    }
  };
  const coordinator = new RoutePreparationCoordinator({ store, provider });
  const options = { regions: [region], seed, targetRouteCount: 2000, maxRequests: 700 };
  const first = await coordinator.prepare(options);
  assert.equal(first.status, 'request-limit');
  assert.equal(first.attempts, 700);
  assert.equal(first.planningRound, 2);
  assert.equal(first.resumeAvailable, true);
  const afterFirst = JSON.parse(await fs.readFile(path.join(store.rootDir, 'jobs',
    'preparation-state.json'), 'utf8'));
  assert.ok(Object.values(afterFirst.planningRounds).includes(1));
  assert.ok(Object.values(afterFirst.planningSearch).some((search) =>
    search.noGainRounds === 1 && search.attemptsWithoutGain === 200));
  const second = await coordinator.prepare({ ...options, maxRequests: 300 });
  assert.equal(second.status, 'request-limit');
  assert.equal(second.attempts, 300);
  assert.equal(second.planningRound, 3);
  const third = await coordinator.prepare({ ...options, maxRequests: 500 });
  assert.equal(third.status, 'search-stalled');
  assert.equal(third.attempts, 500);
  assert.equal(third.planningRound, 4);
  assert.equal(third.resumeAvailable, false);
  assert.match(third.statusDetail, /Three varied planning rounds/);
  const repeated = await coordinator.prepare({ ...options, maxRequests: 1 });
  assert.equal(repeated.status, 'search-stalled');
  assert.equal(repeated.attempts, 0);
  assert.equal(requests.length, 1500);
  assert.notEqual(requests[499], requests[500]);
  assert.notEqual(requests[999], requests[1000]);
  graphRevision = 2;
  const rebuilt = await coordinator.prepare({ ...options, maxRequests: 1 });
  assert.equal(rebuilt.status, 'request-limit');
  assert.equal(rebuilt.attempts, 1);
  assert.equal(requests.length, 1501);
});

test('incremental novelty agrees with full route comparison', () => {
  const a = existingLoop();
  const b = { ...a, digest: 'different-but-same-geometry' };
  const index = createNoveltyIndex([a]);
  assert.equal(index.check(b).accepted, novelty(b, [a]).accepted);
  assert.equal(index.check(a).reason, 'exact-duplicate');
});

test('canceling a local batch publishes accepted routes and a later action resumes', async (t) => {
  const directory = await fs.mkdtemp(path.join(__dirname, '.gps-local-cancel-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new RoutePackStore(path.join(directory, 'road-routes'));
  const controller = new AbortController();
  let calls = 0;
  const provider = {
    id: 'valhalla-local', bulkAllowed: true, endpointFamily: 'http://127.0.0.1:8002',
    health: async () => ({ ready: true, version: 'fixture', tilesetLastModified: 1 }),
    fetchRoute: async (candidate) => {
      calls += 1;
      if (calls === 3) controller.abort();
      return fakeDirections(candidate);
    },
    fetchRoadClasses: async () => ({ localShare: 0.5,
      classMeters: { residential: 500, primary: 500 }, classCounts: { residential: 1, primary: 1 } })
  };
  const coordinator = new RoutePreparationCoordinator({ store, provider });
  const first = await coordinator.prepare({ regions: [region], seed: 'cancel-fixture',
    targetRouteCount: 10, maxRequests: 10, signal: controller.signal });
  assert.equal(first.status, 'canceled');
  assert.ok(first.accepted >= 1);
  assert.equal((await store.loadPack(first.packDigests[0])).routes.length, first.routeCount);

  const resumed = await coordinator.prepare({ regions: [region], seed: 'cancel-fixture',
    targetRouteCount: first.routeCount + 1, maxRequests: 10 });
  assert.equal(resumed.status, 'ready');
  assert.equal(resumed.routeCount, first.routeCount + 1);
  assert.ok(resumed.attempts >= 1);
});

test('a damaged selected generation does not prevent building a fresh local catalog', async (t) => {
  const directory = await fs.mkdtemp(path.join(__dirname, '.gps-local-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new RoutePackStore(path.join(directory, 'road-routes'));
  const oldDigest = await store.writePack({ region, routes: [existingLoop()],
    provider: { id: 'valhalla-local', endpointFamily: 'http://127.0.0.1:8002' } });
  const old = await store.loadPack(oldDigest);
  const checksum = old.manifest.routes[0].blobChecksum;
  const blobFile = path.join(store.rootDir, 'blobs-v2', checksum.slice(0, 2), `${checksum}.bin`);
  const blob = await fs.readFile(blobFile);
  blob[0] ^= 1;
  await fs.writeFile(blobFile, blob);
  const provider = {
    id: 'valhalla-local', bulkAllowed: true, endpointFamily: 'http://127.0.0.1:8002',
    health: async () => ({ ready: true, version: 'fixture', tilesetLastModified: 1 }),
    fetchRoute: async (candidate) => fakeDirections(candidate),
    fetchRoadClasses: async () => ({ localShare: 0.5,
      classMeters: { residential: 500, primary: 500 }, classCounts: { residential: 1, primary: 1 } })
  };
  const result = await new RoutePreparationCoordinator({ store, provider }).prepare({
    regions: [region], seed: 'recover', targetRouteCount: 1, maxRequests: 3
  });
  assert.equal(result.status, 'ready');
  assert.notEqual(result.packDigests[0], oldDigest);
  assert.equal((await store.loadPack(result.packDigests[0])).routes.length, 1);
});

test('a rebuilt local graph starts a new pack and retries its own candidates', async (t) => {
  const directory = await fs.mkdtemp(path.join(__dirname, '.gps-local-graph-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new RoutePackStore(path.join(directory, 'road-routes'));
  let tilesetLastModified = 1;
  const requested = [];
  const provider = {
    id: 'valhalla-local', bulkAllowed: true, endpointFamily: 'http://127.0.0.1:8002',
    health: async () => ({ ready: true, version: 'fixture', tilesetLastModified }),
    fetchRoute: async (candidate) => { requested.push(candidate.digest); return fakeDirections(candidate); },
    fetchRoadClasses: async () => ({ localShare: 0.5,
      classMeters: { residential: 500, primary: 500 }, classCounts: { residential: 1, primary: 1 } })
  };
  const coordinator = new RoutePreparationCoordinator({ store, provider });
  const first = await coordinator.prepare({ regions: [region], seed: 'graph-rebuild',
    targetRouteCount: 1, maxRequests: 1 });
  assert.equal(first.status, 'ready');
  tilesetLastModified = 2;
  const second = await coordinator.prepare({ regions: [region], seed: 'graph-rebuild',
    targetRouteCount: 1, maxRequests: 1 });
  assert.equal(second.status, 'ready');
  assert.equal(second.accepted, 1);
  assert.equal(requested.length, 2);
  assert.equal(requested[0], requested[1]);
  assert.notEqual(first.packDigests[0], second.packDigests[0]);
  assert.equal((await store.loadPack(second.packDigests[0])).manifest.provider.tilesetLastModified, 2);
  assert.equal((await store.loadPack(first.packDigests[0])).manifest.provider.tilesetLastModified, 1);
});

test('a deduplicated alternate keeps its own road-class attribution', async (t) => {
  const directory = await fs.mkdtemp(path.join(__dirname, '.gps-local-alternates-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new RoutePackStore(path.join(directory, 'road-routes'));
  const wideRegion = { ...region, radiusKm: 150 };
  const seed = 'alternate-fixture';
  const candidates = generateCandidates([wideRegion], { seed, limit: 5000 });
  const directIndex = candidates.findIndex((candidate) => candidate.locations.length === 2);
  assert.ok(directIndex >= 0 && directIndex < 20);
  let uniqueDigest;
  const attributedSources = [];
  const provider = {
    id: 'valhalla-local', bulkAllowed: true, endpointFamily: 'http://127.0.0.1:8002',
    health: async () => ({ ready: true, version: 'fixture', tilesetLastModified: 1 }),
    fetchRoute: async (candidate) => {
      if (candidate.locations.length !== 2) {
        throw Object.assign(new Error('Skip non-direct fixture'), { status: 400 });
      }
      const main = fakeDirections(candidate);
      main.tag = 'main';
      const duplicate = { trip: structuredClone(main.trip), tag: 'duplicate' };
      const [start, end] = candidate.locations;
      const detour = { latitude: (start.latitude + end.latitude) / 2,
        longitude: (start.longitude + end.longitude) / 2 + 0.1 };
      const first = interpolate(start, detour);
      const points = first.concat(interpolate(detour, end).slice(1));
      let meters = 0;
      for (let i = 1; i < points.length; i += 1) meters += distanceMeters(points[i - 1], points[i]);
      const unique = { trip: { legs: [{ shape: encodePolyline6(points),
        summary: { length: meters / 1000 } }] }, tag: 'unique' };
      uniqueDigest = validateValhallaRoute(unique, candidate, { region: wideRegion }).digest;
      main.alternate_paths = [duplicate, unique];
      return main;
    },
    fetchRoadClasses: async (source) => {
      attributedSources.push(source.tag);
      const localShare = { main: 0.6, duplicate: 0.1, unique: 0.9 }[source.tag];
      return { localShare, classMeters: { residential: localShare * 1000,
        primary: (1 - localShare) * 1000 }, classCounts: { residential: 1, primary: 1 } };
    }
  };
  const result = await new RoutePreparationCoordinator({ store, provider }).prepare({
    regions: [wideRegion], seed, targetRouteCount: 3, maxRequests: directIndex + 1
  });
  assert.equal(result.accepted, 2);
  assert.deepEqual(attributedSources, ['main', 'unique']);
  const pack = await store.loadPack(result.packDigests[0]);
  const alternate = pack.routes.find((route) => route.digest === uniqueDigest);
  assert.ok(alternate);
  assert.equal(alternate.roadClassSummary.localShare, 0.9);
});

test('overlapping routed geometry skips native road-class tracing while retaining graph checks', async (t) => {
  const directory = await fs.mkdtemp(path.join(__dirname, '.gps-local-novelty-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new RoutePackStore(path.join(directory, 'road-routes'));
  let firstCandidate;
  let routeCalls = 0;
  let traceCalls = 0;
  let healthCalls = 0;
  const provider = {
    id: 'valhalla-local', bulkAllowed: true, endpointFamily: 'http://127.0.0.1:8002',
    health: async () => {
      healthCalls += 1;
      return { ready: true, version: 'fixture', tilesetLastModified: 1 };
    },
    fetchRoute: async (candidate) => {
      routeCalls += 1;
      if (!firstCandidate) {
        firstCandidate = { locations: candidate.locations.map((point) => ({ ...point })),
          closedLoop: candidate.closedLoop, family: candidate.family };
      } else {
        // Simulate two nearby proposals snapping to the same verified road path.
        candidate.locations = firstCandidate.locations;
        candidate.closedLoop = firstCandidate.closedLoop;
        candidate.family = firstCandidate.family;
      }
      return fakeDirections(candidate);
    },
    fetchRoadClasses: async () => {
      traceCalls += 1;
      return { localShare: 0.6, classMeters: { residential: 600, primary: 400 },
        classCounts: { residential: 1, primary: 1 } };
    }
  };
  const result = await new RoutePreparationCoordinator({ store, provider }).prepare({
    regions: [region], seed: 'novelty-prefilter', targetRouteCount: 3, maxRequests: 2
  });
  assert.equal(result.status, 'request-limit');
  assert.equal(result.accepted, 1);
  assert.equal(result.rejected, 1);
  assert.equal(routeCalls, 2);
  assert.equal(traceCalls, 1);
  assert.equal(healthCalls, 3);
  assert.equal(result.coverage.acceptedRouteCount, 1);
  assert.equal((await store.loadPack(result.packDigests[0])).routes.length, 1);
});

test('a graph change or service outage during attribution discards the current candidate', async (t) => {
  for (const [laterHealth, expectedStatus] of [
    [{ ready: true, version: 'fixture', tilesetLastModified: 2 }, 'graph-changed'],
    [{ ready: false }, 'provider-unavailable']
  ]) {
    const directory = await fs.mkdtemp(path.join(__dirname, '.gps-local-health-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = new RoutePackStore(path.join(directory, 'road-routes'));
    let healthCalls = 0;
    const provider = {
      id: 'valhalla-local', bulkAllowed: true, endpointFamily: 'http://127.0.0.1:8002',
      health: async () => ++healthCalls === 1
        ? { ready: true, version: 'fixture', tilesetLastModified: 1 } : laterHealth,
      fetchRoute: async (candidate) => fakeDirections(candidate),
      fetchRoadClasses: async () => ({ localShare: 0.6,
        classMeters: { residential: 600, primary: 400 },
        classCounts: { residential: 1, primary: 1 } })
    };
    const result = await new RoutePreparationCoordinator({ store, provider }).prepare({
      regions: [region], seed: `health-${expectedStatus}`, targetRouteCount: 1, maxRequests: 1
    });
    assert.equal(result.status, expectedStatus);
    assert.equal(result.accepted, 0);
    assert.equal(result.routeCount, 0);
    assert.deepEqual(result.packDigests, []);
    assert.equal(healthCalls, 2);
  }
});

test('one untraceable route does not halt local catalog preparation', async (t) => {
  const directory = await fs.mkdtemp(path.join(__dirname, '.gps-local-trace-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new RoutePackStore(path.join(directory, 'road-routes'));
  let traceCalls = 0;
  const provider = {
    id: 'valhalla-local', bulkAllowed: true, endpointFamily: 'http://127.0.0.1:8002',
    health: async () => ({ ready: true, version: 'fixture', tilesetLastModified: 1 }),
    fetchRoute: async (candidate) => fakeDirections(candidate),
    fetchRoadClasses: async () => {
      traceCalls += 1;
      if (traceCalls === 1) throw Object.assign(new Error('Untraceable route leg'),
        { code: 'ROAD_ATTRIBUTES_UNAVAILABLE' });
      return { localShare: 0.6, classMeters: { residential: 600, primary: 400 },
        classCounts: { residential: 1, primary: 1 } };
    }
  };
  const result = await new RoutePreparationCoordinator({ store, provider }).prepare({
    regions: [region], seed: 'trace-recovery', targetRouteCount: 1, maxRequests: 3
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.rejected, 1);
  assert.equal(result.accepted, 1);
  assert.equal(traceCalls, 2);
});
