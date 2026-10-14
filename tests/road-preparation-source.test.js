'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRoadPreparationSource } = require('../src/main/road-preparation-source');

const localProvider = { id: 'valhalla-local' };
const publicProvider = { id: 'fossgis-valhalla-public' };
const base = { localHealth: { ready: true }, localProvider, publicProvider,
  publicEnabled: true };

test('local catalog request pins the local provider and target', () => {
  assert.deepEqual(resolveRoadPreparationSource({ ...base,
    input: { source: 'local', targetRouteCount: 2000 } }),
  { provider: localProvider, targetRouteCount: 2000, maxRequests: 4000 });
});

test('a stopped local router cannot change a catalog request into a public action', () => {
  assert.throws(() => resolveRoadPreparationSource({ ...base, localHealth: { ready: false },
    input: { source: 'local', targetRouteCount: 2000 } }),
  (error) => error.code === 'LOCAL_ROUTER_UNAVAILABLE');
});

test('public preparation requires an explicit source and explicit enablement', () => {
  assert.throws(() => resolveRoadPreparationSource({ ...base, input: {} }),
    /Choose a route preparation source/);
  assert.throws(() => resolveRoadPreparationSource({ ...base, publicEnabled: false,
    input: { source: 'public' } }), /disabled/);
  assert.throws(() => resolveRoadPreparationSource({ ...base,
    input: { source: 'public', targetRouteCount: 2000 } }), /local routing source/);
  assert.deepEqual(resolveRoadPreparationSource({ ...base,
    input: { source: 'public', maxRequests: 20 } }),
  { provider: publicProvider, targetRouteCount: 0, maxRequests: 20 });
});
