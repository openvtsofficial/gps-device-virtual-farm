'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MinHeap } = require('../src/simulator/min-heap');

test('min heap returns actions in timestamp order', () => {
  const heap = new MinHeap((left, right) => left.at - right.at);
  heap.push({ at: 30 });
  heap.push({ at: 10 });
  heap.push({ at: 20 });
  assert.deepEqual([heap.pop().at, heap.pop().at, heap.pop().at], [10, 20, 30]);
});

