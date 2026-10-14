'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RoadPreparationProgress } = require('../src/main/road-preparation-progress');

test('route ETA needs measured accepted progress and stops when progress stalls', async () => {
  let clock = 1_000;
  const saved = [];
  const events = [];
  const store = { read: async () => null,
    write: async (_scope, status) => { saved.push(structuredClone(status)); } };
  const progress = new RoadPreparationProgress({ store, scope: 'a'.repeat(64),
    emit: (event) => events.push(event), now: () => clock,
    targetRouteCount: 100, attemptBudget: 200 });
  await progress.start();
  progress.update({ phase: 'download', bytes: 1_000, totalBytes: 10_000 });
  assert.equal(events.at(-1).estimatedRemainingMs, null);
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    clock += 1_000;
    progress.update({ phase: 'accepted', attempts: attempt,
      routeCount: attempt, accepted: attempt, targetRouteCount: 100 });
  }
  assert.ok(events.at(-1).estimatedRemainingMs > 0);
  assert.equal(events.at(-1).stage, 'routes');
  clock += 121_000;
  progress.update({ phase: 'request', attempts: 13, routeCount: 12 });
  assert.equal(events.at(-1).estimatedRemainingMs, null);
  progress.update({ phase: 'saved', routeCount: 12 });
  await progress.finish({ status: 'canceled', routeCount: 12, targetRouteCount: 100,
    attempts: 13, accepted: 12, rejected: 1 });
  assert.equal(saved.at(-1).state, 'canceled');
  assert.equal(saved.at(-1).savedRouteCount, 12);
  assert.equal(saved.at(-1).estimatedRemainingMs, null);
});

test('transient retry progress includes a countdown and final failure preserves route count', async () => {
  let clock = 2_000;
  const events = [];
  const saved = [];
  const progress = new RoadPreparationProgress({ store: {
    read: async () => ({ routeCount: 20, savedRouteCount: 20 }),
    write: async (_scope, status) => { saved.push(structuredClone(status)); }
  }, scope: 'b'.repeat(64), emit: (event) => events.push(event), now: () => clock });
  await progress.start();
  clock += 500;
  progress.update({ phase: 'retrying', reason: 'Router temporarily unavailable',
    retryInMs: 1_000, retryAttempt: 1, maxRetryAttempts: 2, attempts: 1,
    routeCount: 20 });
  assert.equal(events.at(-1).retryAt, 3_500);
  await progress.fail(new Error('Router still unavailable'));
  assert.equal(saved.at(-1).routeCount, 20);
  assert.equal(saved.at(-1).state, 'blocked');
  assert.equal(saved.at(-1).reason, 'Router still unavailable');
});

test('terminal route search status persists its action and diagnosis', async () => {
  const saved = [];
  const progress = new RoadPreparationProgress({ store: {
    read: async () => null,
    write: async (_scope, status) => { saved.push(structuredClone(status)); }
  }, scope: 'c'.repeat(64), emit: () => {} });
  await progress.start();
  await progress.finish({ status: 'search-stalled', statusDetail: 'No new verified routes across varied searches.',
    resumeAvailable: false, routeCount: 169, savedRouteCount: 169,
    targetRouteCount: 2000, attempts: 1500, attemptsSinceAccepted: 1500 });
  assert.equal(saved.at(-1).state, 'blocked');
  assert.equal(saved.at(-1).resumeAvailable, false);
  assert.equal(saved.at(-1).statusDetail, 'No new verified routes across varied searches.');
  assert.equal(saved.at(-1).attemptsSinceAccepted, 1500);
});

test('a fleet-ready partial catalog is usable while its 2000-route goal remains open', async () => {
  const saved = [];
  const progress = new RoadPreparationProgress({ store: {
    read: async () => null,
    write: async (_scope, status) => { saved.push(structuredClone(status)); }
  }, scope: 'd'.repeat(64), emit: () => {} });
  await progress.start();
  await progress.finish({ status: 'usable', routeCount: 500, savedRouteCount: 500,
    targetRouteCount: 2000, resumeAvailable: true,
    statusDetail: 'Saved routes support the configured fleet.' });
  assert.equal(saved.at(-1).state, 'usable');
  assert.equal(saved.at(-1).savedRouteCount, 500);
  assert.equal(saved.at(-1).resumeAvailable, true);
});
