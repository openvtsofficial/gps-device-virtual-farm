'use strict';

const { createRegionZones, validateRegions } = require('./region-planner');
const { CELL_METERS, footprint, summarizeDiversity } = require('./diversity-evaluator');
const { distanceMeters } = require('./route-validator');
const { countUniqueParkedPositionCapacity,
  countParkedPositionCapacityForPacks,
  countEligibleParkedAnchors } = require('../simulator/road-allocator');

function coveredZones(routes, region) {
  const zones = createRegionZones(region);
  const hit = [];
  const radiusMeters = region.radiusKm * 0.2 * 1000;
  for (const zone of zones) {
    if (routes.some((route) => route.points.some((point) => distanceMeters(point, zone.point) <= radiusMeters))) {
      hit.push(zone.id);
    }
  }
  return hit;
}

function evaluateCoverage(packs, { regions, movingDevices = 0, parkedDevices = 0, minDistinctRoutes,
  minZones = 3, minSpacingMeters = 250, requireContinuousMotion = false,
  requiredFamilies = [], scenarioSeed } = {}) {
  const normalized = validateRegions(regions);
  if (!Number.isInteger(movingDevices) || movingDevices < 0 || movingDevices > 50_000 ||
      !Number.isInteger(parkedDevices) || parkedDevices < 0 || parkedDevices > 50_000 ||
      !Number.isFinite(minSpacingMeters) || minSpacingMeters < 20 || minSpacingMeters > 1000) {
    throw new Error('Invalid road coverage capacity request');
  }
  const matchingPacks = packs.filter((pack) => normalized.some((region) =>
    pack.region?.id === region.id && pack.region.centerLatitude === region.centerLatitude &&
    pack.region.centerLongitude === region.centerLongitude && pack.region.radiusKm === region.radiusKm &&
    pack.region.fleetWeight === region.fleetWeight));
  const routeList = matchingPacks.flatMap((pack) => pack.routes || []);
  const parkedCapacity = (selectedPacks, selectedRoutes, requested) => {
    if (requested === 0 || selectedRoutes.length === 0 ||
        countEligibleParkedAnchors(selectedRoutes) === 0) return 0;
    // Startup supplies its scenario seed. Match the allocator's seeded anchor
    // and weighted-region order so a coverage pass cannot precede a failure.
    if (typeof scenarioSeed === 'string' && selectedPacks.length > 0) {
      return countParkedPositionCapacityForPacks(selectedPacks, requested,
        { seed: scenarioSeed });
    }
    return countUniqueParkedPositionCapacity(selectedRoutes, requested);
  };
  const totalNeededRoutes = minDistinctRoutes ?? (movingDevices ? Math.max(3, Math.ceil(movingDevices / 25)) : 0);
  const regionResults = [];
  let capacity = 0;
  let distinctRouteCount = 0;
  let parkedAnchorCount = 0;
  let coveredZoneCount = 0;
  let requiredZoneCount = 0;
  const deficits = [];
  const uniqueAll = new Set();
  let allSampledCells = 0;
  for (const region of normalized) {
    const requestedMoving = Math.ceil(movingDevices * region.fleetWeight);
    const requestedParked = Math.ceil(parkedDevices * region.fleetWeight);
    const rawRoutes = routeList.filter((route) => route.regionId === region.id);
    const regionAnchorCount = countEligibleParkedAnchors(rawRoutes);
    const regionParkedCapacity = requestedParked > 0 && regionAnchorCount > 0
      ? parkedCapacity(matchingPacks.filter((pack) => pack.region.id === region.id),
        rawRoutes, requestedParked) : 0;
    // Destination journeys remain valid inventory, but only closed tours can
    // support a fleet whose moving vehicles must keep moving indefinitely.
    const eligibleRoutes = requireContinuousMotion
      ? rawRoutes.filter((route) => route.closedLoop) : rawRoutes;
    const distinct = summarizeDiversity(eligibleRoutes);
    const usableRoutes = distinct.routes;
    const regionFootprint = new Set();
    let regionCapacity = 0;
    for (const route of usableRoutes) {
      const cells = footprint(route);
      let newCells = 0;
      for (const cell of cells) {
        if (!regionFootprint.has(cell)) newCells += 1;
        regionFootprint.add(cell);
      }
      // Route density is limited both by real path length and incremental corridor footprint.
      const distinctFraction = Math.max(0.1, newCells / Math.max(1, cells.size));
      regionCapacity += Math.min(50, Math.floor(route.lengthMeters / minSpacingMeters * distinctFraction));
    }
    const hit = coveredZones(distinct.routes, region);
    const requiredZones = Math.min(createRegionZones(region).length, minZones);
    const neededDistinct = Math.ceil(totalNeededRoutes * region.fleetWeight);
    const regionDeficits = [];
    if (distinct.distinctRouteCount < neededDistinct) regionDeficits.push(`needs ${neededDistinct - distinct.distinctRouteCount} more distinct routes`);
    if (hit.length < requiredZones) regionDeficits.push(`needs ${requiredZones - hit.length} more prepared zones`);
    if (regionCapacity < requestedMoving) regionDeficits.push(`needs capacity for ${requestedMoving - regionCapacity} more moving devices`);
    if (requestedParked > 0 && regionAnchorCount === 0) {
      regionDeficits.push('needs eligible stationary anchors for parked devices');
    } else if (regionParkedCapacity < requestedParked) {
      regionDeficits.push(`needs ${requestedParked - regionParkedCapacity} more parked road positions at least 50 m apart`);
    }
    for (const family of requiredFamilies) {
      if (!distinct.routes.some((route) => route.family === family)) regionDeficits.push(`missing ${family} route family`);
    }
    if (regionDeficits.length) deficits.push(`${region.id}: ${regionDeficits.join('; ')}`);
    regionResults.push({ id: region.id, routeCount: rawRoutes.length,
      distinctRouteCount: distinct.distinctRouteCount, coveredZoneCount: hit.length,
      requiredZoneCount: requiredZones, capacity: regionCapacity, requestedMoving,
      parkedAnchorCount: regionAnchorCount, parkedPositionCapacity: regionParkedCapacity,
      requestedParked, deficits: regionDeficits });
    capacity += regionCapacity;
    distinctRouteCount += distinct.distinctRouteCount;
    parkedAnchorCount += regionAnchorCount;
    coveredZoneCount += hit.length;
    requiredZoneCount += requiredZones;
    for (const cell of regionFootprint) uniqueAll.add(`${region.id}:${cell}`);
    allSampledCells += [...distinct.routes].reduce((sum, route) => sum + footprint(route).size, 0);
  }
  // Regions may overlap geographically. The allocator reserves stationary
  // coordinates globally, so its preflight must also count across all packs.
  const parkedPositionCapacity = parkedDevices > 0 &&
    regionResults.every((region) => region.parkedAnchorCount > 0)
    ? parkedCapacity(matchingPacks, routeList, parkedDevices) : 0;
  if (parkedPositionCapacity < parkedDevices) {
    deficits.push(`needs ${parkedDevices - parkedPositionCapacity} more parked road positions at least 50 m apart across selected regions`);
  }
  const ready = deficits.length === 0;
  const missingRegion = regionResults.some((region) => region.routeCount === 0 || region.coveredZoneCount === 0);
  return { status: ready ? 'ready' : missingRegion ? 'insufficient-coverage' : 'reduced-diversity',
    ready, requestedMoving: movingDevices, requestedParked: parkedDevices,
    usableMovingCapacityEstimate: capacity,
    acceptedRouteCount: routeList.length, distinctRouteCount, parkedAnchorCount,
    parkedPositionCapacity,
    coveredZoneCount, requiredZoneCount,
    uniqueFootprintKm: uniqueAll.size * CELL_METERS / 1000,
    overlapRatio: allSampledCells ? 1 - uniqueAll.size / allSampledCells : 0,
    regions: regionResults, deficits };
}

module.exports = { evaluateCoverage };
