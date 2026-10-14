'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const SCHEMA_VERSION = 1;
const MAX_STATUS_BYTES = 16_384;
const STATES = new Set(['running', 'ready', 'usable', 'incomplete', 'blocked', 'canceled']);
const NUMBER_FIELDS = ['routeCount', 'savedRouteCount', 'targetRouteCount', 'minimumUsableRouteCount', 'attempts', 'accepted', 'rejected',
  'attemptBudget', 'candidateCount', 'remainingCandidates', 'planningRound',
  'planningRoundLimit', 'attemptsSinceAccepted', 'elapsedMs', 'estimatedRemainingMs', 'retryInMs',
  'retryAttempt', 'maxRetryAttempts'];
const STRING_FIELDS = ['status', 'stage', 'phase', 'reason', 'statusDetail'];

function preparationScope(config, targetRouteCount = 2000) {
  const regions = config?.road?.regions;
  if (!Array.isArray(regions) || regions.length === 0 ||
      typeof config.scenarioSeed !== 'string' ||
      !Number.isInteger(targetRouteCount) || targetRouteCount < 0 || targetRouteCount > 2500) {
    throw new Error('Invalid road preparation status scope');
  }
  const identity = { seed: config.scenarioSeed, targetRouteCount,
    regions: regions.map(({ id, centerLatitude, centerLongitude, radiusKm, fleetWeight }) =>
      [id, centerLatitude, centerLongitude, radiusKm, fleetWeight]) };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function normalizeStatus(status) {
  if (!status || typeof status !== 'object' || !STATES.has(status.state)) {
    throw new Error('Invalid road preparation status');
  }
  const normalized = { state: status.state };
  for (const field of NUMBER_FIELDS) {
    const value = status[field];
    if (value === undefined || value === null) continue;
    if (!Number.isFinite(value) || value < 0 || value > 30 * 24 * 60 * 60 * 1000) {
      throw new Error(`Invalid road preparation status ${field}`);
    }
    normalized[field] = Math.round(value);
  }
  for (const field of STRING_FIELDS) {
    const value = status[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || value.length > 300) {
      throw new Error(`Invalid road preparation status ${field}`);
    }
    normalized[field] = value;
  }
  if (status.retryAt !== undefined && status.retryAt !== null) {
    if (!Number.isInteger(status.retryAt) || status.retryAt < 0 ||
        status.retryAt > 4_102_444_800_000) {
      throw new Error('Invalid road preparation retry time');
    }
    normalized.retryAt = status.retryAt;
  }
  if (status.resumeAvailable !== undefined) {
    if (typeof status.resumeAvailable !== 'boolean') {
      throw new Error('Invalid road preparation resume availability');
    }
    normalized.resumeAvailable = status.resumeAvailable;
  }
  if (status.composition !== undefined) {
    const composition = status.composition;
    if (!composition || typeof composition !== 'object' ||
        ['cityRoutes', 'regionalRoutes', 'intercityRoutes'].some((key) =>
          !Number.isInteger(composition[key]) || composition[key] < 0 || composition[key] > 2500)) {
      throw new Error('Invalid road preparation composition');
    }
    normalized.composition = { cityRoutes: composition.cityRoutes,
      regionalRoutes: composition.regionalRoutes,
      intercityRoutes: composition.intercityRoutes };
  }
  return normalized;
}

class RoadPreparationStatusStore {
  constructor(rootDir) {
    if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) {
      throw new Error('Road preparation status directory must be absolute');
    }
    this.filePath = path.join(rootDir, 'jobs', 'preparation-status.json');
  }

  async read(scope) {
    if (!/^[a-f0-9]{64}$/.test(scope || '')) return null;
    try {
      const raw = await fs.readFile(this.filePath);
      if (raw.length > MAX_STATUS_BYTES) return null;
      const record = JSON.parse(raw.toString('utf8'));
      if (record.schemaVersion !== SCHEMA_VERSION || record.scope !== scope ||
          !Number.isInteger(record.lastUpdatedAt) || record.lastUpdatedAt < 0) return null;
      const status = normalizeStatus(record);
      return { ...status, state: status.state === 'running' ? 'interrupted' : status.state,
        ...(status.state === 'running' ? { estimatedRemainingMs: null,
          retryInMs: null, retryAt: null } : {}),
        lastUpdatedAt: record.lastUpdatedAt };
    } catch { return null; }
  }

  async write(scope, status) {
    if (!/^[a-f0-9]{64}$/.test(scope || '')) {
      throw new Error('Invalid road preparation status scope');
    }
    const record = { schemaVersion: SCHEMA_VERSION, scope,
      ...normalizeStatus(status), lastUpdatedAt: Date.now() };
    const payload = JSON.stringify(record);
    if (Buffer.byteLength(payload) > MAX_STATUS_BYTES) {
      throw new Error('Road preparation status exceeds size limit');
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, payload, { flag: 'wx' });
      await fs.rename(temporary, this.filePath);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    return record;
  }
}

module.exports = { RoadPreparationStatusStore, preparationScope };
