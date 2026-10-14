'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeHost, validateConfig } = require('../src/simulator/config');

test('normalizes valid IP addresses and hostnames', () => {
  assert.equal(normalizeHost(' 127.0.0.1 '), '127.0.0.1');
  assert.equal(normalizeHost('[::1]'), '::1');
  assert.equal(normalizeHost('GPS.EXAMPLE.COM'), 'gps.example.com');
});

test('rejects unsafe or malformed destinations', () => {
  assert.throws(() => normalizeHost(''), /valid IP address or hostname/);
  assert.throws(() => normalizeHost('https://example.com'), /valid IP address or hostname/);
  assert.throws(() => normalizeHost('bad host'), /valid IP address or hostname/);
});

test('enforces supported device and moving-population limits', () => {
  assert.throws(() => validateConfig({ deviceCount: 0 }), /Device count/);
  assert.throws(() => validateConfig({ deviceCount: 50_001 }), /Device count/);
  assert.throws(() => validateConfig({ movingPercent: 24 }), /Moving percentage/);
  const config = validateConfig({ deviceCount: 20_000, movingPercent: 25 });
  assert.equal(config.deviceCount, 20_000);
  assert.equal(config.movingPercent, 25);
});

test('validates road mode regions and selected pack identities without changing legacy defaults', () => {
  const legacy = validateConfig();
  assert.equal(legacy.port, 7510);
  assert.equal(legacy.movementMode, 'synthetic');
  assert.equal(legacy.movingIntervalMs, 10_000);
  assert.equal(legacy.road.regions[0].id, 'default');

  const digest = 'a'.repeat(64);
  const road = validateConfig({ movementMode: 'real-road', scenarioSeed: 'fleet-1',
    road: { regionMode: 'multi', selectedRoutePackDigests: [digest],
      regions: [
        { id: 'north', centerLatitude: 28.6, centerLongitude: 77.2, radiusKm: 50, fleetWeight: 0.6 },
        { id: 'south', centerLatitude: 12.9, centerLongitude: 77.6, radiusKm: 60, fleetWeight: 0.4 }
      ] } });
  assert.equal(road.road.regions.length, 2);
  assert.deepEqual(road.road.selectedRoutePackDigests, [digest]);
  assert.throws(() => validateConfig({ movementMode: 'real-road', road: {
    regionMode: 'multi', regions: road.road.regions.map((region) => ({ ...region, fleetWeight: 0.6 }))
  } }), /weights must be unique IDs and sum to 1/);
  assert.throws(() => validateConfig({ road: { selectedRoutePackDigests: ['../unsafe'] } }), /SHA-256/);
});

