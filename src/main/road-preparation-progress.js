'use strict';

const MAP_PHASES = new Set(['map-index', 'map-select', 'download', 'downloaded',
  'clip', 'clipped', 'merge', 'merged', 'build', 'graph-ready']);
const THROTTLED_PHASES = new Set(['request', 'accepted', 'rejected']);
const BLOCKED_RESULTS = new Set(['provider-unavailable', 'road-attributes-unavailable',
  'graph-changed', 'geometry-limit', 'route-limit', 'rate-limited',
  'BUDGET_EXHAUSTED', 'PROVIDER_DISABLED', 'PROVIDER_COOLDOWN',
  'search-stalled', 'candidates-exhausted']);

class RoadPreparationProgress {
  constructor({ store, scope, emit, now = Date.now, targetRouteCount = 2000,
    attemptBudget = 4000, onPersistenceError } = {}) {
    if (!store || typeof store.read !== 'function' || typeof store.write !== 'function' ||
        typeof scope !== 'string' || typeof emit !== 'function' || typeof now !== 'function') {
      throw new Error('Road preparation progress needs storage and an event target');
    }
    this.store = store;
    this.scope = scope;
    this.emit = emit;
    this.now = now;
    this.onPersistenceError = onPersistenceError;
    this.status = { state: 'running', stage: 'map', phase: 'starting',
      routeCount: 0, savedRouteCount: 0, targetRouteCount, attempts: 0,
      accepted: 0, rejected: 0, attemptBudget, estimatedRemainingMs: null };
    this.startedAt = now();
    this.lastPersistAt = 0;
    this.lastEmitAt = 0;
    this.lastRouteCount = 0;
    this.samples = [];
    this.pending = Promise.resolve();
  }

  async start() {
    const previous = await this.store.read(this.scope);
    if (previous) {
      this.status.routeCount = previous.savedRouteCount ?? previous.routeCount ?? 0;
      this.status.savedRouteCount = previous.savedRouteCount ?? previous.routeCount ?? 0;
    }
    this.lastRouteCount = this.status.routeCount;
    await this.#persist(true);
    this.emit({ ...this.status, elapsedMs: 0 });
  }

  #eta() {
    const attempts = this.status.attempts;
    if (attempts < 10 || this.samples.length < 2) return null;
    const first = this.samples[0];
    const last = this.samples.at(-1);
    const gained = last.count - first.count;
    const duration = last.at - first.at;
    if (gained < 3 || duration < 5_000 || duration <= 0) return null;
    const remaining = Math.max(0, this.status.targetRouteCount - this.status.routeCount);
    const estimate = remaining * duration / gained;
    return Number.isFinite(estimate) && estimate <= 24 * 60 * 60 * 1000
      ? Math.round(estimate) : null;
  }

  async #persist(immediate = false) {
    const at = this.now();
    if (!immediate && at - this.lastPersistAt < 2_000) return;
    this.lastPersistAt = at;
    const snapshot = { ...this.status, elapsedMs: at - this.startedAt };
    this.pending = this.pending.then(() => this.store.write(this.scope, snapshot))
      .catch((error) => this.onPersistenceError?.(error));
    if (immediate) await this.pending;
  }

  update(progress) {
    const now = this.now();
    const stage = MAP_PHASES.has(progress.phase)
      ? progress.phase === 'graph-ready' ? 'routes' : progress.phase
      : progress.phase === 'saved' ? 'saving' : 'routes';
    this.status.stage = stage;
    this.status.phase = progress.phase || 'working';
    for (const key of ['routeCount', 'savedRouteCount', 'targetRouteCount', 'minimumUsableRouteCount', 'attempts',
      'accepted', 'rejected', 'attemptBudget', 'candidateCount', 'remainingCandidates',
      'planningRound', 'planningRoundLimit', 'attemptsSinceAccepted']) {
      if (Number.isFinite(progress[key])) this.status[key] = progress[key];
    }
    if (progress.phase === 'saved' && Number.isInteger(progress.routeCount)) {
      this.status.savedRouteCount = progress.routeCount;
    }
    if (progress.composition) this.status.composition = progress.composition;
    if (progress.reason) this.status.reason = String(progress.reason).slice(0, 300);
    else if (progress.phase !== 'retrying') delete this.status.reason;
    if (progress.phase === 'retrying') {
      this.status.retryInMs = progress.retryInMs;
      this.status.retryAt = now + (progress.retryInMs || 0);
      this.status.retryAttempt = progress.retryAttempt;
      this.status.maxRetryAttempts = progress.maxRetryAttempts;
    } else {
      delete this.status.retryInMs;
      delete this.status.retryAt;
      delete this.status.retryAttempt;
      delete this.status.maxRetryAttempts;
    }
    if (this.status.routeCount > this.lastRouteCount) {
      this.samples.push({ at: now, count: this.status.routeCount });
      this.lastRouteCount = this.status.routeCount;
    }
    this.samples = this.samples.filter((sample) => now - sample.at <= 120_000).slice(-40);
    this.status.estimatedRemainingMs = stage === 'routes' || stage === 'saving'
      ? this.#eta() : null;
    const event = { ...progress, ...this.status, elapsedMs: now - this.startedAt };
    void this.#persist(['saved', 'blocked', 'retrying'].includes(progress.phase));
    if (THROTTLED_PHASES.has(progress.phase) && now - this.lastEmitAt < 200) return;
    this.lastEmitAt = now;
    this.emit(event);
  }

  async finish(result) {
    this.status.state = result.status === 'ready' ? 'ready'
      : result.status === 'usable' ? 'usable'
      : result.status === 'canceled' ? 'canceled'
        : BLOCKED_RESULTS.has(result.status) ? 'blocked' : 'incomplete';
    this.status.status = result.status;
    this.status.stage = 'complete';
    this.status.phase = 'complete';
    this.status.estimatedRemainingMs = null;
    if (result.status === 'ready') delete this.status.reason;
    else this.status.reason = String(result.statusDetail || result.reason || result.status).slice(0, 300);
    if (typeof result.statusDetail === 'string') this.status.statusDetail = result.statusDetail;
    else delete this.status.statusDetail;
    if (typeof result.resumeAvailable === 'boolean') this.status.resumeAvailable = result.resumeAvailable;
    delete this.status.retryInMs;
    delete this.status.retryAt;
    delete this.status.retryAttempt;
    delete this.status.maxRetryAttempts;
    for (const key of ['routeCount', 'targetRouteCount', 'minimumUsableRouteCount', 'attempts', 'accepted', 'rejected',
      'attemptBudget', 'candidateCount', 'remainingCandidates', 'planningRound',
      'planningRoundLimit', 'attemptsSinceAccepted', 'savedRouteCount']) {
      if (Number.isFinite(result[key])) this.status[key] = result[key];
    }
    if (result.composition) this.status.composition = result.composition;
    await this.#persist(true);
    this.emit({ ...this.status, elapsedMs: this.now() - this.startedAt });
  }

  async fail(error, canceled = false) {
    this.status.state = canceled ? 'canceled' : 'blocked';
    this.status.status = canceled ? 'canceled' : 'failed';
    this.status.stage = 'complete';
    this.status.phase = 'complete';
    this.status.reason = String(error?.message || error || 'Route preparation failed').slice(0, 300);
    this.status.estimatedRemainingMs = null;
    delete this.status.retryInMs;
    delete this.status.retryAt;
    delete this.status.retryAttempt;
    delete this.status.maxRetryAttempts;
    await this.#persist(true);
    this.emit({ ...this.status, elapsedMs: this.now() - this.startedAt });
  }
}

module.exports = { RoadPreparationProgress };
