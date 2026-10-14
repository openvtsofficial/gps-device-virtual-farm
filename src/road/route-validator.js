'use strict';

const { createHash } = require('node:crypto');
const { haversineKm } = require('../simulator/geo');

const MAX_POINTS = 100_000;
const MAX_SEGMENT_METERS = 2_000;
const MAX_ROUTE_METERS = 1_000_000;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertPoint(point) {
  if (!point || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude) ||
      point.latitude < -90 || point.latitude > 90 || point.longitude < -180 || point.longitude > 180) {
    throw new Error('Invalid route coordinate');
  }
}

function distanceMeters(a, b) {
  return haversineKm(a, b) * 1000;
}

// Native Valhalla JSON legs use encoded polyline6, latitude delta first.
function decodePolyline6(encoded, maxPoints = MAX_POINTS) {
  if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > maxPoints * 14) {
    throw new Error('Invalid polyline6 length');
  }
  const values = [];
  let offset = 0;
  while (offset < encoded.length) {
    let value = 0;
    let shift = 0;
    let complete = false;
    for (let group = 0; group < 7 && offset < encoded.length; group += 1) {
      const byte = encoded.charCodeAt(offset++) - 63;
      if (byte < 0 || byte > 63) throw new Error('Malformed polyline6 byte');
      value += (byte & 31) * 2 ** shift;
      if (!Number.isSafeInteger(value) || value > 0xffffffff) throw new Error('Polyline6 integer overflow');
      if (byte < 32) {
        complete = true;
        break;
      }
      shift += 5;
    }
    if (!complete) throw new Error('Unterminated polyline6 integer');
    values.push(value % 2 ? -(value + 1) / 2 : value / 2);
    if (values.length > maxPoints * 2) throw new Error('Too many polyline6 points');
  }
  if (values.length < 4 || values.length % 2 !== 0) throw new Error('Polyline6 needs coordinate pairs');
  const points = [];
  let latitude = 0;
  let longitude = 0;
  for (let i = 0; i < values.length; i += 2) {
    latitude += values[i];
    longitude += values[i + 1];
    const point = { latitude: latitude / 1e6, longitude: longitude / 1e6 };
    assertPoint(point);
    points.push(point);
  }
  return points;
}

function candidatePoint(location) {
  const point = { latitude: location?.latitude ?? location?.lat, longitude: location?.longitude ?? location?.lon };
  assertPoint(point);
  return point;
}

function coordinatesDigest(points) {
  // Quantized coordinates are the exact decoded polyline6 values, independent of response IDs.
  return sha256(points.map((p) => `${Math.round(p.latitude * 1e6)},${Math.round(p.longitude * 1e6)}`).join(';'));
}

function chooseRouteAnchors(points, closedLoop, family = 'local', legEndIndices = []) {
  // Directions geometry does not establish legal parking. Use requested
  // waypoints on lower-speed journey families as stationary anchors, never an
  // arbitrary interior vertex of a regional or suburban through route.
  if (!['local', 'urban', 'depot', 'delivery'].includes(family)) return [];
  const candidates = closedLoop
    ? legEndIndices.slice(0, -1)
    : [points.length - 1, ...legEndIndices.slice(0, -1)];
  const anchors = [0];
  for (const index of candidates) {
    if (Number.isInteger(index) && index > 0 && index < points.length &&
        distanceMeters(points[0], points[index]) >= 50) {
      anchors.push(index);
      break;
    }
  }
  return anchors;
}

function validateValhallaRoute(response, candidate, options = {}) {
  const trip = response?.trip || response;
  const legs = trip?.legs;
  const locations = candidate?.locations;
  if (trip?.status !== undefined && trip.status !== 0) throw new Error('Valhalla trip did not succeed');
  if (trip?.units !== undefined && trip.units !== 'kilometers') throw new Error('Valhalla route units must be kilometers');
  if (!Array.isArray(legs) || legs.length === 0 || !Array.isArray(locations) || locations.length < 2 || locations.length > 8) {
    throw new Error('Missing Valhalla legs or requested locations');
  }
  if (legs.length !== locations.length - 1) throw new Error('Unexpected Valhalla leg count');
  const maxPoints = options.maxPoints ?? MAX_POINTS;
  const maxSnapMeters = options.maxSnapMeters ?? 1500;
  const maxSegmentMeters = options.maxSegmentMeters ?? MAX_SEGMENT_METERS;
  const maxLengthMeters = options.maxLengthMeters ?? MAX_ROUTE_METERS;
  const maxLegGapMeters = options.maxLegGapMeters ?? 2;
  const minLengthMeters = options.minLengthMeters ?? 100;
  const points = [];
  const legEndIndices = [];
  let reportedMeters = 0;
  for (let i = 0; i < legs.length; i += 1) {
    const leg = legs[i];
    const decoded = decodePolyline6(leg?.shape, maxPoints - points.length);
    if (distanceMeters(decoded[0], candidatePoint(locations[i])) > maxSnapMeters ||
        distanceMeters(decoded.at(-1), candidatePoint(locations[i + 1])) > maxSnapMeters) {
      throw new Error('Valhalla snapped too far from a requested waypoint');
    }
    if (i > 0) {
      if (distanceMeters(points.at(-1), decoded[0]) > maxLegGapMeters) throw new Error('Disconnected Valhalla legs');
      decoded.shift();
    }
    const beforeLeg = points.length;
    for (const point of decoded) {
      // Provider polylines can repeat a vertex. Remove it before building a
      // distance index: playback requires every stored segment to advance.
      if (points.length === 0 || distanceMeters(points.at(-1), point) > 0) points.push(point);
    }
    if (points.length === beforeLeg) throw new Error('Degenerate Valhalla leg');
    legEndIndices.push(points.length - 1);
    const summaryKm = leg?.summary?.length;
    if (!Number.isFinite(summaryKm) || summaryKm <= 0) throw new Error('Missing or invalid Valhalla leg length');
    reportedMeters += summaryKm * 1000;
  }
  if (points.length > maxPoints || points.length < 2) throw new Error('Invalid route point count');
  const cumulativeMeters = [0];
  for (let i = 1; i < points.length; i += 1) {
    const step = distanceMeters(points[i - 1], points[i]);
    if (!Number.isFinite(step) || step > maxSegmentMeters) throw new Error('Implausible route geometry jump');
    cumulativeMeters.push(cumulativeMeters.at(-1) + step);
  }
  const lengthMeters = cumulativeMeters.at(-1);
  if (lengthMeters < minLengthMeters || lengthMeters > maxLengthMeters ||
      Math.abs(reportedMeters - lengthMeters) > Math.max(250, lengthMeters * 0.25)) {
    throw new Error('Valhalla length differs from geometry');
  }
  const closedLoop = Boolean(candidate.closedLoop);
  if (closedLoop) {
    if (locations.length < 4 || distanceMeters(candidatePoint(locations[0]), candidatePoint(locations.at(-1))) > 10 ||
      distanceMeters(points[0], points.at(-1)) > 2) {
      throw new Error('Closed tour lacks a provider-routed return leg');
    }
  }
  if (options.region) {
    const center = { latitude: options.region.centerLatitude, longitude: options.region.centerLongitude };
    const limitMeters = (options.region.radiusKm + (options.regionAllowanceKm ?? 10)) * 1000;
    if (points.some((point) => distanceMeters(point, center) > limitMeters)) {
      throw new Error('Route leaves requested region');
    }
  }
  const digest = coordinatesDigest(points);
  return {
    id: `${candidate.regionId}-${digest.slice(0, 16)}`,
    regionId: candidate.regionId,
    family: candidate.family,
    closedLoop,
    points,
    cumulativeMeters,
    lengthMeters,
    digest,
    legEndIndices,
    parkedAnchors: chooseRouteAnchors(points, closedLoop, candidate.family, legEndIndices),
    sourceRequestDigest: candidate.digest || null,
    provider: 'fossgis-valhalla-public'
  };
}

function validateValhallaResponseWithSources(response, candidate, options = {}) {
  const routes = [{ route: validateValhallaRoute(response, candidate, options), sourceResponse: response }];
  const alternates = response?.alternate_paths;
  if (alternates !== undefined) {
    if (!Array.isArray(alternates) || candidate.locations.length !== 2) throw new Error('Unsupported Valhalla alternates');
    for (const alternate of alternates.slice(0, 3)) {
      const route = validateValhallaRoute(alternate, candidate, options);
      if (!routes.some((existing) => existing.route.digest === route.digest)) {
        routes.push({ route, sourceResponse: alternate });
      }
    }
  }
  return routes;
}

function validateValhallaResponse(response, candidate, options = {}) {
  return validateValhallaResponseWithSources(response, candidate, options).map(({ route }) => route);
}

module.exports = { decodePolyline6, validateValhallaRoute, validateValhallaResponse,
  validateValhallaResponseWithSources, coordinatesDigest, chooseRouteAnchors, distanceMeters, sha256 };
