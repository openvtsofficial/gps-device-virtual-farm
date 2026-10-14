'use strict';

const { createHash } = require('node:crypto');
const { createRegionZones, validateRegions } = require('./region-planner');

const FAMILIES = Object.freeze(['local', 'urban', 'suburban', 'regional', 'depot']);
const TARGETS_PER_ORIGIN = 8;
// Preferences influence the route engine; only the returned road geometry is verified.
const PROFILES = Object.freeze({
  local: Object.freeze({ name: 'local-preferred', use_highways: 0.05, use_distance: 0.55 }),
  urban: Object.freeze({ name: 'urban-mixed', use_highways: 0.2, use_distance: 0.35 }),
  suburban: Object.freeze({ name: 'suburban-mixed', use_highways: 0.5, use_distance: 0.15 }),
  regional: Object.freeze({ name: 'regional-major', use_highways: 0.8, use_distance: 0 }),
  depot: Object.freeze({ name: 'depot-local-preferred', use_highways: 0.1, use_distance: 0.5 })
});

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hashFraction(value) {
  return Number.parseInt(hash(value).slice(0, 8), 16) / 0x100000000;
}

function kilometerDistance(a, b) {
  return Math.hypot(a.northKm - b.northKm, a.eastKm - b.eastKm);
}

function pointAt(region, northKm, eastKm) {
  const cos = Math.cos(region.centerLatitude * Math.PI / 180);
  return {
    latitude: Math.round((region.centerLatitude + northKm / 111.32) * 1e6) / 1e6,
    longitude: Math.round((region.centerLongitude + eastKm / (111.32 * cos)) * 1e6) / 1e6
  };
}

function createPlanningSites(region, seed, round) {
  const zones = createRegionZones(region);
  const innerRadius = Math.min(3, Math.max(0.3, region.radiusKm * 0.08));
  const outerRadius = Math.min(8, Math.max(1, region.radiusKm * 0.2));
  const sites = [];
  for (const zone of zones) {
    const zoneNorthKm = (zone.point.latitude - region.centerLatitude) * 111.32;
    const zoneEastKm = (zone.point.longitude - region.centerLongitude) *
      111.32 * Math.cos(region.centerLatitude * Math.PI / 180);
    // A later planning round moves the sampling sites within each zone. The
    // first round stays byte-for-byte compatible with previously saved jobs.
    // This creates new geographic requests without relying on a second road
    // source or retrying the same rejected Valhalla request indefinitely.
    const coreJitterKm = round === 0 ? 0 : Math.min(1.8, region.radiusKm * 0.035) *
      (0.25 + 0.75 * hashFraction(`${seed}:${zone.id}:core-distance`));
    const coreAngle = 2 * Math.PI * hashFraction(`${seed}:${zone.id}:core-angle`);
    const northKm = zoneNorthKm + coreJitterKm * Math.sin(coreAngle);
    const eastKm = zoneEastKm + coreJitterKm * Math.cos(coreAngle);
    sites.push({ id: `${zone.id}:core`, zoneId: zone.id, level: 'core',
      northKm, eastKm, centerDistanceKm: Math.hypot(northKm, eastKm),
      point: round === 0 ? zone.point : pointAt(region, northKm, eastKm) });
    for (const [level, radius] of [['inner', innerRadius], ['outer', outerRadius]]) {
      const phase = 2 * Math.PI * hashFraction(`${seed}:${zone.id}:${level}`);
      const variedRadius = round === 0 ? radius : radius *
        (0.65 + 0.7 * hashFraction(`${seed}:${zone.id}:${level}:radius`));
      for (let index = 0; index < 8; index += 1) {
        const angle = phase + index * Math.PI / 4;
        const north = northKm + variedRadius * Math.sin(angle);
        const east = eastKm + variedRadius * Math.cos(angle);
        const centerDistanceKm = Math.hypot(north, east);
        if (centerDistanceKm > region.radiusKm * 0.93) continue;
        sites.push({ id: `${zone.id}:${level}:${index}`, zoneId: zone.id,
          level, northKm: north, eastKm: east, centerDistanceKm,
          point: pointAt(region, north, east) });
      }
    }
  }
  return sites;
}

function distanceRange(family, radiusKm) {
  switch (family) {
    case 'local': return [Math.min(2, radiusKm * 0.16), Math.min(8, radiusKm * 0.95)];
    case 'urban': return [Math.min(6, radiusKm * 0.4), Math.min(25, radiusKm * 1.2)];
    case 'suburban': return [Math.min(15, radiusKm * 0.7), Math.min(60, radiusKm * 1.6)];
    case 'regional': return [Math.min(30, radiusKm * 0.9), radiusKm * 1.8];
    case 'depot': return [Math.min(1.5, radiusKm * 0.15), Math.min(12, radiusKm * 0.8)];
    default: throw new Error('Unknown route family');
  }
}

function chooseMidway(sites, start, target, family, seed, targetRank) {
  const dx = target.eastKm - start.eastKm;
  const dy = target.northKm - start.northKm;
  const direct = Math.hypot(dx, dy);
  const bend = Math.min(Math.max(0.6, direct * (family === 'regional' ? 0.2 : 0.35)), 12);
  const side = hashFraction(`${seed}:${family}:${start.id}:${target.id}:${targetRank}`) < 0.5 ? -1 : 1;
  const wanted = {
    eastKm: (start.eastKm + target.eastKm) / 2 + side * (-dy / direct) * bend,
    northKm: (start.northKm + target.northKm) / 2 + side * (dx / direct) * bend
  };
  const pool = sites.filter((site) => site.id !== start.id && site.id !== target.id &&
    (family === 'regional' || family === 'suburban'
      ? site.level === 'core' || site.zoneId === start.zoneId || site.zoneId === target.zoneId
      : site.zoneId === start.zoneId || site.zoneId === target.zoneId));
  let best = null;
  let bestScore = Infinity;
  for (const site of pool) {
    const separation = Math.min(kilometerDistance(site, start), kilometerDistance(site, target));
    if (separation < Math.min(0.25, direct * 0.1)) continue;
    const score = kilometerDistance(site, wanted) +
      (site.level === 'core' && family === 'local' ? 0.15 : 0);
    if (score < bestScore || score === bestScore && site.id < best.id) {
      best = site;
      bestScore = score;
    }
  }
  return best;
}

function generateCandidates(regions, { seed = 'road-v3', existingRoutes = [], limit = 200,
  round = 0 } = {}) {
  const normalized = validateRegions(regions);
  if (typeof seed !== 'string' || seed.length > 128 || !Number.isInteger(limit) || limit < 0 ||
      limit > 5000 || !Number.isInteger(round) || round < 0 || round > 65_535) {
    throw new Error('Invalid candidate planning options');
  }
  if (limit === 0) return [];
  const planningSeed = round === 0 ? seed : `${seed}:planning-round:${round}`;
  const acceptedByFamily = new Map();
  for (const route of existingRoutes) {
    if (route?.regionId && route?.family) {
      const key = `${route.regionId}:${route.family}`;
      acceptedByFamily.set(key, (acceptedByFamily.get(key) || 0) + 1);
    }
  }
  const generated = [];
  for (const region of normalized) {
    const sites = createPlanningSites(region, planningSeed, round);
    const cores = sites.filter((site) => site.level === 'core');
    const zoneCounts = new Map(cores.map((site) => [site.zoneId, 0]));
    for (const route of existingRoutes) {
      if (route?.regionId !== region.id || !Array.isArray(route.points)) continue;
      const touched = new Set();
      const stride = Math.max(1, Math.floor(route.points.length / 100));
      for (let index = 0; index < route.points.length; index += stride) {
        const point = route.points[index];
        if (!Number.isFinite(point?.latitude) || !Number.isFinite(point?.longitude)) continue;
        let nearest = null;
        let distance = Infinity;
        for (const site of cores) {
          const delta = Math.hypot(point.latitude - site.point.latitude,
            (point.longitude - site.point.longitude) * Math.cos(region.centerLatitude * Math.PI / 180));
          if (delta < distance) { distance = delta; nearest = site.zoneId; }
        }
        if (nearest && distance * 111.32 <= region.radiusKm * 0.2) touched.add(nearest);
      }
      for (const id of touched) zoneCounts.set(id, zoneCounts.get(id) + 1);
    }
    for (const family of FAMILIES) {
      const [minimum, maximum] = distanceRange(family, region.radiusKm);
      const wantedDistance = (minimum + maximum) / 2;
      const profile = PROFILES[family];
      for (const start of sites) {
        const targets = sites.filter((site) => site.id !== start.id &&
          kilometerDistance(start, site) >= minimum && kilometerDistance(start, site) <= maximum)
          .sort((a, b) => {
            const preferenceA = Math.abs(kilometerDistance(start, a) - wantedDistance);
            const preferenceB = Math.abs(kilometerDistance(start, b) - wantedDistance);
            return preferenceA - preferenceB ||
              hash(`${planningSeed}:${family}:${start.id}:${a.id}`).localeCompare(hash(`${planningSeed}:${family}:${start.id}:${b.id}`));
          }).slice(0, TARGETS_PER_ORIGIN);
        for (let targetRank = 0; targetRank < targets.length; targetRank += 1) {
          const target = targets[targetRank];
          const midway = chooseMidway(sites, start, target, family, planningSeed, targetRank);
          if (!midway) continue;
          const closedLoop = family === 'local' || family === 'depot' || targetRank % 2 === 0;
          const directJourney = !closedLoop && family === 'suburban' && targetRank % 4 === 1;
          const locations = closedLoop
            ? [start.point, target.point, midway.point, start.point]
            : directJourney ? [start.point, target.point] : [start.point, midway.point, target.point];
          const costingOptions = { use_highways: profile.use_highways, use_distance: profile.use_distance };
          const digest = hash(JSON.stringify({ region: region.id, family,
            costing: 'auto', costingOptions, locations }));
          const zoneIds = [...new Set(directJourney
            ? [start.zoneId, target.zoneId] : [start.zoneId, target.zoneId, midway.zoneId])];
          const zoneDeficit = zoneIds.reduce((sum, id) => sum + 1 / (1 + zoneCounts.get(id)), 0);
          const familyDeficit = 1 / (1 + (acceptedByFamily.get(`${region.id}:${family}`) || 0));
          const cityPreference = ['local', 'urban', 'depot'].includes(family)
            ? 1.5 * (1 - start.centerDistanceKm / region.radiusKm) : 0;
          generated.push({ digest, regionId: region.id, family, profile: profile.name,
            costingOptions, closedLoop, locations, zoneIds,
            score: zoneDeficit * 3 + familyDeficit * 3 + cityPreference - targetRank * 0.02 });
        }
      }
    }
  }
  const seenLocations = new Set();
  const distinct = generated.sort((a, b) => b.score - a.score || a.digest.localeCompare(b.digest)).filter((candidate) => {
    const key = JSON.stringify({ regionId: candidate.regionId, locations: candidate.locations });
    if (seenLocations.has(key)) return false;
    seenLocations.add(key);
    return true;
  });
  const buckets = new Map();
  for (const region of normalized) {
    for (const family of FAMILIES) {
      buckets.set(`${region.id}:${family}:closed`, []);
      if (family !== 'local' && family !== 'depot') buckets.set(`${region.id}:${family}:destination`, []);
    }
  }
  for (const candidate of distinct) {
    buckets.get(`${candidate.regionId}:${candidate.family}:${candidate.closedLoop ? 'closed' : 'destination'}`).push(candidate);
  }
  // More short city tours are proposed first, while retaining destination and
  // longer regional journeys in every batch. This does not certify road class.
  const schedule = [];
  for (const region of normalized) {
    const id = region.id;
    schedule.push(`${id}:local:closed`, `${id}:local:closed`, `${id}:local:closed`,
      `${id}:urban:closed`, `${id}:urban:closed`, `${id}:urban:destination`,
      `${id}:suburban:closed`, `${id}:suburban:destination`,
      `${id}:regional:closed`, `${id}:regional:destination`,
      `${id}:depot:closed`, `${id}:depot:closed`);
  }
  const result = [];
  while (result.length < limit) {
    let added = false;
    for (const key of schedule) {
      if (result.length >= limit) break;
      const bucket = buckets.get(key);
      if (bucket.length) { result.push(bucket.shift()); added = true; }
    }
    if (!added) break;
  }
  return result;
}

module.exports = { FAMILIES, generateCandidates };
