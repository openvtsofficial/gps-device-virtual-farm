'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decodePolyline6, distanceMeters } = require('../src/road/route-validator');
const { LocalValhallaProvider, normalizeEndpoint, encodePolyline6,
  splitLegShapes } = require('../src/road/local-valhalla-provider');

const a = { latitude: 28.6139, longitude: 77.2090 };
const b = { latitude: 28.6149, longitude: 77.2100 };
const c = { latitude: 28.6159, longitude: 77.2110 };
const candidate = { family: 'local', locations: [a, b, c] };
const route = { trip: { legs: [
  { shape: encodePolyline6([a, b]) },
  { shape: encodePolyline6([b, c]) }
] } };

test('local endpoint is restricted to explicit loopback HTTP origins', () => {
  assert.equal(normalizeEndpoint('http://127.0.0.1:8002'), 'http://127.0.0.1:8002');
  assert.equal(normalizeEndpoint('http://localhost:8002/'), 'http://localhost:8002');
  assert.equal(normalizeEndpoint('http://[::1]:8002'), 'http://[::1]:8002');
  for (const endpoint of [
    'https://localhost:8002', 'http://192.168.1.10:8002', 'http://127.0.0.2:8002',
    'http://localhost.example.com:8002', 'http://localhost/route',
    'http://localhost:8002/route', 'http://localhost:8002?next=https://example.com',
    'http://user:pass@localhost:8002'
  ]) {
    assert.throws(() => normalizeEndpoint(endpoint), /loopback HTTP/);
  }
});

test('local route request uses drivable local-street options and permits validated overrides', async () => {
  const requests = [];
  const provider = new LocalValhallaProvider({ fetchImpl: async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify(route), { headers: { 'content-type': 'application/json' } });
  } });
  assert.equal(provider.id, 'valhalla-local');
  assert.equal(provider.bulkAllowed, true);
  assert.equal(provider.endpointFamily, 'http://127.0.0.1:8002');
  assert.deepEqual(await provider.fetchRoute(candidate), route);
  assert.equal(requests[0].url, 'http://127.0.0.1:8002/route');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.redirect, 'error');
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.costing, 'auto');
  assert.deepEqual(body.locations, [{ lat: a.latitude, lon: a.longitude },
    { lat: b.latitude, lon: b.longitude }, { lat: c.latitude, lon: c.longitude }]);
  assert.equal(body.costing_options.auto.use_highways, 0);
  assert.equal(body.costing_options.auto.service_penalty, 0);
  await provider.fetchRoute({ ...candidate, locations: [a, b],
    costingOptions: { use_highways: 0.8, shortest: false }, alternates: 2 });
  const custom = JSON.parse(requests[1].init.body);
  assert.deepEqual(custom.costing_options, { auto: { use_highways: 0.8, shortest: false } });
  assert.equal(custom.alternates, 2);
  await assert.rejects(provider.fetchRoute({ ...candidate, costingOptions: { use_highways: -1 } }), /Unsupported/);
  await assert.rejects(provider.fetchRoute({ ...candidate, costing: 'pedestrian' }), /automobile/);
  assert.equal(requests.length, 2);
});

test('road-class trace covers each route leg and computes a distance-weighted local share', async () => {
  let calls = 0;
  const provider = new LocalValhallaProvider({ fetchImpl: async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:8002/trace_attributes');
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body);
    assert.equal(body.shape_match, 'edge_walk');
    assert.equal(body.costing, 'auto');
    assert.deepEqual(body.filters.attributes, ['edge.road_class', 'edge.length']);
    assert.deepEqual(decodePolyline6(body.encoded_polyline), calls === 0 ? [a, b] : [b, c]);
    const edges = calls++ === 0
      ? [{ road_class: 'residential', length: distanceMeters(a, b) / 1000 * 0.4 },
        { road_class: 'service_other', length: distanceMeters(a, b) / 1000 * 0.6 }]
      : [{ road_class: 'primary', length: distanceMeters(b, c) / 1000 }];
    return new Response(JSON.stringify({ edges }));
  } });
  const result = await provider.fetchRoadClasses(route);
  assert.ok(Math.abs(result.localShare - distanceMeters(a, b) /
    (distanceMeters(a, b) + distanceMeters(b, c))) < 1e-12);
  assert.ok(Math.abs(result.classMeters.service_other - distanceMeters(a, b) * 0.6) < 1e-9);
  assert.equal(result.classCounts.primary, 1);
  assert.equal(calls, 2);
  assert.deepEqual(Object.keys(result).sort(), ['classCounts', 'classMeters', 'localShare']);
});

test('long intercity leg is traced in overlapping chunks below distance and point limits', async () => {
  const points = Array.from({ length: 400 }, (_, index) => ({ latitude: 0, longitude: index * 0.01 }));
  const longRoute = { trip: { legs: [{ shape: encodePolyline6(points) }] } };
  const seen = [];
  const provider = new LocalValhallaProvider({ fetchImpl: async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:8002/trace_attributes');
    const traced = decodePolyline6(JSON.parse(init.body).encoded_polyline);
    const meters = traced.slice(1).reduce((sum, point, index) => sum + distanceMeters(traced[index], point), 0);
    assert.ok(traced.length <= 8_000);
    assert.ok(meters <= 80_000.001);
    seen.push({ traced, meters });
    return new Response(JSON.stringify({ edges: [{ road_class: seen.length % 2 ? 'residential' : 'primary',
      length: meters / 1000 }] }));
  } });
  const result = await provider.fetchRoadClasses(longRoute);
  assert.ok(seen.length >= 5);
  assert.deepEqual(seen[0].traced[0], points[0]);
  assert.deepEqual(seen.at(-1).traced.at(-1), points.at(-1));
  for (let index = 1; index < seen.length; index += 1) {
    assert.deepEqual(seen[index].traced[0], seen[index - 1].traced.at(-1));
  }
  const tracedMeters = seen.reduce((sum, item) => sum + item.meters, 0);
  const originalMeters = points.slice(1).reduce((sum, point, index) => sum + distanceMeters(points[index], point), 0);
  assert.ok(Math.abs(tracedMeters - originalMeters) < 1e-6);
  const residentialMeters = seen.filter((_, index) => index % 2 === 0).reduce((sum, item) => sum + item.meters, 0);
  assert.ok(Math.abs(result.localShare - residentialMeters / originalMeters) < 1e-12);
  assert.equal(result.classCounts.residential + result.classCounts.primary, seen.length);
});

test('dense city geometry is split at the point cap without repeating road distance', () => {
  const points = Array.from({ length: 9_000 }, (_, index) => ({ latitude: 0, longitude: index / 1e6 }));
  const chunks = splitLegShapes({ trip: { legs: [{ shape: encodePolyline6(points) }] } });
  assert.equal(chunks.length, 2);
  const first = decodePolyline6(chunks[0].encodedPolyline);
  const second = decodePolyline6(chunks[1].encodedPolyline);
  assert.equal(first.length, 8_000);
  assert.equal(second.length, 1_001);
  assert.deepEqual(first.at(-1), second[0]);
  assert.ok(Math.abs(chunks.reduce((sum, chunk) => sum + chunk.geometryMeters, 0) -
    distanceMeters(points[0], points.at(-1))) < 1e-6);
});

test('a trace that attributes only a fragment of a long leg is rejected', async () => {
  const points = Array.from({ length: 300 }, (_, index) => ({ latitude: 0, longitude: index * 0.01 }));
  const longRoute = { trip: { legs: [{ shape: encodePolyline6(points) }] } };
  const provider = new LocalValhallaProvider({ fetchImpl: async () =>
    new Response(JSON.stringify({ edges: [{ road_class: 'residential', length: 0.1 }] })) });
  await assert.rejects(provider.fetchRoadClasses(longRoute), (error) =>
    error.code === 'ROAD_ATTRIBUTES_UNAVAILABLE' && /only part/.test(error.message));
});

test('missing road-class attributes fail clearly instead of claiming zero local roads', async () => {
  const provider = new LocalValhallaProvider({ fetchImpl: async () => new Response(JSON.stringify({ edges: [
    { road_class: 'residential' }
  ] })) });
  await assert.rejects(provider.fetchRoadClasses(route), (error) =>
    error.code === 'ROAD_ATTRIBUTES_UNAVAILABLE' && /incomplete/.test(error.message));
  const unavailable = new LocalValhallaProvider({ fetchImpl: async () => new Response('Not found', { status: 404 }) });
  await assert.rejects(unavailable.fetchRoadClasses(route), (error) =>
    error.code === 'ROAD_ATTRIBUTES_UNAVAILABLE' && error.status === 404);
  const unknown = new LocalValhallaProvider({ fetchImpl: async () => new Response(JSON.stringify({ edges: [
    { road_class: 'cycleway', length: 1 }
  ] })) });
  await assert.rejects(unknown.fetchRoadClasses(route), (error) =>
    error.code === 'ROAD_ATTRIBUTES_UNAVAILABLE' && /incomplete/.test(error.message));
});

test('local requests honor cancellation and bounded response sizes', async () => {
  let calls = 0;
  const provider = new LocalValhallaProvider({ fetchImpl: async () => {
    calls += 1;
    return new Response('{}', { headers: { 'content-length': String(9 * 1024 * 1024) } });
  } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(provider.fetchRoute(candidate, { signal: controller.signal }), (error) => error.name === 'AbortError');
  assert.equal(calls, 0);
  await assert.rejects(provider.fetchRoute(candidate), /byte limit/);
  assert.equal(calls, 1);
});

test('local status reports graph readiness and unavailable services', async () => {
  const ready = new LocalValhallaProvider({ fetchImpl: async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:8002/status');
    assert.equal(init.method, 'GET');
    return new Response(JSON.stringify({ version: '3.6.0', tileset_last_modified: 1_700_000_000 }));
  } });
  assert.deepEqual(await ready.health(), { ready: true, version: '3.6.0',
    tilesetLastModified: 1_700_000_000, endpointFamily: 'http://127.0.0.1:8002' });
  const unavailable = new LocalValhallaProvider({ fetchImpl: async () => { throw new Error('connection refused'); } });
  assert.equal((await unavailable.health()).ready, false);
});
