'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { abortError } = require('./provider-budget');

const INDEX_URL = 'https://download.geofabrik.de/index-v1.json';
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_EXTRACT_BYTES = 8 * 1024 ** 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function allowedGeofabrikUrl(value, kind = 'pbf') {
  let url;
  // URL normalisation can erase encoded `..` components before pathname checks.
  if (typeof value !== 'string' || value.includes('%')) {
    throw new Error('Geofabrik downloads must use an official HTTPS PBF URL');
  }
  try { url = new URL(value); } catch { throw new Error('Invalid Geofabrik download URL'); }
  const suffix = kind === 'index' ? '/index-v1.json' : kind === 'md5' ? '.osm.pbf.md5' : '.osm.pbf';
  if (url.protocol !== 'https:' || url.hostname !== 'download.geofabrik.de' ||
      (url.port && url.port !== '443') || url.username || url.password ||
      url.search || url.hash || !url.pathname.endsWith(suffix) ||
      !(kind === 'index' ? url.pathname === '/index-v1.json' :
        /^\/[a-z0-9/_-]+(?:\.osm\.pbf(?:\.md5)?)$/i.test(url.pathname)) ||
      url.pathname.split('/').slice(1).some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Geofabrik downloads must use an official HTTPS PBF URL');
  }
  return url.href;
}

async function fetchGeofabrik(url, { fetchImpl = globalThis.fetch, signal, kind = 'pbf' } = {}) {
  let current = allowedGeofabrikUrl(url, kind);
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    if (signal?.aborted) throw abortError();
    const response = await fetchImpl(current, { redirect: 'manual', cache: 'no-store', signal,
      headers: { Accept: kind === 'pbf' ? 'application/octet-stream' : 'text/plain' } });
    if (!REDIRECT_STATUSES.has(response.status)) {
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const error = new Error(`Geofabrik returned HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return { response, resolvedUrl: current };
    }
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (!location) throw new Error('Geofabrik redirect has no target');
    current = allowedGeofabrikUrl(new URL(location, current).href, kind);
  }
  throw new Error('Too many Geofabrik redirects');
}

async function readBounded(response, limitBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limitBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Geofabrik response exceeds size limit');
  }
  if (!response.body?.getReader) throw new Error('Geofabrik response is not streamable');
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limitBytes) throw new Error('Geofabrik response exceeds size limit');
      chunks.push(value);
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function loadGeofabrikIndex({ fetchImpl = globalThis.fetch, signal } = {}) {
  const { response } = await fetchGeofabrik(INDEX_URL, { fetchImpl, signal, kind: 'index' });
  let index;
  try { index = JSON.parse((await readBounded(response, MAX_INDEX_BYTES)).toString('utf8')); }
  catch (error) { throw new Error(`Invalid Geofabrik region index: ${error.message}`); }
  if (index?.type !== 'FeatureCollection' || !Array.isArray(index.features) ||
      index.features.length > 10_000) throw new Error('Invalid Geofabrik region index');
  return index;
}

function regionBounds(region, marginKm) {
  const lat = region?.centerLatitude;
  const lon = region?.centerLongitude;
  const radius = region?.radiusKm;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(radius) ||
      !Number.isFinite(marginKm) || radius < 0 || radius > 500 || marginKm < 0 || marginKm > 100 ||
      Math.abs(lat) > 85 || Math.abs(lon) > 180) {
    throw new Error('Invalid road region for Geofabrik selection');
  }
  const halfLat = (radius + marginKm) / 111.32;
  const polewardLat = Math.abs(lat) + halfLat;
  const halfLon = (radius + marginKm) / (111.32 * Math.cos(polewardLat * Math.PI / 180));
  if (polewardLat >= 89 || Math.abs(lon) + halfLon >= 180) {
    throw new Error('Road region crosses an unsupported pole or dateline boundary');
  }
  return [lon - halfLon, lat - halfLat, lon + halfLon, lat + halfLat];
}

function pointOnSegment(point, a, b) {
  const cross = (point[0] - a[0]) * (b[1] - a[1]) - (point[1] - a[1]) * (b[0] - a[0]);
  if (Math.abs(cross) > 1e-10) return false;
  return point[0] >= Math.min(a[0], b[0]) - 1e-10 && point[0] <= Math.max(a[0], b[0]) + 1e-10 &&
    point[1] >= Math.min(a[1], b[1]) - 1e-10 && point[1] <= Math.max(a[1], b[1]) + 1e-10;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let previous = ring.length - 1, current = 0; current < ring.length; previous = current++) {
    const a = ring[previous];
    const b = ring[current];
    if (!Array.isArray(a) || !Array.isArray(b) || !Number.isFinite(a[0]) || !Number.isFinite(a[1]) ||
        !Number.isFinite(b[0]) || !Number.isFinite(b[1])) return false;
    if (pointOnSegment(point, a, b)) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
        point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function orientation(a, b, c) {
  const value = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return Math.abs(value) < 1e-10 ? 0 : Math.sign(value);
}

function segmentsIntersect(a, b, c, d) {
  const one = orientation(a, b, c);
  const two = orientation(a, b, d);
  const three = orientation(c, d, a);
  const four = orientation(c, d, b);
  return (one !== two && three !== four) || (one === 0 && pointOnSegment(c, a, b)) ||
    (two === 0 && pointOnSegment(d, a, b)) || (three === 0 && pointOnSegment(a, c, d)) ||
    (four === 0 && pointOnSegment(b, c, d));
}

function ringIntersectsBounds(ring, bounds) {
  const [west, south, east, north] = bounds;
  const corners = [[west, south], [east, south], [east, north], [west, north]];
  for (let previous = ring.length - 1, current = 0; current < ring.length; previous = current++) {
    const a = ring[previous];
    const b = ring[current];
    if (!Array.isArray(a) || !Array.isArray(b)) return true;
    if (Math.max(a[0], b[0]) < west || Math.min(a[0], b[0]) > east ||
        Math.max(a[1], b[1]) < south || Math.min(a[1], b[1]) > north) continue;
    for (let edge = 0; edge < 4; edge += 1) {
      if (segmentsIntersect(a, b, corners[edge], corners[(edge + 1) % 4])) return true;
    }
  }
  return false;
}

function polygonContainsBounds(polygon, bounds) {
  if (!Array.isArray(polygon) || !Array.isArray(polygon[0]) || polygon[0].length < 4) return false;
  const [west, south, east, north] = bounds;
  const corners = [[west, south], [east, south], [east, north], [west, north]];
  if (!corners.every((point) => pointInRing(point, polygon[0])) ||
      ringIntersectsBounds(polygon[0], bounds)) return false;
  for (const hole of polygon.slice(1)) {
    if (!Array.isArray(hole) || !hole.length ||
        corners.some((point) => pointInRing(point, hole)) || ringIntersectsBounds(hole, bounds) ||
        hole.some((point) => point[0] > west && point[0] < east && point[1] > south && point[1] < north)) {
      return false;
    }
  }
  return true;
}

function geometryContainsBounds(geometry, bounds) {
  if (geometry?.type === 'Polygon') return polygonContainsBounds(geometry.coordinates, bounds);
  if (geometry?.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates.some((polygon) => polygonContainsBounds(polygon, bounds));
  }
  return false;
}

function ringArea(ring) {
  let doubleArea = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    doubleArea += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(doubleArea) / 2;
}

function geometryArea(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.reduce((sum, polygon) => {
    if (!Array.isArray(polygon) || !Array.isArray(polygon[0])) return sum;
    return sum + ringArea(polygon[0]) - polygon.slice(1).reduce((holes, ring) => holes + ringArea(ring), 0);
  }, 0);
}

function selectGeofabrikExtract(index, regions, { marginKm = 10 } = {}) {
  if (index?.type !== 'FeatureCollection' || !Array.isArray(index.features) ||
      !Array.isArray(regions) || !regions.length || regions.length > 8) {
    throw new Error('Invalid Geofabrik selection request');
  }
  const bounds = regions.map((region) => regionBounds(region, marginKm));
  const candidates = [];
  for (const feature of index.features) {
    const id = feature?.properties?.id;
    const pbf = feature?.properties?.urls?.pbf;
    if (typeof id !== 'string' || !/^[a-z0-9/_-]{1,100}$/i.test(id) ||
        typeof pbf !== 'string' || !feature.geometry) continue;
    let url;
    try { url = allowedGeofabrikUrl(pbf); } catch { continue; }
    let area;
    try {
      if (!bounds.every((box) => geometryContainsBounds(feature.geometry, box))) continue;
      area = geometryArea(feature.geometry);
    } catch { continue; }
    if (!Number.isFinite(area) || area <= 0) continue;
    candidates.push({ id, name: String(feature.properties.name || id).slice(0, 120),
      url, parent: feature.properties.parent || null, area });
  }
  candidates.sort((a, b) => a.area - b.area || a.id.localeCompare(b.id));
  if (!candidates.length) {
    const error = new Error('No Geofabrik extract fully covers the configured road region and routing margin');
    error.code = 'ROAD_EXTRACT_UNAVAILABLE';
    throw error;
  }
  const { area, ...selected } = candidates[0];
  return selected;
}

async function hashFile(file) {
  const hash = createHash('sha256');
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
  return hash.digest('hex');
}

async function cachedDownload(destination, url, maxBytes) {
  try {
    const metadata = JSON.parse(await fs.readFile(`${destination}.json`, 'utf8'));
    const stat = await fs.stat(destination);
    if (metadata.schemaVersion === 1 && metadata.sourceUrl === url &&
        Number.isInteger(metadata.bytes) && metadata.bytes > 0 && metadata.bytes <= maxBytes &&
        stat.isFile() && stat.size === metadata.bytes && /^[a-f0-9]{64}$/.test(metadata.sha256) &&
        metadata.sha256 === await hashFile(destination)) return { ...metadata, path: destination, cached: true };
  } catch (error) {
    if (!['ENOENT', 'SyntaxError'].includes(error.code) && !(error instanceof SyntaxError)) throw error;
  }
  return null;
}

function extractTooLargeError(sourceUrl, resolvedUrl, maxBytes, advertisedBytes, observedBytes) {
  const size = observedBytes ?? advertisedBytes;
  const verb = observedBytes === null ? 'advertises' : 'has delivered';
  const error = new Error(`Road extract ${sourceUrl} ${verb} ${size.toLocaleString('en-US')} bytes, ` +
    `exceeding the download byte limit of ${maxBytes.toLocaleString('en-US')} bytes`);
  error.code = 'ROAD_EXTRACT_TOO_LARGE';
  error.extractUrl = sourceUrl;
  error.resolvedUrl = resolvedUrl;
  error.advertisedBytes = advertisedBytes;
  error.observedBytes = observedBytes;
  error.maxBytes = maxBytes;
  return error;
}

async function downloadGeofabrikExtract(url, destination, { fetchImpl = globalThis.fetch, signal,
  onProgress, maxBytes = DEFAULT_MAX_EXTRACT_BYTES } = {}) {
  const sourceUrl = allowedGeofabrikUrl(url);
  if (typeof destination !== 'string' || !path.isAbsolute(destination) ||
      !destination.toLowerCase().endsWith('.osm.pbf') ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 32 * 1024 ** 3 ||
      (onProgress !== undefined && typeof onProgress !== 'function')) {
    throw new Error('Invalid Geofabrik download destination or byte limit');
  }
  if (signal?.aborted) throw abortError();
  const cached = await cachedDownload(destination, sourceUrl, maxBytes);
  if (cached) return cached;
  const timeout = AbortSignal.timeout(2 * 60 * 60 * 1000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const { response, resolvedUrl } = await fetchGeofabrik(sourceUrl,
    { fetchImpl, signal: combined, kind: 'pbf' });
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw extractTooLargeError(sourceUrl, resolvedUrl, maxBytes, declared, null);
  }
  if (!response.body?.getReader) throw new Error('Road extract response is not streamable');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.part`;
  const reader = response.body.getReader();
  let bytes = 0;
  let lastProgress = 0;
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  try {
    const handle = await fs.open(temporary, 'wx');
    try {
      while (true) {
        if (combined.aborted) throw abortError();
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          throw extractTooLargeError(sourceUrl, resolvedUrl, maxBytes,
            Number.isFinite(declared) && declared > 0 ? declared : null, bytes);
        }
        const chunk = Buffer.from(value);
        for (let written = 0; written < chunk.length;) {
          const result = await handle.write(chunk, written, chunk.length - written);
          if (!result.bytesWritten) throw new Error('Could not write road extract');
          written += result.bytesWritten;
        }
        sha256.update(chunk);
        md5.update(chunk);
        if (onProgress && Date.now() - lastProgress >= 250) {
          onProgress({ phase: 'download', bytes, totalBytes: Number.isFinite(declared) && declared > 0 ? declared : null });
          lastProgress = Date.now();
        }
      }
      await handle.sync();
    } finally { await handle.close(); }
    if (bytes < 1024 || (Number.isFinite(declared) && declared > 0 && bytes !== declared)) {
      throw new Error('Road extract download is incomplete');
    }
    // Resolve the dated URL before checking the adjacent checksum. The `-latest`
    // alias can advance during a long download; the dated object remains pinned.
    const checksumUrl = allowedGeofabrikUrl(`${resolvedUrl}.md5`, 'md5');
    const { response: checksumResponse } = await fetchGeofabrik(checksumUrl,
      { fetchImpl, signal: combined, kind: 'md5' });
    const checksumText = (await readBounded(checksumResponse, 1024)).toString('utf8').trim();
    const match = /^([a-f0-9]{32})(?:\s+\S+)?$/i.exec(checksumText);
    if (!match || match[1].toLowerCase() !== md5.digest('hex')) {
      throw new Error('Road extract checksum does not match Geofabrik');
    }
    const metadata = { schemaVersion: 1, sourceUrl, resolvedUrl,
      sha256: sha256.digest('hex'), md5: match[1].toLowerCase(), bytes,
      downloadedAtUtc: new Date().toISOString() };
    await fs.rename(temporary, destination);
    const metadataTemporary = `${destination}.json.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(metadataTemporary, JSON.stringify(metadata), { flag: 'wx' });
      await fs.rename(metadataTemporary, `${destination}.json`);
    } finally { await fs.rm(metadataTemporary, { force: true }); }
    onProgress?.({ phase: 'downloaded', bytes, totalBytes: bytes });
    return { ...metadata, path: destination, cached: false };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    await fs.rm(temporary, { force: true });
  }
}

module.exports = { INDEX_URL, MAX_INDEX_BYTES, DEFAULT_MAX_EXTRACT_BYTES,
  allowedGeofabrikUrl, regionBounds, geometryContainsBounds, selectGeofabrikExtract,
  loadGeofabrikIndex, downloadGeofabrikExtract };
