'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RouteModel, haversineKm } = require('../src/simulator/geo');

function model(moving) {
  return new RouteModel({
    index: 10,
    total: 100,
    imei: '358988888800011',
    baseLatitude: 28.6139,
    baseLongitude: 77.209,
    moving
  });
}

test('moving route advances continuously from the previous point', () => {
  const route = model(true);
  const first = route.nextPoint(1_000_000);
  const second = route.nextPoint(1_010_000);
  const distanceKm = haversineKm(first, second);
  const physicallyExpectedKm = second.speedKph * 10 / 3600;
  assert.ok(distanceKm > 0);
  assert.ok(distanceKm < physicallyExpectedKm * 1.25);
  assert.ok(Math.abs(first.latitude - second.latitude) < 0.01);
  assert.ok(Math.abs(first.longitude - second.longitude) < 0.01);
  assert.ok(second.course >= 0 && second.course < 360);
});

test('parked route retains its last position with zero speed', () => {
  const route = model(false);
  const first = route.nextPoint(1_000_000);
  const second = route.nextPoint(1_300_000);
  assert.equal(first.latitude, second.latitude);
  assert.equal(first.longitude, second.longitude);
  assert.equal(second.speedKph, 0);
});

test('each device gets a deterministic but distinct starting position', () => {
  const a = model(true).nextPoint(1_000_000);
  const b = model(true).nextPoint(1_000_000);
  const c = new RouteModel({
    index: 11,
    total: 100,
    imei: '358988888800012',
    baseLatitude: 28.6139,
    baseLongitude: 77.209,
    moving: true
  }).nextPoint(1_000_000);
  assert.deepEqual(a, b);
  assert.notDeepEqual([a.latitude, a.longitude], [c.latitude, c.longitude]);
});

