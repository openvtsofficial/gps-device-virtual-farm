'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function abortError() {
  const error = new Error('Route preparation canceled');
  error.name = 'AbortError';
  return error;
}

function wait(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }
    function cancel() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(abortError());
    }
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

class ProviderBudget {
  constructor({ stateFile, now = Date.now, sleep = wait, minSpacingMs = 2000,
    dailyLimit = 100, actionLimit = 30, random = Math.random } = {}) {
    if (typeof stateFile !== 'string' || !path.isAbsolute(stateFile)) throw new Error('Provider budget needs absolute state file');
    if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || !Number.isInteger(actionLimit) || actionLimit < 1 ||
        !Number.isFinite(minSpacingMs)) throw new Error('Invalid provider budget limits');
    this.stateFile = stateFile;
    this.now = now;
    this.sleep = sleep;
    this.random = random;
    this.minSpacingMs = Math.max(2000, minSpacingMs);
    this.dailyLimit = Math.min(100, dailyLimit);
    this.actionLimit = Math.min(30, actionLimit);
    this.queue = Promise.resolve();
  }

  async readState() {
    try {
      const state = JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
      if (state.schemaVersion !== 1 || typeof state.day !== 'string' ||
          !Number.isInteger(state.dailyAttempts) || !Number.isFinite(state.lastAttemptMs) ||
          !Number.isFinite(state.cooldownUntilMs) || !state.actions || typeof state.actions !== 'object') {
        throw new Error('Invalid provider budget state');
      }
      return state;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { schemaVersion: 1, day: new Date(this.now()).toISOString().slice(0, 10),
        dailyAttempts: 0, lastAttemptMs: 0, cooldownUntilMs: 0, consecutiveFailures: 0, actions: {} };
    }
  }

  async writeState(state) {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx');
      try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, this.stateFile);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async run(actionId, operation, { signal } = {}) {
    if (typeof actionId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(actionId) ||
        ['constructor', '__proto__', 'prototype'].includes(actionId) || typeof operation !== 'function') {
      throw new Error('Invalid route preparation action');
    }
    const job = this.queue.catch(() => {}).then(() => this.#runOne(actionId, operation, signal));
    this.queue = job.catch(() => {});
    return job;
  }

  async #runOne(actionId, operation, signal) {
    const release = await this.#acquireInstallationLock(signal);
    try { return await this.#runLocked(actionId, operation, signal); }
    finally { await release(); }
  }

  async #acquireInstallationLock(signal) {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    const directory = `${this.stateFile}.lock`;
    const token = randomUUID();
    const started = Date.now();
    while (true) {
      if (signal?.aborted) throw abortError();
      try {
        await fs.mkdir(directory);
        try {
          await fs.writeFile(path.join(directory, 'owner.json'), JSON.stringify({ pid: process.pid, token }));
        } catch (error) {
          await fs.rm(directory, { recursive: true, force: true });
          throw error;
        }
        return async () => {
          try {
            const owner = JSON.parse(await fs.readFile(path.join(directory, 'owner.json'), 'utf8'));
            if (owner.token === token) await fs.rm(directory, { recursive: true, force: true });
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stat = await fs.stat(directory).catch((statError) => {
          if (statError.code === 'ENOENT') return null;
          throw statError;
        });
        if (!stat) continue;
        if (Date.now() - stat.mtimeMs > 120_000) {
          let owner;
          try { owner = JSON.parse(await fs.readFile(path.join(directory, 'owner.json'), 'utf8')); }
          catch { owner = null; }
          let alive = false;
          if (Number.isInteger(owner?.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0); alive = true; }
            catch (probe) { alive = probe.code !== 'ESRCH'; }
          }
          if (!alive) { await fs.rm(directory, { recursive: true, force: true }); continue; }
        }
        if (Date.now() - started > 60_000) throw new Error('Public routing installation lock timed out');
        await this.sleep(200, signal);
      }
    }
  }

  async #runLocked(actionId, operation, signal) {
    if (signal?.aborted) throw abortError();
    const state = await this.readState();
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day < state.day) throw new Error('System clock moved backward; provider budget remains locked');
    if (day > state.day) {
      state.day = day;
      state.dailyAttempts = 0;
      state.actions = {};
    }
    const actionAttempts = state.actions[actionId] || 0;
    if (actionAttempts >= this.actionLimit || state.dailyAttempts >= this.dailyLimit) {
      const error = new Error('Provider request budget reached');
      error.code = 'BUDGET_EXHAUSTED';
      throw error;
    }
    if (this.now() < state.cooldownUntilMs) {
      const error = new Error('Public routing provider is cooling down');
      error.code = 'PROVIDER_COOLDOWN';
      error.retryAtMs = state.cooldownUntilMs;
      throw error;
    }
    const delay = state.lastAttemptMs + this.minSpacingMs - this.now();
    if (delay > 0) await this.sleep(delay, signal);
    if (signal?.aborted) throw abortError();
    state.lastAttemptMs = this.now();
    state.dailyAttempts += 1;
    state.actions[actionId] = actionAttempts + 1;
    await this.writeState(state); // Count before network: a crash cannot refund an attempt.
    try {
      const result = await operation(signal);
      state.consecutiveFailures = 0;
      await this.writeState(state);
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      if (error.status === 429) {
        state.cooldownUntilMs = Math.max(state.cooldownUntilMs, this.now() + Math.max(15 * 60_000, error.retryAfterMs || 0));
      } else if (!Number.isInteger(error.status) || error.status >= 500) {
        state.consecutiveFailures = (state.consecutiveFailures || 0) + 1;
        if (state.consecutiveFailures >= 3) {
          const jitter = 0.8 + Math.max(0, Math.min(1, this.random())) * 0.4;
          state.cooldownUntilMs = Math.max(state.cooldownUntilMs,
            this.now() + Math.min(60 * 60_000,
              Math.floor(60_000 * 2 ** Math.min(8, state.consecutiveFailures - 3) * jitter)));
        }
      }
      await this.writeState(state);
      throw error;
    }
  }
}

module.exports = { ProviderBudget, abortError };
