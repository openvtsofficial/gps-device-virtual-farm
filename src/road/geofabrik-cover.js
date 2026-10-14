'use strict';

const { allowedGeofabrikUrl, regionBounds, selectGeofabrikExtract } =
  require('./geofabrik-source');

const EPSILON = 1e-10;
const MAX_SWEEP_SEGMENTS = 2_000;
const MAX_SWEEP_CELLS = 100_000;

function ringArea(ring) {
  let twice = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    twice += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(twice) / 2;
}

function geometryArea(geometry) {
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] :
    geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.reduce((total, polygon) => total +
    ringArea(polygon[0] || []) - polygon.slice(1).reduce((holes, ring) =>
      holes + ringArea(ring), 0), 0);
}

function geometryRings(geometry) {
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] :
    geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.flat();
}

function pointOnSegment(point, a, b) {
  const cross = (point[0] - a[0]) * (b[1] - a[1]) -
    (point[1] - a[1]) * (b[0] - a[0]);
  return Math.abs(cross) <= EPSILON &&
    point[0] >= Math.min(a[0], b[0]) - EPSILON &&
    point[0] <= Math.max(a[0], b[0]) + EPSILON &&
    point[1] >= Math.min(a[1], b[1]) - EPSILON &&
    point[1] <= Math.max(a[1], b[1]) + EPSILON;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let previous = ring.length - 1, current = 0;
    current < ring.length; previous = current++) {
    const a = ring[previous];
    const b = ring[current];
    if (pointOnSegment(point, a, b)) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
        point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

function geometryContainsPoint(geometry, point) {
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] :
    geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.some((polygon) => pointInRing(point, polygon[0]) &&
    !polygon.slice(1).some((hole) => pointInRing(point, hole)));
}

function geometryIntersectsBounds(geometry, bounds) {
  const [west, south, east, north] = bounds;
  for (const ring of geometryRings(geometry)) {
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (Math.max(a[0], b[0]) >= west && Math.min(a[0], b[0]) <= east &&
          Math.max(a[1], b[1]) >= south && Math.min(a[1], b[1]) <= north) return true;
    }
  }
  return geometryContainsPoint(geometry, [(west + east) / 2, (south + north) / 2]);
}

function uniqueSorted(values) {
  return values.sort((a, b) => a - b).filter((value, index, sorted) =>
    index === 0 || value - sorted[index - 1] > EPSILON);
}

function crossingX(first, second) {
  const [a, b] = first;
  const [c, d] = second;
  const x1 = b[0] - a[0];
  const y1 = b[1] - a[1];
  const x2 = d[0] - c[0];
  const y2 = d[1] - c[1];
  const determinant = x1 * y2 - y1 * x2;
  if (Math.abs(determinant) <= EPSILON) return null;
  const dx = c[0] - a[0];
  const dy = c[1] - a[1];
  const t = (dx * y2 - dy * x2) / determinant;
  const u = (dx * y1 - dy * x1) / determinant;
  return t > EPSILON && t < 1 - EPSILON &&
    u > EPSILON && u < 1 - EPSILON ? a[0] + t * x1 : null;
}

function arrangementCells(candidates, bounds) {
  const [west, south, east, north] = bounds;
  const segments = [];
  const events = [west, east];
  for (const candidate of candidates) {
    for (const ring of geometryRings(candidate.geometry)) {
      for (let i = 0; i < ring.length; i += 1) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        if (Math.max(a[0], b[0]) < west || Math.min(a[0], b[0]) > east ||
            Math.max(a[1], b[1]) < south || Math.min(a[1], b[1]) > north) continue;
        segments.push([a, b]);
        if (a[0] > west && a[0] < east) events.push(a[0]);
        if (b[0] > west && b[0] < east) events.push(b[0]);
        if (Math.abs(a[1] - b[1]) > EPSILON) {
          for (const y of [south, north]) {
            const t = (y - a[1]) / (b[1] - a[1]);
            const x = a[0] + t * (b[0] - a[0]);
            if (t > 0 && t < 1 && x > west && x < east) events.push(x);
          }
        }
      }
    }
  }
  if (segments.length > MAX_SWEEP_SEGMENTS) return null;
  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      const first = segments[i];
      const second = segments[j];
      if (Math.max(first[0][0], first[1][0]) < Math.min(second[0][0], second[1][0]) ||
          Math.max(second[0][0], second[1][0]) < Math.min(first[0][0], first[1][0]) ||
          Math.max(first[0][1], first[1][1]) < Math.min(second[0][1], second[1][1]) ||
          Math.max(second[0][1], second[1][1]) < Math.min(first[0][1], first[1][1])) continue;
      const x = crossingX(first, second);
      if (x !== null && x > west && x < east) events.push(x);
    }
  }
  const xs = uniqueSorted(events);
  const cells = [];
  for (let i = 0; i < xs.length - 1; i += 1) {
    const x = (xs[i] + xs[i + 1]) / 2;
    const ys = [south, north];
    for (const [a, b] of segments) {
      if (x <= Math.min(a[0], b[0]) || x >= Math.max(a[0], b[0])) continue;
      const y = a[1] + (x - a[0]) * (b[1] - a[1]) / (b[0] - a[0]);
      if (y > south && y < north) ys.push(y);
    }
    const cuts = uniqueSorted(ys);
    for (let j = 0; j < cuts.length - 1; j += 1) {
      const y = (cuts[j] + cuts[j + 1]) / 2;
      const mask = candidates.reduce((bits, candidate, index) =>
        bits | (geometryContainsPoint(candidate.geometry, [x, y]) ? 1n << BigInt(index) : 0n), 0n);
      if (!mask) return null;
      cells.push(mask);
      if (cells.length > MAX_SWEEP_CELLS) return null;
    }
  }
  return [...new Set(cells)];
}

function chooseCover(candidates, cells, maxSources) {
  let best = null;
  const chosen = [];
  function search(start, cost) {
    const selected = chosen.reduce((mask, index) => mask | (1n << BigInt(index)), 0n);
    if (cells.every((cell) => (cell & selected) !== 0n)) {
      if (chosen.length < 2) return;
      const signature = chosen.map((index) => candidates[index].id).join('|');
      if (!best || cost < best.cost - EPSILON ||
          (Math.abs(cost - best.cost) <= EPSILON &&
            (chosen.length < best.indexes.length ||
              (chosen.length === best.indexes.length && signature < best.signature)))) {
        best = { indexes: [...chosen], cost, signature };
      }
      return;
    }
    if (chosen.length >= maxSources || (best && cost >= best.cost - EPSILON)) return;
    for (let i = start; i < candidates.length; i += 1) {
      chosen.push(i);
      search(i + 1, cost + candidates[i].area);
      chosen.pop();
    }
  }
  search(0, 0);
  return best?.indexes.map((index) => candidates[index]) || [];
}

/** Find a smaller exact union of prebuilt Geofabrik extracts for a road region. */
function selectGeofabrikCover(index, region, { marginKm = 10, maxSources = 4 } = {}) {
  if (index?.type !== 'FeatureCollection' || !Array.isArray(index.features) ||
      !Number.isInteger(maxSources) || maxSources < 2 || maxSources > 8) {
    throw new Error('Invalid Geofabrik cover request');
  }
  const bounds = regionBounds(region, marginKm);
  let singleArea = Infinity;
  try {
    const single = selectGeofabrikExtract(index, [region], { marginKm });
    const feature = index.features.find((item) => item?.properties?.id === single.id);
    singleArea = geometryArea(feature?.geometry);
  } catch (error) {
    if (error.code !== 'ROAD_EXTRACT_UNAVAILABLE') throw error;
  }
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
      area = geometryArea(feature.geometry);
      if (!Number.isFinite(area) || area <= 0 || area >= singleArea - EPSILON ||
          !geometryIntersectsBounds(feature.geometry, bounds)) continue;
    } catch { continue; }
    candidates.push({ id, name: String(feature.properties.name || id).slice(0, 120),
      url, parent: feature.properties.parent || null, geometry: feature.geometry, area });
  }
  // Exhaustive subset search stays small for neighbouring administrative extracts.
  // A larger search can consume too much startup time; the caller can use its
  // existing single-extract path in that case.
  if (candidates.length < 2 || candidates.length > 16) return [];
  candidates.sort((a, b) => a.area - b.area || a.id.localeCompare(b.id));
  const cells = arrangementCells(candidates, bounds);
  if (!cells) return [];
  return chooseCover(candidates, cells, maxSources)
    .map(({ geometry, area, ...record }) => record);
}

module.exports = { selectGeofabrikCover };
