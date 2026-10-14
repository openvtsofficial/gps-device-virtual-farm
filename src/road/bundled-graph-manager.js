'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { validateRegions } = require('./region-planner');
const { loadGeofabrikIndex, selectGeofabrikExtract, regionBounds,
  downloadGeofabrikExtract } = require('./geofabrik-source');
const { selectGeofabrikCover } = require('./geofabrik-cover');
const configTemplate = require('./valhalla-config-template.json');

const ENGINE_VERSION = '3.9.1';
const GRAPH_SCHEMA = 1;

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function regionKey(region) {
  return digest([region.id, region.centerLatitude, region.centerLongitude, region.radiusKm]);
}

function extractKey(extract) {
  return digest([extract.id, extract.url]).slice(0, 24);
}

function graphKey(extracts, region, bounds) {
  const keys = (Array.isArray(extracts) ? extracts : [extracts]).map(extractKey).sort();
  // Keep the original single-extract key so previously built graphs are reused.
  return digest([keys.length === 1 ? keys[0] : keys, regionKey(region), bounds]).slice(0, 24);
}

function extractDate(download) {
  const match = /-(\d{6,8})\.osm\.pbf$/i.exec(download.resolvedUrl || '');
  return match?.[1] || null;
}

function assertMatchingExtractDates(downloads) {
  if (downloads.length < 2) return;
  const dates = downloads.map(extractDate);
  if (dates.every(Boolean) && new Set(dates).size !== 1) {
    const error = new Error('Regional OpenStreetMap extracts have different snapshot dates');
    error.code = 'ROAD_SOURCE_DATE_MISMATCH';
    throw error;
  }
}

async function readNativeSnapshot({ binaryPath, sourcePath, signal }) {
  if (signal?.aborted) throw abortError();
  return new Promise((resolve, reject) => {
    execFile(binaryPath, ['fileinfo', '-g',
      'header.option.osmosis_replication_timestamp', sourcePath], {
      windowsHide: true, timeout: 30_000, maxBuffer: 4096, signal
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

async function assertMatchingSnapshots(downloads, clipperPath, readSnapshot, signal) {
  if (downloads.length < 2) return;
  try {
    const snapshots = [];
    for (const download of downloads) {
      const snapshot = await readSnapshot({ binaryPath: clipperPath,
        sourcePath: download.path, signal });
      snapshots.push(snapshot);
    }
    if (snapshots.some((value) => typeof value !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)) ||
        new Set(snapshots).size !== 1) {
      throw new Error('OSM replication timestamps differ or are missing');
    }
  } catch (error) {
    if (signal?.aborted) throw abortError();
    const failure = new Error(`Regional OpenStreetMap extracts cannot be merged safely: ${error.message}`);
    failure.code = 'ROAD_SOURCE_DATE_MISMATCH';
    throw failure;
  }
}

function abortError() {
  return Object.assign(new Error('Road preparation canceled'), { name: 'AbortError' });
}

function graphConfig(graphDirectory) {
  const config = structuredClone(configTemplate);
  config.mjolnir.tile_dir = path.join(graphDirectory, 'tiles');
  config.mjolnir.tile_extract = '';
  config.mjolnir.traffic_extract = '';
  config.mjolnir.admin = path.join(graphDirectory, 'admin.sqlite');
  config.mjolnir.timezone = '';
  config.mjolnir.landmarks = '';
  config.mjolnir.transit_dir = '';
  config.mjolnir.transit_feeds_dir = '';
  config.mjolnir.data_processing.use_admin_db = true;
  config.additional_data.elevation = '';
  config.logging.type = '';
  return config;
}

function nativePathEnv(...directories) {
  const env = { ...process.env };
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path') || 'PATH';
  for (const name of Object.keys(env)) {
    if (name !== key && name.toLowerCase() === 'path') delete env[name];
  }
  env[key] = `${directories.join(path.delimiter)}${path.delimiter}${env[key] || ''}`;
  return env;
}

async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx');
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

async function inspectGraphTiles(directory, limit = 100_000) {
  let count = 0;
  let bytes = 0;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
      else if (entry.isFile() && entry.name.endsWith('.gph')) {
        const size = (await fs.stat(path.join(current, entry.name))).size;
        if (size < 1) throw new Error('Road graph contains an empty tile');
        count += 1;
        bytes += size;
      }
      if (count > limit) throw new Error('Road graph contains too many tiles');
    }
  }
  return { count, bytes };
}

async function hasAdminDatabase(file) {
  const handle = await fs.open(file, 'r');
  try {
    if ((await handle.stat()).size < 100) return false;
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead === 16 && header.toString('ascii') === 'SQLite format 3\0';
  } finally { await handle.close(); }
}

async function runNativeBuild({ binaryPath, libsPath, configPath, pbfPath,
  signal, onProgress }) {
  const adminBinaryPath = path.join(path.dirname(binaryPath), 'valhalla_build_admins.exe');
  await runNativeCommand(adminBinaryPath, ['-c', configPath, pbfPath],
    { libsPath, configPath, signal, onProgress, label: 'administrative boundaries' });
  await runNativeCommand(binaryPath, ['-c', configPath, '-j', String(Math.max(1,
    Math.min(4, os.availableParallelism?.() || os.cpus().length))), pbfPath],
  { libsPath, configPath, signal, onProgress, label: 'road graph' });
}

async function runNativeClip({ binaryPath, sourcePath, destinationPath, bounds,
  signal, onProgress }) {
  if (!Array.isArray(bounds) || bounds.length !== 4 ||
      bounds.some((value) => !Number.isFinite(value)) || signal?.aborted) {
    throw signal?.aborted ? abortError() : new Error('Invalid road extraction bounds');
  }
  await new Promise((resolve, reject) => {
    const child = spawn(binaryPath, ['extract', '--bbox', bounds.join(','),
      '--strategy', 'complete_ways', '--set-bounds', sourcePath,
      '--output', destinationPath], {
      windowsHide: true, cwd: path.dirname(destinationPath), stdio: ['ignore', 'pipe', 'pipe']
    });
    let outputTail = '';
    const ingest = (chunk) => { outputTail = (outputTail + chunk.toString('utf8')).slice(-8_000); };
    child.stdout.on('data', ingest);
    child.stderr.on('data', ingest);
    const cancel = () => child.kill();
    signal?.addEventListener('abort', cancel, { once: true });
    child.once('error', (error) => {
      signal?.removeEventListener('abort', cancel);
      reject(signal?.aborted ? abortError() : error);
    });
    child.once('close', (code) => {
      signal?.removeEventListener('abort', cancel);
      if (signal?.aborted) reject(abortError());
      else if (code !== 0) reject(new Error(`Local OSM clipping failed (exit ${code}): ${outputTail.trim().slice(-1000)}`));
      else resolve();
    });
  });
  const clipped = await fs.stat(destinationPath);
  if (!clipped.isFile() || clipped.size < 1024) {
    throw new Error('Regional OSM clip contains no routable map data');
  }
  onProgress?.({ phase: 'clipped', bytes: clipped.size,
    message: `Regional road data clipped to ${Math.round(clipped.size / 1024 ** 2)} MB` });
}

async function runNativeMerge({ binaryPath, sourcePaths, destinationPath, signal,
  onProgress }) {
  if (!path.isAbsolute(binaryPath || '') || !path.isAbsolute(destinationPath || '') ||
      !Array.isArray(sourcePaths) || sourcePaths.length < 2 || sourcePaths.length > 32 ||
      sourcePaths.some((source) => !path.isAbsolute(source || '')) || signal?.aborted) {
    throw signal?.aborted ? abortError() : new Error('Invalid regional OSM merge request');
  }
  await new Promise((resolve, reject) => {
    const child = spawn(binaryPath, ['merge', ...sourcePaths, '--output', destinationPath], {
      windowsHide: true, cwd: path.dirname(destinationPath), stdio: ['ignore', 'pipe', 'pipe']
    });
    let outputTail = '';
    const ingest = (chunk) => { outputTail = (outputTail + chunk.toString('utf8')).slice(-8_000); };
    child.stdout.on('data', ingest);
    child.stderr.on('data', ingest);
    const cancel = () => child.kill();
    signal?.addEventListener('abort', cancel, { once: true });
    child.once('error', (error) => {
      signal?.removeEventListener('abort', cancel);
      reject(signal?.aborted ? abortError() : error);
    });
    child.once('close', (code) => {
      signal?.removeEventListener('abort', cancel);
      if (signal?.aborted) reject(abortError());
      else if (code !== 0) reject(new Error(`Local OSM merge failed (exit ${code}): ${outputTail.trim().slice(-1000)}`));
      else resolve();
    });
  });
  const merged = await fs.stat(destinationPath);
  if (!merged.isFile() || merged.size < 1024) {
    throw new Error('Merged regional OSM data contains no routable map data');
  }
  onProgress?.({ phase: 'merged', bytes: merged.size,
    message: `Regional road data merged to ${Math.round(merged.size / 1024 ** 2)} MB` });
}

async function runNativeCommand(binaryPath, args, { libsPath, configPath,
  signal, onProgress, label }) {
  if (signal?.aborted) throw abortError();
  await new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      windowsHide: true, cwd: path.dirname(configPath),
      env: nativePathEnv(libsPath, path.dirname(binaryPath)),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let outputTail = '';
    let lastStage = '';
    const ingest = (chunk) => {
      outputTail = (outputTail + chunk.toString('utf8')).slice(-16_000);
      const matches = [...outputTail.matchAll(/(?:^|\n).*?(?:stage|Stage)\s+(initialize|parseways|parserelations|parseareaways|parsenodes|buildareas|constructedges|build|enhance|filter|hierarchy|shortcuts|restrictions|elevation|validate|cleanup)/g)];
      const stage = matches.at(-1)?.[1];
      if (stage && stage !== lastStage) {
        lastStage = stage;
        onProgress?.({ phase: 'build', stage,
          message: `Building local road graph: ${stage}` });
      }
    };
    child.stdout.on('data', ingest);
    child.stderr.on('data', ingest);
    const cancel = () => child.kill();
    signal?.addEventListener('abort', cancel, { once: true });
    child.once('error', (error) => {
      signal?.removeEventListener('abort', cancel);
      reject(signal?.aborted ? abortError() : error);
    });
    child.once('close', (code) => {
      signal?.removeEventListener('abort', cancel);
      if (signal?.aborted) reject(abortError());
      else if (code !== 0) reject(new Error(`Local ${label} build failed (exit ${code}): ${outputTail.trim().slice(-1000)}`));
      else resolve();
    });
  });
}

async function probeNativeRuntime({ binaries, libsPath, clipperPath }) {
  const env = nativePathEnv(libsPath, path.dirname(binaries[0]));
  for (const binary of binaries) {
    const version = await new Promise((resolve, reject) => {
      execFile(binary, ['--version'], { env, windowsHide: true, timeout: 5_000,
        maxBuffer: 4096 }, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve(`${stdout}${stderr}`.trim());
      });
    });
    if (!version.includes(ENGINE_VERSION)) {
      throw new Error(`Bundled road engine version mismatch: ${path.basename(binary)}`);
    }
  }
  const clipperVersion = await new Promise((resolve, reject) => {
    execFile(clipperPath, ['--version'], { windowsHide: true, timeout: 5_000,
      maxBuffer: 4096 }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve(`${stdout}${stderr}`.trim());
    });
  });
  if (!clipperVersion.includes('1.19.1')) throw new Error('Bundled OSM clipper version mismatch');
}

class BundledGraphManager {
  constructor({ rootDir, runtimeDir, clipperDir, loadIndex = loadGeofabrikIndex,
    selectExtract = selectGeofabrikExtract,
    selectCover = selectGeofabrikCover,
    downloadExtract = downloadGeofabrikExtract,
    buildGraph = runNativeBuild, clipExtract = runNativeClip, mergeExtracts = runNativeMerge,
    readSnapshot = readNativeSnapshot,
    probeRuntime = probeNativeRuntime } = {}) {
    if (!path.isAbsolute(rootDir || '') || !path.isAbsolute(runtimeDir || '') ||
        !path.isAbsolute(clipperDir || '')) {
      throw new Error('Bundled road graph directories must be absolute');
    }
    this.rootDir = rootDir;
    this.runtimeDir = runtimeDir;
    this.clipperDir = clipperDir;
    this.loadIndex = loadIndex;
    this.selectExtract = selectExtract;
    this.selectCover = selectCover;
    this.downloadExtract = downloadExtract;
    this.buildGraph = buildGraph;
    this.clipExtract = clipExtract;
    this.mergeExtracts = mergeExtracts;
    this.readSnapshot = readSnapshot;
    this.probeRuntime = probeRuntime;
    this.runtimeProbe = null;
    this.runtimeFailureReason = null;
    this.regions = [];
  }

  get binaryPath() { return path.join(this.runtimeDir, 'valhalla', 'bin', 'valhalla_service.exe'); }
  get buildBinaryPath() { return path.join(this.runtimeDir, 'valhalla', 'bin', 'valhalla_build_tiles.exe'); }
  get adminBinaryPath() { return path.join(this.runtimeDir, 'valhalla', 'bin', 'valhalla_build_admins.exe'); }
  get libsPath() { return path.join(this.runtimeDir, 'pyvalhalla.libs'); }
  get clipperPath() { return path.join(this.clipperDir, 'osmium.exe'); }
  graphDirectory(key) { return path.join(this.rootDir, 'graphs', key); }
  bindingFile(region) { return path.join(this.rootDir, 'regions', `${region.id}.json`); }

  setRegions(regions) {
    this.regions = validateRegions(regions);
  }

  async runtimeAvailable() {
    if (process.platform !== 'win32' || process.arch !== 'x64') return false;
    if (!this.runtimeProbe) this.runtimeProbe = (async () => {
      try {
        await Promise.all([fs.access(this.binaryPath), fs.access(this.buildBinaryPath),
          fs.access(this.adminBinaryPath),
          ...['msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']
            .map((name) => fs.access(path.join(path.dirname(this.binaryPath), name))),
          fs.stat(this.libsPath), fs.access(this.clipperPath)]);
        await this.probeRuntime({ binaries: [this.binaryPath, this.buildBinaryPath,
          this.adminBinaryPath], libsPath: this.libsPath, clipperPath: this.clipperPath });
        return true;
      } catch (error) {
        this.runtimeFailureReason = error.message;
        return false;
      }
    })();
    return this.runtimeProbe;
  }

  async #readGraph(key, { verifyTiles = false } = {}) {
    if (!/^[a-f0-9]{24}$/.test(key)) return null;
    const folder = this.graphDirectory(key);
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(folder, 'manifest.json'), 'utf8'));
      if (manifest.schemaVersion !== GRAPH_SCHEMA || manifest.key !== key ||
          manifest.engineVersion !== ENGINE_VERSION ||
          !/^[a-f0-9]{64}$/.test(manifest.sourceSha256) ||
          !Number.isInteger(manifest.tileCount) || manifest.tileCount < 1 ||
          !Number.isSafeInteger(manifest.tileBytes) || manifest.tileBytes < 1 ||
          !Number.isInteger(manifest.builtAtEpoch) || manifest.builtAtEpoch <= 0) return null;
      const [tiles, config] = await Promise.all([
        fs.stat(path.join(folder, 'tiles')),
        fs.readFile(path.join(folder, 'config.json'), 'utf8')
      ]);
      if (!tiles.isDirectory() || JSON.parse(config).mjolnir?.tile_dir !== path.join(folder, 'tiles') ||
          !(await hasAdminDatabase(path.join(folder, 'admin.sqlite')))) return null;
      if (verifyTiles) {
        const observed = await inspectGraphTiles(path.join(folder, 'tiles'));
        if (observed.count !== manifest.tileCount || observed.bytes !== manifest.tileBytes) return null;
      }
      return manifest;
    } catch { return null; }
  }

  async #readBinding(region, { verifyTiles = false } = {}) {
    try {
      const binding = JSON.parse(await fs.readFile(this.bindingFile(region), 'utf8'));
      if (binding.schemaVersion !== GRAPH_SCHEMA || binding.regionKey !== regionKey(region) ||
          !/^[a-f0-9]{24}$/.test(binding.graphKey)) return null;
      const graph = await this.#readGraph(binding.graphKey, { verifyTiles });
      return graph ? { binding, graph } : null;
    } catch { return null; }
  }

  async readHealth({ signal } = {}) {
    if (signal?.aborted) throw abortError();
    if (!(await this.runtimeAvailable())) return { ready: false,
      reason: `Bundled Windows road engine is unavailable: ${this.runtimeFailureReason || 'unsupported platform'}` };
    if (!this.regions.length) return { ready: false, reason: 'No road regions configured' };
    const records = [];
    for (const region of this.regions) {
      const record = await this.#readBinding(region);
      if (!record) return { ready: false,
        reason: `Road map for ${region.id} has not been downloaded and built yet` };
      records.push(record);
    }
    return { ready: true,
      version: `${ENGINE_VERSION}:${digest(records.map(({ graph }) => [graph.key, graph.sourceSha256])).slice(0, 32)}`,
      tilesetLastModified: Math.max(...records.map(({ graph }) => graph.builtAtEpoch)) };
  }

  async resolveGraph(regionId, { signal } = {}) {
    if (signal?.aborted) throw abortError();
    const region = this.regions.find((item) => item.id === regionId);
    if (!region) throw new Error(`Unknown road region ${regionId}`);
    const record = await this.#readBinding(region);
    if (!record) throw new Error(`Road graph for ${regionId} is unavailable`);
    return { binaryPath: this.binaryPath,
      libsPath: this.libsPath,
      configPath: path.join(this.graphDirectory(record.binding.graphKey), 'config.json') };
  }

  async #loadCachedIndex(signal) {
    if (signal?.aborted) throw abortError();
    try {
      const index = JSON.parse(await fs.readFile(path.join(this.rootDir, 'geofabrik-index.json'), 'utf8'));
      if (index?.type === 'FeatureCollection' && Array.isArray(index.features) &&
          index.features.length <= 10_000) return index;
    } catch { /* Fetch a fresh index. */ }
    const index = await this.loadIndex({ signal });
    await atomicJson(path.join(this.rootDir, 'geofabrik-index.json'), index);
    return index;
  }

  async #buildSources(extracts, region, bounds, key, { signal, onProgress }) {
    const finalDirectory = this.graphDirectory(key);
    if (await this.#readGraph(key, { verifyTiles: true })) return;
    const downloads = [];
    for (const [index, extract] of extracts.entries()) {
      if (signal?.aborted) throw abortError();
      const downloadPath = path.join(this.rootDir, 'extracts', `${extractKey(extract)}.osm.pbf`);
      onProgress?.({ phase: 'download', extractName: extract.name,
        sourceIndex: index + 1, sourceCount: extracts.length,
        message: `Downloading OpenStreetMap roads for ${extract.name} (${index + 1}/${extracts.length})…` });
      const downloaded = await this.downloadExtract(extract.url, downloadPath, {
        signal, onProgress: (progress) => onProgress?.({ ...progress, extractName: extract.name,
          sourceIndex: index + 1, sourceCount: extracts.length,
          message: progress.totalBytes
            ? `Downloading ${extract.name} (${index + 1}/${extracts.length}): ${Math.round(progress.bytes / progress.totalBytes * 100)}%`
            : `Downloading ${extract.name} (${index + 1}/${extracts.length}): ${Math.round(progress.bytes / 1024 ** 2)} MB` })
      });
      downloads.push(downloaded);
    }
    assertMatchingExtractDates(downloads);
    await assertMatchingSnapshots(downloads, this.clipperPath, this.readSnapshot, signal);
    if (signal?.aborted) throw abortError();
    const stage = `${finalDirectory}.${randomUUID()}.building`;
    await fs.mkdir(path.join(stage, 'tiles'), { recursive: true });
    try {
      const clippedPaths = [];
      for (const [index, extract] of extracts.entries()) {
        if (signal?.aborted) throw abortError();
        const clippedPath = path.join(stage, extracts.length === 1
          ? 'regional.osm.pbf' : `regional-${index}.osm.pbf`);
        onProgress?.({ phase: 'clip', extractName: extract.name, regionId: region.id,
          sourceIndex: index + 1, sourceCount: extracts.length,
          message: `Clipping ${extract.name} roads around ${region.id} (${index + 1}/${extracts.length})…` });
        await this.clipExtract({ binaryPath: this.clipperPath,
          sourcePath: downloads[index].path, destinationPath: clippedPath, bounds,
          signal, onProgress });
        clippedPaths.push(clippedPath);
      }
      const regionalPath = extracts.length === 1 ? clippedPaths[0]
        : path.join(stage, 'regional.osm.pbf');
      if (extracts.length > 1) {
        onProgress?.({ phase: 'merge', regionId: region.id, sourceCount: extracts.length,
          message: `Merging ${extracts.length} regional OpenStreetMap extracts…` });
        await this.mergeExtracts({ binaryPath: this.clipperPath,
          sourcePaths: clippedPaths, destinationPath: regionalPath, signal, onProgress });
        for (const clippedPath of clippedPaths) await fs.rm(clippedPath, { force: true });
      }
      await atomicJson(path.join(stage, 'config.json'), graphConfig(stage));
      const extractName = extracts.map((extract) => extract.name).join(', ');
      onProgress?.({ phase: 'build', extractName,
        message: `Building local road graph for ${region.id}…` });
      await this.buildGraph({ binaryPath: this.buildBinaryPath, libsPath: this.libsPath,
        configPath: path.join(stage, 'config.json'), pbfPath: regionalPath,
        signal, onProgress });
      if (signal?.aborted) throw abortError();
      const tiles = await inspectGraphTiles(path.join(stage, 'tiles'));
      if (!tiles.count) throw new Error('Valhalla built no routable road graph tiles');
      if (!(await hasAdminDatabase(path.join(stage, 'admin.sqlite')))) {
        throw new Error('Valhalla did not build a valid administrative road database');
      }
      await fs.rm(regionalPath, { force: true });
      await atomicJson(path.join(stage, 'config.json'), graphConfig(finalDirectory));
      const manifest = { schemaVersion: GRAPH_SCHEMA, key,
        engineVersion: ENGINE_VERSION,
        ...(extracts.length === 1
          ? { extractId: extracts[0].id, sourceUrl: extracts[0].url,
            sourceSha256: downloads[0].sha256 }
          : { extractIds: extracts.map((extract) => extract.id),
            sourceUrls: extracts.map((extract) => extract.url),
            sourceSha256: digest(downloads.map((download) => download.sha256)) }),
        clipBounds: bounds,
        tileCount: tiles.count, tileBytes: tiles.bytes,
        builtAtEpoch: Math.floor(Date.now() / 1000) };
      await atomicJson(path.join(stage, 'manifest.json'), manifest);
      if (await this.#readGraph(key, { verifyTiles: true })) return;
      try { await fs.access(finalDirectory); await fs.rename(finalDirectory,
        `${finalDirectory}.${randomUUID()}.invalid`); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await fs.rename(stage, finalDirectory);
      onProgress?.({ phase: 'graph-ready', extractName,
        message: `Local road graph for ${region.id} is ready` });
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
  }

  #selectSources(index, region, marginKm) {
    const cover = this.selectCover(index, region, { marginKm, maxSources: 8 });
    if (!Array.isArray(cover) || (cover.length !== 0 && cover.length < 2) || cover.length > 8) {
      throw new Error('Invalid regional OpenStreetMap extract cover');
    }
    return cover.length ? [...cover].sort((a, b) => a.id.localeCompare(b.id) ||
      a.url.localeCompare(b.url)) : [this.selectExtract(index, [region], { marginKm })];
  }

  async ensureGraphs(regions, { signal, onProgress } = {}) {
    this.setRegions(regions);
    if (!(await this.runtimeAvailable())) {
      throw new Error(`The bundled Windows road engine cannot start: ${this.runtimeFailureReason || 'unsupported platform'}. Reinstall the desktop app.`);
    }
    const pending = [];
    for (const region of this.regions) {
      if (!(await this.#readBinding(region, { verifyTiles: true }))) pending.push(region);
    }
    if (!pending.length) return this.readHealth({ signal });
    onProgress?.({ phase: 'map-index', message: 'Finding the regional OpenStreetMap download…' });
    const index = await this.#loadCachedIndex(signal);
    for (const region of pending) {
      if (signal?.aborted) throw abortError();
      const marginKm = Math.min(50, Math.max(10, region.radiusKm * 0.3));
      const bounds = regionBounds(region, marginKm);
      let extracts;
      let selectedIndex = index;
      try { extracts = this.#selectSources(index, region, marginKm); }
      catch (error) {
        // A cached index may predate a newly added region; refresh it once.
        const fresh = await this.loadIndex({ signal });
        await atomicJson(path.join(this.rootDir, 'geofabrik-index.json'), fresh);
        selectedIndex = fresh;
        extracts = this.#selectSources(fresh, region, marginKm);
      }
      let key = graphKey(extracts, region, bounds);
      const extractName = extracts.map((extract) => extract.name).join(', ');
      onProgress?.({ phase: 'map-select', regionId: region.id, extractName,
        sourceCount: extracts.length,
        message: `Using ${extracts.length} OpenStreetMap extract${extracts.length === 1 ? '' : 's'} for ${region.id}: ${extractName}` });
      try {
        await this.#buildSources(extracts, region, bounds, key, { signal, onProgress });
      } catch (error) {
        if (extracts.length < 2 || error.code !== 'ROAD_SOURCE_DATE_MISMATCH') throw error;
        // Geofabrik subregions can update at different times. Reuse the
        // original one-extract workflow rather than merging inconsistent OSM.
        let single;
        try { single = this.selectExtract(selectedIndex, [region], { marginKm }); }
        catch {
          throw new Error(`${error.message}; no single regional extract is available`);
        }
        extracts = [single];
        key = graphKey(single, region, bounds);
        onProgress?.({ phase: 'map-select', regionId: region.id, extractName: single.name,
          sourceCount: 1,
          message: `Regional sources have different snapshot dates; using ${single.name} instead…` });
        await this.#buildSources(extracts, region, bounds, key, { signal, onProgress });
      }
      await atomicJson(this.bindingFile(region), { schemaVersion: GRAPH_SCHEMA,
        regionKey: regionKey(region), graphKey: key });
    }
    return this.readHealth({ signal });
  }
}

module.exports = { BundledGraphManager, graphConfig, runNativeBuild, runNativeClip,
  runNativeMerge,
  regionKey, extractKey, graphKey };
