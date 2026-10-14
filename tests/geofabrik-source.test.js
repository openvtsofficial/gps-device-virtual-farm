'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { INDEX_URL, allowedGeofabrikUrl, regionBounds, geometryContainsBounds,
  selectGeofabrikExtract, loadGeofabrikIndex, downloadGeofabrikExtract } =
  require('../src/road/geofabrik-source');
const fixtureRoot = path.join(__dirname, '..', '.runtime', 'tests');

async function makeFixtureDirectory() {
  await fs.mkdir(fixtureRoot, { recursive: true });
  return fs.mkdtemp(path.join(fixtureRoot, 'gps-geofabrik-'));
}

const square = (west, south, east, north) => ({ type: 'Polygon', coordinates: [[
  [west, south], [east, south], [east, north], [west, north], [west, south]
]] });
const feature = (id, geometry, parent = null) => ({ type: 'Feature', properties: {
  id, name: id, parent, urls: { pbf: `https://download.geofabrik.de/asia/${id}-latest.osm.pbf` }
}, geometry });
const region = (lat, lon, radiusKm = 2) =>
  ({ centerLatitude: lat, centerLongitude: lon, radiusKm });

test('extract selection covers the entire padded region box and chooses the smaller graph', () => {
  const index = { type: 'FeatureCollection', features: [
    feature('parent', square(0, 0, 10, 10)),
    feature('child', square(1, 1, 5, 5), 'parent')
  ] };
  assert.equal(selectGeofabrikExtract(index, [region(2.5, 2.5)], { marginKm: 0 }).id, 'child');
  assert.equal(selectGeofabrikExtract(index, [region(4.5, 4.5, 100)], { marginKm: 0 }).id, 'parent');
  assert.equal(selectGeofabrikExtract(index, [region(2.5, 2.5), region(7, 7)],
    { marginKm: 0 }).id, 'parent');
  assert.deepEqual(regionBounds(region(0, 0, 2), 0).map((value) => Math.sign(value)), [-1, -1, 1, 1]);
});

test('extract selection rejects holes and concave incursions into the region box', () => {
  const hole = { type: 'Polygon', coordinates: [
    square(0, 0, 10, 10).coordinates[0], square(2, 2, 3, 3).coordinates[0]
  ] };
  const notch = { type: 'Polygon', coordinates: [[
    [0, 0], [5, 0], [5, 5], [3, 5], [3, 2], [2, 2], [2, 5], [0, 5], [0, 0]
  ]] };
  const box = regionBounds(region(2.5, 2.5, 55), 0);
  assert.equal(geometryContainsBounds(hole, box), false);
  assert.equal(geometryContainsBounds(notch, regionBounds(region(2.5, 2.5, 110), 0)), false);
  const index = { type: 'FeatureCollection', features: [feature('hole', hole)] };
  assert.throws(() => selectGeofabrikExtract(index, [region(2.5, 2.5)], { marginKm: 0 }),
    (error) => error.code === 'ROAD_EXTRACT_UNAVAILABLE');
});

test('selection rejects unsafe URLs and regions outside supported extract polygons', () => {
  const index = { type: 'FeatureCollection', features: [
    feature('land', square(0, 0, 10, 10)),
    { ...feature('unsafe', square(0, 0, 2, 2)), properties: { id: 'unsafe',
      urls: { pbf: 'https://attacker.example/roads.osm.pbf' } } }
  ] };
  assert.equal(selectGeofabrikExtract(index, [region(1, 1)], { marginKm: 0 }).id, 'land');
  assert.throws(() => selectGeofabrikExtract(index, [region(30, 30)], { marginKm: 0 }),
    (error) => error.code === 'ROAD_EXTRACT_UNAVAILABLE');
  for (const url of ['http://download.geofabrik.de/asia/land.osm.pbf',
    'https://download.geofabrik.de.evil.test/land.osm.pbf',
    'https://download.geofabrik.de/asia/%2e%2e/land.osm.pbf',
    'https://download.geofabrik.de/asia/land.osm.pbf?token=x']) {
    assert.throws(() => allowedGeofabrikUrl(url), /official HTTPS/);
  }
});

test('official index fetch is bounded and validated', async () => {
  const index = { type: 'FeatureCollection', features: [feature('land', square(0, 0, 10, 10))] };
  const loaded = await loadGeofabrikIndex({ fetchImpl: async (url, options) => {
    assert.equal(url, INDEX_URL);
    assert.equal(options.redirect, 'manual');
    return new Response(JSON.stringify(index));
  } });
  assert.deepEqual(loaded, index);
  await assert.rejects(loadGeofabrikIndex({ fetchImpl: async () =>
    new Response('{}', { headers: { 'content-length': String(33 * 1024 * 1024) } }) }),
  /size limit/);
});

test('download follows only official redirects, checks dated PBF MD5, and reuses a verified cache', async () => {
  const folder = await makeFixtureDirectory();
  try {
    const sourceUrl = 'https://download.geofabrik.de/asia/india-latest.osm.pbf';
    const datedUrl = 'https://download.geofabrik.de/asia/india-261012.osm.pbf';
    const destination = path.join(folder, 'india.osm.pbf');
    const bytes = Buffer.alloc(2048, 0x34);
    const checksum = createHash('md5').update(bytes).digest('hex');
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push(url);
      assert.equal(options.redirect, 'manual');
      if (url === sourceUrl) return new Response(null, { status: 302,
        headers: { location: '/asia/india-261012.osm.pbf' } });
      if (url === datedUrl) return new Response(bytes,
        { headers: { 'content-length': String(bytes.length) } });
      if (url === `${datedUrl}.md5`) return new Response(`${checksum}  india-261012.osm.pbf\n`);
      throw new Error(`Unexpected URL: ${url}`);
    };
    const first = await downloadGeofabrikExtract(sourceUrl, destination, { fetchImpl });
    assert.deepEqual(calls, [sourceUrl, datedUrl, `${datedUrl}.md5`]);
    assert.equal(first.cached, false);
    assert.equal(first.resolvedUrl, datedUrl);
    assert.equal(first.md5, checksum);
    assert.equal(first.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(await fs.readFile(destination), bytes);
    assert.equal(JSON.parse(await fs.readFile(`${destination}.json`, 'utf8')).bytes, bytes.length);
    const second = await downloadGeofabrikExtract(sourceUrl, destination, { fetchImpl });
    assert.equal(second.cached, true);
    assert.equal(calls.length, 3);
    await fs.writeFile(destination, Buffer.alloc(bytes.length, 0xff));
    const repaired = await downloadGeofabrikExtract(sourceUrl, destination, { fetchImpl });
    assert.equal(repaired.cached, false);
    assert.equal(calls.length, 6);
    assert.deepEqual(await fs.readFile(destination), bytes);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test('unsafe redirect, oversized content, bad checksum, and cancellation leave no published PBF', async () => {
  const folder = await makeFixtureDirectory();
  try {
    const url = 'https://download.geofabrik.de/asia/india-latest.osm.pbf';
    const destination = path.join(folder, 'india.osm.pbf');
    const bytes = Buffer.alloc(2048, 0x12);
    await assert.rejects(downloadGeofabrikExtract(url, destination, { fetchImpl: async () =>
      new Response(null, { status: 302, headers: { location: 'https://bad.example/india.osm.pbf' } }) }),
    /official HTTPS/);
    await assert.rejects(downloadGeofabrikExtract(url, destination, { maxBytes: 1024,
      fetchImpl: async () => new Response(bytes, { headers: { 'content-length': '2048' } }) }),
    (error) => {
      assert.equal(error.code, 'ROAD_EXTRACT_TOO_LARGE');
      assert.equal(error.extractUrl, url);
      assert.equal(error.resolvedUrl, url);
      assert.equal(error.advertisedBytes, 2048);
      assert.equal(error.observedBytes, null);
      assert.equal(error.maxBytes, 1024);
      assert.match(error.message, /2,048 bytes.*download byte limit of 1,024 bytes/);
      return true;
    });
    await assert.rejects(downloadGeofabrikExtract(url, destination, { maxBytes: 1024,
      fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
        controller.enqueue(bytes);
        controller.close();
      } })) }), (error) => {
      assert.equal(error.code, 'ROAD_EXTRACT_TOO_LARGE');
      assert.equal(error.extractUrl, url);
      assert.equal(error.advertisedBytes, null);
      assert.equal(error.observedBytes, 2048);
      assert.equal(error.maxBytes, 1024);
      assert.match(error.message, /has delivered 2,048 bytes.*download byte limit of 1,024 bytes/);
      return true;
    });
    await assert.rejects(downloadGeofabrikExtract(url, destination, { fetchImpl: async (target) =>
      new Response(target.endsWith('.md5') ? `${'0'.repeat(32)}  india.osm.pbf` : bytes) }),
    /checksum/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(downloadGeofabrikExtract(url, destination, { signal: controller.signal }),
      (error) => error.name === 'AbortError');
    await assert.rejects(fs.stat(destination), (error) => error.code === 'ENOENT');
    assert.equal((await fs.readdir(folder)).filter((name) => name.endsWith('.part')).length, 0);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});
