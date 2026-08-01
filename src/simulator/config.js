'use strict';

const net = require('node:net');
const { DEFAULT_CONFIG, LIMITS } = require('./constants');

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

function validateConfig(input = {}) {
  const merged = { ...DEFAULT_CONFIG, ...input };
  const logDetail = merged.logDetail === 'detailed' ? 'detailed' : 'summary';

  return {
    host: normalizeHost(merged.host),
    port: requireInteger(merged.port, 'Port', 1, 65_535),
    deviceCount: requireInteger(
      merged.deviceCount,
      'Device count',
      LIMITS.minDevices,
      LIMITS.maxDevices
    ),
    baseLatitude: requireFinite(merged.baseLatitude, 'Base latitude', -90, 90),
    baseLongitude: requireFinite(merged.baseLongitude, 'Base longitude', -180, 180),
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
    logDetail
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
    logDetail: config.logDetail
  };
}

module.exports = {
  normalizeHost,
  publicSettings,
  validateConfig
};

