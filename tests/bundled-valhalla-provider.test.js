'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { BundledValhallaProvider, runValhallaOneShot, valhallaErrorStatus } =
  require('../src/road/bundled-valhalla-provider');
const { encodePolyline6 } = require('../src/road/local-valhalla-provider');
const { distanceMeters } = require('../src/road/route-validator');

const a = { latitude: 28.6139, longitude: 77.2090 };
const b = { latitude: 28.6149, longitude: 77.2100 };
const c = { latitude: 28.6159, longitude: 77.2110 };

test('bundled provider routes and attributes each response against its region graph', async () => {
  const calls = [];
  const graphs = {
    delhi: { binaryPath: 'C:\\app\\valhalla_service.exe', configPath: 'C:\\data\\delhi.json',
      libsPath: 'C:\\app\\libs' },
    jaipur: { binaryPath: 'C:\\app\\valhalla_service.exe', configPath: 'C:\\data\\jaipur.json',
      libsPath: 'C:\\app\\libs' }
  };
  // On non-Windows test hosts, resolveGraph must still provide platform-absolute paths.
  if (process.platform !== 'win32') {
    for (const [regionId, graph] of Object.entries(graphs)) {
      graph.binaryPath = `/app/${regionId}/valhalla_service`;
      graph.configPath = `/data/${regionId}.json`;
      graph.libsPath = '/app/libs';
    }
  }
  const provider = new BundledValhallaProvider({
    resolveGraph: async (regionId) => graphs[regionId],
    readHealth: async () => ({ ready: true, version: '3.9.1', tilesetLastModified: 12345 }),
    runOneShot: async (graph, action, request) => {
      calls.push({ graph, action, request });
      if (action === 'route') {
        return JSON.stringify({ trip: { legs: [{ shape: encodePolyline6([a, b]) }] },
          alternate_paths: [{ trip: { legs: [{ shape: encodePolyline6([a, c]) }] } }] });
      }
      const meters = action === 'trace_attributes' && request.encoded_polyline === encodePolyline6([a, c])
        ? distanceMeters(a, c) : distanceMeters(a, b);
      return JSON.stringify({ edges: [{ road_class: 'residential', length: meters / 1000 }] });
    }
  });
  assert.equal(provider.id, 'valhalla-bundled');
  assert.equal(provider.bulkAllowed, true);
  assert.deepEqual(await provider.health(), { ready: true, version: '3.9.1',
    tilesetLastModified: 12345, endpointFamily: 'bundled-valhalla-cli' });
  const delhi = await provider.fetchRoute({ regionId: 'delhi', family: 'local', locations: [a, b] });
  const jaipur = await provider.fetchRoute({ regionId: 'jaipur', family: 'urban', locations: [a, b] });
  assert.deepEqual(calls.slice(0, 2).map((call) => call.graph.configPath),
    [graphs.delhi.configPath, graphs.jaipur.configPath]);
  assert.equal(calls[0].request.costing_options.auto.use_highways, 0);
  assert.equal(calls[1].request.costing_options.auto.use_highways, 0.15);
  assert.equal((await provider.fetchRoadClasses(delhi)).localShare, 1);
  assert.equal((await provider.fetchRoadClasses(jaipur.alternate_paths[0])).localShare, 1);
  assert.deepEqual(calls.slice(2).map((call) => call.graph.configPath),
    [graphs.delhi.configPath, graphs.jaipur.configPath]);
  await assert.rejects(provider.fetchRoadClasses({ trip: { legs: [] } }), (error) =>
    error.code === 'ROAD_ATTRIBUTES_UNAVAILABLE');
});

test('native one-shot runner passes a request file without shell expansion or installed runtime', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gps-farm-native-test-'));
  try {
    const scriptPath = path.join(directory, 'fake-valhalla.js');
    await fs.writeFile(scriptPath, "const fs = require('node:fs'); const payload = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')); process.stdout.write(JSON.stringify({action:process.argv[2],payload}));\n");
    const graph = { binaryPath: process.execPath, configPath: scriptPath, libsPath: directory };
    const body = { locations: [{ lat: 28.6, lon: 77.2 }], suspicious: '`$(whoami)`' };
    const parsed = JSON.parse(await runValhallaOneShot(graph, 'route', body));
    assert.deepEqual(parsed, { action: 'route', payload: body });
    await assert.rejects(runValhallaOneShot(graph, 'status', body), /Invalid bundled road request/);
    await fs.writeFile(scriptPath,
      "process.stdout.write(JSON.stringify({status_code:400,error:'No suitable edges'})); process.exitCode = 1;\n");
    await assert.rejects(runValhallaOneShot(graph, 'route', body), (error) =>
      error.status === 400 && /rejected/.test(error.message));
    await fs.writeFile(scriptPath, "setTimeout(() => process.stdout.write('{}'), 5000);\n");
    const controller = new AbortController();
    const pending = runValhallaOneShot(graph, 'route', body, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, (error) => error.name === 'AbortError');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('bundled provider rejects malformed graph health and preserves candidate errors', async () => {
  const provider = new BundledValhallaProvider({
    resolveGraph: async () => ({ binaryPath: 'relative.exe' }),
    readHealth: async () => ({ ready: true, version: '3.9.1', tilesetLastModified: 0 })
  });
  assert.equal((await provider.health()).ready, false);
  await assert.rejects(provider.fetchRoute({ regionId: 'delhi', locations: [a, b] }),
    /not configured/);
  assert.equal(valhallaErrorStatus('{"status_code":400,"error":"No suitable edges"}'), 400);
  assert.equal(valhallaErrorStatus('{"status_code":500}'), null);
});

test('managed bundled service reuses one loopback process for routes and road-class traces', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gps-farm-service-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'graph.json');
  const config = { httpd: { service: {} }, loki: { service: {} },
    thor: { service: {} }, odin: { service: {} }, meili: { service: {} } };
  await fs.writeFile(configPath, JSON.stringify(config));
  const graph = { binaryPath: process.execPath, configPath, libsPath: directory };
  const children = [];
  const requests = [];
  let serviceConfigPath;
  const provider = new BundledValhallaProvider({
    resolveGraph: async () => graph,
    readHealth: async () => ({ ready: true, version: 'fixture', tilesetLastModified: 100 }),
    allocatePorts: async () => [31421, 31422, 31423, 31424, 31425, 31426, 31427],
    spawnService: (_binary, args, options) => {
      assert.equal(args[1], '1');
      assert.equal(options.windowsHide, true);
      serviceConfigPath = args[0];
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        child.exitCode = 0;
        queueMicrotask(() => child.emit('close', 0));
        return true;
      };
      children.push(child);
      return child;
    },
    serviceFetch: async (url, init) => {
      requests.push({ url, method: init.method });
      if (url.endsWith('/status')) {
        return new Response(JSON.stringify({ version: '3.9.1', tileset_last_modified: 100,
          has_tiles: true }));
      }
      if (url.endsWith('/route')) {
        return new Response(JSON.stringify({ trip: { legs: [{ shape: encodePolyline6([a, b]) }] } }));
      }
      return new Response(JSON.stringify({ edges: [{ road_class: 'residential',
        length: distanceMeters(a, b) / 1000 }] }));
    },
    runOneShot: async () => { throw new Error('managed service unexpectedly fell back'); }
  });
  await provider.startSession();
  try {
    const route = await provider.fetchRoute({ regionId: 'delhi', family: 'local', locations: [a, b] });
    assert.equal((await provider.fetchRoadClasses(route)).localShare, 1);
    const second = await provider.fetchRoute({ regionId: 'delhi', family: 'local', locations: [a, b] });
    assert.equal((await provider.fetchRoadClasses(second)).localShare, 1);
    assert.equal(children.length, 1);
    assert.equal(requests.filter((request) => request.url.endsWith('/route')).length, 2);
    assert.equal(requests.filter((request) => request.url.endsWith('/trace_attributes')).length, 2);
    const configured = JSON.parse(await fs.readFile(serviceConfigPath, 'utf8'));
    assert.equal(configured.httpd.service.listen, 'tcp://127.0.0.1:31421');
    assert.equal(configured.meili.service.proxy, 'tcp://127.0.0.1:31427');
    assert.deepEqual(config, { httpd: { service: {} }, loki: { service: {} },
      thor: { service: {} }, odin: { service: {} }, meili: { service: {} } });
  } finally { await provider.stopSession(); }
  assert.equal(children[0].killed, true);
  await assert.rejects(fs.access(serviceConfigPath), (error) => error.code === 'ENOENT');
});

test('managed startup failure falls back to the bundled one-shot runner', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gps-farm-service-fallback-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'graph.json');
  await fs.writeFile(configPath, JSON.stringify({ httpd: { service: {} },
    loki: { service: {} }, thor: { service: {} }, odin: { service: {} },
    meili: { service: {} } }));
  const calls = [];
  const provider = new BundledValhallaProvider({
    resolveGraph: async () => ({ binaryPath: process.execPath, configPath, libsPath: directory }),
    readHealth: async () => ({ ready: true, version: 'fixture', tilesetLastModified: 100 }),
    allocatePorts: async () => [31421, 31422, 31423, 31424, 31425, 31426, 31427],
    spawnService: () => { throw new Error('Service cannot bind'); },
    runOneShot: async (_graph, action) => {
      calls.push(action);
      return action === 'route'
        ? JSON.stringify({ trip: { legs: [{ shape: encodePolyline6([a, b]) }] } })
        : JSON.stringify({ edges: [{ road_class: 'residential',
          length: distanceMeters(a, b) / 1000 }] });
    }
  });
  await provider.startSession();
  try {
    const route = await provider.fetchRoute({ regionId: 'delhi', family: 'local', locations: [a, b] });
    assert.equal((await provider.fetchRoadClasses(route)).localShare, 1);
  } finally { await provider.stopSession(); }
  assert.deepEqual(calls, ['route', 'trace_attributes']);
});

test('managed routing keeps two region services and avoids restart churn for a third region', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gps-farm-service-regions-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const graphs = {};
  for (const id of ['a', 'b', 'c']) {
    const configPath = path.join(directory, `${id}.json`);
    await fs.writeFile(configPath, JSON.stringify({ httpd: { service: {} },
      loki: { service: {} }, thor: { service: {} }, odin: { service: {} },
      meili: { service: {} } }));
    graphs[id] = { binaryPath: process.execPath, configPath, libsPath: directory };
  }
  let launches = 0;
  let serviceRoutes = 0;
  let oneShotRoutes = 0;
  const payload = JSON.stringify({ trip: { legs: [{ shape: encodePolyline6([a, b]) }] } });
  const provider = new BundledValhallaProvider({
    resolveGraph: async (id) => graphs[id],
    readHealth: async () => ({ ready: true, version: 'fixture', tilesetLastModified: 100 }),
    allocatePorts: async () => [31421, 31422, 31423, 31424, 31425, 31426, 31427],
    spawnService: () => {
      launches += 1;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.killed = false;
      child.kill = () => { child.killed = true; child.exitCode = 0;
        queueMicrotask(() => child.emit('close', 0)); return true; };
      return child;
    },
    serviceFetch: async (url) => {
      if (url.endsWith('/status')) return new Response(JSON.stringify({
        version: '3.9.1', tileset_last_modified: 100, has_tiles: true }));
      serviceRoutes += 1;
      return new Response(payload);
    },
    runOneShot: async () => { oneShotRoutes += 1; return payload; }
  });
  await provider.startSession();
  try {
    for (const regionId of ['a', 'b', 'c', 'a', 'b', 'c']) {
      await provider.fetchRoute({ regionId, family: 'local', locations: [a, b] });
    }
    assert.equal(launches, 2);
    assert.equal(serviceRoutes, 4);
    assert.equal(oneShotRoutes, 2);
    assert.equal(provider.services.size, 2);
    assert.equal(provider.serviceFailures.has(graphs.c.configPath), true);
  } finally { await provider.stopSession(); }
});
