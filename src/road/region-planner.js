'use strict';

const { distanceMeters } = require('./route-validator');

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function validateRegions(regions) {
  if (!Array.isArray(regions) || regions.length < 1 || regions.length > 8) throw new Error('Choose one to eight road regions');
  const ids = new Set();
  let weight = 0;
  const validated = regions.map((region) => {
    if (!region || !ID_PATTERN.test(region.id) || ids.has(region.id)) throw new Error('Invalid or repeated road region ID');
    ids.add(region.id);
    const { centerLatitude, centerLongitude, radiusKm } = region;
    if (!Number.isFinite(centerLatitude) || !Number.isFinite(centerLongitude) ||
        !Number.isFinite(radiusKm) || radiusKm < 2 || radiusKm > 500 ||
        Math.abs(centerLatitude) > 85 || Math.abs(centerLongitude) > 180) {
      throw new Error('Invalid road region coordinates or radius');
    }
    const latRadius = radiusKm / 111.32;
    const lonRadius = radiusKm / (111.32 * Math.cos(centerLatitude * Math.PI / 180));
    if (Math.abs(centerLatitude) + latRadius >= 89 || Math.abs(centerLongitude) + lonRadius >= 180) {
      throw new Error('Road region crosses an unsupported pole or dateline boundary');
    }
    const fleetWeight = region.fleetWeight ?? 1 / regions.length;
    if (!Number.isFinite(fleetWeight) || fleetWeight <= 0 || fleetWeight > 1) throw new Error('Invalid region fleet weight');
    weight += fleetWeight;
    return { id: region.id, centerLatitude, centerLongitude, radiusKm, fleetWeight,
      planningBounds: [centerLongitude - lonRadius, centerLatitude - latRadius, centerLongitude + lonRadius, centerLatitude + latRadius] };
  });
  if (Math.abs(weight - 1) > 0.001) throw new Error('Road region fleet weights must total one');
  return validated;
}

function createRegionZones(region) {
  const zones = [];
  const cos = Math.cos(region.centerLatitude * Math.PI / 180);
  for (let row = -2; row <= 2; row += 1) {
    for (let column = -2; column <= 2; column += 1) {
      const northKm = row * region.radiusKm * 0.37;
      const eastKm = column * region.radiusKm * 0.37;
      if (Math.hypot(northKm, eastKm) > region.radiusKm * 0.95) continue;
      const point = { latitude: region.centerLatitude + northKm / 111.32,
        longitude: region.centerLongitude + eastKm / (111.32 * cos) };
      zones.push({ id: `${region.id}:${row + 2}:${column + 2}`, row, column, point });
    }
  }
  return zones;
}

function pointInRegion(point, region, allowanceKm = 0) {
  return distanceMeters(point, { latitude: region.centerLatitude, longitude: region.centerLongitude }) <=
    (region.radiusKm + allowanceKm) * 1000;
}

module.exports = { validateRegions, createRegionZones, pointInRegion };
