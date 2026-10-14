'use strict';

const { distanceMeters } = require('./route-validator');

// Approximate 50 m geographic cells distinguish nearby neighborhood streets.
// They describe prepared geometry, not every road in the region.
const CELL_METERS = 50;
function cellKey(point) {
  const north = Math.floor(point.latitude * 111_320 / CELL_METERS);
  const east = Math.floor(point.longitude * 111_320 * Math.cos(point.latitude * Math.PI / 180) / CELL_METERS);
  return `${north}:${east}`;
}

const signatureCache = new WeakMap();

function signatures(route) {
  const cached = signatureCache.get(route);
  if (cached) return cached;
  const cells = new Set();
  const directedEdges = new Set();
  let previous = null;
  for (let i = 1; i < route.points.length; i += 1) {
    const from = route.points[i - 1];
    const to = route.points[i];
    const steps = Math.max(1, Math.ceil(distanceMeters(from, to) / 35));
    for (let n = i === 1 ? 0 : 1; n <= steps; n += 1) {
      const fraction = n / steps;
      const cell = cellKey({ latitude: from.latitude + (to.latitude - from.latitude) * fraction,
        longitude: from.longitude + (to.longitude - from.longitude) * fraction });
      cells.add(cell);
      if (previous && cell !== previous) directedEdges.add(`${previous}>${cell}`);
      previous = cell;
    }
  }
  const result = { cells, directedEdges };
  signatureCache.set(route, result);
  return result;
}

function footprint(route) {
  return signatures(route).cells;
}

function novelty(route, existingRoutes) {
  if (existingRoutes.some((existing) => existing.digest === route.digest)) {
    return { accepted: false, reason: 'exact-duplicate', overlapRatio: 1, newFootprintKm: 0 };
  }
  const { cells: candidateCells, directedEdges } = signatures(route);
  const existingCells = new Set();
  const existingEdges = new Set();
  for (const existing of existingRoutes) {
    if (existing.regionId !== route.regionId) continue;
    const signature = signatures(existing);
    for (const cell of signature.cells) existingCells.add(cell);
    for (const edge of signature.directedEdges) existingEdges.add(edge);
  }
  let shared = 0;
  for (const cell of candidateCells) if (existingCells.has(cell)) shared += 1;
  const overlapRatio = candidateCells.size ? shared / candidateCells.size : 1;
  let sameDirection = 0;
  for (const edge of directedEdges) if (existingEdges.has(edge)) sameDirection += 1;
  const directedOverlapRatio = directedEdges.size ? sameDirection / directedEdges.size : overlapRatio;
  const newFootprintKm = (candidateCells.size - shared) * CELL_METERS / 1000;
  const accepted = directedOverlapRatio < 0.9 ||
    newFootprintKm >= (['local', 'urban', 'depot'].includes(route.family) ? 0.5 : 2);
  return { accepted, reason: accepted ? null : 'overlapping-corridor',
    overlapRatio, directedOverlapRatio, newFootprintKm };
}

// Incremental counterpart for large local catalogs. The union is updated only
// after a route has passed the same novelty check used by one-off preparation.
function createNoveltyIndex(existingRoutes = []) {
  const digests = new Set();
  const byRegion = new Map();
  const regionIndex = (id) => {
    if (!byRegion.has(id)) byRegion.set(id, { cells: new Set(), directedEdges: new Set() });
    return byRegion.get(id);
  };
  const add = (route) => {
    digests.add(route.digest);
    const source = signatures(route);
    const destination = regionIndex(route.regionId);
    for (const cell of source.cells) destination.cells.add(cell);
    for (const edge of source.directedEdges) destination.directedEdges.add(edge);
  };
  for (const route of existingRoutes) add(route);
  const check = (route) => {
    if (digests.has(route.digest)) {
      return { accepted: false, reason: 'exact-duplicate', overlapRatio: 1, newFootprintKm: 0 };
    }
    const source = signatures(route);
    const existing = regionIndex(route.regionId);
    let shared = 0;
    for (const cell of source.cells) if (existing.cells.has(cell)) shared += 1;
    let sameDirection = 0;
    for (const edge of source.directedEdges) if (existing.directedEdges.has(edge)) sameDirection += 1;
    const overlapRatio = source.cells.size ? shared / source.cells.size : 1;
    const directedOverlapRatio = source.directedEdges.size ? sameDirection / source.directedEdges.size : overlapRatio;
    const newFootprintKm = (source.cells.size - shared) * CELL_METERS / 1000;
    const accepted = directedOverlapRatio < 0.9 ||
      newFootprintKm >= (['local', 'urban', 'depot'].includes(route.family) ? 0.5 : 2);
    return { accepted, reason: accepted ? null : 'overlapping-corridor',
      overlapRatio, directedOverlapRatio, newFootprintKm };
  };
  return { check, add };
}

function summarizeDiversity(routes) {
  const unique = [];
  const allCells = new Set();
  const allEdges = new Set();
  const digests = new Set();
  let sampledCells = 0;
  for (const route of routes) {
    if (digests.has(route.digest)) continue;
    const { cells, directedEdges } = signatures(route);
    let shared = 0;
    for (const edge of directedEdges) if (allEdges.has(edge)) shared += 1;
    let newCells = 0;
    for (const cell of cells) if (!allCells.has(cell)) newCells += 1;
    const directedOverlap = directedEdges.size ? shared / directedEdges.size : 1;
    const minimumCells = ['local', 'urban', 'depot'].includes(route.family) ? 10 : 40;
    if (unique.length && directedOverlap >= 0.9 && newCells < minimumCells) continue;
    digests.add(route.digest);
    unique.push(route);
    sampledCells += cells.size;
    for (const cell of cells) allCells.add(cell);
    for (const edge of directedEdges) allEdges.add(edge);
  }
  return { routes: unique, distinctRouteCount: unique.length,
    uniqueFootprintKm: allCells.size * CELL_METERS / 1000,
    overlapRatio: sampledCells ? 1 - allCells.size / sampledCells : 0,
    footprintCells: allCells };
}

module.exports = { CELL_METERS, cellKey, footprint, novelty, createNoveltyIndex, summarizeDiversity };
