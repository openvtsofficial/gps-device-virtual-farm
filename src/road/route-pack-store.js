'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { coordinatesDigest, chooseRouteAnchors, distanceMeters, sha256 } = require('./route-validator');

const SCHEMA_VERSION = 2;
const ATTRIBUTION = '© OpenStreetMap contributors\n';
const MAX_PACK_BYTES = 128 * 1024 * 1024;
// Decoded routes currently use JavaScript point objects in both the main process
// and worker. Keep the combined active catalog well below the binary file limit.
const MAX_ACTIVE_ROUTE_POINTS = 2_000_000;
const MAX_ROUTES_PER_PACK = 2_500;
const ROAD_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'unclassified', 'residential', 'service_other']);
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const LEGACY_GEOMETRY_STORAGE = 'content-addressed-route-blobs-v1';
const GEOMETRY_STORAGE = 'content-addressed-route-blobs-v2';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validateRoadClassSummary(summary) {
  if (summary === undefined) return;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary) ||
      Object.keys(summary).some((key) => !['localShare', 'classMeters', 'classCounts'].includes(key)) ||
      !Number.isFinite(summary.localShare) || summary.localShare < 0 || summary.localShare > 1) {
    throw new Error('Invalid route road-class summary');
  }
  for (const [name, maximum, integer] of [['classMeters', 1_000_000, false],
    ['classCounts', 100_000, true]]) {
    const values = summary[name];
    if (!values || typeof values !== 'object' || Array.isArray(values) ||
        Object.keys(values).some((roadClass) => !ROAD_CLASSES.has(roadClass) ||
          !Number.isFinite(values[roadClass]) || values[roadClass] < 0 ||
          values[roadClass] > maximum || (integer && !Number.isInteger(values[roadClass])))) {
      throw new Error('Invalid route road-class summary');
    }
  }
}

function validateRoute(route, region) {
  const regionId = region.id;
  if (!route || typeof route.id !== 'string' || route.id.length > 128 ||
      !/^[a-zA-Z0-9_-]+$/.test(route.id) || route.regionId !== regionId ||
      typeof route.family !== 'string' || !/^[a-z-]{1,32}$/.test(route.family) ||
      !Array.isArray(route.points) || route.points.length < 2 || route.points.length > 100_000) {
    throw new Error('Invalid route-pack route metadata');
  }
  if ((route.provider !== undefined && (typeof route.provider !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(route.provider))) ||
      (route.profile !== undefined && (typeof route.profile !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(route.profile)))) {
    throw new Error('Invalid route provider or profile');
  }
  validateRoadClassSummary(route.roadClassSummary);
  const digest = coordinatesDigest(route.points);
  if (route.digest !== digest) throw new Error('Route geometry digest mismatch');
  let lengthMeters = 0;
  const cumulativeMeters = [0];
  for (let i = 0; i < route.points.length; i += 1) {
    const point = route.points[i];
    if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude) ||
        Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180) throw new Error('Invalid route-pack coordinate');
    if (distanceMeters(point, { latitude: region.centerLatitude, longitude: region.centerLongitude }) >
        (region.radiusKm + 10) * 1000) throw new Error('Route geometry outside its declared region');
    if (i > 0) {
      const step = distanceMeters(route.points[i - 1], point);
      if (!Number.isFinite(step) || step <= 0 || step > 2000) throw new Error('Invalid route-pack segment');
      lengthMeters += step;
      cumulativeMeters.push(lengthMeters);
    }
  }
  if (lengthMeters < 100 || lengthMeters > 1_000_000 || !Number.isFinite(route.lengthMeters) ||
      Math.abs(route.lengthMeters - lengthMeters) > 1 ||
      !Array.isArray(route.cumulativeMeters) || route.cumulativeMeters.length !== cumulativeMeters.length ||
      cumulativeMeters.some((value, i) => Math.abs(value - route.cumulativeMeters[i]) > 1)) {
    throw new Error('Invalid route-pack distance index');
  }
  if (route.closedLoop && distanceMeters(route.points[0], route.points.at(-1)) > 2) {
    throw new Error('Invalid route-pack closed tour');
  }
  const parkedAnchors = route.parkedAnchors || chooseRouteAnchors(route.points, route.closedLoop,
    route.family, route.legEndIndices);
  if (!Array.isArray(parkedAnchors) || parkedAnchors.some((index) => !Number.isInteger(index) || index < 0 || index >= route.points.length)) {
    throw new Error('Invalid route-pack parked anchor');
  }
  return { ...route, cumulativeMeters, lengthMeters, parkedAnchors };
}

function encodeRoutes(routes, region) {
  const regionId = region.id;
  if (routes.length > MAX_ROUTES_PER_PACK) throw new Error('Route pack exceeds route count limit');
  const proposedPointCount = routes.reduce((sum, route) => sum + (Array.isArray(route?.points) ? route.points.length : 0), 0);
  if (proposedPointCount > MAX_ACTIVE_ROUTE_POINTS ||
      proposedPointCount * 16 > MAX_PACK_BYTES) throw new Error('Route pack exceeds active geometry point limit');
  const validated = routes.map((route) => {
    const initial = validateRoute(route, region);
    // Valhalla polyline6 and previously loaded packs already contain exact
    // microdegree coordinates. Avoid copying and validating their geometry a
    // second time on every append; still revalidate if quantization changes it.
    if (initial.points.every((point) =>
      point.latitude === Math.round(point.latitude * 1e6) / 1e6 &&
      point.longitude === Math.round(point.longitude * 1e6) / 1e6)) return initial;
    const points = route.points.map((point) => ({
      latitude: Math.round(point.latitude * 1e6) / 1e6,
      longitude: Math.round(point.longitude * 1e6) / 1e6
    }));
    const cumulativeMeters = [0];
    for (let i = 1; i < points.length; i += 1) {
      cumulativeMeters.push(cumulativeMeters.at(-1) + distanceMeters(points[i - 1], points[i]));
    }
    return validateRoute({ ...route, points, cumulativeMeters,
      lengthMeters: cumulativeMeters.at(-1), digest: coordinatesDigest(points) }, region);
  });
  if (new Set(validated.map((route) => route.id)).size !== validated.length ||
      new Set(validated.map((route) => route.digest)).size !== validated.length) {
    throw new Error('Route pack contains duplicate route identity or geometry');
  }
  const count = validated.reduce((sum, route) => sum + route.points.length, 0);
  if (count > MAX_ACTIVE_ROUTE_POINTS ||
      count * 16 > MAX_PACK_BYTES) throw new Error('Route pack exceeds active geometry point limit');
  const blobs = [];
  const metadata = [];
  for (const route of validated) {
    const bytes = Buffer.allocUnsafe(route.points.length * 16);
    for (let i = 0; i < route.points.length; i += 1) {
      const point = route.points[i];
      bytes.writeInt32LE(Math.round(point.latitude * 1e6), i * 16);
      bytes.writeInt32LE(Math.round(point.longitude * 1e6), i * 16 + 4);
      bytes.writeDoubleLE(route.cumulativeMeters[i], i * 16 + 8);
    }
    const blobChecksum = sha256(bytes);
    blobs.push({ digest: route.digest, checksum: blobChecksum, bytes });
    metadata.push({ id: route.id, regionId, family: route.family, closedLoop: Boolean(route.closedLoop),
      digest: route.digest, blobChecksum, pointCount: route.points.length, lengthMeters: route.lengthMeters,
      legEndIndices: route.legEndIndices || [], parkedAnchors: route.parkedAnchors,
      sourceRequestDigest: route.sourceRequestDigest || null, fetchedAtUtc: route.fetchedAtUtc || null,
      ...(route.provider === undefined ? {} : { provider: route.provider }),
      ...(route.profile === undefined ? {} : { profile: route.profile }),
      ...(route.roadClassSummary === undefined ? {} : { roadClassSummary: route.roadClassSummary }) });
  }
  return { blobs, metadata, pointCount: count };
}

function manifestPointCount(manifest) {
  if (!Array.isArray(manifest.routes) || manifest.routes.length === 0 ||
      manifest.routes.length > MAX_ROUTES_PER_PACK) {
    throw new Error('Route manifest has an invalid route count');
  }
  let pointCount = 0;
  for (const item of manifest.routes) {
    if (!item || !HEX_64.test(item.digest) || !HEX_64.test(item.blobChecksum) ||
        !Number.isInteger(item.pointCount) || item.pointCount < 2 || item.pointCount > 100_000) {
      throw new Error('Route blob reference invalid');
    }
    pointCount += item.pointCount;
    if (pointCount > MAX_ACTIVE_ROUTE_POINTS || pointCount * 16 > MAX_PACK_BYTES) {
      throw new Error('Route pack exceeds active geometry point limit');
    }
  }
  return pointCount;
}

async function writeDurable(file, bytes) {
  const handle = await fs.open(file, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

class RoutePackStore {
  constructor(rootDir) {
    if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) throw new Error('Route pack root must be absolute');
    this.rootDir = rootDir;
  }

  async #readIndex() {
    const file = path.join(this.rootDir, 'inventory-index.json');
    let raw;
    try { raw = await fs.readFile(file); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (raw.length > 100_000) throw new Error('Road inventory index too large');
    const index = JSON.parse(raw.toString('utf8'));
    if (index.schemaVersion !== 1 || !index.selected || typeof index.selected !== 'object' ||
        sha256(stableJson(index.selected)) !== index.checksum ||
        Object.entries(index.selected).some(([id, digest]) => !ID_PATTERN.test(id) || !HEX_64.test(digest))) {
      throw new Error('Road inventory index corrupt');
    }
    return index;
  }

  async #selectPack(regionId, digest) {
    const current = await this.#readIndex();
    const selected = { ...(current?.selected || {}), [regionId]: digest };
    const payload = JSON.stringify({ schemaVersion: 1, selected, checksum: sha256(stableJson(selected)) });
    await fs.mkdir(this.rootDir, { recursive: true });
    const temporary = path.join(this.rootDir, `.inventory-${randomUUID()}.tmp`);
    try {
      await writeDurable(temporary, payload);
      await fs.rename(temporary, path.join(this.rootDir, 'inventory-index.json'));
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async #writeBlob(blob) {
    // Distance indexes are float64 values computed from geometry. Different
    // JavaScript runtimes can differ in the low bits of trigonometric results,
    // even when the microdegree coordinates (and their digest) are identical.
    // Address new blobs by the checksum of their full bytes so an appended pack
    // cannot collide with a valid blob written by another runtime.
    const directory = path.join(this.rootDir, 'blobs-v2', blob.checksum.slice(0, 2));
    const file = path.join(directory, `${blob.checksum}.bin`);
    await fs.mkdir(directory, { recursive: true });
    let corruptExisting = false;
    try {
      const existing = await fs.readFile(file);
      if (sha256(existing) === blob.checksum) return;
      corruptExisting = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const temporary = path.join(directory, `.tmp-${randomUUID()}`);
    try {
      await writeDurable(temporary, blob.bytes);
      try {
        await fs.rename(temporary, file);
      } catch (error) {
        if (!corruptExisting || !['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        const existing = await fs.readFile(file);
        if (sha256(existing) === blob.checksum) return;
        // The named file is already unusable. Replace it with verified bytes.
        await fs.rm(file);
        await fs.rename(temporary, file);
      }
    } catch (error) {
      if (await fs.stat(file).then(() => true, () => false)) {
        const existing = await fs.readFile(file);
        if (sha256(existing) === blob.checksum) return;
      }
      throw error;
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async writePack({ region, routes, provider = { id: 'fossgis-valhalla-public', costing: 'auto' }, sourceRequests = 0 }) {
    if (!region || !ID_PATTERN.test(region.id) || !Number.isFinite(region.centerLatitude) ||
        !Number.isFinite(region.centerLongitude) || !Number.isFinite(region.radiusKm) ||
        region.radiusKm < 2 || region.radiusKm > 500 || !Array.isArray(routes) || routes.length === 0) {
      throw new Error('A route pack needs a valid region and accepted routes');
    }
    if (!provider || typeof provider.id !== 'string' || provider.id.length > 80 ||
        !Number.isInteger(sourceRequests) || sourceRequests < 0) throw new Error('Invalid route pack source metadata');
    const { blobs, metadata } = encodeRoutes(routes, region);
    const checksums = { 'ATTRIBUTION.txt': sha256(ATTRIBUTION) };
    const body = { schemaVersion: SCHEMA_VERSION, generatedAtUtc: new Date().toISOString(), region, provider, routes: metadata,
      geometryStorage: GEOMETRY_STORAGE,
      sourceRequests, coordinateFormat: 'signed-int32-microdegrees', distanceFormat: 'float64-metres',
      attribution: '© OpenStreetMap contributors', checksums };
    const digest = sha256(stableJson(body));
    const manifest = { ...body, routePackDigest: digest };
    const regionRoot = path.join(this.rootDir, 'regions', region.id);
    const finalDir = path.join(regionRoot, digest);
    await fs.mkdir(regionRoot, { recursive: true });
    try {
      await this.loadPack(digest, region.id);
      await this.#selectPack(region.id, digest);
      return digest;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const exists = await fs.stat(finalDir).then(() => true, () => false);
        if (exists) throw error;
      }
    }
    for (const blob of blobs) await this.#writeBlob(blob);
    const temporary = path.join(regionRoot, `.tmp-${randomUUID()}`);
    await fs.mkdir(temporary);
    try {
      await writeDurable(path.join(temporary, 'ATTRIBUTION.txt'), ATTRIBUTION);
      await writeDurable(path.join(temporary, 'manifest.json'), JSON.stringify(manifest));
      await fs.rename(temporary, finalDir);
    } catch (error) {
      await fs.rm(temporary, { recursive: true, force: true });
      if (await fs.stat(finalDir).then(() => true, () => false)) {
        await this.loadPack(digest, region.id);
        await this.#selectPack(region.id, digest);
        return digest;
      }
      throw error;
    }
    await this.#selectPack(region.id, digest);
    return digest;
  }

  async loadPack(digest, regionId, { pointBudget = MAX_ACTIVE_ROUTE_POINTS } = {}) {
    if (!HEX_64.test(digest)) throw new Error('Invalid route pack digest');
    if (!Number.isInteger(pointBudget) || pointBudget < 0 || pointBudget > MAX_ACTIVE_ROUTE_POINTS) {
      throw new Error('Invalid active geometry point budget');
    }
    const regionIds = regionId ? [regionId] : (await fs.readdir(path.join(this.rootDir, 'regions'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name)).map((entry) => entry.name);
    for (const id of regionIds) {
      if (!ID_PATTERN.test(id)) throw new Error('Invalid road region ID');
      const directory = path.join(this.rootDir, 'regions', id, digest);
      let raw;
      try { raw = await fs.readFile(path.join(directory, 'manifest.json')); } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (raw.length > 2_000_000) throw new Error('Route manifest too large');
      const manifest = JSON.parse(raw.toString('utf8'));
      if (manifest.schemaVersion !== SCHEMA_VERSION || manifest.routePackDigest !== digest || manifest.region?.id !== id ||
          ![LEGACY_GEOMETRY_STORAGE, GEOMETRY_STORAGE].includes(manifest.geometryStorage) ||
          !Number.isFinite(manifest.region.centerLatitude) || !Number.isFinite(manifest.region.centerLongitude) ||
          !Number.isFinite(manifest.region.radiusKm) || !Array.isArray(manifest.routes) ||
          manifest.routes.length > MAX_ROUTES_PER_PACK) {
        throw new Error('Route manifest schema or identity mismatch');
      }
      const { routePackDigest, ...body } = manifest;
      if (sha256(stableJson(body)) !== digest) throw new Error('Route manifest digest mismatch');
      const pointCount = manifestPointCount(manifest);
      if (pointCount > pointBudget) throw new Error('Selected route packs exceed active geometry point limit');
      if (new Set(manifest.routes.map((route) => route.id)).size !== manifest.routes.length ||
          new Set(manifest.routes.map((route) => route.digest)).size !== manifest.routes.length) {
        throw new Error('Route manifest contains duplicate routes');
      }
      const attribution = await fs.readFile(path.join(directory, 'ATTRIBUTION.txt'));
      if (sha256(attribution) !== manifest.checksums['ATTRIBUTION.txt']) {
        throw new Error('Route pack file checksum mismatch');
      }
      const routes = [];
      let bytesLoaded = 0;
      for (const item of manifest.routes) {
        const blobFile = manifest.geometryStorage === LEGACY_GEOMETRY_STORAGE
          ? path.join(this.rootDir, 'blobs', item.digest.slice(0, 2), `${item.digest}.bin`)
          : path.join(this.rootDir, 'blobs-v2', item.blobChecksum.slice(0, 2), `${item.blobChecksum}.bin`);
        const blob = await fs.readFile(blobFile);
        bytesLoaded += blob.length;
        if (bytesLoaded > MAX_PACK_BYTES || blob.length !== item.pointCount * 16 ||
            sha256(blob) !== item.blobChecksum) throw new Error('Route geometry blob checksum mismatch');
        const points = [];
        const cumulativeMeters = [];
        for (let i = 0; i < item.pointCount; i += 1) {
          points.push({ latitude: blob.readInt32LE(i * 16) / 1e6,
            longitude: blob.readInt32LE(i * 16 + 4) / 1e6 });
          cumulativeMeters.push(blob.readDoubleLE(i * 16 + 8));
        }
        routes.push(validateRoute({ ...item, points, cumulativeMeters }, manifest.region));
      }
      const parkedAnchors = routes.flatMap((route) => route.parkedAnchors.map((pointIndex) => ({
        routeId: route.id, pointIndex, ...route.points[pointIndex]
      })));
      return deepFreeze({ schemaVersion: SCHEMA_VERSION, digest, region: manifest.region,
        pointCount, routes, parkedAnchors, manifest });
    }
    const error = new Error(`Route pack ${digest} not found`);
    error.code = 'ENOENT';
    throw error;
  }

  async selectPack(digest, regionId) {
    const pack = await this.loadPack(digest, regionId);
    await this.#selectPack(pack.region.id, digest);
    return pack;
  }

  async listPacks(regionId, { includeHistorical = false, pointBudget = MAX_ACTIVE_ROUTE_POINTS } = {}) {
    if (!Number.isInteger(pointBudget) || pointBudget < 0 || pointBudget > MAX_ACTIVE_ROUTE_POINTS) {
      throw new Error('Invalid active geometry point budget');
    }
    const index = await this.#readIndex();
    if (index && !includeHistorical) {
      const entries = Object.entries(index.selected).filter(([id]) => !regionId || id === regionId);
      const packs = [];
      let remaining = pointBudget;
      for (const [id, digest] of entries) {
        try {
          const pack = await this.loadPack(digest, id, { pointBudget: remaining });
          packs.push(pack);
          remaining -= pack.pointCount;
        } catch (error) {
          throw new Error(`Corrupt selected road route pack ${id}/${digest}: ${error.message}`, { cause: error });
        }
      }
      return packs;
    }
    const regionRoot = path.join(this.rootDir, 'regions');
    let ids;
    try {
      ids = regionId ? [regionId] : (await fs.readdir(regionRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name)).map((entry) => entry.name);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const packs = [];
    let remaining = pointBudget;
    for (const id of ids) {
      if (!ID_PATTERN.test(id)) throw new Error('Invalid road region ID');
      let entries;
      try { entries = await fs.readdir(path.join(regionRoot, id), { withFileTypes: true }); } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && HEX_64.test(entry.name)) {
          try {
            const pack = await this.loadPack(entry.name, id, { pointBudget: remaining });
            packs.push(pack);
            remaining -= pack.pointCount;
          } catch (error) {
            if (!includeHistorical) throw new Error(`Corrupt road route pack ${id}/${entry.name}: ${error.message}`, { cause: error });
          }
        }
      }
    }
    return packs;
  }

  async listPackSummaries(regionId, { includeHistorical = true } = {}) {
    const index = await this.#readIndex();
    if (regionId && !ID_PATTERN.test(regionId)) throw new Error('Invalid road region ID');
    const regionRoot = path.join(this.rootDir, 'regions');
    let ids;
    try {
      ids = regionId ? [regionId] : (await fs.readdir(regionRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name)).map((entry) => entry.name);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const summaries = [];
    for (const id of ids) {
      let entries;
      try { entries = await fs.readdir(path.join(regionRoot, id), { withFileTypes: true }); } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || !HEX_64.test(entry.name) ||
            (!includeHistorical && index?.selected[id] !== entry.name)) continue;
        const selected = index?.selected[id] === entry.name;
        try {
          const raw = await fs.readFile(path.join(regionRoot, id, entry.name, 'manifest.json'));
          if (raw.length > 2_000_000) throw new Error('manifest too large');
          const manifest = JSON.parse(raw.toString('utf8'));
          const { routePackDigest, ...body } = manifest;
          if (routePackDigest !== entry.name || sha256(stableJson(body)) !== entry.name ||
              manifest.schemaVersion !== SCHEMA_VERSION || manifest.region?.id !== id ||
              ![LEGACY_GEOMETRY_STORAGE, GEOMETRY_STORAGE].includes(manifest.geometryStorage)) {
            throw new Error('manifest digest or schema mismatch');
          }
          manifestPointCount(manifest);
          if (new Set(manifest.routes.map((route) => route.id)).size !== manifest.routes.length ||
              new Set(manifest.routes.map((route) => route.digest)).size !== manifest.routes.length) {
            throw new Error('manifest contains duplicate routes');
          }
          summaries.push({ digest: entry.name, regionId: id, routeCount: manifest.routes.length,
            generatedAtUtc: manifest.generatedAtUtc, sourceRequests: manifest.sourceRequests,
            selected, integrity: 'manifest-verified' });
        } catch (error) {
          summaries.push({ digest: entry.name, regionId: id, selected, integrity: 'corrupt', reason: error.message });
        }
      }
    }
    return summaries.sort((a, b) => a.regionId.localeCompare(b.regionId) ||
      String(b.generatedAtUtc || '').localeCompare(String(a.generatedAtUtc || '')));
  }
}

module.exports = { RoutePackStore, SCHEMA_VERSION, MAX_ACTIVE_ROUTE_POINTS, MAX_ROUTES_PER_PACK };
