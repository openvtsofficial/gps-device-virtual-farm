'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isRetryableLocalFailure, waitForLocalRetry } =
  require('../src/road/local-retry-policy');

test('local retry policy retries transient faults but not deterministic or canceled requests', () => {
  for (const status of [408, 425, 500, 502, 503, 504]) {
    assert.equal(isRetryableLocalFailure({ status }), true);
  }
  for (const status of [400, 404, 429]) {
    assert.equal(isRetryableLocalFailure({ status }), false);
  }
  assert.equal(isRetryableLocalFailure({ name: 'AbortError' }), false);
  assert.equal(isRetryableLocalFailure({ name: 'TimeoutError' }), true);
  assert.equal(isRetryableLocalFailure({ code: 'ROAD_ATTRIBUTES_UNAVAILABLE' }), false);
  assert.equal(isRetryableLocalFailure({ code: 'ROAD_ATTRIBUTES_UNAVAILABLE',
    cause: { status: 503 } }), true);
  assert.equal(isRetryableLocalFailure(new Error('Bundled Valhalla failed: temporary native exit')), true);
});

test('local retry wait ends promptly on cancel', async () => {
  const controller = new AbortController();
  const waiting = waitForLocalRetry(10_000, controller.signal);
  controller.abort();
  await assert.rejects(waiting, (error) => error.name === 'AbortError');
});
