'use strict';

const net = require('node:net');
const { DEFAULT_CONFIG, LIMITS } = require('./constants');
const { validateRegions } = require('../road/region-planner');

function requireInteger(value, name, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function requireFinite(value, name, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return parsed;
}

function normalizeHost(value) {
  let host = String(value ?? '').trim();
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }

  if (!host || host.length > 253 || /[\s/\\]/.test(host)) {
    throw new Error('Destination must be a valid IP address or hostname');
  }

  if (net.isIP(host)) return host;

  const labels = host.split('.');
  const hostnameIsValid = labels.every((label) =>
    label.length > 0 &&
    label.length <= 63 &&
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label)
  );

  if (!hostnameIsValid) {
    throw new Error('Destination must be a valid IP address or hostname');
  }

  return host.toLowerCase();
}

function normalizeRoad(input, baseLatitude, baseLongitude) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Road settings must be an object');
  }
  const regionMode = input.regionMode === undefined ? 'single' : input.regionMode;
  if (regionMode !== 'single' && regionMode !== 'multi') {
    throw new Error('Road region mode must be single or multi');
  }
  const radiusKm = requireFinite(input.radiusKm ?? 50, 'Road radius', 2, 350);
  const suppliedRegions = input.regions ?? [];
  if (!Array.isArray(suppliedRegions) || suppliedRegions.length > 8) {
    throw new Error('Road regions must be an array of at most 8 regions');
  }
  const regions = regionMode === 'single'
    ? [{ id: 'default', centerLatitude: baseLatitude, centerLongitude: baseLongitude,
      radiusKm, fleetWeight: 1 }]
    : suppliedRegions.map((region) => {
      if (!region || typeof region !== 'object' || Array.isArray(region) ||
          typeof region.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(region.id)) {
        throw new Error('Each road region needs a simple unique ID');
      }
      return {
        id: region.id,
        centerLatitude: requireFinite(region.centerLatitude, 'Region latitude', -90, 90),
        centerLongitude: requireFinite(region.centerLongitude, 'Region longitude', -180, 180),
        radiusKm: requireFinite(region.radiusKm, 'Region radius', 2, 350),
        fleetWeight: requireFinite(region.fleetWeight, 'Region weight', 0.001, 1)
      };
    });
  if (regionMode === 'multi' && (regions.length === 0 ||
      new Set(regions.map((region) => region.id)).size !== regions.length ||
      Math.abs(regions.reduce((sum, region) => sum + region.fleetWeight, 0) - 1) > 0.001)) {
    throw new Error('Multi-region weights must be unique IDs and sum to 1');
  }
  const selectedRoutePackDigests = input.selectedRoutePackDigests ?? [];
  if (!Array.isArray(selectedRoutePackDigests) || selectedRoutePackDigests.length > 8 ||
      selectedRoutePackDigests.some((digest) => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) ||
      new Set(selectedRoutePackDigests).size !== selectedRoutePackDigests.length) {
    throw new Error('Selected route packs must be unique SHA-256 digests');
  }
  if (input.requireEnterpriseDiversityGate !== undefined &&
      typeof input.requireEnterpriseDiversityGate !== 'boolean') {
    throw new Error('Road diversity gate must be a boolean');
  }
  if (input.offlineTravelPolicy !== undefined && input.offlineTravelPolicy !== 'freeze') {
    throw new Error('Road offline travel policy must be freeze');
  }
  return {
    regionMode,
    radiusKm,
    regions,
    selectedRoutePackDigests,
    requireEnterpriseDiversityGate: input.requireEnterpriseDiversityGate ?? true,
    offlineTravelPolicy: 'freeze'
  };
}

function validateConfig(input = {}) {
  const merged = { ...DEFAULT_CONFIG, ...input };
  const logDetail = merged.logDetail === 'detailed' ? 'detailed' : 'summary';
  const baseLatitude = requireFinite(merged.baseLatitude, 'Base latitude', -90, 90);
  const baseLongitude = requireFinite(merged.baseLongitude, 'Base longitude', -180, 180);
  const movementMode = merged.movementMode ?? 'synthetic';
  if (movementMode !== 'synthetic' && movementMode !== 'real-road') {
    throw new Error('Movement mode must be synthetic or real-road');
  }
  const scenarioSeed = merged.scenarioSeed ?? 'default';
  if (typeof scenarioSeed !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(scenarioSeed)) {
    throw new Error('Scenario seed must contain 1–64 letters, numbers, dots, underscores or hyphens');
  }
  const road = normalizeRoad(merged.road, baseLatitude, baseLongitude);
  if (movementMode === 'real-road') validateRegions(road.regions);

  return {
    host: normalizeHost(merged.host),
    port: requireInteger(merged.port, 'Port', 1, 65_535),
    deviceCount: requireInteger(
      merged.deviceCount,
      'Device count',
      LIMITS.minDevices,
      LIMITS.maxDevices
    ),
    baseLatitude,
    baseLongitude,
    movingPercent: requireFinite(
      merged.movingPercent,
      'Moving percentage',
      LIMITS.minMovingPercent,
      LIMITS.maxMovingPercent
    ),
    movingIntervalMs: requireInteger(merged.movingIntervalMs, 'Moving interval', 100, 86_400_000),
    parkedIntervalMs: requireInteger(merged.parkedIntervalMs, 'Parked interval', 100, 86_400_000),
    heartbeatIntervalMs: requireInteger(merged.heartbeatIntervalMs, 'Heartbeat interval', 100, 86_400_000),
    connectionRatePerSecond: requireInteger(
      merged.connectionRatePerSecond,
      'Connection ramp',
      LIMITS.minConnectionRate,
      LIMITS.maxConnectionRate
    ),
    connectTimeoutMs: requireInteger(merged.connectTimeoutMs, 'Connect timeout', 100, 120_000),
    loginAckTimeoutMs: requireInteger(merged.loginAckTimeoutMs, 'Login ACK timeout', 100, 120_000),
    maxLoginAttempts: requireInteger(merged.maxLoginAttempts, 'Maximum login attempts', 1, 10),
    reconnectBaseMs: requireInteger(merged.reconnectBaseMs, 'Reconnect base', 100, 120_000),
    reconnectMaxMs: requireInteger(merged.reconnectMaxMs, 'Reconnect maximum', 100, 600_000),
    metricsIntervalMs: requireInteger(merged.metricsIntervalMs, 'Metrics interval', 100, 60_000),
    logDetail,
    movementMode,
    scenarioSeed,
    road
  };
}

function publicSettings(config) {
  return {
    host: config.host,
    port: config.port,
    deviceCount: config.deviceCount,
    baseLatitude: config.baseLatitude,
    baseLongitude: config.baseLongitude,
    connectionRatePerSecond: config.connectionRatePerSecond,
    logDetail: config.logDetail,
    movementMode: config.movementMode,
    scenarioSeed: config.scenarioSeed,
    road: config.road
  };
}

module.exports = {
  normalizeHost,
  publicSettings,
  validateConfig
};

