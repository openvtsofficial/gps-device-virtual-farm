'use strict';

const { bearingDegrees, fnv1a, haversineKm } = require('./geo');

const MAX_STEP_MS = 15_000;
const INTEGRATION_STEP_MS = 1_000;
const ACCELERATION_MPS2 = 1.5;
const BRAKING_MPS2 = 2.5;
const validatedImmutableRoutes = new WeakSet();

const FAMILY_CRUISE_KPH = Object.freeze({
  local: 28,
  urban: 42,
  suburban: 58,
  peripheral: 58,
  regional: 78,
  intercity: 78,
  depot: 25,
  delivery: 25
});

class RoadMovementModel {
  constructor({ route, assignment, checkpoint }) {
    if (!route || !Object.isFrozen(route) || !validatedImmutableRoutes.has(route)) {
      validateRoute(route);
      if (Object.isFrozen(route) && Object.isFrozen(route.points) &&
          Object.isFrozen(route.cumulativeMeters)) validatedImmutableRoutes.add(route);
    }
    if (!assignment || typeof assignment.imei !== 'string' ||
        assignment.routeId !== route.id || assignment.routeDigest !== route.digest ||
        typeof assignment.routePackDigest !== 'string' ||
        assignment.regionId !== route.regionId ||
        !Number.isFinite(assignment.cursorMeters) ||
        assignment.cursorMeters < 0 || assignment.cursorMeters > route.lengthMeters) {
      throw new Error('Road assignment does not match its verified route');
    }
    const stopMeters = validatedStops(route);
    if (checkpoint) validateCheckpoint(checkpoint, assignment, route, stopMeters);

    this.route = route;
    this.assignment = assignment;
    this.speedSeed = assignment.speedSeed ?? fnv1a(`${assignment.imei}|speed`);
    this.stopSeed = assignment.stopSeed ?? fnv1a(`${assignment.imei}|stop`);
    this.stopMeters = stopMeters;
    this.available = true;
    this.lastMotionMs = null;
    this.pending = null;
    this.tokenSequence = 0;

    const cursorMeters = checkpoint ? checkpoint.cursorMeters : assignment.cursorMeters;
    const initialPoint = pointAtDistance(route, cursorMeters);
    const moving = Boolean(assignment.moving);
    this.state = {
      cursorMeters,
      completedTours: checkpoint?.completedTours ?? 0,
      phase: checkpoint?.phase ?? (moving ? 'moving' : 'parked'),
      // Paused-world resume holds the saved cursor. The first packet must not
      // claim motion when no path distance has elapsed in this process.
      currentSpeedMps: 0,
      headingDegrees: checkpoint?.headingDegrees ?? initialPoint.course,
      lastQueuedWallUtcMs: checkpoint?.lastQueuedWallUtcMs ?? 0,
      lastQueuedLatitude: checkpoint?.lastQueuedLatitude ?? initialPoint.latitude,
      lastQueuedLongitude: checkpoint?.lastQueuedLongitude ?? initialPoint.longitude,
      nextStopIndex: checkpoint?.nextStopIndex ?? nextStopIndex(this.stopMeters, cursorMeters),
      dwellRemainingMs: checkpoint?.dwellRemainingMs ?? 0
    };
    if (!moving) {
      this.state.phase = 'parked';
      this.state.currentSpeedMps = 0;
    }
  }

  proposePoint(nowWallUtcMs = Date.now(), nowMonotonicMs = nowWallUtcMs) {
    if (this.pending) return this.pending.proposal;
    if (!Number.isFinite(nowWallUtcMs) || Math.abs(nowWallUtcMs) > 8.64e15 ||
        !Number.isFinite(nowMonotonicMs)) throw new Error('Invalid road movement time');

    const safeWallMs = Math.max(nowWallUtcMs, this.state.lastQueuedWallUtcMs +
      (this.state.lastQueuedWallUtcMs ? 1 : 0));
    const elapsedMs = this.available && this.lastMotionMs !== null
      ? clamp(nowMonotonicMs - this.lastMotionMs, 0, MAX_STEP_MS) : 0;
    const next = { ...this.state };
    if (this.available && next.phase !== 'parked' && next.phase !== 'terminal') {
      advanceState(this.route, this.stopMeters, next, elapsedMs, this.speedSeed, this.stopSeed);
    }
    if (!this.available) next.currentSpeedMps = 0;

    const point = pointAtDistance(this.route, next.cursorMeters);
    if (next.currentSpeedMps > 0) next.headingDegrees = point.course;
    const gpsPoint = Object.freeze({
      latitude: round6(point.latitude),
      longitude: round6(point.longitude),
      speedKph: round1(next.currentSpeedMps * 3.6),
      course: Math.round(next.headingDegrees) % 360,
      satellites: 8 + (fnv1a(this.assignment.imei) % 5),
      valid: true,
      deviceTimeISO: new Date(safeWallMs).toISOString()
    });
    next.lastQueuedWallUtcMs = safeWallMs;
    next.lastQueuedLatitude = gpsPoint.latitude;
    next.lastQueuedLongitude = gpsPoint.longitude;
    const nextStateToken = Object.freeze({ id: ++this.tokenSequence });
    const proposal = Object.freeze({ gpsPoint, nextStateToken });
    this.pending = { proposal, next, nowMonotonicMs };
    return proposal;
  }

  commitQueuedPoint(token) {
    if (!this.pending || token !== this.pending.proposal.nextStateToken) {
      throw new Error('Road point token is stale or was not proposed');
    }
    this.state = this.pending.next;
    this.lastMotionMs = this.pending.nowMonotonicMs;
    this.pending = null;
  }

  onTransportAvailable(nowMonotonicMs = Date.now()) {
    if (!Number.isFinite(nowMonotonicMs)) throw new Error('Invalid road movement time');
    this.available = true;
    this.lastMotionMs = nowMonotonicMs;
    this.pending = null;
  }

  onTransportUnavailable() {
    this.available = false;
    this.lastMotionMs = null;
    this.pending = null;
    this.state.currentSpeedMps = 0;
  }

  checkpoint() {
    const state = this.state;
    return {
      schemaVersion: 1,
      imei: this.assignment.imei,
      moving: Boolean(this.assignment.moving),
      regionId: this.assignment.regionId,
      routeId: this.assignment.routeId,
      routeDigest: this.assignment.routeDigest,
      routePackDigest: this.assignment.routePackDigest,
      cursorMeters: state.cursorMeters,
      completedTours: state.completedTours,
      phase: state.phase,
      currentSpeedMps: state.currentSpeedMps,
      headingDegrees: state.headingDegrees,
      lastQueuedWallUtcMs: state.lastQueuedWallUtcMs,
      lastQueuedLatitude: state.lastQueuedLatitude,
      lastQueuedLongitude: state.lastQueuedLongitude,
      nextStopIndex: state.nextStopIndex,
      dwellRemainingMs: state.dwellRemainingMs,
      speedSeed: this.speedSeed,
      stopSeed: this.stopSeed,
      ...(this.assignment.parkedAnchor ? { parkedAnchor: this.assignment.parkedAnchor } : {})
    };
  }
}

function advanceState(route, stopMeters, state, elapsedMs, speedSeed, stopSeed) {
  let remainingMs = elapsedMs;
  while (remainingMs > 0) {
    const stepMs = Math.min(remainingMs, INTEGRATION_STEP_MS);
    remainingMs -= stepMs;
    if (state.phase === 'dwelling') {
      state.dwellRemainingMs = Math.max(0, state.dwellRemainingMs - stepMs);
      state.currentSpeedMps = 0;
      if (state.dwellRemainingMs === 0) state.phase = 'moving';
      continue;
    }
    if (state.phase !== 'moving') break;

    const targetMps = targetSpeedKph(route, state.cursorMeters, speedSeed) / 3.6;
    const seconds = stepMs / 1000;
    const oldSpeed = state.currentSpeedMps;
    const adjustment = clamp(targetMps - oldSpeed,
      -BRAKING_MPS2 * seconds, ACCELERATION_MPS2 * seconds);
    const newSpeed = Math.max(0, oldSpeed + adjustment);
    const traveledMeters = (oldSpeed + newSpeed) * 0.5 * seconds;
    const nextStop = stopMeters[state.nextStopIndex];
    const distanceToStop = nextStop === undefined ? Infinity : nextStop - state.cursorMeters;
    const distanceToEnd = route.lengthMeters - state.cursorMeters;
    const traveled = Math.min(traveledMeters, distanceToStop, distanceToEnd);
    state.cursorMeters += Math.max(0, traveled);
    state.currentSpeedMps = newSpeed;

    if (distanceToStop <= traveledMeters && distanceToStop <= distanceToEnd) {
      state.cursorMeters = nextStop;
      state.currentSpeedMps = 0;
      state.phase = 'dwelling';
      state.dwellRemainingMs = 5_000 + (stopSeed % 11) * 1_000;
      state.nextStopIndex += 1;
      continue;
    }
    if (distanceToEnd <= traveledMeters) {
      state.currentSpeedMps = 0;
      if (route.closedLoop) {
        state.cursorMeters = 0;
        state.completedTours += 1;
        state.nextStopIndex = 0;
      } else {
        state.cursorMeters = route.lengthMeters;
        state.phase = 'terminal';
      }
    }
  }
}

function targetSpeedKph(route, cursorMeters, speedSeed) {
  const base = FAMILY_CRUISE_KPH[route.family] ?? 42;
  const individual = 0.82 + ((speedSeed >>> 0) / 0xffffffff) * 0.32;
  const progressVariation = 0.92 + 0.08 * Math.sin(cursorMeters / 400 + speedSeed % 7);
  let target = base * individual * progressVariation;
  const segment = segmentAtDistance(route.cumulativeMeters, cursorMeters);
  if (segment < route.points.length - 2) {
    const currentCourse = bearingDegrees(route.points[segment], route.points[segment + 1]);
    const nextCourse = bearingDegrees(route.points[segment + 1], route.points[segment + 2]);
    const turnDegrees = Math.abs(((nextCourse - currentCourse + 540) % 360) - 180);
    const distanceToTurn = route.cumulativeMeters[segment + 1] - cursorMeters;
    if (distanceToTurn < 50 && turnDegrees > 70) target = Math.min(target, 18);
    else if (distanceToTurn < 40 && turnDegrees > 40) target = Math.min(target, 28);
  }
  return clamp(target, 8, 95);
}

function pointAtDistance(route, distanceMeters) {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0 ||
      distanceMeters > route.lengthMeters) throw new Error('Road cursor is out of bounds');
  const segment = segmentAtDistance(route.cumulativeMeters, distanceMeters);
  const from = route.points[segment];
  const to = route.points[segment + 1];
  const fromMeters = route.cumulativeMeters[segment];
  const segmentMeters = route.cumulativeMeters[segment + 1] - fromMeters;
  const fraction = clamp((distanceMeters - fromMeters) / segmentMeters, 0, 1);
  const longitudeDelta = ((to.longitude - from.longitude + 540) % 360) - 180;
  return {
    latitude: from.latitude + (to.latitude - from.latitude) * fraction,
    longitude: normalizeLongitude(from.longitude + longitudeDelta * fraction),
    course: bearingDegrees(from, to)
  };
}

function segmentAtDistance(cumulativeMeters, distanceMeters) {
  let low = 1;
  let high = cumulativeMeters.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (cumulativeMeters[middle] <= distanceMeters) low = middle + 1;
    else high = middle;
  }
  return Math.min(cumulativeMeters.length - 2, low - 1);
}

function validatedStops(route) {
  let stops = route.stopMeters;
  if (stops === undefined && (route.family === 'depot' || route.family === 'delivery') &&
      Array.isArray(route.legEndIndices)) {
    stops = route.legEndIndices.slice(0, -1).map((index) => {
      if (!Number.isInteger(index) || index <= 0 || index >= route.points.length - 1) {
        throw new Error('Invalid verified depot stop vertex');
      }
      return route.cumulativeMeters[index];
    });
  }
  if (stops === undefined) return [];
  if (!Array.isArray(stops) || stops.some((stop, index) =>
    !Number.isFinite(stop) || stop <= 0 || stop >= route.lengthMeters ||
    (index > 0 && stop <= stops[index - 1]))) {
    throw new Error('Invalid verified route stop markers');
  }
  return stops;
}

function nextStopIndex(stops, cursorMeters) {
  return stops.findIndex((stop) => stop > cursorMeters) === -1
    ? stops.length : stops.findIndex((stop) => stop > cursorMeters);
}

function validateRoute(route) {
  if (!route || typeof route.id !== 'string' || typeof route.digest !== 'string' ||
      typeof route.regionId !== 'string' || !Array.isArray(route.points) ||
      route.points.length < 2 || !route.cumulativeMeters ||
      route.cumulativeMeters.length !== route.points.length ||
      !Number.isFinite(route.lengthMeters) || route.lengthMeters <= 0 ||
      Math.abs(route.cumulativeMeters[0]) > 1e-6 ||
      Math.abs(route.cumulativeMeters.at(-1) - route.lengthMeters) > 1e-3) {
    throw new Error('Invalid verified road route');
  }
  for (let index = 0; index < route.points.length; index += 1) {
    const point = route.points[index];
    if (!point || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude) ||
        Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180 ||
        (index > 0 && route.cumulativeMeters[index] <= route.cumulativeMeters[index - 1])) {
      throw new Error('Invalid verified road geometry');
    }
  }
  if (route.closedLoop && haversineKm(route.points[0], route.points.at(-1)) > 0.002) {
    throw new Error('Closed road route has an unverified endpoint gap');
  }
}

function validateCheckpoint(checkpoint, assignment, route, stopMeters) {
  if (checkpoint.schemaVersion !== 1 ||
      checkpoint.imei !== assignment.imei ||
      checkpoint.moving !== Boolean(assignment.moving) ||
      checkpoint.regionId !== assignment.regionId ||
      checkpoint.routeId !== route.id || checkpoint.routeDigest !== route.digest ||
      checkpoint.routePackDigest !== assignment.routePackDigest ||
      !Number.isFinite(checkpoint.cursorMeters) || checkpoint.cursorMeters < 0 ||
      checkpoint.cursorMeters > route.lengthMeters ||
      !Number.isFinite(checkpoint.currentSpeedMps) || checkpoint.currentSpeedMps < 0 ||
      checkpoint.currentSpeedMps > 95 / 3.6 ||
      !Number.isInteger(checkpoint.completedTours) || checkpoint.completedTours < 0 ||
      !['moving', 'dwelling', 'parked', 'terminal'].includes(checkpoint.phase) ||
      !Number.isFinite(checkpoint.headingDegrees) || checkpoint.headingDegrees < 0 ||
      checkpoint.headingDegrees >= 360 ||
      !Number.isFinite(checkpoint.lastQueuedWallUtcMs) ||
      checkpoint.lastQueuedWallUtcMs < 0 || checkpoint.lastQueuedWallUtcMs > 8.64e15 ||
      !Number.isFinite(checkpoint.lastQueuedLatitude) ||
      !Number.isFinite(checkpoint.lastQueuedLongitude) ||
      !Number.isInteger(checkpoint.nextStopIndex) || checkpoint.nextStopIndex < 0 ||
      checkpoint.nextStopIndex > stopMeters.length ||
      !Number.isFinite(checkpoint.dwellRemainingMs) ||
      checkpoint.dwellRemainingMs < 0 || checkpoint.dwellRemainingMs > 60_000 ||
      (checkpoint.nextStopIndex < stopMeters.length &&
        stopMeters[checkpoint.nextStopIndex] < checkpoint.cursorMeters - 1e-3) ||
      (route.closedLoop && checkpoint.phase === 'terminal') ||
      (!route.closedLoop && checkpoint.completedTours > 0) ||
      (!assignment.moving && checkpoint.phase !== 'parked') ||
      (assignment.moving && checkpoint.phase === 'parked')) {
    throw new Error('Road checkpoint is incompatible with selected assignment');
  }
}

function normalizeLongitude(longitude) {
  return ((longitude + 540) % 360) - 180;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function round6(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

module.exports = { RoadMovementModel, pointAtDistance };
