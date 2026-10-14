'use strict';

const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_GENERATIONS = 3;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_STATES = 50_000;
const FILE_GENERATION_WIDTH = 12;

class CheckpointCorruptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CheckpointCorruptError';
  }
}

class CheckpointIncompatibleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CheckpointIncompatibleError';
  }
}

/**
 * Stores complete, compact road-vehicle snapshots outside settings.json.
 * The caller decides when to save (normally every 5–15 seconds and on clean stop).
 * There is no filesystem work on the per-device packet path.
 */
class RoadCheckpointStore {
  constructor(userDataDirectory, options = {}) {
    if (typeof userDataDirectory !== 'string' || !path.isAbsolute(userDataDirectory)) {
      throw new TypeError('userDataDirectory must be an absolute path');
    }
    const { runId, routePackDigest } = options;
    if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(runId)) {
      throw new TypeError('runId must be 1–64 safe filename characters');
    }
    if (typeof routePackDigest !== 'string' || !/^[a-fA-F0-9]{64}$/.test(routePackDigest)) {
      throw new TypeError('routePackDigest must be a SHA-256 hexadecimal digest');
    }
    const maxGenerations = options.maxGenerations ?? DEFAULT_MAX_GENERATIONS;
    if (!Number.isInteger(maxGenerations) || maxGenerations < 2 || maxGenerations > 32) {
      throw new TypeError('maxGenerations must be an integer between 2 and 32');
    }
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 1024 * 1024 * 1024) {
      throw new TypeError('maxBytes must be between 1 KiB and 1 GiB');
    }

    this.directory = path.join(userDataDirectory, 'road-vehicle-state', 'checkpoints');
    this.runId = runId;
    this.routePackDigest = routePackDigest.toLowerCase();
    this.maxGenerations = maxGenerations;
    this.maxBytes = maxBytes;
    this.generation = 0;
    this.latestFileGeneration = 0;
    this.corruptGenerations = new Set();
    this.closing = false;
    this.closed = false;
    this.loaded = false;
    this.loadPromise = null;
    this.queue = Promise.resolve();
    this.lastOperation = Promise.resolve();
  }

  async load() {
    if (this.closed) throw new Error('Checkpoint store is closed');
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.#load().catch((error) => {
      this.loadPromise = null;
      throw error;
    });
    return this.loadPromise;
  }

  /**
   * Queue one complete in-memory snapshot. The state array is cloned before any
   * asynchronous work, so subsequent motion cannot change the queued snapshot.
   */
  async save(states) {
    if (this.closed || this.closing) {
      return Promise.reject(new Error('Checkpoint store is closed'));
    }
    const snapshot = cloneAndValidateStates(states);
    const operation = this.queue.then(async () => {
      if (!this.loaded) await this.load();
      return this.#save(snapshot);
    });
    this.lastOperation = operation;
    this.queue = operation.catch(() => {});
    return operation;
  }

  async flush() {
    await this.queue;
    await this.lastOperation;
  }

  async close() {
    if (this.closed) return this.flush();
    this.closing = true;
    await this.flush();
    this.closed = true;
  }

  async #load() {
    const files = await this.#generationFiles();
    if (files.length === 0) {
      this.loaded = true;
      this.generation = 0;
      this.latestFileGeneration = 0;
      return null;
    }

    this.latestFileGeneration = files[0].generation;
    let corruptCount = 0;
    for (const file of files) {
      let envelope;
      try {
        const filePath = path.join(this.directory, file.name);
        const stat = await fs.stat(filePath);
        if (!stat.isFile() || stat.size > this.maxBytes) {
          throw new CheckpointCorruptError('Checkpoint exceeds size limit or is not a file');
        }
        envelope = JSON.parse(await fs.readFile(filePath, 'utf8'));
        validateEnvelope(envelope, this.runId, file.generation);
      } catch (error) {
        if (error.code === 'EACCES' || error.code === 'EPERM') throw error;
        corruptCount += 1;
        this.corruptGenerations.add(file.generation);
        continue;
      }

      const payload = envelope.payload;
      if (payload.schemaVersion !== SCHEMA_VERSION) {
        throw new CheckpointIncompatibleError(
          `Checkpoint schema ${payload.schemaVersion} is not supported (expected ${SCHEMA_VERSION})`
        );
      }
      if (payload.routePackDigest !== this.routePackDigest) {
        throw new CheckpointIncompatibleError(
          'Checkpoint is bound to a different route pack digest; an explicit fresh start or migration is required'
        );
      }

      this.loaded = true;
      this.generation = file.generation;
      return {
        generation: file.generation,
        createdAtUtc: payload.createdAtUtc,
        routePackDigest: payload.routePackDigest,
        states: payload.states,
        recoveredFromCorruption: corruptCount > 0
      };
    }

    throw new CheckpointCorruptError(
      `No intact checkpoint generation exists for run ${this.runId}`
    );
  }

  async #save(states) {
    await fs.mkdir(this.directory, { recursive: true });
    const generation = this.latestFileGeneration + 1;
    if (generation > 999_999_999_999) throw new Error('Checkpoint generation limit reached');
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      runId: this.runId,
      routePackDigest: this.routePackDigest,
      generation,
      createdAtUtc: new Date().toISOString(),
      states
    };
    const envelope = {
      payload,
      checksum: sha256(JSON.stringify(payload))
    };
    const content = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(content) > this.maxBytes) {
      throw new RangeError('Checkpoint exceeds configured size limit');
    }

    const finalPath = path.join(this.directory, fileName(this.runId, generation));
    const temporaryPath = `${finalPath}.${process.pid}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporaryPath, finalPath);
      await syncDirectoryIfSupported(this.directory);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporaryPath).catch(() => {});
      throw error;
    }

    this.generation = generation;
    this.latestFileGeneration = generation;
    this.loadPromise = Promise.resolve({
      generation,
      createdAtUtc: payload.createdAtUtc,
      routePackDigest: this.routePackDigest,
      states,
      recoveredFromCorruption: false
    });
    await this.#pruneOldGenerations();
    return { generation, createdAtUtc: payload.createdAtUtc, stateCount: states.length };
  }

  async #pruneOldGenerations() {
    const files = await this.#generationFiles();
    let kept = 0;
    for (const file of files) {
      if (!this.corruptGenerations.has(file.generation) && kept < this.maxGenerations) {
        kept += 1;
        continue;
      }
      await fs.unlink(path.join(this.directory, file.name));
      this.corruptGenerations.delete(file.generation);
    }
  }

  async #generationFiles() {
    let names;
    try {
      names = await fs.readdir(this.directory);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const prefix = `${this.runId}-`;
    const result = [];
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
      const digits = name.slice(prefix.length, -'.json'.length);
      if (!/^\d{12}$/.test(digits)) continue;
      result.push({ name, generation: Number(digits) });
    }
    return result.sort((a, b) => b.generation - a.generation);
  }
}

function fileName(runId, generation) {
  return `${runId}-${String(generation).padStart(FILE_GENERATION_WIDTH, '0')}.json`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validateEnvelope(envelope, runId, generation) {
  if (!isPlainObject(envelope) || !isPlainObject(envelope.payload)) {
    throw new CheckpointCorruptError('Checkpoint envelope is malformed');
  }
  const { payload, checksum } = envelope;
  if (typeof checksum !== 'string' || !/^[a-f0-9]{64}$/.test(checksum) ||
      checksum !== sha256(JSON.stringify(payload))) {
    throw new CheckpointCorruptError('Checkpoint checksum does not match');
  }
  if (payload.runId !== runId || payload.generation !== generation ||
      typeof payload.createdAtUtc !== 'string' ||
      typeof payload.routePackDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(payload.routePackDigest)) {
    throw new CheckpointCorruptError('Checkpoint identity or metadata is malformed');
  }
  cloneAndValidateStates(payload.states);
}

function cloneAndValidateStates(states) {
  if (!Array.isArray(states) || states.length > MAX_STATES) {
    throw new TypeError(`states must be an array of at most ${MAX_STATES} records`);
  }
  const seen = new Set();
  for (const state of states) {
    if (!isPlainObject(state) || !/^\d{15}$/.test(state.imei)) {
      throw new TypeError('Each checkpoint state needs a 15-digit IMEI');
    }
    if (seen.has(state.imei)) throw new TypeError(`Duplicate checkpoint IMEI ${state.imei}`);
    seen.add(state.imei);
  }
  assertJsonSafe(states, 0, new WeakSet());
  return JSON.parse(JSON.stringify(states));
}

function assertJsonSafe(value, depth, seen) {
  if (depth > 16) throw new TypeError('Checkpoint state is nested too deeply');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Checkpoint state contains a non-finite number');
    return;
  }
  if (typeof value !== 'object' || (!Array.isArray(value) && !isPlainObject(value))) {
    throw new TypeError('Checkpoint state must contain JSON-safe values');
  }
  if (seen.has(value)) throw new TypeError('Checkpoint state contains a cycle or repeated object');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonSafe(item, depth + 1, seen);
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new TypeError('Checkpoint state contains an unsafe key');
      }
      assertJsonSafe(item, depth + 1, seen);
    }
  }
  seen.delete(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

async function syncDirectoryIfSupported(directory) {
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    if (handle) await handle.close();
  }
}

module.exports = {
  CheckpointCorruptError,
  CheckpointIncompatibleError,
  RoadCheckpointStore,
  SCHEMA_VERSION
};
