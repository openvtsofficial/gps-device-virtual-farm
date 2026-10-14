'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFile, spawn } = require('node:child_process');
const { LocalValhallaProvider } = require('./local-valhalla-provider');

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const ACTIONS = new Set(['route', 'trace_attributes']);
const SERVICE_PORT_PATHS = Object.freeze([
  ['httpd', 'service', 'listen'], ['httpd', 'service', 'loopback'],
  ['httpd', 'service', 'interrupt'], ['loki', 'service', 'proxy'],
  ['thor', 'service', 'proxy'], ['odin', 'service', 'proxy'],
  ['meili', 'service', 'proxy']
]);
const MAX_MANAGED_SERVICES = 2;
const SERVICE_START_TIMEOUT_MS = 15_000;

function abortError() {
  return Object.assign(new Error('Road routing canceled'), { name: 'AbortError' });
}

function nativeEnv(graph) {
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  for (const key of Object.keys(env)) {
    if (key !== pathKey && key.toLowerCase() === 'path') delete env[key];
  }
  env[pathKey] = `${graph.libsPath}${delimiter}${path.dirname(graph.binaryPath)}${delimiter}${env[pathKey] || ''}`;
  return env;
}

async function reserveLoopbackPorts(count = SERVICE_PORT_PATHS.length) {
  const reservations = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = net.createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      reservations.push(server);
    }
    return reservations.map((server) => server.address().port);
  } finally {
    await Promise.all(reservations.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

function serviceConfig(config, ports) {
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      !Array.isArray(ports) || ports.length !== SERVICE_PORT_PATHS.length ||
      new Set(ports).size !== ports.length ||
      ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535)) {
    throw new Error('Invalid bundled road service configuration');
  }
  const copy = structuredClone(config);
  for (const [index, keys] of SERVICE_PORT_PATHS.entries()) {
    let node = copy;
    for (const key of keys.slice(0, -1)) node = node?.[key];
    if (!node || typeof node !== 'object') throw new Error('Incomplete bundled road service configuration');
    node[keys.at(-1)] = `tcp://127.0.0.1:${ports[index]}`;
  }
  return copy;
}

function waitForDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const timer = setTimeout(done, milliseconds);
    function done() { signal?.removeEventListener('abort', canceled); resolve(); }
    function canceled() { clearTimeout(timer); signal?.removeEventListener('abort', canceled); reject(abortError()); }
    signal?.addEventListener('abort', canceled, { once: true });
  });
}

async function stopManagedService(service) {
  if (!service) return;
  const child = service.child;
  if (child && !service.closed && child.exitCode === null && !child.killed) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.kill();
    });
  }
  await fs.rm(service.tempDir, { recursive: true, force: true });
}

function valhallaErrorStatus(output) {
  if (!output || typeof output !== 'string' || output.length > MAX_RESPONSE_BYTES) return null;
  try {
    const parsed = JSON.parse(output);
    const status = Number(parsed.status_code ?? parsed.status);
    return Number.isInteger(status) && status >= 400 && status < 500 ? status : null;
  } catch {
    return null;
  }
}

function validateGraph(graph) {
  if (!graph || typeof graph !== 'object' ||
      ![graph.binaryPath, graph.configPath, graph.libsPath].every((value) =>
        typeof value === 'string' && path.isAbsolute(value))) {
    throw new Error('Bundled road graph is not configured');
  }
  return graph;
}

async function runValhallaOneShot(graph, action, request, { signal } = {}) {
  validateGraph(graph);
  if (!ACTIONS.has(action) || !request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Invalid bundled road request');
  }
  if (signal?.aborted) throw signal.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' });
  const json = JSON.stringify(request);
  if (Buffer.byteLength(json) > MAX_REQUEST_BYTES) throw new Error('Bundled road request exceeds byte limit');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gps-farm-road-'));
  const requestPath = path.join(tempDir, 'request.json');
  try {
    await fs.writeFile(requestPath, json, { flag: 'wx' });
    return await new Promise((resolve, reject) => {
      execFile(graph.binaryPath, [graph.configPath, action, requestPath], {
        cwd: path.dirname(graph.binaryPath), env: nativeEnv(graph), windowsHide: true,
        maxBuffer: MAX_RESPONSE_BYTES, timeout: 120_000, signal
      }, (error, stdout, stderr) => {
        if (error) {
          if (signal?.aborted || error.name === 'AbortError') {
            reject(Object.assign(new Error('Road routing canceled'), { name: 'AbortError' }));
            return;
          }
          const status = valhallaErrorStatus(stdout);
          const failure = new Error(status
            ? `Bundled Valhalla rejected the route (HTTP ${status})`
            : `Bundled Valhalla failed: ${(stderr || error.message).trim().slice(0, 300)}`);
          if (status) failure.status = status;
          reject(failure);
          return;
        }
        if (!stdout || Buffer.byteLength(stdout) > MAX_RESPONSE_BYTES) {
          reject(new Error('Bundled Valhalla response exceeds byte limit'));
          return;
        }
        resolve(stdout);
      });
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

class BundledValhallaProvider {
  constructor({ resolveGraph, readHealth, runOneShot = runValhallaOneShot,
    spawnService = spawn, serviceFetch = globalThis.fetch,
    allocatePorts = reserveLoopbackPorts } = {}) {
    if (typeof resolveGraph !== 'function' || typeof readHealth !== 'function' ||
        typeof runOneShot !== 'function' || typeof spawnService !== 'function' ||
        typeof serviceFetch !== 'function' || typeof allocatePorts !== 'function') {
      throw new Error('Bundled Valhalla provider requires graph management');
    }
    this.id = 'valhalla-bundled';
    this.bulkAllowed = true;
    this.endpointFamily = 'bundled-valhalla-cli';
    this.resolveGraph = resolveGraph;
    this.readHealth = readHealth;
    this.runOneShot = runOneShot;
    this.spawnService = spawnService;
    this.serviceFetch = serviceFetch;
    this.allocatePorts = allocatePorts;
    this.responseProviders = new WeakMap();
    this.services = new Map();
    this.serviceFailures = new Set();
    this.serviceFailureReasons = new Map();
    this.sessionAbort = null;
    this.sessionSignal = null;
    this.sessionCancel = null;
  }

  async startSession({ signal } = {}) {
    if (signal?.aborted) throw abortError();
    if (this.sessionAbort) return;
    this.sessionAbort = new AbortController();
    this.sessionSignal = signal || null;
    this.sessionCancel = () => this.sessionAbort?.abort();
    signal?.addEventListener('abort', this.sessionCancel, { once: true });
    this.serviceFailures.clear();
    this.serviceFailureReasons.clear();
  }

  async stopSession() {
    this.sessionSignal?.removeEventListener('abort', this.sessionCancel);
    this.sessionAbort?.abort();
    this.sessionAbort = null;
    this.sessionSignal = null;
    this.sessionCancel = null;
    const pending = [...this.services.values()];
    this.services.clear();
    this.serviceFailures.clear();
    await Promise.all(pending.map(async (promise) => {
      try { await stopManagedService(await promise); } catch { /* Startup already cleaned up. */ }
    }));
  }

  async health({ signal } = {}) {
    if (signal?.aborted) throw signal.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' });
    try {
      const status = await this.readHealth({ signal });
      const version = typeof status?.version === 'string' && status.version.length <= 80
        ? status.version : null;
      const tilesetLastModified = Number.isInteger(status?.tilesetLastModified) &&
        status.tilesetLastModified > 0 ? status.tilesetLastModified : null;
      return { ready: status?.ready === true && Boolean(version && tilesetLastModified),
        version, tilesetLastModified, endpointFamily: this.endpointFamily,
        ...(status?.reason ? { reason: String(status.reason).slice(0, 300) } : {}) };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { ready: false, version: null, tilesetLastModified: null,
        endpointFamily: this.endpointFamily, reason: error.message };
    }
  }

  async #launchService(graph, signal) {
    if (signal?.aborted) throw abortError();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gps-farm-valhalla-service-'));
    const service = { tempDir, child: null, closed: false, error: null, endpoint: null,
      outputTail: '' };
    try {
      const config = JSON.parse(await fs.readFile(graph.configPath, 'utf8'));
      const ports = await this.allocatePorts();
      const configured = serviceConfig(config, ports);
      if (signal?.aborted) throw abortError();
      const configPath = path.join(tempDir, 'config.json');
      await fs.writeFile(configPath, JSON.stringify(configured), { flag: 'wx' });
      service.endpoint = `http://127.0.0.1:${ports[0]}`;
      const child = this.spawnService(graph.binaryPath, [configPath, '1'], {
        cwd: path.dirname(graph.binaryPath), env: nativeEnv(graph),
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
      });
      service.child = child;
      child.on('error', (error) => { service.error = error; });
      child.on('close', () => { service.closed = true; });
      for (const stream of [child.stdout, child.stderr]) {
        stream?.on('data', (chunk) => {
          service.outputTail = (service.outputTail + chunk.toString('utf8')).slice(-4_000);
        });
      }
      const probe = new LocalValhallaProvider({ endpoint: service.endpoint,
        fetchImpl: this.serviceFetch, timeoutMs: 3_000 });
      const deadline = Date.now() + SERVICE_START_TIMEOUT_MS;
      let lastHealth;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw abortError();
        if (service.error || service.closed || child.exitCode !== null) {
          throw new Error(`Bundled road service exited during startup: ${service.outputTail.slice(-300) ||
            service.error?.message || 'native process stopped'}`);
        }
        lastHealth = await probe.health({ signal });
        if (lastHealth.ready) {
          if (service.closed || child.exitCode !== null) throw new Error('Bundled road service stopped during startup');
          return service;
        }
        await waitForDelay(250, signal);
      }
      throw new Error(`Bundled road service did not become ready in time: ${
        lastHealth?.reason || service.outputTail.slice(-300) || 'status endpoint not ready'}`);
    } catch (error) {
      await stopManagedService(service);
      throw error;
    }
  }

  async #serviceFor(graph, signal) {
    const sessionAbort = this.sessionAbort;
    if (!sessionAbort || this.serviceFailures.has(graph.configPath)) return null;
    const key = graph.configPath;
    let pending = this.services.get(key);
    if (pending) {
      this.services.delete(key);
      this.services.set(key, pending);
      const existing = await pending;
      if (!existing || existing.closed || existing.child?.exitCode !== null) {
        this.services.delete(key);
        this.serviceFailures.add(key);
        await stopManagedService(existing);
        return null;
      }
      return existing;
    }
    if (this.services.size >= MAX_MANAGED_SERVICES) {
      // Candidate planning interleaves regions. Eviction here would restart a
      // native process on nearly every candidate for a 3+ region catalog.
      this.serviceFailures.add(key);
      this.serviceFailureReasons.set(key, 'Managed service pool is full; using one-shot routing');
      return null;
    }
    const combined = signal ? AbortSignal.any([signal, sessionAbort.signal]) : sessionAbort.signal;
    pending = this.#launchService(graph, combined).catch((error) => {
      if (combined.aborted) throw abortError();
      this.serviceFailures.add(key);
      this.serviceFailureReasons.set(key, error.message);
      return null;
    });
    this.services.set(key, pending);
    const service = await pending;
    if (!service) this.services.delete(key);
    return service;
  }

  async #localProvider(graph, signal) {
    const service = await this.#serviceFor(graph, signal);
    const endpoint = service?.endpoint || 'http://127.0.0.1:8002';
    return new LocalValhallaProvider({ endpoint, timeoutMs: 120_000, fetchImpl: async (url, init) => {
      const action = new URL(url).pathname.slice(1);
      if (!ACTIONS.has(action) || init.method !== 'POST' || typeof init.body !== 'string') {
        throw new Error('Unsupported bundled Valhalla action');
      }
      if (service && !service.closed && service.child?.exitCode === null) {
        try { return await this.serviceFetch(url, init); }
        catch (error) {
          if (init.signal?.aborted) throw error;
          this.serviceFailures.add(graph.configPath);
          this.serviceFailureReasons.set(graph.configPath,
            `Managed service transport failed: ${error.message}`);
          this.services.delete(graph.configPath);
          await stopManagedService(service);
        }
      }
      const output = await this.runOneShot(graph, action, JSON.parse(init.body), { signal: init.signal });
      // Keep the existing streamed-size, JSON-depth, geometry and road-class
      // checks even when the native service cannot start and CLI mode is used.
      return new Response(output, { headers: { 'content-type': 'application/json' } });
    } });
  }

  async fetchRoute(candidate, { signal } = {}) {
    if (!candidate || typeof candidate.regionId !== 'string') {
      throw new Error('Bundled route candidate needs a region');
    }
    const graph = validateGraph(await this.resolveGraph(candidate.regionId, { signal }));
    const provider = await this.#localProvider(graph, signal);
    const response = await provider.fetchRoute(candidate, { signal });
    this.responseProviders.set(response, graph);
    if (Array.isArray(response.alternate_paths)) {
      for (const alternate of response.alternate_paths) {
        if (alternate && typeof alternate === 'object') this.responseProviders.set(alternate, graph);
      }
    }
    return response;
  }

  async fetchRoadClasses(response, { signal } = {}) {
    const graph = this.responseProviders.get(response);
    if (!graph) {
      throw Object.assign(new Error('Bundled route graph identity is unavailable'),
        { code: 'ROAD_ATTRIBUTES_UNAVAILABLE' });
    }
    const provider = await this.#localProvider(graph, signal);
    return provider.fetchRoadClasses(response, { signal });
  }
}

module.exports = { BundledValhallaProvider, runValhallaOneShot, valhallaErrorStatus,
  serviceConfig, reserveLoopbackPorts };
