'use strict';

const { fnv1a, haversineKm } = require('./geo');
const { MinHeap } = require('./min-heap');
const { pointAtDistance } = require('./road-movement');

const DEFAULT_MIN_SPACING_METERS = 250;
const PARKED_MIN_SEPARATION_METERS = 50;
// Mean-radius spherical distance can overstate WGS84 ground distance by about
// 0.56% near the equator. A 50.5 m sphere guard guarantees at least 50 m on
// the ellipsoid even for the shortest north-south curvature radius.
const PARKED_SPHERICAL_GUARD_METERS = 50.5;
const PARKED_SLOT_SPACING_METERS = 3;
const PARKED_ANCHOR_RADIUS_METERS = 150;
const PARKED_DERIVED_ANCHOR_INTERVAL_METERS = 1000;
const EARTH_RADIUS_METERS = 6371008.8;
const PARKED_ROUTE_FAMILIES = new Set(['local', 'urban', 'depot', 'delivery']);
const ALLOW_PARTIAL_PARKED = Symbol('allow partial parked placement');
const PARKED_RETRY_DONE = Symbol('parked checkpoint retry complete');
// Persisted cursors can differ from a freshly decoded route length by a few
// floating-point units. One micrometre is far below GPS precision while still
// rejecting checkpoints that have actually left their verified route.
const RESTORED_CURSOR_TOLERANCE_METERS = 1e-6;

function allocateRoadFleet({
  pack,
  packs = pack ? [pack] : [],
  imeis,
  movingCount,
  seed = 'default',
  restoredAssignments,
  minSpacingMeters = DEFAULT_MIN_SPACING_METERS,
  requireContinuousMotion = false,
  [ALLOW_PARTIAL_PARKED]: allowPartialParked = false,
  [PARKED_RETRY_DONE]: parkedRetryDone = false
}) {
  if (!Array.isArray(packs) || packs.length === 0) throw new Error('At least one verified road pack is required');
  if (!Array.isArray(imeis) || imeis.some((imei) => typeof imei !== 'string' || !imei)) {
    throw new Error('IMEIs must be a nonempty string array');
  }
  if (new Set(imeis).size !== imeis.length) throw new Error('Duplicate IMEI in road fleet');
  if (!Number.isInteger(movingCount) || movingCount < 0 || movingCount > imeis.length) {
    throw new Error('Invalid moving device count');
  }
  if (!Number.isFinite(minSpacingMeters) || minSpacingMeters <= 0) {
    throw new Error('Invalid minimum route spacing');
  }
  if (typeof requireContinuousMotion !== 'boolean') {
    throw new Error('Invalid continuous-motion requirement');
  }

  const regions = new Map();
  const routes = new Map();
  for (const selectedPack of packs) {
    if (!selectedPack || typeof selectedPack.digest !== 'string' || !selectedPack.digest ||
        !Array.isArray(selectedPack.routes)) throw new Error('Invalid verified road pack');
    const declaredRegionId = selectedPack.region && selectedPack.region.id;
    const regionWeight = selectedPack.region &&
      (selectedPack.region.fleetWeight ?? selectedPack.region.weight);
    const weight = regionWeight === undefined ? 1 : Number(regionWeight);
    if (!Number.isFinite(weight) || weight <= 0) throw new Error('Invalid region fleet weight');

    for (const route of selectedPack.routes) {
      if (!route || typeof route.id !== 'string' || !route.id ||
          typeof route.digest !== 'string' || !route.digest ||
          !Array.isArray(route.points) || route.points.length < 2 ||
          !Number.isFinite(route.lengthMeters) || route.lengthMeters <= 0) {
        throw new Error('Invalid route in verified road pack');
      }
      const regionId = route.regionId || declaredRegionId;
      if (typeof regionId !== 'string' || !regionId) throw new Error('Road route has no region ID');
      const region = getOrCreateRegion(regions, regionId, weight);
      const key = routeKey(selectedPack.digest, route.id);
      if (routes.has(key)) throw new Error(`Duplicate route ${route.id} in selected road packs`);
      const overlapRatio = Number.isFinite(route.overlapRatio)
        ? clamp(route.overlapRatio, 0, 1) : 0;
      const effectiveLength = route.lengthMeters * (1 - 0.8 * overlapRatio);
      const capacity = requireContinuousMotion && !route.closedLoop
        ? 0 : Math.min(50, Math.floor(effectiveLength / minSpacingMeters));
      const state = {
        key, pack: selectedPack, route, region, capacity, occupancy: 0,
        usedSlots: new Set(), nextSlotOrdinal: 0,
        slotStart: capacity ? fnv1a(`${seed}|${key}`) % capacity : 0,
        slotStride: coprimeStride(capacity),
        tie: fnv1a(`${seed}|route|${key}`)
      };
      region.routes.push(state);
      region.capacity += capacity;
      routes.set(key, state);
    }
  }

  for (const selectedPack of packs) {
    const anchors = Array.isArray(selectedPack.parkedAnchors)
      ? [...selectedPack.parkedAnchors] : anchorsFromRoutes(selectedPack.routes);
    const explicitAnchorKeys = new Set();
    for (const anchor of anchors) {
      const key = `${anchor.routeId}\u0000${anchor.pointIndex}`;
      if (explicitAnchorKeys.has(key)) throw new Error('Duplicate parked anchor');
      explicitAnchorKeys.add(key);
    }
    for (const route of selectedPack.routes) {
      for (const pointIndex of derivedParkedAnchorIndices(route)) {
        const key = `${route.id}\u0000${pointIndex}`;
        if (!explicitAnchorKeys.has(key)) {
          anchors.push({ routeId: route.id, pointIndex });
          explicitAnchorKeys.add(key);
        }
      }
    }
    for (const anchor of anchors) {
      const state = routes.get(routeKey(selectedPack.digest, anchor.routeId));
      if (!state) throw new Error('Parked anchor references an unknown route');
      const pointIndex = anchor.pointIndex;
      const point = state.route.points[pointIndex];
      const distances = state.route.cumulativeMeters;
      if (!Number.isInteger(pointIndex) || !point || !distances ||
          !Number.isFinite(distances[pointIndex])) {
        throw new Error('Parked anchor has an invalid route vertex');
      }
      const latitude = anchor.latitude ?? point.latitude;
      const longitude = anchor.longitude ?? point.longitude;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
          Math.abs(latitude - point.latitude) > 1e-6 ||
          Math.abs(longitude - point.longitude) > 1e-6) {
        throw new Error('Parked anchor is not on its verified route vertex');
      }
      const item = {
        state, pointIndex, latitude, longitude,
        cursorMeters: distances[pointIndex], occupancy: 0,
        nextCandidateOrdinal: 0,
        tie: fnv1a(`${seed}|anchor|${state.key}|${pointIndex}`)
      };
      const key = `${state.key}\u0000${pointIndex}`;
      if (state.region.anchorLookup.has(key)) throw new Error('Duplicate parked anchor');
      state.region.anchors.push(item);
      state.region.anchorLookup.set(key, item);
    }
  }

  const restored = normalizeRestoredAssignments(restoredAssignments);
  const assignments = new Array(imeis.length);
  const parkedPositions = new ParkedPositionIndex();
  const collidingParked = [];
  let restoredParkedUsed = false;
  for (let index = 0; index < imeis.length; index += 1) {
    const imei = imeis[index];
    const saved = restored.get(imei);
    if (!saved) continue;
    const moving = index < movingCount;
    if (saved.moving !== moving) {
      throw new Error(`Moving/parked role changed for ${imei} after a device-count or profile change; restore the previous count or choose a new scenario seed for fresh road positions`);
    }
    const state = routes.get(routeKey(saved.routePackDigest, saved.routeId));
    const cursorMeters = state && normalizeRestoredCursor(saved.cursorMeters,
      state.route.lengthMeters);
    if (!state || saved.imei !== imei ||
        saved.routeDigest !== state.route.digest ||
        saved.regionId !== state.region.id || cursorMeters === null) {
      throw new Error(`Road assignment for ${imei} is incompatible with selected packs or role`);
    }
    // The same normalized object is passed to RoadMovementModel as both the
    // assignment and, for schema v1, its checkpoint.
    const previous = cursorMeters === saved.cursorMeters ? saved :
      { ...saved, cursorMeters };
    if (moving) {
      if (state.capacity === 0) {
        throw new Error(`Road assignment for ${imei} cannot sustain requested movement`);
      }
      state.occupancy += 1;
      state.region.movingAssigned += 1;
      state.usedSlots.add(slotForCursor(previous.cursorMeters, state));
    } else {
      restoredParkedUsed = true;
      const anchor = state.region.anchorLookup.get(`${state.key}\u0000${previous.parkedAnchor?.pointIndex}`);
      if (!anchor || !Number.isFinite(previous.parkedAnchor.latitude) ||
          !Number.isFinite(previous.parkedAnchor.longitude) ||
          Math.abs(previous.parkedAnchor.latitude - anchor.latitude) > 1e-6 ||
          Math.abs(previous.parkedAnchor.longitude - anchor.longitude) > 1e-6 ||
          distanceFromAnchor(previous.cursorMeters, anchor) > PARKED_ANCHOR_RADIUS_METERS + 1e-3) {
        throw new Error(`Parked anchor for ${imei} is incompatible with selected pack`);
      }
      const point = pointAtDistance(state.route, previous.cursorMeters);
      const savedPositionMatches = previous.schemaVersion !== 1 ||
        (previous.lastQueuedWallUtcMs === 0 ||
        (previous.lastQueuedLatitude === round6(point.latitude) &&
          previous.lastQueuedLongitude === round6(point.longitude)));
      if (!savedPositionMatches || !reserveParkedPosition(point, parkedPositions)) {
        collidingParked.push({ index, previous, anchor });
        continue;
      }
      anchor.occupancy += 1;
      state.region.parkedAssigned += 1;
    }
    assignments[index] = { ...previous };
  }

  // Keep already-separated checkpoints exactly where they were. Relocate old
  // parked checkpoints that are closer than 50 m at either GPS precision.
  for (const { index, previous, anchor } of collidingParked) {
    const position = takeParkedPosition(anchor, parkedPositions);
    if (!position) continue;
    assignments[index] = parkedAssignment(imeis[index], anchor, position,
      previous.speedSeed, previous.stopSeed);
    anchor.occupancy += 1;
    anchor.state.region.parkedAssigned += 1;
  }

  const missingMoving = movingCount - assignments.slice(0, movingCount).filter(Boolean).length;
  const availableCapacity = [...regions.values()].reduce(
    (sum, region) => sum + region.capacity - region.movingAssigned, 0
  );
  if (missingMoving > availableCapacity) {
    throw new Error(`Road route capacity insufficient: ${availableCapacity} slots for ${missingMoving} new moving devices`);
  }
  const regionList = [...regions.values()];
  const weightTotal = regionList.reduce((sum, region) => sum + region.weight, 0);
  for (const region of regionList) {
    const target = Math.floor(movingCount * region.weight / weightTotal);
    if (movingCount > 0 && (region.capacity === 0 || region.capacity < target)) {
      throw new Error(`Road route capacity insufficient in region ${region.id}`);
    }
    if (imeis.length > movingCount && region.anchors.length === 0) {
      if (allowPartialParked) return { parkedPlaced: 0 };
      throw new Error(`No eligible parked anchors in region ${region.id}`);
    }
    region.routeHeap = new MinHeap(compareRouteStates);
    for (const state of region.routes) {
      if (state.occupancy > state.capacity) throw new Error(`Road route ${state.route.id} exceeds capacity`);
      if (state.occupancy < state.capacity) region.routeHeap.push(state);
    }
    region.anchorHeap = new MinHeap(compareAnchorStates);
    for (const anchor of region.anchors) {
      if (!anchor.exhausted) region.anchorHeap.push(anchor);
    }
  }

  const movingRegions = new MinHeap(compareMovingRegions);
  for (const region of regionList) {
    if (region.movingAssigned < region.capacity) movingRegions.push(region);
  }
  for (let index = 0; index < movingCount; index += 1) {
    if (assignments[index]) continue;
    const region = movingRegions.pop();
    if (!region) throw new Error('Road route capacity exhausted');
    const state = region.routeHeap.pop();
    if (!state) throw new Error('Road route capacity exhausted in selected region');
    const imei = imeis[index];
    const cursorMeters = takeRouteSlot(state);
    assignments[index] = {
      imei, moving: true, regionId: region.id,
      routeId: state.route.id, routeDigest: state.route.digest,
      routePackDigest: state.pack.digest, cursorMeters,
      speedSeed: fnv1a(`${seed}|speed|${imei}`),
      stopSeed: fnv1a(`${seed}|stop|${imei}`)
    };
    state.occupancy += 1;
    region.movingAssigned += 1;
    if (state.occupancy < state.capacity) region.routeHeap.push(state);
    if (region.movingAssigned < region.capacity) movingRegions.push(region);
  }

  const parkedRegions = new MinHeap(compareParkedRegions);
  for (const region of regionList) {
    if (region.anchorHeap.size > 0) parkedRegions.push(region);
  }
  for (let index = movingCount; index < imeis.length; index += 1) {
    if (assignments[index]) continue;
    let region;
    let anchor;
    let position;
    while (!position) {
      region = parkedRegions.pop();
      if (!region) {
        const parkedPlaced = regionList.reduce((sum, item) => sum + item.parkedAssigned, 0);
        if (restoredParkedUsed && !parkedRetryDone) {
          // Old stationary checkpoints can occupy positions that make the
          // remaining 50 m spaced placement impossible. Keep every moving
          // checkpoint and try one fresh stationary arrangement before giving up.
          const movingRestored = new Map();
          for (let movingIndex = 0; movingIndex < movingCount; movingIndex += 1) {
            const movingImei = imeis[movingIndex];
            const prior = restored.get(movingImei);
            if (prior) movingRestored.set(movingImei, prior);
          }
          const fresh = allocateRoadFleet({
            packs, imeis, movingCount, seed, restoredAssignments: movingRestored,
            minSpacingMeters, requireContinuousMotion,
            [ALLOW_PARTIAL_PARKED]: allowPartialParked,
            [PARKED_RETRY_DONE]: true
          });
          return allowPartialParked && fresh.parkedPlaced < parkedPlaced
            ? { parkedPlaced } : fresh;
        }
        if (allowPartialParked) return { parkedPlaced };
        throw new Error(`Unique parked road positions insufficient: cannot place all ${imeis.length - movingCount} stationary devices with at least ${PARKED_MIN_SEPARATION_METERS} m separation on verified roads`);
      }
      anchor = region.anchorHeap.pop();
      position = takeParkedPosition(anchor, parkedPositions);
      if (position) {
        anchor.occupancy += 1;
        region.parkedAssigned += 1;
      }
      if (!anchor.exhausted) region.anchorHeap.push(anchor);
      if (region.anchorHeap.size > 0) parkedRegions.push(region);
    }
    const imei = imeis[index];
    assignments[index] = parkedAssignment(imei, anchor, position,
      fnv1a(`${seed}|speed|${imei}`), fnv1a(`${seed}|stop|${imei}`));
  }

  return {
    assignments,
    ...(allowPartialParked ? { parkedPlaced: imeis.length - movingCount } : {}),
    summary: {
      total: imeis.length,
      moving: movingCount,
      parked: imeis.length - movingCount,
      regions: regionList.map((region) => ({
        regionId: region.id,
        moving: region.movingAssigned,
        parked: region.parkedAssigned,
        routeCapacity: region.capacity,
        routesUsed: region.routes.filter((state) => state.occupancy > 0).length,
        eligibleParkedAnchors: region.anchors.length
      }))
    }
  };
}

function getOrCreateRegion(regions, id, weight) {
  let region = regions.get(id);
  if (!region) {
    region = { id, weight, routes: [], anchors: [], anchorLookup: new Map(),
      capacity: 0, movingAssigned: 0, parkedAssigned: 0 };
    regions.set(id, region);
  } else if (Math.abs(region.weight - weight) > 1e-9) {
    throw new Error(`Conflicting fleet weights for region ${id}`);
  }
  return region;
}

function anchorsFromRoutes(routes) {
  const anchors = [];
  for (const route of routes) {
    if (!Array.isArray(route.parkedAnchors)) continue;
    for (const pointIndex of route.parkedAnchors) anchors.push({ routeId: route.id, pointIndex });
  }
  return anchors;
}

function derivedParkedAnchorIndices(route) {
  if (!PARKED_ROUTE_FAMILIES.has(route.family) ||
      !Array.isArray(route.cumulativeMeters)) return [];
  const indices = [];
  let nextDistance = PARKED_DERIVED_ANCHOR_INTERVAL_METERS;
  for (let index = 1; index < route.cumulativeMeters.length; index += 1) {
    const distance = route.cumulativeMeters[index];
    if (!Number.isFinite(distance) || distance < nextDistance) continue;
    indices.push(index);
    // A long verified segment may pass several intervals. One route vertex
    // is still one anchor; the next one follows at least 1 km farther on.
    nextDistance = distance + PARKED_DERIVED_ANCHOR_INTERVAL_METERS;
  }
  return indices;
}

function parkedAssignment(imei, anchor, position, speedSeed, stopSeed) {
  return {
    imei, moving: false, regionId: anchor.state.region.id,
    routeId: anchor.state.route.id, routeDigest: anchor.state.route.digest,
    routePackDigest: anchor.state.pack.digest,
    cursorMeters: position.cursorMeters,
    parkedAnchor: {
      pointIndex: anchor.pointIndex,
      latitude: anchor.latitude,
      longitude: anchor.longitude
    },
    speedSeed, stopSeed
  };
}

function distanceFromAnchor(cursorMeters, anchor) {
  const distance = Math.abs(cursorMeters - anchor.cursorMeters);
  return anchor.state.route.closedLoop
    ? Math.min(distance, anchor.state.route.lengthMeters - distance) : distance;
}

// Chord distance never exceeds great-circle distance, so any two positions
// closer than the guard fall in the same or adjacent Earth-centred cube on
// each axis. This stays correct across the antimeridian and near the poles.
class SpatialPositionGrid {
  constructor() {
    this.cells = new Map();
  }

  hasPositionWithin(point, minimumMeters) {
    const [x, y, z] = earthCentredCell(point);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const entries = this.cells.get(`${x + dx},${y + dy},${z + dz}`);
          if (!entries) continue;
          for (const other of entries) {
            if (haversineKm(point, other) * 1000 < minimumMeters) return true;
          }
        }
      }
    }
    return false;
  }

  add(point) {
    const key = earthCentredCell(point).join(',');
    let entries = this.cells.get(key);
    if (!entries) {
      entries = [];
      this.cells.set(key, entries);
    }
    entries.push(point);
  }
}

class ParkedPositionIndex {
  constructor() {
    this.rounded = new SpatialPositionGrid();
    this.wire = new SpatialPositionGrid();
  }

  reserve(point) {
    // RoadMovementModel first rounds to six decimals. GT06 then quantizes
    // each absolute coordinate to integer 1/1,800,000-degree units.
    const rounded = {
      latitude: round6(point.latitude),
      longitude: round6(point.longitude)
    };
    const wire = {
      latitude: signedWireCoordinate(rounded.latitude),
      longitude: signedWireCoordinate(rounded.longitude)
    };
    if (this.rounded.hasPositionWithin(rounded, PARKED_SPHERICAL_GUARD_METERS) ||
        this.wire.hasPositionWithin(wire, PARKED_SPHERICAL_GUARD_METERS)) return false;
    this.rounded.add(rounded);
    this.wire.add(wire);
    return true;
  }
}

function signedWireCoordinate(value) {
  const magnitude = Math.round(Math.abs(value) * 1_800_000) / 1_800_000;
  return value < 0 ? -magnitude : magnitude;
}

function earthCentredCell(point) {
  const latitude = point.latitude * Math.PI / 180;
  const longitude = point.longitude * Math.PI / 180;
  const projected = EARTH_RADIUS_METERS * Math.cos(latitude);
  return [
    Math.floor(projected * Math.cos(longitude) / PARKED_SPHERICAL_GUARD_METERS),
    Math.floor(projected * Math.sin(longitude) / PARKED_SPHERICAL_GUARD_METERS),
    Math.floor(EARTH_RADIUS_METERS * Math.sin(latitude) / PARKED_SPHERICAL_GUARD_METERS)
  ];
}

function reserveParkedPosition(point, used) {
  return used.reserve(point);
}

function takeParkedPosition(anchor, used) {
  const route = anchor.state?.route || anchor.route;
  const maximumOrdinal = Math.ceil(PARKED_ANCHOR_RADIUS_METERS /
    PARKED_SLOT_SPACING_METERS) * 2;
  while (anchor.nextCandidateOrdinal <= maximumOrdinal) {
    const ordinal = anchor.nextCandidateOrdinal++;
    const displacement = Math.ceil(ordinal / 2) * PARKED_SLOT_SPACING_METERS *
      (ordinal % 2 === 1 ? 1 : -1);
    let cursorMeters = anchor.cursorMeters + displacement;
    if (route.closedLoop) {
      cursorMeters = ((cursorMeters % route.lengthMeters) + route.lengthMeters) % route.lengthMeters;
    } else if (cursorMeters < 0 || cursorMeters > route.lengthMeters) {
      continue;
    }
    if (reserveParkedPosition(pointAtDistance(route, cursorMeters), used)) {
      return { cursorMeters };
    }
  }
  anchor.exhausted = true;
  return null;
}

function countUniqueParkedPositionCapacity(routes, requestedCount) {
  if (!Number.isInteger(requestedCount) || requestedCount < 0) {
    throw new Error('Invalid stationary road capacity request');
  }
  if (requestedCount === 0) return 0;
  const heap = new MinHeap((left, right) =>
    left.occupancy - right.occupancy || left.tie - right.tie);
  let tie = 0;
  for (const route of routes) {
    if (!route || !Array.isArray(route.parkedAnchors) ||
        !Array.isArray(route.points) || !Array.isArray(route.cumulativeMeters)) continue;
    for (const pointIndex of new Set([
      ...route.parkedAnchors, ...derivedParkedAnchorIndices(route)
    ])) {
      const cursorMeters = route.cumulativeMeters[pointIndex];
      if (!Number.isFinite(cursorMeters)) continue;
      heap.push({ route, cursorMeters, nextCandidateOrdinal: 0,
        occupancy: 0, tie: tie++ });
    }
  }
  const used = new ParkedPositionIndex();
  let available = 0;
  while (available < requestedCount && heap.size > 0) {
    const anchor = heap.pop();
    if (!takeParkedPosition(anchor, used)) continue;
    available += 1;
    anchor.occupancy += 1;
    heap.push(anchor);
  }
  return available;
}

// Use the real allocator when checking a selected pack set. This preserves
// seeded anchor tie-breaking and weighted region selection, which a route-only
// estimate cannot reproduce when nearby road positions compete for space.
function countParkedPositionCapacityForPacks(packs, requestedCount, {
  seed = 'default', imeis, movingCount = 0, restoredAssignments
} = {}) {
  if (!Number.isInteger(requestedCount) || requestedCount < 0 ||
      !Number.isInteger(movingCount) || movingCount < 0) {
    throw new Error('Invalid stationary road capacity request');
  }
  if (requestedCount === 0) return 0;
  if (restoredAssignments && !imeis) {
    throw new Error('Stationary checkpoint preflight needs the matching fleet IMEIs');
  }
  const identities = imeis || Array.from({ length: requestedCount }, (_, index) =>
    `parked-preflight-${index}`);
  if (!Array.isArray(identities) || identities.length - movingCount !== requestedCount) {
    throw new Error('Stationary preflight IMEIs do not match the fleet size');
  }
  return allocateRoadFleet({
    packs, imeis: identities, movingCount, seed, restoredAssignments,
    [ALLOW_PARTIAL_PARKED]: true
  }).parkedPlaced;
}

function countEligibleParkedAnchors(routes) {
  if (!Array.isArray(routes)) throw new Error('Invalid stationary road routes');
  let count = 0;
  for (const route of routes) {
    if (!route || !Array.isArray(route.parkedAnchors) ||
        !Array.isArray(route.cumulativeMeters)) continue;
    count += new Set([
      ...route.parkedAnchors, ...derivedParkedAnchorIndices(route)
    ]).size;
  }
  return count;
}

function round6(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function normalizeRestoredCursor(cursorMeters, routeLengthMeters) {
  if (!Number.isFinite(cursorMeters) ||
      cursorMeters < -RESTORED_CURSOR_TOLERANCE_METERS ||
      cursorMeters > routeLengthMeters + RESTORED_CURSOR_TOLERANCE_METERS) return null;
  return clamp(cursorMeters, 0, routeLengthMeters);
}

function normalizeRestoredAssignments(source) {
  if (!source) return new Map();
  if (source instanceof Map) return source;
  if (Array.isArray(source)) return new Map(source.map((entry) => [entry.imei, entry]));
  if (typeof source === 'object') return new Map(Object.entries(source));
  throw new Error('Invalid restored road assignments');
}

function routeKey(packDigest, routeId) {
  return `${packDigest}\u0000${routeId}`;
}

function slotForCursor(cursorMeters, state) {
  return Math.min(state.capacity - 1,
    Math.floor(cursorMeters / state.route.lengthMeters * state.capacity));
}

function takeRouteSlot(state) {
  for (let attempts = 0; attempts < state.capacity; attempts += 1) {
    const slot = (state.slotStart + state.slotStride * state.nextSlotOrdinal) % state.capacity;
    state.nextSlotOrdinal += 1;
    if (state.usedSlots.has(slot)) continue;
    state.usedSlots.add(slot);
    return (slot + 0.5) * state.route.lengthMeters / state.capacity;
  }
  throw new Error(`No separated cursor slot remains on route ${state.route.id}`);
}

function coprimeStride(capacity) {
  if (capacity <= 1) return 1;
  let stride = Math.floor(capacity / 2) + 1;
  while (gcd(stride, capacity) !== 1) stride += 1;
  return stride;
}

function gcd(a, b) {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function compareRouteStates(left, right) {
  const a = (left.occupancy + 0.5) / left.capacity;
  const b = (right.occupancy + 0.5) / right.capacity;
  return a - b || left.tie - right.tie || left.key.localeCompare(right.key);
}

function compareAnchorStates(left, right) {
  return left.occupancy - right.occupancy || left.tie - right.tie;
}

function compareMovingRegions(left, right) {
  return (left.movingAssigned + 0.5) / left.weight -
    (right.movingAssigned + 0.5) / right.weight || left.id.localeCompare(right.id);
}

function compareParkedRegions(left, right) {
  return (left.parkedAssigned + 0.5) / left.weight -
    (right.parkedAssigned + 0.5) / right.weight || left.id.localeCompare(right.id);
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

module.exports = { allocateRoadFleet, countUniqueParkedPositionCapacity,
  countParkedPositionCapacityForPacks,
  countEligibleParkedAnchors,
  DEFAULT_MIN_SPACING_METERS, PARKED_MIN_SEPARATION_METERS,
  PARKED_SLOT_SPACING_METERS, PARKED_DERIVED_ANCHOR_INTERVAL_METERS,
  PARKED_ANCHOR_RADIUS_METERS };
