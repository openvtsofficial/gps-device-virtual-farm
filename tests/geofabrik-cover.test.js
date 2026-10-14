'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectGeofabrikCover } = require('../src/road/geofabrik-cover');

const region = { centerLatitude: 5, centerLongitude: 5, radiusKm: 50 };

function rectangle(west, south, east, north) {
  return { type: 'Polygon', coordinates: [[
    [west, south], [east, south], [east, north], [west, north], [west, south]
  ]] };
}

function feature(id, geometry, parent = 'parent', url =
  `https://download.geofabrik.de/test/${id}-latest.osm.pbf`) {
  return { type: 'Feature', geometry,
    properties: { id, name: id, parent, urls: { pbf: url } } };
}

function index(...features) {
  return { type: 'FeatureCollection', features };
}

test('two neighbouring buffered extracts cover a region without the large parent', () => {
  const source = index(
    feature('parent', rectangle(0, 0, 10, 10), 'world'),
    feature('west', rectangle(0, 0, 5.1, 10)),
    feature('east', rectangle(4.9, 0, 10, 10))
  );
  assert.deepEqual(selectGeofabrikCover(source, region, { marginKm: 0 })
    .map((record) => record.id), ['east', 'west']);
});

test('an uncovered gap rejects a multi-extract cover', () => {
  const source = index(
    feature('parent', rectangle(0, 0, 10, 10), 'world'),
    feature('west', rectangle(0, 0, 4.99, 10)),
    feature('east', rectangle(5.01, 0, 10, 10))
  );
  assert.deepEqual(selectGeofabrikCover(source, region, { marginKm: 0 }), []);
});

test('slanted borders with a narrow uncovered strip are rejected', () => {
  const west = { type: 'Polygon', coordinates: [[
    [0, 0], [4, 0], [6, 10], [0, 10], [0, 0]
  ]] };
  const east = { type: 'Polygon', coordinates: [[
    [4.05, 0], [10, 0], [10, 10], [6.05, 10], [4.05, 0]
  ]] };
  assert.deepEqual(selectGeofabrikCover(index(
    feature('parent', rectangle(0, 0, 10, 10), 'world'),
    feature('west', west), feature('east', east)
  ), region, { marginKm: 0 }), []);
});

test('source count limit is enforced', () => {
  const source = index(
    feature('parent', rectangle(0, 0, 10, 10), 'world'),
    feature('west', rectangle(0, 0, 4.9, 10)),
    feature('middle', rectangle(4.8, 0, 5.2, 10)),
    feature('east', rectangle(5.1, 0, 10, 10))
  );
  assert.deepEqual(selectGeofabrikCover(source, region,
    { marginKm: 0, maxSources: 2 }), []);
  assert.deepEqual(selectGeofabrikCover(source, region,
    { marginKm: 0, maxSources: 3 }).map((record) => record.id),
  ['middle', 'east', 'west']);
});

test('a hostile source URL cannot contribute to a cover', () => {
  const source = index(
    feature('parent', rectangle(0, 0, 10, 10), 'world'),
    feature('west', rectangle(0, 0, 5.1, 10)),
    feature('east', rectangle(4.9, 0, 10, 10), 'parent',
      'https://download.geofabrik.de.evil.test/test/east-latest.osm.pbf')
  );
  assert.deepEqual(selectGeofabrikCover(source, region, { marginKm: 0 }), []);
});

test('one smaller containing extract stays on the existing single-source path', () => {
  const source = index(
    feature('parent', rectangle(0, 0, 10, 10), 'world'),
    feature('child', rectangle(4, 4, 6, 6))
  );
  assert.deepEqual(selectGeofabrikCover(source, region, { marginKm: 0 }), []);
});
