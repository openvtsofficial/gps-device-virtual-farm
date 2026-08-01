'use strict';

const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { validateConfig } = require('../src/simulator/config');
const { generateImei, movingDeviceCount } = require('../src/simulator/imei');
const { FrameDecoder, buildHeartbeat, buildLocation, buildLogin } = require('../src/simulator/gt06');
const { MinHeap } = require('../src/simulator/min-heap');

const started = performance.now();
const config = validateConfig({ deviceCount: 20_000 });
assert.equal(movingDeviceCount(config.deviceCount), 5_000);
assert.equal(generateImei(0), '358988888800001');
assert.equal(generateImei(19_999), '358988888820000');

const samplePoint = {
  latitude: 28.6139,
  longitude: 77.209,
  speedKph: 45,
  course: 90,
  satellites: 10,
  valid: true,
  deviceTimeISO: new Date().toISOString()
};
const packets = [
  buildLogin(generateImei(0), 1),
  buildHeartbeat(2, true),
  buildLocation(3, samplePoint)
];
const decoded = new FrameDecoder().feed(Buffer.concat(packets));
assert.deepEqual(decoded.map((frame) => frame.protocol), [0x01, 0x13, 0x12]);

const heap = new MinHeap((left, right) => left.at - right.at);
for (let index = 19_999; index >= 0; index -= 1) heap.push({ at: index });
for (let index = 0; index < 20_000; index += 1) assert.equal(heap.pop().at, index);

process.stdout.write(`${JSON.stringify({
  status: 'ok',
  verifiedDevicePopulation: config.deviceCount,
  movingDevices: 5_000,
  parkedDevices: 15_000,
  firstImei: generateImei(0),
  lastImei: generateImei(19_999),
  protocolsDecoded: decoded.map((frame) => `0x${frame.protocol.toString(16)}`),
  elapsedMs: Math.round(performance.now() - started)
}, null, 2)}\n`);

