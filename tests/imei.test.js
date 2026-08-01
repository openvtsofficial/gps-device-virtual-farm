'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generateImei,
  generateManifest,
  manifestAsCsv,
  manifestAsJson,
  movingDeviceCount
} = require('../src/simulator/imei');

test('generates the requested exact incremental IMEI sequence', () => {
  assert.equal(generateImei(0), '358988888800001');
  assert.equal(generateImei(1), '358988888800002');
  assert.equal(generateImei(554), '358988888800555');
  assert.equal(generateImei(19_999), '358988888820000');
});

test('uses at least 25 percent moving devices', () => {
  assert.equal(movingDeviceCount(100, 25), 25);
  assert.equal(movingDeviceCount(3, 25), 1);
  assert.equal(movingDeviceCount(20_000, 25), 5_000);
});

test('manifest contains unique protocol and behavior assignments', () => {
  const manifest = generateManifest(20, 25);
  assert.equal(manifest.length, 20);
  assert.equal(new Set(manifest.map((device) => device.imei)).size, 20);
  assert.equal(manifest.filter((device) => device.behavior === 'MOVING').length, 5);
  assert.ok(manifest.every((device) => device.protocol === 'GT06'));
});

test('CSV and JSON exports contain the complete list', () => {
  const csv = manifestAsCsv(3, 25);
  assert.equal(csv.trim().split(/\r?\n/).length, 4);
  assert.match(csv, /358988888800003,GT06,PARKED/);

  const json = JSON.parse(manifestAsJson(3, 25));
  assert.equal(json.deviceCount, 3);
  assert.equal(json.movingDevices, 1);
  assert.equal(json.devices[2].imei, '358988888800003');
});

