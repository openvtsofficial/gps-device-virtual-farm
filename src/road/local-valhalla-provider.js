'use strict';

const { abortError } = require('./provider-budget');
const { decodePolyline6, distanceMeters } = require('./route-validator');

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8002';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TRACE_POINTS = 100_000;
// Valhalla's default trace limits are lower than the longest valid route. Keep
// each edge-walk request well below both its distance and shape-point limits.
const MAX_TRACE_CHUNK_POINTS = 8_000;
const MAX_TRACE_CHUNK_METERS = 80_000;
const ROAD_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'unclassified', 'residential', 'service_other']);
const LOCAL_CLASSES = new Set(['residential', 'unclassified', 'service_other']);
const UNIT_INTERVAL_OPTIONS = new Set(['use_highways', 'use_tolls', 'use_living_streets', 'use_tracks', 'use_distance']);
const BOOLEAN_OPTIONS = new Set(['shortest', 'disable_hierarchy_pruning']);
const COSTING_BY_FAMILY = Object.freeze({
  local: Object.freeze({ use_highways: 0, use_living_streets: 0.5, service_penalty: 0, use_distance: 0.5 }),
  urban: Object.freeze({ use_highways: 0.15, use_living_streets: 0.35, service_penalty: 0, use_distance: 0.35 }),
  depot: Object.freeze({ use_highways: 0, use_living_streets: 0.5, service_penalty: 0, use_distance: 0.5 }),
  suburban: Object.freeze({ use_highways: 0.45 }),
  regional: Object.freeze({ use_highways: 0.8 })
});

function normalizeEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 128) throw new Error('Invalid local Valhalla endpoint');
  let parsed;
  try { parsed = new URL(endpoint); } catch { throw new Error('Invalid local Valhalla endpoint'); }
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
      !parsed.port || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Local Valhalla endpoint must be loopback HTTP with an explicit port');
  }
  return parsed.origin;
}

function validateCandidate(candidate) {
  if (!candidate || !Array.isArray(candidate.locations) ||
      candidate.locations.length < 2 || candidate.locations.length > 8) {
    throw new Error('Invalid Valhalla candidate locations');
  }
  if (candidate.costing !== undefined && candidate.costing !== 'auto') {
    throw new Error('Local road routing requires automobile costing');
  }
  const locations = candidate.locations.map((point) => {
    const lat = point?.latitude ?? point?.lat;
    const lon = point?.longitude ?? point?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new Error('Invalid Valhalla candidate coordinate');
    }
    return { lat, lon };
  });
  const options = candidate.costingOptions ?? COSTING_BY_FAMILY[candidate.family] ?? {};
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).length > 12) {
    throw new Error('Invalid local road costing options');
  }
  const costingOptions = {};
  for (const [key, value] of Object.entries(options)) {
    if (UNIT_INTERVAL_OPTIONS.has(key) && Number.isFinite(value) && value >= 0 && value <= 1) {
      costingOptions[key] = value;
    } else if (BOOLEAN_OPTIONS.has(key) && typeof value === 'boolean') {
      costingOptions[key] = value;
    } else if (key === 'service_penalty' && Number.isFinite(value) && value >= 0 && value <= 43_200) {
      costingOptions[key] = value;
    } else {
      throw new Error(`Unsupported local road costing option: ${key}`);
    }
  }
  const body = { locations, costing: 'auto', units: 'kilometers' };
  if (Object.keys(costingOptions).length) body.costing_options = { auto: costingOptions };
  if (candidate.alternates !== undefined) {
    if (locations.length !== 2 || !Number.isInteger(candidate.alternates) ||
        candidate.alternates < 0 || candidate.alternates > 2) {
      throw new Error('Invalid Valhalla alternate route request');
    }
    body.alternates = candidate.alternates;
  }
  return body;
}

function encodeNumber(number) {
  let value = number < 0 ? -number * 2 - 1 : number * 2;
  let result = '';
  while (value >= 32) {
    result += String.fromCharCode((32 | (value % 32)) + 63);
    value = Math.floor(value / 32);
  }
  return result + String.fromCharCode(value + 63);
}

function encodePolyline6(points) {
  let latitude = 0;
  let longitude = 0;
  let result = '';
  for (const point of points) {
    const lat = Math.round(point.latitude * 1e6);
    const lon = Math.round(point.longitude * 1e6);
    result += encodeNumber(lat - latitude) + encodeNumber(lon - longitude);
    latitude = lat;
    longitude = lon;
  }
  return result;
}

function splitLegShapes(response) {
  const legs = response?.trip?.legs || response?.legs;
  if (!Array.isArray(legs) || legs.length === 0 || legs.length > 8) {
    throw Object.assign(new Error('Route response has no traceable Valhalla legs'), { code: 'ROAD_ATTRIBUTES_UNAVAILABLE' });
  }
  const chunks = [];
  let totalPoints = 0;
  let previousEnd = null;
  for (const [legIndex, leg] of legs.entries()) {
    const decoded = decodePolyline6(leg?.shape, MAX_TRACE_POINTS);
    const points = [];
    for (const point of decoded) {
      if (points.length && points.at(-1).latitude === point.latitude &&
          points.at(-1).longitude === point.longitude) continue;
      points.push(point);
    }
    if (points.length < 2) {
      throw Object.assign(new Error('Route leg has too few points for road-class tracing'), { code: 'ROAD_ATTRIBUTES_UNAVAILABLE' });
    }
    if (previousEnd && distanceMeters(previousEnd, points[0]) > 2) {
      throw Object.assign(new Error('Route legs are disconnected for road-class tracing'), { code: 'ROAD_ATTRIBUTES_UNAVAILABLE' });
    }
    totalPoints += points.length - (previousEnd && previousEnd.latitude === points[0].latitude &&
      previousEnd.longitude === points[0].longitude ? 1 : 0);
    if (totalPoints > MAX_TRACE_POINTS) {
      throw Object.assign(new Error('Route has too many points for road-class tracing'), { code: 'ROAD_ATTRIBUTES_UNAVAILABLE' });
    }
    previousEnd = points.at(-1);
    let start = 0;
    while (start < points.length - 1) {
      let end = start + 1;
      let meters = distanceMeters(points[start], points[end]);
      if (!Number.isFinite(meters) || meters > MAX_TRACE_CHUNK_METERS) {
        throw Object.assign(new Error('Route segment is too long for road-class tracing'), { code: 'ROAD_ATTRIBUTES_UNAVAILABLE' });
      }
      while (end + 1 < points.length && end - start + 2 <= MAX_TRACE_CHUNK_POINTS) {
        const step = distanceMeters(points[end], points[end + 1]);
        if (!Number.isFinite(step)) {
          throw Object.assign(new Error('Route segment distance is invalid'), { code: 'ROAD_ATTRIBUTES_UNAVAILABLE' });
        }
        if (meters + step > MAX_TRACE_CHUNK_METERS) break;
        meters += step;
        end += 1;
      }
      chunks.push({ legIndex, encodedPolyline: encodePolyline6(points.slice(start, end + 1)), geometryMeters: meters });
      start = end; // Shared endpoint joins chunks without repeating a road segment.
    }
  }
  return chunks;
}

function checkDepth(value, depth = 0) {
  if (depth > 32) throw new Error('Valhalla JSON nesting exceeds limit');
  if (Array.isArray(value)) {
    if (value.length > 100_000) throw new Error('Valhalla JSON array exceeds limit');
    for (const item of value) checkDepth(item, depth + 1);
  } else if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length > 1000) throw new Error('Valhalla JSON object exceeds limit');
    for (const key of keys) checkDepth(value[key], depth + 1);
  }
}

function summarizeRoadClasses(response) {
  if (!response || !Array.isArray(response.edges) || response.edges.length === 0) {
    throw Object.assign(new Error('Valhalla did not return road-class attributes'), { code: 'ROAD_ATTRIBUTES_UNAVAILABLE' });
  }
  const classMeters = Object.create(null);
  const classCounts = Object.create(null);
  let totalMeters = 0;
  let localMeters = 0;
  for (const edge of response.edges) {
    const roadClass = edge?.road_class;
    const lengthKm = edge?.length;
    if (!ROAD_CLASSES.has(roadClass) ||
        !Number.isFinite(lengthKm) || lengthKm <= 0) {
      throw Object.assign(new Error('Valhalla road-class attributes are incomplete'), { code: 'ROAD_ATTRIBUTES_UNAVAILABLE' });
    }
    const meters = lengthKm * 1000;
    classMeters[roadClass] = (classMeters[roadClass] || 0) + meters;
    classCounts[roadClass] = (classCounts[roadClass] || 0) + 1;
    totalMeters += meters;
    if (LOCAL_CLASSES.has(roadClass)) localMeters += meters;
  }
  if (!Number.isFinite(totalMeters) || totalMeters <= 0) {
    throw Object.assign(new Error('Valhalla road-class lengths are invalid'), { code: 'ROAD_ATTRIBUTES_UNAVAILABLE' });
  }
  if (totalMeters > 1_000_000 || Object.values(classCounts).some((count) => count > 100_000)) {
    throw Object.assign(new Error('Valhalla road-class summary exceeds route limits'), { code: 'ROAD_ATTRIBUTES_UNAVAILABLE' });
  }
  return { localShare: localMeters / totalMeters, classMeters, classCounts };
}

class LocalValhallaProvider {
  constructor({ endpoint = DEFAULT_ENDPOINT, fetchImpl = globalThis.fetch, timeoutMs = 45_000 } = {}) {
    if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
      throw new Error('Invalid local Valhalla provider options');
    }
    this.endpointFamily = normalizeEndpoint(endpoint);
    this.id = 'valhalla-local';
    this.bulkAllowed = true;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async #fetchJson(path, { method = 'GET', body, signal, timeoutMs = this.timeoutMs } = {}) {
    if (signal?.aborted) throw abortError();
    const endpoint = `${this.endpointFamily}${path}`;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await this.fetchImpl(endpoint, {
      method, redirect: 'error', cache: 'no-store', signal: combined,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (response.url && response.url !== endpoint) throw new Error('Unexpected local Valhalla redirect');
    if (!response.ok) {
      const error = new Error(`Local Valhalla returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('Local Valhalla response exceeds byte limit');
    if (!response.body?.getReader) throw new Error('Local Valhalla response is not streamable');
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        if (combined.aborted) throw combined.reason || abortError();
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new Error('Local Valhalla response exceeds byte limit');
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    const parsed = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
    checkDepth(parsed);
    return parsed;
  }

  async fetchRoute(candidate, { signal } = {}) {
    return this.#fetchJson('/route', { method: 'POST', body: validateCandidate(candidate), signal });
  }

  async fetchRoadClasses(response, { signal } = {}) {
    let chunks;
    try { chunks = splitLegShapes(response); } catch (error) {
      if (error.code === 'ROAD_ATTRIBUTES_UNAVAILABLE') throw error;
      throw Object.assign(new Error(`Route geometry cannot be traced: ${error.message}`), { code: 'ROAD_ATTRIBUTES_UNAVAILABLE' });
    }
    try {
      const classMeters = Object.create(null);
      const classCounts = Object.create(null);
      const geometryByLeg = [];
      const tracedByLeg = [];
      for (const chunk of chunks) {
        const attributes = await this.#fetchJson('/trace_attributes', { method: 'POST', signal,
          body: { encoded_polyline: chunk.encodedPolyline, shape_match: 'edge_walk', costing: 'auto', units: 'kilometers',
            filters: { action: 'include', attributes: ['edge.road_class', 'edge.length'] } } });
        const summary = summarizeRoadClasses(attributes);
        const tracedMeters = Object.values(summary.classMeters).reduce((sum, meters) => sum + meters, 0);
        geometryByLeg[chunk.legIndex] = (geometryByLeg[chunk.legIndex] || 0) + chunk.geometryMeters;
        tracedByLeg[chunk.legIndex] = (tracedByLeg[chunk.legIndex] || 0) + tracedMeters;
        for (const [roadClass, meters] of Object.entries(summary.classMeters)) {
          classMeters[roadClass] = (classMeters[roadClass] || 0) + meters;
          classCounts[roadClass] = (classCounts[roadClass] || 0) + summary.classCounts[roadClass];
        }
      }
      for (let index = 0; index < geometryByLeg.length; index += 1) {
        const geometryMeters = geometryByLeg[index];
        const tracedMeters = tracedByLeg[index];
        if (!Number.isFinite(tracedMeters) || Math.abs(tracedMeters - geometryMeters) >
            Math.max(250, geometryMeters * 0.25)) {
          throw Object.assign(new Error('Valhalla road-class trace covers only part of a route leg'),
            { code: 'ROAD_ATTRIBUTES_UNAVAILABLE' });
        }
      }
      const totalMeters = Object.values(classMeters).reduce((sum, meters) => sum + meters, 0);
      if (!Number.isFinite(totalMeters) || totalMeters <= 0 || totalMeters > 1_000_000 ||
          Object.values(classCounts).some((count) => count > 100_000)) {
        throw Object.assign(new Error('Valhalla road-class summary exceeds route limits'), { code: 'ROAD_ATTRIBUTES_UNAVAILABLE' });
      }
      const localMeters = [...LOCAL_CLASSES].reduce((sum, roadClass) => sum + (classMeters[roadClass] || 0), 0);
      return { localShare: localMeters / totalMeters, classMeters, classCounts };
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError' || error.code === 'ROAD_ATTRIBUTES_UNAVAILABLE') throw error;
      throw Object.assign(new Error(`Road-class validation unavailable: ${error.message}`, { cause: error }),
        { code: 'ROAD_ATTRIBUTES_UNAVAILABLE', status: error.status });
    }
  }

  async health({ signal } = {}) {
    try {
      const status = await this.#fetchJson('/status', { signal, timeoutMs: Math.min(this.timeoutMs, 3_000) });
      const version = typeof status.version === 'string' && status.version.length <= 80 ? status.version : null;
      const tilesetLastModified = Number.isInteger(status.tileset_last_modified) && status.tileset_last_modified > 0
        ? status.tileset_last_modified : null;
      return { ready: Boolean(version && tilesetLastModified && status.has_tiles !== false),
        version, tilesetLastModified, endpointFamily: this.endpointFamily };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { ready: false, version: null, tilesetLastModified: null,
        endpointFamily: this.endpointFamily, reason: error.message };
    }
  }
}

module.exports = { LocalValhallaProvider, DEFAULT_ENDPOINT, normalizeEndpoint,
  splitLegShapes, encodePolyline6, summarizeRoadClasses };
