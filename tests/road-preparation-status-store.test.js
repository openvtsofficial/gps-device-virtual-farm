'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { RoadPreparationStatusStore, preparationScope } =
  require('../src/main/road-preparation-status-store');

const config = { scenarioSeed: 'fleet-1', road: { regions: [{ id: 'default',
  centerLatitude: 28.6139, centerLongitude: 77.209, radiusKm: 50, fleetWeight: 1 }] } };

test('preparation status resumes after restart and ignores another region', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gps-road-status-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scope = preparationScope(config);
  const store = new RoadPreparationStatusStore(root);
  await store.write(scope, { state: 'running', stage: 'routes', phase: 'accepted',
    routeCount: 169, targetRouteCount: 2000, attempts: 1282,
    accepted: 169, rejected: 1113, estimatedRemainingMs: 300_000,
    attemptsSinceAccepted: 120, resumeAvailable: true,
    composition: { cityRoutes: 122, regionalRoutes: 47, intercityRoutes: 24 } });
  const restarted = new RoadPreparationStatusStore(root);
  const status = await restarted.read(scope);
  assert.equal(status.state, 'interrupted');
  assert.equal(status.routeCount, 169);
  assert.equal(status.estimatedRemainingMs, null);
  assert.equal(status.resumeAvailable, true);
  assert.equal(status.attemptsSinceAccepted, 120);
  assert.deepEqual(status.composition,
    { cityRoutes: 122, regionalRoutes: 47, intercityRoutes: 24 });
  const changed = structuredClone(config);
  changed.road.regions[0].centerLatitude += 0.1;
  assert.equal(await restarted.read(preparationScope(changed)), null);
});

test('corrupt preparation status cannot block a new route action', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gps-road-status-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new RoadPreparationStatusStore(root);
  const scope = preparationScope(config);
  await store.write(scope, { state: 'canceled', routeCount: 40, targetRouteCount: 2000 });
  await fs.writeFile(store.filePath, '{broken');
  assert.equal(await store.read(scope), null);
  await store.write(scope, { state: 'ready', routeCount: 2000, targetRouteCount: 2000 });
  assert.equal((await store.read(scope)).state, 'ready');
});

test('usable partial catalog status survives restart', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gps-road-usable-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new RoadPreparationStatusStore(root);
  const scope = preparationScope(config);
  await store.write(scope, { state: 'usable', status: 'usable', routeCount: 500,
    savedRouteCount: 500, targetRouteCount: 2000, resumeAvailable: true });
  const loaded = await new RoadPreparationStatusStore(root).read(scope);
  assert.equal(loaded.state, 'usable');
  assert.equal(loaded.savedRouteCount, 500);
  assert.equal(loaded.resumeAvailable, true);
});
