'use strict';

const DEFAULT_CONFIG = Object.freeze({
  host: '127.0.0.1',
  port: 5023,
  deviceCount: 100,
  baseLatitude: 28.6139,
  baseLongitude: 77.209,
  movingPercent: 25,
  movingIntervalMs: 10_000,
  parkedIntervalMs: 5 * 60_000,
  heartbeatIntervalMs: 60_000,
  connectionRatePerSecond: 250,
  connectTimeoutMs: 10_000,
  loginAckTimeoutMs: 5_000,
  maxLoginAttempts: 3,
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 30_000,
  metricsIntervalMs: 1_000,
  logDetail: 'summary'
});

const LIMITS = Object.freeze({
  minDevices: 1,
  maxDevices: 50_000,
  minMovingPercent: 25,
  maxMovingPercent: 100,
  minConnectionRate: 1,
  maxConnectionRate: 2_000
});

const IMEI_START = 358988888800001n;

module.exports = {
  DEFAULT_CONFIG,
  LIMITS,
  IMEI_START
};

