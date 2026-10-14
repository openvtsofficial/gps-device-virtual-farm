'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { BundledGraphManager, graphKey, extractKey } =
  require('../src/road/bundled-graph-manager');
const { regionBounds } = require('../src/road/geofabrik-source');
const { createHash } = require('node:crypto');

const region = { id: 'test', centerLatitude: 42.5, centerLongitude: 1.5,
  radiusKm: 20, fleetWeight: 1 };

async function fixture(t) {
  const tempRoot = path.join(process.cwd(), '.runtime', 'tests');
  await fs.mkdir(tempRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(tempRoot, 'gps-road-manager-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, 'runtime');
  const clipperDir = path.join(root, 'clipper');
  await fs.mkdir(path.join(runtimeDir, 'valhalla', 'bin'), { recursive: true });
  await fs.mkdir(clipperDir);
  await fs.mkdir(path.join(runtimeDir, 'pyvalhalla.libs'));
  await fs.writeFile(path.join(runtimeDir, 'valhalla', 'bin', 'valhalla_service.exe'), 'stub');
  await fs.writeFile(path.join(runtimeDir, 'valhalla', 'bin', 'valhalla_build_tiles.exe'), 'stub');
  await fs.writeFile(path.join(runtimeDir, 'valhalla', 'bin', 'valhalla_build_admins.exe'), 'stub');
  await fs.writeFile(path.join(clipperDir, 'osmium.exe'), 'stub');
  for (const name of ['msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) {
    await fs.writeFile(path.join(runtimeDir, 'valhalla', 'bin', name), 'stub');
  }
  return { rootDir: path.join(root, 'graphs-cache'), runtimeDir, clipperDir };
}

test('bundled graph manager provisions once and reuses a graph across app restarts', async (t) => {
  const paths = await fixture(t);
  const extract = { id: 'europe/andorra', name: 'Andorra',
    url: 'https://download.geofabrik.de/europe/andorra-latest.osm.pbf' };
  let indexCalls = 0;
  let downloads = 0;
  let builds = 0;
  const dependencies = {
    ...paths,
    probeRuntime: async () => {},
    loadIndex: async () => { indexCalls += 1; return { type: 'FeatureCollection', features: [] }; },
    selectExtract: () => extract,
    downloadExtract: async (_url, destination) => {
      downloads += 1;
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, 'osm fixture');
      return { path: destination, sha256: 'a'.repeat(64) };
    },
    clipExtract: async ({ sourcePath, destinationPath }) => {
      await fs.copyFile(sourcePath, destinationPath);
    },
    buildGraph: async ({ configPath }) => {
      builds += 1;
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      await fs.writeFile(path.join(config.mjolnir.tile_dir, '0.gph'), 'tile');
      await fs.writeFile(config.mjolnir.admin,
        Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(84)]));
    }
  };
  const first = new BundledGraphManager(dependencies);
  const health = await first.ensureGraphs([region]);
  assert.equal(health.ready, true);
  assert.equal(indexCalls, 1);
  assert.equal(downloads, 1);
  assert.equal(builds, 1);
  assert.equal((await first.resolveGraph(region.id)).configPath.endsWith('config.json'), true);
  const second = new BundledGraphManager(dependencies);
  second.setRegions([region]);
  assert.equal((await second.readHealth()).version, health.version);
  await second.ensureGraphs([region]);
  assert.equal(indexCalls, 1);
  assert.equal(downloads, 1);
  assert.equal(builds, 1);
  const configPath = (await second.resolveGraph(region.id)).configPath;
  await fs.rm(path.join(path.dirname(configPath), 'tiles', '0.gph'));
  await second.ensureGraphs([region]);
  assert.equal(builds, 2, 'a damaged graph is rebuilt before preparing routes');
  await fs.rm(path.join(path.dirname(configPath), 'admin.sqlite'));
  await second.ensureGraphs([region]);
  assert.equal(builds, 3, 'a missing administrative database is also rebuilt');
});

test('bundled graph manager rejects stale region bindings', async (t) => {
  const paths = await fixture(t);
  const manager = new BundledGraphManager({ ...paths, probeRuntime: async () => {} });
  manager.setRegions([region]);
  assert.equal((await manager.readHealth()).ready, false);
  await assert.rejects(manager.resolveGraph(region.id), /unavailable/);
});

test('bundled graph manager downloads, clips, merges, and caches a multi-extract road graph', async (t) => {
  const paths = await fixture(t);
  const northern = { id: 'asia/india/northern-zone', name: 'Northern Zone',
    url: 'https://download.geofabrik.de/asia/india/northern-zone-latest.osm.pbf' };
  const central = { id: 'asia/india/central-zone', name: 'Central Zone',
    url: 'https://download.geofabrik.de/asia/india/central-zone-latest.osm.pbf' };
  const parent = { id: 'asia/india', name: 'India',
    url: 'https://download.geofabrik.de/asia/india-latest.osm.pbf' };
  const actions = [];
  const dependencies = {
    ...paths,
    probeRuntime: async () => {},
    loadIndex: async () => ({ type: 'FeatureCollection', features: [] }),
    selectCover: (_index, _region, options) => {
      assert.equal(options.maxSources, 8);
      return [northern, central];
    },
    selectExtract: () => { throw new Error('Parent extract should not be selected'); },
    readSnapshot: async ({ sourcePath }) => {
      actions.push(`snapshot:${path.basename(sourcePath)}`);
      return '2026-10-14T00:00:00Z';
    },
    downloadExtract: async (url, destination) => {
      actions.push(`download:${url}`);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      const contents = Buffer.alloc(2048, url.includes('central') ? 0x63 : 0x6e);
      await fs.writeFile(destination, contents);
      return { path: destination,
        sha256: createHash('sha256').update(contents).digest('hex'),
        resolvedUrl: url.replace('-latest.osm.pbf', '-261014.osm.pbf') };
    },
    clipExtract: async ({ sourcePath, destinationPath }) => {
      actions.push(`clip:${path.basename(sourcePath)}`);
      await fs.copyFile(sourcePath, destinationPath);
    },
    mergeExtracts: async ({ sourcePaths, destinationPath }) => {
      actions.push('merge');
      assert.equal(sourcePaths.length, 2);
      await fs.writeFile(destinationPath, Buffer.concat(await Promise.all(
        sourcePaths.map((source) => fs.readFile(source)))));
    },
    buildGraph: async ({ configPath, pbfPath }) => {
      actions.push('build');
      const data = await fs.readFile(pbfPath);
      assert.equal(data.length, 4096);
      assert.equal(data[0], 0x63, 'sources are merged in canonical order');
      assert.equal(data[2048], 0x6e);
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      await fs.writeFile(path.join(config.mjolnir.tile_dir, '0.gph'), 'tile');
      await fs.writeFile(config.mjolnir.admin,
        Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(84)]));
    }
  };
  const manager = new BundledGraphManager(dependencies);
  const health = await manager.ensureGraphs([region]);
  assert.equal(health.ready, true);
  assert.equal(actions.filter((action) => action.startsWith('download:')).length, 2);
  assert.equal(actions.filter((action) => action.startsWith('clip:')).length, 2);
  assert.equal(actions.filter((action) => action.startsWith('snapshot:')).length, 2);
  assert.equal(actions.filter((action) => action === 'merge').length, 1);
  assert.equal(actions.filter((action) => action === 'build').length, 1);
  const graphDir = path.dirname((await manager.resolveGraph(region.id)).configPath);
  const manifest = JSON.parse(await fs.readFile(path.join(graphDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.extractIds, [central.id, northern.id]);
  assert.equal(manifest.sourceSha256.length, 64);
  assert.equal((await fs.readdir(graphDir)).some((name) => name.endsWith('.osm.pbf')), false,
    'temporary clipped and merged PBFs must not be retained in the graph');
  const restarted = new BundledGraphManager(dependencies);
  await restarted.ensureGraphs([region]);
  assert.equal(actions.filter((action) => action === 'build').length, 1,
    'a valid multi-source graph must be reused');
  assert.equal(graphKey([northern, central], region, regionBounds(region, 10)),
    graphKey([central, northern], region, regionBounds(region, 10)));
  assert.equal(graphKey(parent, region, regionBounds(region, 10)),
    createHash('sha256').update(JSON.stringify([extractKey(parent),
      createHash('sha256').update(JSON.stringify([region.id, region.centerLatitude,
        region.centerLongitude, region.radiusKm])).digest('hex'),
      regionBounds(region, 10)])).digest('hex').slice(0, 24),
  'single-source graph key remains backward compatible');
  await fs.rm(path.join(graphDir, 'tiles', '0.gph'));
  const failing = new BundledGraphManager({ ...dependencies,
    mergeExtracts: async () => { throw new Error('Test merge failure'); } });
  await assert.rejects(failing.ensureGraphs([region]), /Test merge failure/);
  const graphEntries = await fs.readdir(path.join(paths.rootDir, 'graphs'));
  assert.equal(graphEntries.some((name) => name.endsWith('.building')), false,
    'failed merges must remove temporary clipped and merged data');
});

for (const mismatch of ['dated URL', 'OSM replication timestamp']) {
test(`${mismatch} mismatch falls back to the original single-extract graph`, async (t) => {
  const paths = await fixture(t);
  const children = ['one', 'two'].map((id) => ({ id, name: id,
    url: `https://download.geofabrik.de/asia/${id}-latest.osm.pbf` }));
  const parent = { id: 'parent', name: 'Parent',
    url: 'https://download.geofabrik.de/asia/parent-latest.osm.pbf' };
  const actions = [];
  let snapshotCalls = 0;
  const manager = new BundledGraphManager({
    ...paths,
    probeRuntime: async () => {},
    loadIndex: async () => ({ type: 'FeatureCollection', features: [] }),
    selectCover: () => children,
    selectExtract: () => parent,
    readSnapshot: async () => ++snapshotCalls === 2
      && mismatch === 'OSM replication timestamp'
      ? '2026-10-13T00:00:00Z' : '2026-10-14T00:00:00Z',
    downloadExtract: async (url, destination) => {
      actions.push(`download:${url}`);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, Buffer.alloc(2048, 0x42));
      const day = url.includes('two') && mismatch === 'dated URL' ? '261013' : '261014';
      return { path: destination, sha256: 'b'.repeat(64),
        resolvedUrl: url.replace('-latest.osm.pbf', `-${day}.osm.pbf`) };
    },
    clipExtract: async ({ sourcePath, destinationPath }) => {
      actions.push('clip');
      await fs.copyFile(sourcePath, destinationPath);
    },
    mergeExtracts: async () => { throw new Error('Mismatched sources were merged'); },
    buildGraph: async ({ configPath }) => {
      actions.push('build');
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      await fs.writeFile(path.join(config.mjolnir.tile_dir, '0.gph'), 'tile');
      await fs.writeFile(config.mjolnir.admin,
        Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(84)]));
    }
  });
  await manager.ensureGraphs([region]);
  assert.equal(actions.filter((action) => action.startsWith('download:')).length, 3);
  assert.equal(actions.filter((action) => action === 'clip').length, 1);
  assert.equal(actions.filter((action) => action === 'build').length, 1);
  const graphDir = path.dirname((await manager.resolveGraph(region.id)).configPath);
  const manifest = JSON.parse(await fs.readFile(path.join(graphDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.extractId, parent.id);
});
}
