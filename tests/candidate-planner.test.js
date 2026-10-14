'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { generateCandidates } = require('../src/road/candidate-planner');
const { distanceMeters } = require('../src/road/route-validator');

const metro = { id: 'metro', centerLatitude: 28.6139, centerLongitude: 77.209,
  radiusKm: 50, fleetWeight: 1 };

test('one saved metro region yields 2000 distinct multi-scale route proposals', () => {
  const proposals = generateCandidates([metro], { seed: 'road-network-fixture', limit: 2000 });
  assert.equal(proposals.length, 2000);
  assert.equal(new Set(proposals.map((candidate) => candidate.digest)).size, 2000);
  assert.equal(new Set(proposals.map((candidate) => JSON.stringify(candidate.locations))).size, 2000);
  const local = proposals.filter((candidate) => candidate.family === 'local');
  const urban = proposals.filter((candidate) => candidate.family === 'urban');
  const regional = proposals.filter((candidate) => candidate.family === 'regional');
  assert.ok(local.length >= 400);
  assert.ok(urban.length >= 400);
  assert.ok(regional.length >= 200);
  assert.ok(local.every((candidate) => {
    const meters = distanceMeters(candidate.locations[0], candidate.locations[1]);
    return meters >= 1_900 && meters <= 8_100 && candidate.closedLoop;
  }));
  assert.ok(regional.some((candidate) =>
    distanceMeters(candidate.locations[0], candidate.locations[1]) >= 40_000));
  assert.ok(proposals.every((candidate) => candidate.locations.every((point) =>
    distanceMeters(point, { latitude: metro.centerLatitude,
      longitude: metro.centerLongitude }) <= metro.radiusKm * 940)));
});

test('seed and route preference are deterministic and part of candidate identity', () => {
  const first = generateCandidates([metro], { seed: 'stable', limit: 50 });
  assert.deepEqual(first, generateCandidates([metro], { seed: 'stable', limit: 50 }));
  assert.notDeepEqual(first, generateCandidates([metro], { seed: 'different', limit: 50 }));
  for (const candidate of first) {
    assert.ok(candidate.profile);
    assert.ok(candidate.costingOptions.use_highways >= 0 && candidate.costingOptions.use_highways <= 1);
    assert.ok(candidate.costingOptions.use_distance >= 0 && candidate.costingOptions.use_distance <= 1);
    const payload = { region: candidate.regionId, family: candidate.family,
      costing: 'auto', costingOptions: candidate.costingOptions, locations: candidate.locations };
    assert.equal(candidate.digest, createHash('sha256').update(JSON.stringify(payload)).digest('hex'));
  }
  assert.ok(first.some((candidate) => candidate.family === 'local' &&
    candidate.costingOptions.use_highways < 0.1));
  assert.ok(first.some((candidate) => candidate.family === 'regional' &&
    candidate.costingOptions.use_highways > 0.5));
});

test('small regions stay within bounds and still provide short route proposals', () => {
  const small = { ...metro, radiusKm: 2 };
  const proposals = generateCandidates([small], { seed: 'small', limit: 100 });
  assert.equal(proposals.length, 100);
  assert.ok(proposals.some((candidate) => candidate.family === 'local'));
  assert.ok(proposals.every((candidate) => candidate.locations.every((point) =>
    distanceMeters(point, { latitude: small.centerLatitude,
      longitude: small.centerLongitude }) < 2_000)));
});

test('later planning rounds replenish geographically distinct proposals deterministically', () => {
  const first = generateCandidates([metro], { seed: 'replenish', limit: 2000 });
  const second = generateCandidates([metro], { seed: 'replenish', limit: 2000, round: 1 });
  const third = generateCandidates([metro], { seed: 'replenish', limit: 2000, round: 2 });
  assert.deepEqual(second, generateCandidates([metro],
    { seed: 'replenish', limit: 2000, round: 1 }));
  const oldDigests = new Set(first.map((candidate) => candidate.digest));
  const secondDigests = new Set(second.map((candidate) => candidate.digest));
  assert.equal(second.length, 2000);
  assert.equal(third.length, 2000);
  assert.ok(second.filter((candidate) => !oldDigests.has(candidate.digest)).length >= 1900);
  assert.ok(third.filter((candidate) => !secondDigests.has(candidate.digest)).length >= 1900);
  for (const family of ['local', 'urban', 'suburban', 'regional', 'depot']) {
    assert.ok(second.some((candidate) => candidate.family === family));
  }
  assert.ok(second.every((candidate) => candidate.locations.every((point) =>
    distanceMeters(point, { latitude: metro.centerLatitude,
      longitude: metro.centerLongitude }) <= metro.radiusKm * 940)));
  assert.throws(() => generateCandidates([metro], { round: -1 }), /Invalid candidate/);
});
