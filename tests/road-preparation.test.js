'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { decodePolyline6, validateValhallaRoute, distanceMeters } = require('../src/road/route-validator');
const { validateRegions } = require('../src/road/region-planner');
const { generateCandidates } = require('../src/road/candidate-planner');
const { RoutePackStore } = require('../src/road/route-pack-store');
const { novelty } = require('../src/road/diversity-evaluator');
const { ProviderBudget } = require('../src/road/provider-budget');
const { PublicValhallaProvider, ENDPOINT } = require('../src/road/public-valhalla-provider');
const { evaluateCoverage } = require('../src/road/route-capacity');
const { RoutePreparationCoordinator } = require('../src/road/route-preparation-coordinator');

const region = { id: 'san-francisco', centerLatitude: 37.775, centerLongitude: -122.419,
  radiusKm: 10, fleetWeight: 1 };

function encodeNumber(number) {
  let integer = number < 0 ? -number * 2 - 1 : number * 2;
  let text = '';
  while (integer >= 32) { text += String.fromCharCode((32 | (integer % 32)) + 63); integer = Math.floor(integer / 32); }
  return text + String.fromCharCode(integer + 63);
}

function encodePolyline6(points) {
  let lat = 0;
  let lon = 0;
  let encoded = '';
  for (const point of points) {
    const nextLat = Math.round(point.latitude * 1e6);
    const nextLon = Math.round(point.longitude * 1e6);
    encoded += encodeNumber(nextLat - lat) + encodeNumber(nextLon - lon);
    lat = nextLat;
    lon = nextLon;
  }
  return encoded;
}

function interpolate(from, to) {
  const count = Math.max(1, Math.ceil(distanceMeters(from, to) / 150));
  return Array.from({ length: count + 1 }, (_, index) => ({
    latitude: Math.round((from.latitude + (to.latitude - from.latitude) * index / count) * 1e6) / 1e6,
    longitude: Math.round((from.longitude + (to.longitude - from.longitude) * index / count) * 1e6) / 1e6
  }));
}

function mockValhalla(candidate) {
  const legs = [];
  for (let i = 1; i < candidate.locations.length; i += 1) {
    const shape = interpolate(candidate.locations[i - 1], candidate.locations[i]);
    let meters = 0;
    for (let j = 1; j < shape.length; j += 1) meters += distanceMeters(shape[j - 1], shape[j]);
    legs.push({ shape: encodePolyline6(shape), summary: { length: meters / 1000 } });
  }
  return { trip: { legs } };
}

function squareCandidate() {
  const a = { latitude: 37.7749, longitude: -122.4194 };
  const b = { latitude: 37.7769, longitude: -122.4194 };
  const c = { latitude: 37.7769, longitude: -122.4174 };
  const d = { latitude: 37.7749, longitude: -122.4174 };
  return { regionId: region.id, family: 'local', closedLoop: true, locations: [a, b, c, d, a], digest: 'fixture' };
}

async function temporaryStore(t) {
  const directory = await fs.mkdtemp(path.join(__dirname, '.gps-farm-road-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, store: new RoutePackStore(path.join(directory, 'road-routes')) };
}

test('strict polyline6 decoding preserves latitude/longitude and rejects malformed encoding', () => {
  const input = [{ latitude: 37.7749, longitude: -122.4194 }, { latitude: 37.7751, longitude: -122.4191 }];
  assert.deepEqual(decodePolyline6(encodePolyline6(input)), input);
  assert.throws(() => decodePolyline6('~'), /Unterminated/);
  assert.throws(() => decodePolyline6('!!!!'), /Malformed/);
  assert.throws(() => decodePolyline6(encodePolyline6(input), 1), /length|points/);
});

test('provider legs establish legal closed tour and reject invalid continuity or length', () => {
  const candidate = squareCandidate();
  const response = mockValhalla(candidate);
  const route = validateValhallaRoute(response, candidate, { region });
  assert.equal(route.closedLoop, true);
  assert.equal(route.points[0].latitude, candidate.locations[0].latitude);
  assert.ok(route.lengthMeters > 500);
  assert.equal(route.cumulativeMeters.at(-1), route.lengthMeters);
  assert.equal(route.legEndIndices.length, 4);
  assert.deepEqual(route.parkedAnchors, [0, route.legEndIndices[0]]);
  const regional = validateValhallaRoute(response, { ...candidate, family: 'regional' }, { region });
  assert.deepEqual(regional.parkedAnchors, []);
  const broken = structuredClone(response);
  const displaced = decodePolyline6(broken.trip.legs[1].shape).map((point) => ({ ...point, longitude: point.longitude + 0.01 }));
  broken.trip.legs[1].shape = encodePolyline6(displaced);
  assert.throws(() => validateValhallaRoute(broken, candidate), /snapped|Disconnected/);
  const wrongLength = structuredClone(response);
  wrongLength.trip.legs[0].summary.length = 100;
  assert.throws(() => validateValhallaRoute(wrongLength, candidate), /length differs/);
  assert.throws(() => validateValhallaRoute(response, { ...candidate, locations: candidate.locations.slice(0, -1) }), /leg count/);
});

test('repeated provider vertices are removed before publishing a distance index', async (t) => {
  const { store } = await temporaryStore(t);
  const candidate = squareCandidate();
  const response = mockValhalla(candidate);
  for (const leg of response.trip.legs) {
    const decoded = decodePolyline6(leg.shape);
    decoded.splice(2, 0, decoded[1]);
    leg.shape = encodePolyline6(decoded);
  }
  const route = validateValhallaRoute(response, candidate, { region });
  assert.ok(route.cumulativeMeters.every((meters, index) => index === 0 ||
    meters > route.cumulativeMeters[index - 1]));
  assert.ok(route.points.every((point, index) => index === 0 ||
    distanceMeters(point, route.points[index - 1]) > 0));
  const digest = await store.writePack({ region, routes: [route] });
  const loaded = await store.loadPack(digest);
  assert.ok(loaded.routes[0].cumulativeMeters.every((meters, index) => index === 0 ||
    meters > loaded.routes[0].cumulativeMeters[index - 1]));
});

test('geographic candidates are deterministic, multi-zone and schema bounded', () => {
  const regions = validateRegions([region]);
  const first = generateCandidates(regions, { seed: 'same', limit: 30 });
  const second = generateCandidates(regions, { seed: 'same', limit: 30 });
  assert.deepEqual(first, second);
  assert.ok(new Set(first.flatMap((candidate) => candidate.zoneIds)).size >= 5);
  assert.ok(first.some((candidate) => candidate.closedLoop));
  assert.ok(first.some((candidate) => !candidate.closedLoop));
  assert.throws(() => validateRegions([{ ...region, id: '../escape' }]), /ID/);
});

test('broad metro planner has enough distinct legal-tour proposals for enterprise preparation', () => {
  const metro = { id: 'metro', centerLatitude: 28.6139, centerLongitude: 77.209,
    radiusKm: 50, fleetWeight: 1 };
  const proposals = generateCandidates([metro], { seed: 'enterprise-fixture', limit: 2000 });
  const closed = proposals.filter((candidate) => candidate.closedLoop);
  const firstBatch = generateCandidates([metro], { seed: 'enterprise-fixture', limit: 500 });
  assert.ok(proposals.length > 500);
  assert.ok(closed.length >= 300);
  assert.equal(firstBatch.length, 500);
  assert.ok(firstBatch.filter((candidate) => candidate.closedLoop).length >= 300);
  assert.deepEqual(firstBatch, proposals.slice(0, 500));
  assert.equal(new Set(proposals.map((candidate) => candidate.digest)).size, proposals.length);
  assert.equal(new Set(proposals.map((candidate) => JSON.stringify(candidate.locations))).size, proposals.length);
  assert.ok(new Set(proposals.flatMap((candidate) => candidate.zoneIds)).size >= 15);
  assert.ok(closed.every((candidate) => candidate.locations.length === 4 &&
    candidate.locations[0] === candidate.locations[3]));
  for (const family of ['urban', 'suburban', 'regional']) {
    assert.ok(proposals.some((candidate) => candidate.family === family && candidate.closedLoop));
    assert.ok(proposals.some((candidate) => candidate.family === family && !candidate.closedLoop));
  }
});

test('a separately routed reverse direction is useful while repeated geometry is not', () => {
  const a = { latitude: 37.7749, longitude: -122.4194 };
  const b = { latitude: 37.7799, longitude: -122.4154 };
  const outward = { regionId: region.id, family: 'urban', closedLoop: false, locations: [a, b] };
  const returned = { ...outward, locations: [b, a] };
  const routeOut = validateValhallaRoute(mockValhalla(outward), outward, { region });
  const routeBack = validateValhallaRoute(mockValhalla(returned), returned, { region });
  assert.equal(novelty(routeOut, [routeOut]).accepted, false);
  assert.equal(novelty(routeBack, [routeOut]).accepted, true);
  assert.ok(novelty(routeBack, [routeOut]).directedOverlapRatio < 0.1);
});

test('route packs roundtrip with checksums and reject altered geometry', async (t) => {
  const { store } = await temporaryStore(t);
  const candidate = squareCandidate();
  const route = validateValhallaRoute(mockValhalla(candidate), candidate, { region });
  const digest = await store.writePack({ region, routes: [route] });
  const pack = await store.loadPack(digest);
  assert.equal(pack.routes.length, 1);
  assert.equal(pack.routes[0].digest, route.digest);
  assert.equal(pack.routes[0].lengthMeters, pack.routes[0].cumulativeMeters.at(-1));
  assert.equal(pack.parkedAnchors.length, 2);
  assert.equal((await store.listPacks(region.id)).length, 1);
  const blobChecksum = pack.manifest.routes[0].blobChecksum;
  const geometryFile = path.join(store.rootDir, 'blobs-v2', blobChecksum.slice(0, 2), `${blobChecksum}.bin`);
  const geometry = await fs.readFile(geometryFile);
  geometry[0] ^= 1;
  await fs.writeFile(geometryFile, geometry);
  await assert.rejects(store.loadPack(digest), /checksum/);
  await assert.rejects(store.listPacks(region.id), /Corrupt selected road route pack/);
  assert.deepEqual(await store.listPacks(undefined, { includeHistorical: true }), []);
});

test('provider budget serializes attempts, persists caps and observes 429 cooldown', async (t) => {
  const { directory } = await temporaryStore(t);
  let now = 1_700_000_000_000;
  const stateFile = path.join(directory, 'state.json');
  const budget = new ProviderBudget({ stateFile, now: () => now,
    sleep: async (ms) => { now += ms; }, dailyLimit: 2, actionLimit: 2 });
  await Promise.all([budget.run('job', async () => 1), budget.run('job', async () => 2)]);
  assert.equal((await budget.readState()).dailyAttempts, 2);
  assert.equal((await budget.readState()).lastAttemptMs, 1_700_000_002_000);
  await assert.rejects(budget.run('job', async () => 3), (error) => error.code === 'BUDGET_EXHAUSTED');
  now += 24 * 60 * 60_000;
  await budget.run('new-day-job', async () => 4);
  assert.equal((await budget.readState()).dailyAttempts, 1);
  assert.deepEqual(Object.keys((await budget.readState()).actions), ['new-day-job']);
  const limited = new ProviderBudget({ stateFile: path.join(directory, 'limited.json'), now: () => now, sleep: async () => {} });
  await assert.rejects(limited.run('job', async () => {
    const error = new Error('rate limited');
    error.status = 429;
    error.retryAfterMs = 30 * 60_000;
    throw error;
  }), /rate limited/);
  await assert.rejects(limited.run('job', async () => 1), (error) => error.code === 'PROVIDER_COOLDOWN');
});

test('Valhalla provider is disabled by default and a mocked request stays fixed to approved endpoint', async (t) => {
  const { directory } = await temporaryStore(t);
  const budget = new ProviderBudget({ stateFile: path.join(directory, 'budget.json') });
  let calls = 0;
  const fakeFetch = async (url, init) => {
    calls += 1;
    assert.equal(url, ENDPOINT);
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['X-Client-Id'], 'openvts.io');
    assert.equal(JSON.parse(init.body).costing, 'auto');
    return new Response(JSON.stringify(mockValhalla(squareCandidate())), {
      headers: { 'content-type': 'application/json' }
    });
  };
  const disabled = new PublicValhallaProvider({ budget, fetchImpl: fakeFetch });
  await assert.rejects(disabled.fetchRoute(squareCandidate(), { actionId: 'job' }), (error) => error.code === 'PROVIDER_DISABLED');
  assert.equal(calls, 0);
  const enabled = new PublicValhallaProvider({ budget, enabled: true, fetchImpl: fakeFetch });
  const response = await enabled.fetchRoute(squareCandidate(), { actionId: 'job' });
  assert.equal(response.trip.legs.length, 4);
  assert.equal(calls, 1);
  await assert.rejects(enabled.fetchRoute({ ...squareCandidate(), alternates: 2 }, { actionId: 'job' }), /Multipoint/);
});

test('mocked HTTP 429 causes persistent cooldown without automatic retry', async (t) => {
  const { directory } = await temporaryStore(t);
  let now = 1_700_000_000_000;
  const budget = new ProviderBudget({ stateFile: path.join(directory, 'budget.json'), now: () => now, sleep: async (ms) => { now += ms; } });
  let calls = 0;
  const provider = new PublicValhallaProvider({ budget, enabled: true, fetchImpl: async () => {
    calls += 1;
    return new Response('rate limited', { status: 429, headers: { 'retry-after': '1800' } });
  } });
  await assert.rejects(provider.fetchRoute(squareCandidate(), { actionId: 'job' }), (error) => error.status === 429);
  assert.equal(calls, 1);
  assert.ok((await budget.readState()).cooldownUntilMs >= now + 1_800_000);
  await assert.rejects(provider.fetchRoute(squareCandidate(), { actionId: 'job' }), (error) => error.code === 'PROVIDER_COOLDOWN');
  assert.equal(calls, 1);
});

test('readiness counts distinct roads and reports an unprepared region', () => {
  const candidate = squareCandidate();
  const route = validateValhallaRoute(mockValhalla(candidate), candidate, { region });
  const secondRegion = { ...region, id: 'elsewhere', centerLatitude: 34.05, centerLongitude: -118.24, fleetWeight: 0.5 };
  const firstRegion = { ...region, fleetWeight: 0.5 };
  const duplicate = { ...route, id: `${route.id}-copy` };
  const report = evaluateCoverage([{ region: firstRegion, routes: [route, duplicate] }], {
    regions: [firstRegion, secondRegion], movingDevices: 500
  });
  assert.equal(report.distinctRouteCount, 1);
  assert.equal(report.status, 'insufficient-coverage');
  assert.ok(report.usableMovingCapacityEstimate < 500);
  assert.ok(report.deficits.some((message) => message.includes('elsewhere')));
});

test('continuous-motion readiness counts only closed tours without penalizing other inventory', () => {
  const candidate = squareCandidate();
  const closed = validateValhallaRoute(mockValhalla(candidate), candidate, { region });
  const open = { ...closed, id: 'open-destination', digest: 'open-destination', closedLoop: false,
    points: closed.points.map((point) => ({ ...point, latitude: point.latitude + 0.002 })) };
  const report = evaluateCoverage([{ region, routes: [closed, open] }], {
    regions: [region], movingDevices: 1, minDistinctRoutes: 1, minZones: 0,
    requireContinuousMotion: true
  });
  assert.equal(report.ready, true);
  assert.equal(report.acceptedRouteCount, 2);
  assert.equal(report.distinctRouteCount, 1);
  assert.ok(report.usableMovingCapacityEstimate >= 1);
  const noAnchors = { ...closed, parkedAnchors: [] };
  const parkedReport = evaluateCoverage([{ region, routes: [noAnchors] }], {
    regions: [region], movingDevices: 1, parkedDevices: 1,
    minDistinctRoutes: 1, minZones: 0, requireContinuousMotion: true,
    scenarioSeed: 'saved-scenario'
  });
  assert.equal(parkedReport.ready, false);
  assert.ok(parkedReport.deficits.some((message) => message.includes('stationary anchors')));
});

test('canceled preparation leaves cache and provider untouched', async (t) => {
  const { store } = await temporaryStore(t);
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const coordinator = new RoutePreparationCoordinator({ store, provider: {
    fetchRoute: async () => { calls += 1; throw new Error('unexpected provider call'); }
  } });
  const result = await coordinator.prepare({ regions: [region], maxRequests: 1,
    requestedMoving: 100, signal: controller.signal });
  assert.equal(result.status, 'canceled');
  assert.equal(calls, 0);
  assert.deepEqual(result.packDigests, []);
});

test('transient provider failure keeps a candidate eligible for a later action', async (t) => {
  const { store } = await temporaryStore(t);
  let attempts = 0;
  const coordinator = new RoutePreparationCoordinator({ store, provider: {
    fetchRoute: async (candidate) => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('temporary outage');
        error.status = 503;
        throw error;
      }
      return mockValhalla(candidate);
    }
  } });
  const first = await coordinator.prepare({ regions: [region], seed: 'retry',
    maxRequests: 1, requestedMoving: 100 });
  assert.equal(first.status, 'provider-unavailable');
  assert.equal(first.attempts, 1);
  const second = await coordinator.prepare({ regions: [region], seed: 'retry',
    maxRequests: 1, requestedMoving: 100 });
  assert.equal(second.accepted, 1);
  assert.equal(attempts, 2);
});

for (const [description, savedState] of [
  ['legacy unscoped job state', (digest) => JSON.stringify({ schemaVersion: 1, attempted: [digest] })],
  ['truncated job state', () => '{"schemaVersion":2,"scope":'],
  ['invalid scoped job state', (digest) => JSON.stringify({ schemaVersion: 2,
    scope: 'invalid', attempted: [digest] })]
]) {
  test(`${description} cannot block new real-road preparation`, async (t) => {
    const { store } = await temporaryStore(t);
    const seed = 'job-state-recovery';
    const firstDigest = generateCandidates([region], { seed, limit: 2000 })[0].digest;
    const jobFile = path.join(store.rootDir, 'jobs', 'preparation-state.json');
    await fs.mkdir(path.dirname(jobFile), { recursive: true });
    const original = savedState(firstDigest);
    await fs.writeFile(jobFile, original);
    const requested = [];
    const coordinator = new RoutePreparationCoordinator({ store, provider: {
      fetchRoute: async (candidate) => {
        requested.push(candidate.digest);
        return mockValhalla(candidate);
      }
    } });
    const result = await coordinator.prepare({ regions: [region], seed,
      maxRequests: 1, requestedMoving: 100 });
    assert.equal(requested[0], firstDigest);
    assert.equal(result.accepted, 1);
    const state = JSON.parse(await fs.readFile(jobFile, 'utf8'));
    assert.equal(state.schemaVersion, 2);
    assert.match(state.scope, /^[a-f0-9]{64}$/);
    assert.ok(state.attempted.includes(firstDigest));
    const archive = (await fs.readdir(path.dirname(jobFile)))
      .find((name) => name.startsWith('preparation-state.json.recovered-'));
    assert.ok(archive, 'the obsolete resume list is kept for diagnosis');
    assert.equal(await fs.readFile(path.join(path.dirname(jobFile), archive), 'utf8'), original);
  });
}

test('valid scoped job state still skips a rejected candidate on retry', async (t) => {
  const { store } = await temporaryStore(t);
  const requests = [];
  const coordinator = new RoutePreparationCoordinator({ store, provider: {
    fetchRoute: async (candidate) => {
      requests.push(candidate.digest);
      if (requests.length === 1) {
        const error = new Error('candidate has no drivable road');
        error.status = 400;
        throw error;
      }
      return mockValhalla(candidate);
    }
  } });
  const options = { regions: [region], seed: 'scoped-retry', maxRequests: 1,
    requestedMoving: 100 };
  assert.equal((await coordinator.prepare(options)).rejected, 1);
  assert.equal((await coordinator.prepare(options)).accepted, 1);
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0], requests[1]);
});

test('rejected candidate batches are saved before a preparation action returns', async (t) => {
  const { store } = await temporaryStore(t);
  const requests = [];
  const coordinator = new RoutePreparationCoordinator({ store, provider: {
    fetchRoute: async (candidate) => {
      requests.push(candidate.digest);
      throw Object.assign(new Error('No drivable road near waypoint'), { status: 400 });
    }
  } });
  const options = { regions: [region], seed: 'rejected-batch', maxRequests: 3,
    requestedMoving: 100 };
  const first = await coordinator.prepare(options);
  assert.equal(first.status, 'request-limit');
  assert.equal(first.rejected, 3);
  const state = JSON.parse(await fs.readFile(path.join(store.rootDir, 'jobs',
    'preparation-state.json'), 'utf8'));
  assert.deepEqual(state.attempted, requests);
  await coordinator.prepare({ ...options, maxRequests: 1 });
  assert.equal(requests.length, 4);
  assert.ok(!state.attempted.includes(requests[3]));
});

test('changing only region fleet weights reuses cached geometry with new immutable metadata', async (t) => {
  const { store } = await temporaryStore(t);
  const oldRegions = [
    { ...region, id: 'west', fleetWeight: 0.5 },
    { ...region, id: 'east', centerLongitude: region.centerLongitude + 0.02, fleetWeight: 0.5 }
  ];
  for (const requestedRegion of oldRegions) {
    const candidate = squareCandidate();
    candidate.regionId = requestedRegion.id;
    candidate.locations = candidate.locations.map((point) => ({
      latitude: point.latitude,
      longitude: point.longitude + requestedRegion.centerLongitude - region.centerLongitude
    }));
    const route = validateValhallaRoute(mockValhalla(candidate), candidate, { region: requestedRegion });
    await store.writePack({ region: requestedRegion, routes: [route] });
  }
  let calls = 0;
  const coordinator = new RoutePreparationCoordinator({ store, provider: {
    fetchRoute: async () => { calls += 1; throw new Error('unexpected call'); }
  } });
  const newRegions = [{ ...oldRegions[0], fleetWeight: 0.6 }, { ...oldRegions[1], fleetWeight: 0.4 }];
  const result = await coordinator.prepare({ regions: newRegions, maxRequests: 0, requestedMoving: 50 });
  assert.equal(result.attempts, 0);
  assert.equal(calls, 0);
  assert.equal(result.packDigests.length, 2);
  const selected = await store.listPacks();
  assert.deepEqual(selected.map((pack) => pack.region.fleetWeight).sort(), [0.4, 0.6]);
});

test('preparation reads cache first and appends accepted routes into immutable generations', async (t) => {
  const { store } = await temporaryStore(t);
  let requests = 0;
  const provider = { fetchRoute: async (candidate) => { requests += 1; return mockValhalla(candidate); } };
  const coordinator = new RoutePreparationCoordinator({ store, provider });
  const first = await coordinator.prepare({ regions: [region], seed: 'test', maxRequests: 1, requestedMoving: 100 });
  assert.equal(first.attempts, 1);
  assert.equal(first.accepted, 1);
  assert.equal(first.packDigests.length, 1);
  const previous = await store.loadPack(first.packDigests[0]);
  const second = await coordinator.prepare({ regions: [region], seed: 'test', maxRequests: 1, requestedMoving: 100 });
  assert.equal(second.attempts, 1);
  assert.equal(requests, 2);
  const current = await store.loadPack(second.packDigests[0]);
  assert.ok(current.routes.length >= previous.routes.length);
  assert.equal((await store.loadPack(first.packDigests[0])).routes.length, previous.routes.length);
  assert.equal((await store.listPacks()).length, 1);
  assert.ok((await store.listPacks(undefined, { includeHistorical: true })).length >= 2);
  const summaries = await store.listPackSummaries();
  assert.ok(summaries.length >= 2);
  assert.ok(summaries.every((summary) => summary.integrity === 'manifest-verified'));
  await store.selectPack(first.packDigests[0], region.id);
  assert.equal((await store.listPacks())[0].digest, first.packDigests[0]);
  await store.selectPack(second.packDigests[0], region.id);
  const cacheOnly = await coordinator.prepare({ regions: [region], seed: 'test', maxRequests: 0, requestedMoving: 100 });
  assert.equal(cacheOnly.attempts, 0);
  assert.equal(requests, 2);
  assert.equal(cacheOnly.coverage.acceptedRouteCount, current.routes.length);
  assert.equal(evaluateCoverage([current], { regions: [region], movingDevices: 100 }).ready, false);
  const changedRegion = { ...region, centerLatitude: region.centerLatitude + 0.5 };
  const changed = await coordinator.prepare({ regions: [changedRegion], maxRequests: 0, requestedMoving: 100 });
  assert.deepEqual(changed.packDigests, []);
  assert.equal(changed.coverage.acceptedRouteCount, 0);
});
