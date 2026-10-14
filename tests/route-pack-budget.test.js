'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { RoutePackStore, MAX_ACTIVE_ROUTE_POINTS, MAX_ROUTES_PER_PACK } = require('../src/road/route-pack-store');
const { coordinatesDigest, distanceMeters, sha256 } = require('../src/road/route-validator');

const region = { id: 'budget-fixture', centerLatitude: 20, centerLongitude: 77,
  radiusKm: 10, fleetWeight: 1 };

function route(points) {
  const cumulativeMeters = [0];
  for (let i = 1; i < points.length; i += 1) {
    cumulativeMeters.push(cumulativeMeters.at(-1) + distanceMeters(points[i - 1], points[i]));
  }
  return { id: 'route-1', regionId: region.id, family: 'local', closedLoop: false,
    points, cumulativeMeters, lengthMeters: cumulativeMeters.at(-1),
    digest: coordinatesDigest(points), parkedAnchors: [0] };
}

async function storeForTest(t) {
  const directory = await fs.mkdtemp(path.join(__dirname, '.gps-farm-budget-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return new RoutePackStore(path.join(directory, 'road-routes'));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

test('a point budget rejects a pack before expanding route geometry', async (t) => {
  const store = await storeForTest(t);
  const points = [{ latitude: 20, longitude: 77 }, { latitude: 20.01, longitude: 77 }];
  const digest = await store.writePack({ region, routes: [route(points)] });
  const pack = await store.loadPack(digest, undefined, { pointBudget: 2 });
  assert.equal(pack.pointCount, 2);
  await assert.rejects(store.loadPack(digest, undefined, { pointBudget: 1 }), /point limit/);
  await assert.rejects(store.loadPack(digest, undefined, { pointBudget: MAX_ACTIVE_ROUTE_POINTS + 1 }), /point budget/);
});

test('a newly validated route repairs a corrupt matching geometry blob', async (t) => {
  const store = await storeForTest(t);
  const geometry = route([{ latitude: 20, longitude: 77 },
    { latitude: 20.01, longitude: 77.01 }]);
  const oldDigest = await store.writePack({ region, routes: [geometry] });
  const oldPack = await store.loadPack(oldDigest);
  const checksum = oldPack.manifest.routes[0].blobChecksum;
  const blobFile = path.join(store.rootDir, 'blobs-v2', checksum.slice(0, 2), `${checksum}.bin`);
  const damaged = await fs.readFile(blobFile);
  damaged[0] ^= 1;
  await fs.writeFile(blobFile, damaged);
  await assert.rejects(store.loadPack(oldDigest), /checksum/);
  const repairedDigest = await store.writePack({ region, routes: [geometry], sourceRequests: 1 });
  assert.deepEqual((await store.loadPack(repairedDigest)).routes[0].points, geometry.points);
  assert.deepEqual((await store.loadPack(oldDigest)).routes[0].points, geometry.points);
});

test('writePack rejects an oversized catalog before validating millions of vertices', async (t) => {
  const store = await storeForTest(t);
  const sharedPoints = new Array(100_000);
  const routes = Array.from({ length: Math.floor(MAX_ACTIVE_ROUTE_POINTS / sharedPoints.length) + 1 },
    (_, index) => ({ id: `route-${index}`, points: sharedPoints }));
  await assert.rejects(store.writePack({ region, routes }), /point limit/);
  assert.deepEqual(await store.listPacks(), []);
});

test('a 2000-route catalog roundtrips within the active point budget', async (t) => {
  const store = await storeForTest(t);
  const routes = Array.from({ length: 2_000 }, (_, index) => {
    const row = Math.floor(index / 50);
    const column = index % 50;
    const latitude = 20 + row * 0.001;
    const longitude = 77 + column * 0.001;
    const points = [{ latitude, longitude }, { latitude: latitude + 0.002, longitude }];
    return { ...route(points), id: `route-${index}` };
  });
  routes[0].provider = 'local-valhalla';
  routes[0].profile = 'intracity-auto-v1';
  routes[0].roadClassSummary = { localShare: 0.8,
    classMeters: { residential: 180, tertiary: 45 },
    classCounts: { residential: 2, tertiary: 1 } };
  const digest = await store.writePack({ region, routes });
  await assert.rejects(store.loadPack(digest, region.id, { pointBudget: routes.length * 2 - 1 }),
    /active geometry point limit/);
  const loaded = await store.loadPack(digest, region.id, { pointBudget: routes.length * 2 });
  assert.equal(loaded.routes.length, routes.length);
  assert.equal(loaded.pointCount, routes.length * 2);
  assert.equal(new Set(loaded.routes.map((item) => item.digest)).size, routes.length);
  assert.equal(loaded.routes[0].provider, 'local-valhalla');
  assert.equal(loaded.routes[0].profile, 'intracity-auto-v1');
  assert.deepEqual(loaded.routes[0].roadClassSummary, routes[0].roadClassSummary);
  assert.deepEqual(loaded.routes[1_999].points, routes[1_999].points);
  assert.equal((await store.listPacks(region.id))[0].digest, digest);
  assert.deepEqual((await store.listPackSummaries(region.id, { includeHistorical: false }))
    .map((item) => [item.routeCount, item.integrity]), [[2_000, 'manifest-verified']]);
});

test('route count is bounded before expensive geometry validation', async (t) => {
  const store = await storeForTest(t);
  const tooMany = Array.from({ length: MAX_ROUTES_PER_PACK + 1 }, () => ({ points: [] }));
  await assert.rejects(store.writePack({ region, routes: tooMany }), /route count limit/);
  assert.deepEqual(await store.listPacks(), []);
});

test('road-class metadata rejects unbounded or invalid values', async (t) => {
  const store = await storeForTest(t);
  const points = [{ latitude: 20, longitude: 77 }, { latitude: 20.01, longitude: 77 }];
  const valid = route(points);
  await assert.rejects(store.writePack({ region, routes: [{ ...valid,
    roadClassSummary: { localShare: 2, classMeters: {}, classCounts: {} } }] }), /road-class summary/);
  await assert.rejects(store.writePack({ region, routes: [{ ...valid,
    roadClassSummary: { localShare: 0.5, classMeters: { airport: 100 }, classCounts: {} } }] }),
  /road-class summary/);
  await assert.rejects(store.writePack({ region, routes: [{ ...valid, profile: 'x'.repeat(81) }] }),
    /provider or profile/);
  assert.deepEqual(await store.listPacks(), []);
});

test('writePack rejects points that collapse onto one vertex after microdegree rounding', async (t) => {
  const store = await storeForTest(t);
  const points = [{ latitude: 20, longitude: 77 },
    { latitude: 20.0000004, longitude: 77 },
    { latitude: 20.01, longitude: 77 }];
  await assert.rejects(store.writePack({ region, routes: [route(points)] }), /segment/);
  assert.deepEqual(await store.listPacks(), []);
});

test('appending a legacy pack tolerates a valid blob made with different float64 distances', async (t) => {
  const store = await storeForTest(t);
  const first = route([{ latitude: 20, longitude: 77 }, { latitude: 20.01, longitude: 77 }]);
  const legacyBytes = Buffer.alloc(first.points.length * 16);
  first.points.forEach((point, index) => {
    legacyBytes.writeInt32LE(Math.round(point.latitude * 1e6), index * 16);
    legacyBytes.writeInt32LE(Math.round(point.longitude * 1e6), index * 16 + 4);
    legacyBytes.writeDoubleLE(first.cumulativeMeters[index] + (index === 1 ? 1e-9 : 0), index * 16 + 8);
  });
  const legacyChecksum = sha256(legacyBytes);
  const attribution = '© OpenStreetMap contributors\n';
  const body = {
    schemaVersion: 2,
    generatedAtUtc: '2026-10-14T00:00:00.000Z',
    region,
    provider: { id: 'fossgis-valhalla-public', costing: 'auto' },
    routes: [{ id: first.id, regionId: region.id, family: first.family, closedLoop: false,
      digest: first.digest, blobChecksum: legacyChecksum, pointCount: first.points.length,
      lengthMeters: first.lengthMeters, legEndIndices: [], parkedAnchors: first.parkedAnchors,
      sourceRequestDigest: null, fetchedAtUtc: null }],
    geometryStorage: 'content-addressed-route-blobs-v1',
    sourceRequests: 1,
    coordinateFormat: 'signed-int32-microdegrees',
    distanceFormat: 'float64-metres',
    attribution: '© OpenStreetMap contributors',
    checksums: { 'ATTRIBUTION.txt': sha256(attribution) }
  };
  const legacyDigest = sha256(stableJson(body));
  const legacyDir = path.join(store.rootDir, 'regions', region.id, legacyDigest);
  const legacyBlob = path.join(store.rootDir, 'blobs', first.digest.slice(0, 2), `${first.digest}.bin`);
  await fs.mkdir(path.dirname(legacyBlob), { recursive: true });
  await fs.writeFile(legacyBlob, legacyBytes);
  await fs.mkdir(legacyDir, { recursive: true });
  await fs.writeFile(path.join(legacyDir, 'ATTRIBUTION.txt'), attribution);
  await fs.writeFile(path.join(legacyDir, 'manifest.json'), JSON.stringify({ ...body, routePackDigest: legacyDigest }));

  const loadedLegacy = await store.loadPack(legacyDigest, region.id);
  const second = { ...route([{ latitude: 20, longitude: 77.01 },
    { latitude: 20.01, longitude: 77.01 }]), id: 'route-2' };
  const appendedDigest = await store.writePack({ region, routes: [...loadedLegacy.routes, second] });
  const appended = await store.loadPack(appendedDigest, region.id);
  assert.equal(appended.manifest.geometryStorage, 'content-addressed-route-blobs-v2');
  assert.equal(appended.routes.length, 2);
  assert.notEqual(appended.manifest.routes[0].blobChecksum, legacyChecksum);
  assert.deepEqual(await fs.readFile(legacyBlob), legacyBytes);
  assert.equal((await store.loadPack(legacyDigest, region.id)).routes.length, 1);
  const newChecksum = appended.manifest.routes[0].blobChecksum;
  assert.equal(sha256(await fs.readFile(path.join(store.rootDir, 'blobs-v2',
    newChecksum.slice(0, 2), `${newChecksum}.bin`))), newChecksum);
});
