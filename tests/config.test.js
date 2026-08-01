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

