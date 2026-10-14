'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { validateRegions } = require('./region-planner');
const { generateCandidates } = require('./candidate-planner');
const { validateValhallaResponseWithSources } = require('./route-validator');
const { createNoveltyIndex } = require('./diversity-evaluator');
const { evaluateCoverage } = require('./route-capacity');
const { MAX_ACTIVE_ROUTE_POINTS } = require('./route-pack-store');
const { isRetryableLocalFailure, waitForLocalRetry } = require('./local-retry-policy');

const LOCAL_TARGET_LIMIT = 2500;
const LOCAL_ATTEMPT_LIMIT = 5000;
const PUBLIC_ATTEMPT_LIMIT = 30;
const LOCAL_BATCH_SIZE = 100;
const LOCAL_BATCH_MAX_AGE_MS = 30_000;
const MINIMUM_USABLE_ROUTE_COUNT = 500;
const MAX_LOCAL_PLANNING_ROUNDS = 64;
const LATER_ROUND_CANDIDATE_LIMIT = 2000;
const MAX_EMPTY_PLANNING_ROUNDS = 3;
const MAX_LOCAL_ATTEMPTS_WITHOUT_GAIN = 500;
const MAX_CONSECUTIVE_NO_GAIN_ROUNDS = 3;
// A Valhalla response can contain one main route and at most three alternates.
const MAX_ROUTES_PER_CANDIDATE = 4;
const REJECTED_STATE_BATCH_SIZE = 25;
const LOCAL_RETRY_DELAYS_MS = [1_000, 3_000];

function sourceScope(metadata) {
  return createHash('sha256').update(JSON.stringify({
    id: metadata.id,
    endpointFamily: metadata.endpointFamily,
    graphVersion: metadata.graphVersion,
    tilesetLastModified: metadata.tilesetLastModified
  })).digest('hex');
}

function reusableSource(previous, current, local) {
  if (previous?.id !== current.id) return false;
  if (!local) return true;
  return previous.endpointFamily === current.endpointFamily &&
    previous.graphVersion === current.graphVersion &&
    previous.tilesetLastModified === current.tilesetLastModified;
}

function catalogTargetReady(routeCount, targetRouteCount, composition, regions) {
  if (targetRouteCount <= 0 || routeCount < targetRouteCount) return false;
  if (targetRouteCount < 100) return true;
  return composition.cityRoutes >= Math.ceil(targetRouteCount * 0.4) &&
    composition.regionalRoutes >= Math.ceil(targetRouteCount * 0.15) &&
    (!regions.some((region) => region.radiusKm >= 50) ||
      composition.intercityRoutes >= Math.ceil(targetRouteCount * 0.05));
}

class RoutePreparationCoordinator {
  constructor({ store, provider } = {}) {
    if (!store || typeof store.listPacks !== 'function' || typeof store.writePack !== 'function') {
      throw new Error('Route preparation needs a route pack store');
    }
    this.store = store;
    this.provider = provider;
    this.jobStateFile = path.join(store.rootDir, 'jobs', 'preparation-state.json');
  }

  async #loadJobState(scope) {
    const fresh = () => ({ schemaVersion: 2, scope, attempted: [], planningRounds: {},
      planningSearch: {} });
    let contents;
    try {
      contents = await fs.readFile(this.jobStateFile, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return fresh();
    }
    let state;
    try { state = JSON.parse(contents); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    const valid = state && typeof state === 'object' && !Array.isArray(state) &&
      state.schemaVersion === 2 && typeof state.scope === 'string' &&
      /^[a-f0-9]{64}$/.test(state.scope) && Array.isArray(state.attempted) &&
      state.attempted.length <= 20_000 &&
      state.attempted.every((digest) => typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest)) &&
      (state.planningRounds === undefined ||
        (state.planningRounds && typeof state.planningRounds === 'object' &&
          !Array.isArray(state.planningRounds) &&
          Object.entries(state.planningRounds).length <= 32 &&
          Object.entries(state.planningRounds).every(([key, round]) =>
            /^[a-f0-9]{64}$/.test(key) && Number.isInteger(round) &&
            round >= 0 && round <= MAX_LOCAL_PLANNING_ROUNDS))) &&
      (state.planningSearch === undefined ||
        (state.planningSearch && typeof state.planningSearch === 'object' &&
          !Array.isArray(state.planningSearch) &&
          Object.entries(state.planningSearch).length <= 32 &&
          Object.entries(state.planningSearch).every(([key, search]) =>
            /^[a-f0-9]{64}$/.test(key) && search && typeof search === 'object' &&
            !Array.isArray(search) && Number.isInteger(search.noGainRounds) &&
            search.noGainRounds >= 0 && search.noGainRounds <= MAX_CONSECUTIVE_NO_GAIN_ROUNDS &&
            Number.isInteger(search.attemptsWithoutGain) &&
            search.attemptsWithoutGain >= 0 && search.attemptsWithoutGain <= LOCAL_ATTEMPT_LIMIT &&
            typeof search.gainedInRound === 'boolean')));
    if (!valid) {
      // This is only a resume list. Accepted routes are stored in immutable packs.
      // A v1 list has no graph scope and must not suppress attempts on a new graph.
      try {
        await fs.rename(this.jobStateFile, `${this.jobStateFile}.recovered-${randomUUID()}`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      return fresh();
    }
    if (state.scope !== scope) return fresh();
    state.planningRounds ||= {};
    state.planningSearch ||= {};
    return state;
  }

  async #saveJobState(state) {
    await fs.mkdir(path.dirname(this.jobStateFile), { recursive: true });
    const temporary = `${this.jobStateFile}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx');
      try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, this.jobStateFile);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async prepare({ regions, seed = 'road-v2', maxRequests = 30, signal, onProgress,
    requestedMoving = 0, requestedParked = 0, actionId = randomUUID(), requireContinuousMotion = false,
    targetRouteCount = 0, stopAtUsableRouteCount = false, provider = this.provider } = {}) {
    const normalized = validateRegions(regions);
    const bulkAllowed = provider?.bulkAllowed === true;
    const maxAllowed = bulkAllowed ? LOCAL_ATTEMPT_LIMIT : PUBLIC_ATTEMPT_LIMIT;
    if (!Number.isInteger(maxRequests) || maxRequests < 0 || maxRequests > maxAllowed) {
      throw new Error('Invalid route preparation request budget');
    }
    if (!Number.isInteger(targetRouteCount) || targetRouteCount < 0 || targetRouteCount > LOCAL_TARGET_LIMIT ||
        (targetRouteCount > 0 && !bulkAllowed)) {
      throw new Error('A large route catalog requires a local routing provider');
    }
    if (onProgress !== undefined && typeof onProgress !== 'function') {
      throw new Error('Invalid route preparation progress callback');
    }
    if (typeof stopAtUsableRouteCount !== 'boolean') {
      throw new Error('Invalid usable-route milestone option');
    }
    const usableMilestoneEnabled = bulkAllowed && targetRouteCount > MINIMUM_USABLE_ROUTE_COUNT &&
      stopAtUsableRouteCount;
    const sourceId = provider?.id || 'fossgis-valhalla-public';
    let sourceHealth = null;
    if (bulkAllowed) {
      sourceHealth = await provider.health?.({ signal });
      if (!sourceHealth?.ready || typeof sourceHealth.version !== 'string' ||
          !Number.isInteger(sourceHealth.tilesetLastModified) ||
          sourceHealth.tilesetLastModified <= 0) {
        const error = new Error('Local road routing service is not ready');
        error.code = 'LOCAL_ROUTER_UNAVAILABLE';
        throw error;
      }
    }
    const providerMetadata = bulkAllowed
      ? { id: sourceId, endpointFamily: provider.endpointFamily,
        graphVersion: sourceHealth?.version || null,
        tilesetLastModified: sourceHealth?.tilesetLastModified || null,
        costing: 'varied-auto-profiles' }
      : { id: sourceId, endpointFamily: 'https://valhalla1.openstreetmap.de',
        costing: 'auto', graphVersion: null };
    const scope = sourceScope(providerMetadata);

    const selected = new Map();
    let remainingPoints = MAX_ACTIVE_ROUTE_POINTS;
    for (const region of normalized) {
      let packs;
      try {
        packs = await this.store.listPacks(region.id, { pointBudget: remainingPoints });
      } catch (error) {
        if (!/Corrupt selected road route pack/.test(error.message)) throw error;
        // A damaged pinned generation must not prevent a new verified catalog.
        // The damaged generation stays on disk for explicit diagnosis/rollback.
        packs = [];
      }
      const reusable = packs.find((pack) => pack.region.id === region.id &&
        pack.region.centerLatitude === region.centerLatitude &&
        pack.region.centerLongitude === region.centerLongitude &&
        pack.region.radiusKm === region.radiusKm &&
        reusableSource(pack.manifest.provider, providerMetadata, bulkAllowed));
      if (!reusable) continue;
      if (reusable.region.fleetWeight === region.fleetWeight) {
        selected.set(region.id, reusable);
        remainingPoints -= reusable.pointCount;
      } else {
        // Fleet weights change allocation metadata; validated road geometry remains reusable.
        const digest = await this.store.writePack({ region, routes: reusable.routes,
          provider: reusable.manifest.provider, sourceRequests: reusable.manifest.sourceRequests });
        const updated = await this.store.loadPack(digest, region.id, { pointBudget: remainingPoints });
        selected.set(region.id, updated);
        remainingPoints -= updated.pointCount;
      }
    }
    const working = new Map(normalized.map((region) => {
      const pack = selected.get(region.id);
      return [region.id, { region, routes: pack ? [...pack.routes] : [],
        pointCount: pack?.pointCount || 0, dirty: false,
        sourceRequests: pack?.manifest.sourceRequests || 0 }];
    }));
    const noveltyIndexes = new Map([...working].map(([id, item]) =>
      [id, createNoveltyIndex(item.routes)]));
    const regionAttempts = new Map();
    const pendingAcceptedDigests = new Set();
    let pendingAcceptedRouteCount = 0;
    const getPacks = () => [...selected.values()];
    const countRoutes = () => [...working.values()].reduce((sum, item) => sum + item.routes.length, 0);
    const countSavedRoutes = () => [...selected.values()].reduce((sum, pack) => sum + pack.routes.length, 0);
    const countPoints = () => [...working.values()].reduce((sum, item) => sum + item.pointCount, 0);
    let attempts = 0;
    let accepted = 0;
    let rejected = 0;
    let lastAcceptedAttempt = 0;
    let planningRound = 0;
    let candidateCount = 0;
    let remainingCandidates = 0;
    const notify = (progress) => onProgress?.({ attempts, accepted, rejected,
      routeCount: countRoutes(), savedRouteCount: countSavedRoutes(), targetRouteCount,
      minimumUsableRouteCount: MINIMUM_USABLE_ROUTE_COUNT,
      attemptBudget: maxRequests, candidateCount, remainingCandidates, planningRound,
      planningRoundLimit: bulkAllowed ? MAX_LOCAL_PLANNING_ROUNDS : 1,
      attemptsSinceAccepted: attempts - lastAcceptedAttempt, ...progress });
    const composition = () => {
      let cityRoutes = 0;
      let regionalRoutes = 0;
      let intercityRoutes = 0;
      for (const item of working.values()) {
        for (const route of item.routes) {
          if (['local', 'urban', 'depot'].includes(route.family) &&
              route.roadClassSummary?.localShare >= 0.2) cityRoutes += 1;
          if (['suburban', 'regional'].includes(route.family) && route.lengthMeters >= 25_000) {
            regionalRoutes += 1;
            if (route.lengthMeters >= 80_000) intercityRoutes += 1;
          }
        }
      }
      return { cityRoutes, regionalRoutes, intercityRoutes };
    };
    const targetReady = () => catalogTargetReady(countRoutes(), targetRouteCount,
      composition(), normalized);
    const assess = () => evaluateCoverage(getPacks(), { regions: normalized,
      movingDevices: requestedMoving, parkedDevices: requestedParked,
      requireContinuousMotion, scenarioSeed: seed });
    let coverage = assess();
    let coverageStale = false;
    const usableNow = () => countSavedRoutes() >= MINIMUM_USABLE_ROUTE_COUNT &&
      getPacks().length === normalized.length &&
      coverage.regions.every((region) => region.routeCount > 0 &&
        region.capacity >= region.requestedMoving &&
        region.parkedPositionCapacity >= region.requestedParked) &&
      coverage.parkedPositionCapacity >= coverage.requestedParked &&
      (!requireContinuousMotion || coverage.ready);
    notify({ phase: 'cache', coverage, composition: composition() });
    let status = (targetRouteCount > 0 ? targetReady() : coverage.ready) ? 'ready' :
      usableMilestoneEnabled && usableNow()
        ? 'usable' : 'incomplete';
    const state = await this.#loadJobState(scope);
    const attempted = new Set(state.attempted);
    const planningKey = createHash('sha256').update(JSON.stringify({ seed,
      regions: normalized.map(({ id, centerLatitude, centerLongitude, radiusKm }) =>
        ({ id, centerLatitude, centerLongitude, radiusKm }))
        .sort((a, b) => a.id.localeCompare(b.id)) })).digest('hex');
    const search = state.planningSearch[planningKey] ||
      { noGainRounds: 0, attemptsWithoutGain: 0, gainedInRound: false };
    state.planningSearch[planningKey] = search;
    const searchKeys = Object.keys(state.planningSearch);
    while (searchKeys.length > 32) delete state.planningSearch[searchKeys.shift()];
    // A stalled plan is terminal for this graph and region. Repeating the same
    // action must not silently perform another three low-yield rounds.
    if (bulkAllowed && status === 'incomplete' &&
        search.noGainRounds >= MAX_CONSECUTIVE_NO_GAIN_ROUNDS) status = 'search-stalled';
    let noGainAttemptOffset = search.attemptsWithoutGain;
    let noGainStartAttempt = attempts;
    const attemptsWithoutGain = () => noGainAttemptOffset + attempts - noGainStartAttempt;
    let pendingRejectedCount = 0;
    const persistAttempted = async () => {
      state.attempted = [...attempted].slice(-20_000);
      search.attemptsWithoutGain = attemptsWithoutGain();
      await this.#saveJobState(state);
      pendingRejectedCount = 0;
    };
    const saveAttempted = async (digest) => {
      attempted.add(digest);
      pendingRejectedCount += 1;
      if (pendingRejectedCount >= REJECTED_STATE_BATCH_SIZE) await persistAttempted();
    };
    let lastFlushAtMs = Date.now();
    const flush = async () => {
      let changed = false;
      for (const item of working.values()) {
        if (!item.dirty) continue;
        const digest = await this.store.writePack({ region: item.region, routes: item.routes,
          provider: providerMetadata,
          sourceRequests: item.sourceRequests + (regionAttempts.get(item.region.id) || 0) });
        const pack = await this.store.loadPack(digest, item.region.id,
          { pointBudget: MAX_ACTIVE_ROUTE_POINTS });
        selected.set(item.region.id, pack);
        item.dirty = false;
        changed = true;
        notify({ phase: 'saved', packDigest: digest, attempts, accepted,
          routeCount: countRoutes(), targetRouteCount, composition: composition() });
      }
      if (changed) {
        for (const digest of pendingAcceptedDigests) attempted.add(digest);
        pendingAcceptedDigests.clear();
        await persistAttempted();
        pendingAcceptedRouteCount = 0;
        lastFlushAtMs = Date.now();
        // Bulk catalog completion depends on route count and mix. Defer the
        // full fleet/zone calculation until the final published generation.
        if (targetRouteCount > 0) coverageStale = true;
        else coverage = assess();
      }
    };

    if (status === 'incomplete' && maxRequests > 0) {
      let round = bulkAllowed ? state.planningRounds[planningKey] || 0 : 0;
      let candidates = [];
      let cursor = 0;
      let emptyRounds = 0;
      let roundAttemptStart = attempts;
      const loadRound = () => {
        roundAttemptStart = attempts;
        planningRound = round + 1;
        candidateCount = 0;
        remainingCandidates = 0;
        notify({ phase: 'planning', coverage });
        candidates = generateCandidates(normalized, { seed, round,
          existingRoutes: getPacks().flatMap((pack) => pack.routes),
          limit: bulkAllowed && round > 0 ? LATER_ROUND_CANDIDATE_LIMIT
            : bulkAllowed ? 5000 : 2000 });
        cursor = 0;
        candidateCount = candidates.length;
        remainingCandidates = candidates.filter((candidate) => !attempted.has(candidate.digest)).length;
        notify({ phase: 'planned', coverage });
      };
      const advanceRound = async () => {
        const hadAttempts = attempts > roundAttemptStart ||
          search.attemptsWithoutGain > 0 || search.gainedInRound;
        if (hadAttempts) emptyRounds = 0;
        else emptyRounds += 1;
        // Save accepted geometry before moving the resume cursor. Otherwise a
        // crash could skip a candidate whose route had not reached a pack.
        await flush();
        if (hadAttempts) {
          search.noGainRounds = search.gainedInRound ? 0 :
            Math.min(MAX_CONSECUTIVE_NO_GAIN_ROUNDS, search.noGainRounds + 1);
        }
        search.gainedInRound = false;
        noGainAttemptOffset = 0;
        noGainStartAttempt = attempts;
        search.attemptsWithoutGain = 0;
        round += 1;
        planningRound = round + 1;
        candidateCount = 0;
        remainingCandidates = 0;
        state.planningRounds[planningKey] = round;
        const oldKeys = Object.keys(state.planningRounds);
        while (oldKeys.length > 32) {
          const oldKey = oldKeys.shift();
          delete state.planningRounds[oldKey];
          delete state.planningSearch[oldKey];
        }
        await persistAttempted();
        if (round >= MAX_LOCAL_PLANNING_ROUNDS || emptyRounds >= MAX_EMPTY_PLANNING_ROUNDS) {
          status = 'candidates-exhausted';
          notify({ phase: 'blocked', reason: status, coverage });
        } else if (search.noGainRounds >= MAX_CONSECUTIVE_NO_GAIN_ROUNDS) {
          status = 'search-stalled';
          notify({ phase: 'blocked', reason: status, coverage });
        } else if (attempts < maxRequests) {
          loadRound();
        } else {
          // A later action starts with this new round. No planning CPU is
          // needed after the present action has spent its request budget.
          planningRound = round + 1;
          candidateCount = 0;
          remainingCandidates = 0;
        }
      };
      if (round < (bulkAllowed ? MAX_LOCAL_PLANNING_ROUNDS : 1)) loadRound();
      else status = 'candidates-exhausted';
      while (attempts < maxRequests &&
          status === 'incomplete' &&
          (targetRouteCount > 0 ? !targetReady() : !coverage.ready)) {
        if (signal?.aborted) { status = 'canceled'; break; }
        if (!provider) { status = 'cannot-prepare'; break; }
        if (bulkAllowed && attemptsWithoutGain() >= MAX_LOCAL_ATTEMPTS_WITHOUT_GAIN) {
          await advanceRound();
          continue;
        }
        while (cursor < candidates.length && attempted.has(candidates[cursor].digest)) cursor += 1;
        if (cursor >= candidates.length) {
          if (!bulkAllowed) { status = 'candidates-exhausted'; break; }
          // An exhausted round is a durable checkpoint. Its proposals are
          // deterministic, so resume starts at the next geography sample.
          await advanceRound();
          continue;
        }
        // Flush before a candidate could push the unsaved route count past 100.
        // Its response may contain up to four distinct routed geometries.
        if (bulkAllowed && pendingAcceptedRouteCount > 0 &&
            (pendingAcceptedRouteCount > LOCAL_BATCH_SIZE - MAX_ROUTES_PER_CANDIDATE ||
              Date.now() - lastFlushAtMs >= LOCAL_BATCH_MAX_AGE_MS)) {
          await flush();
        }
        const candidate = candidates[cursor++];
        remainingCandidates -= 1;
        const item = working.get(candidate.regionId);
        notify({ phase: 'request', candidateDigest: candidate.digest, coverage });
        let response;
        let routeError = null;
        for (let call = 1; call <= LOCAL_RETRY_DELAYS_MS.length + 1; call += 1) {
          if (signal?.aborted) {
            routeError = Object.assign(new Error('Road preparation canceled'), { name: 'AbortError' });
            break;
          }
          try {
            response = await provider.fetchRoute(candidate, { signal, actionId });
            attempts += 1;
            regionAttempts.set(item.region.id, (regionAttempts.get(item.region.id) || 0) + 1);
            routeError = null;
            break;
          } catch (error) {
            routeError = error;
            if (error.name === 'AbortError') break;
            if (!['BUDGET_EXHAUSTED', 'PROVIDER_DISABLED', 'PROVIDER_COOLDOWN'].includes(error.code)) {
              attempts += 1;
              regionAttempts.set(item.region.id, (regionAttempts.get(item.region.id) || 0) + 1);
            }
            if (!bulkAllowed || !isRetryableLocalFailure(error) ||
                call > LOCAL_RETRY_DELAYS_MS.length) break;
            if (attempts >= maxRequests) {
              status = 'request-limit';
              break;
            }
            const retryInMs = LOCAL_RETRY_DELAYS_MS[call - 1];
            notify({ phase: 'retrying', reason: error.message, retryInMs,
              retryAttempt: call + 1,
              maxRetryAttempts: LOCAL_RETRY_DELAYS_MS.length + 1, coverage });
            try { await waitForLocalRetry(retryInMs, signal); }
            catch (abort) { routeError = abort; break; }
          }
        }
        if (routeError) {
          const error = routeError;
          if (error.name === 'AbortError') { status = 'canceled'; break; }
          if (status === 'request-limit') break;
          if (['BUDGET_EXHAUSTED', 'PROVIDER_DISABLED', 'PROVIDER_COOLDOWN'].includes(error.code) || error.status === 429) {
            status = error.code || 'rate-limited';
            notify({ phase: 'blocked', reason: status, attempts, coverage });
            break;
          }
          if (isRetryableLocalFailure(error) || !Number.isInteger(error.status)) {
            status = 'provider-unavailable';
            notify({ phase: 'blocked', reason: status, attempts, coverage });
            break;
          }
          rejected += 1;
          await saveAttempted(candidate.digest);
          notify({ phase: 'rejected', reason: error.message, attempts, coverage });
          continue;
        }
        let validated;
        try {
          validated = validateValhallaResponseWithSources(response, candidate, {
            region: item.region,
            maxSnapMeters: bulkAllowed && ['local', 'urban', 'depot'].includes(candidate.family) ? 350
              : bulkAllowed ? 800 : 1500
          });
        } catch (error) {
          rejected += 1;
          await saveAttempted(candidate.digest);
          notify({ phase: 'rejected', reason: error.message, attempts, coverage });
          continue;
        }
        let attributed = validated;
        if (bulkAllowed) {
          try {
            attributed = [];
            // Road-class tracing starts a native Valhalla process for each leg.
            // Reused geometry is already verified in the selected route pack.
            // Check the existing footprint first, then retain the normal check
            // below as each newly accepted alternate updates the index.
            const noveltyIndex = noveltyIndexes.get(item.region.id);
            for (const entry of validated.filter(({ route }) => noveltyIndex.check(route).accepted)) {
              let roadClassSummary;
              for (let call = 1; call <= LOCAL_RETRY_DELAYS_MS.length + 1; call += 1) {
                try {
                  roadClassSummary = await provider.fetchRoadClasses(entry.sourceResponse, { signal });
                  break;
                } catch (error) {
                  if (!isRetryableLocalFailure(error) ||
                      call > LOCAL_RETRY_DELAYS_MS.length) throw error;
                  const retryInMs = LOCAL_RETRY_DELAYS_MS[call - 1];
                  notify({ phase: 'retrying', reason: error.message, retryInMs,
                    retryAttempt: call + 1,
                    maxRetryAttempts: LOCAL_RETRY_DELAYS_MS.length + 1, coverage });
                  await waitForLocalRetry(retryInMs, signal);
                }
              }
              attributed.push({ route: entry.route, roadClassSummary });
            }
          } catch (error) {
            if (error.name === 'AbortError') { status = 'canceled'; break; }
            const candidateTraceFailure = error.code === 'ROAD_ATTRIBUTES_UNAVAILABLE' &&
              ((error.status == null && !error.cause) || (Number.isInteger(error.status) && error.status >= 400 &&
                error.status < 500 && error.status !== 429));
            if (candidateTraceFailure) {
              rejected += 1;
              await saveAttempted(candidate.digest);
              notify({ phase: 'rejected', reason: error.message, attempts, coverage });
              continue;
            }
            status = 'road-attributes-unavailable';
            notify({ phase: 'blocked', reason: status, attempts, coverage });
            break;
          }
          if (attributed.some(({ roadClassSummary }) =>
            !roadClassSummary || !Number.isFinite(roadClassSummary.localShare))) {
            status = 'road-attributes-unavailable';
            notify({ phase: 'blocked', reason: status, attempts, coverage });
            break;
          }
          let currentHealth;
          try {
            currentHealth = await provider.health({ signal });
          } catch (error) {
            status = error.name === 'AbortError' ? 'canceled' : 'provider-unavailable';
            notify({ phase: 'blocked', reason: status, attempts, coverage });
            break;
          }
          if (!currentHealth?.ready) {
            status = 'provider-unavailable';
            notify({ phase: 'blocked', reason: status, attempts, coverage });
            break;
          }
          if ((currentHealth.version ?? null) !== (sourceHealth.version ?? null) ||
              (currentHealth.tilesetLastModified ?? null) !== (sourceHealth.tilesetLastModified ?? null)) {
            status = 'graph-changed';
            notify({ phase: 'blocked', reason: status, attempts, coverage });
            break;
          }
        }
        let newCount = 0;
        for (const { route, roadClassSummary = null } of attributed) {
          if (roadClassSummary && ['local', 'urban', 'depot'].includes(candidate.family) &&
              roadClassSummary.localShare < 0.2) continue;
          const noveltyIndex = noveltyIndexes.get(item.region.id);
          if (noveltyIndex.check(route).accepted) {
            if (item.routes.length >= LOCAL_TARGET_LIMIT) {
              status = 'route-limit';
              break;
            }
            route.fetchedAtUtc = new Date().toISOString();
            route.provider = sourceId;
            route.profile = candidate.profile || 'auto';
            if (roadClassSummary) route.roadClassSummary = roadClassSummary;
            if (countPoints() + route.points.length > MAX_ACTIVE_ROUTE_POINTS) {
              status = 'geometry-limit';
              break;
            }
            item.routes.push(route);
            noveltyIndex.add(route);
            item.pointCount += route.points.length;
            item.dirty = true;
            newCount += 1;
          }
        }
        if (status === 'geometry-limit' || status === 'route-limit') {
          notify({ phase: 'blocked', reason: status, attempts, coverage });
          break;
        }
        if (!newCount) {
          rejected += 1;
          await saveAttempted(candidate.digest);
          notify({ phase: 'rejected', reason: 'overlapping-corridor', attempts, coverage });
          continue;
        }
        accepted += newCount;
        lastAcceptedAttempt = attempts;
        noGainAttemptOffset = 0;
        noGainStartAttempt = attempts;
        search.attemptsWithoutGain = 0;
        search.noGainRounds = 0;
        search.gainedInRound = true;
        pendingAcceptedDigests.add(candidate.digest);
        pendingAcceptedRouteCount += newCount;
        if (!bulkAllowed || pendingAcceptedRouteCount >= LOCAL_BATCH_SIZE ||
            Date.now() - lastFlushAtMs >= LOCAL_BATCH_MAX_AGE_MS ||
            (usableMilestoneEnabled && countRoutes() >= MINIMUM_USABLE_ROUTE_COUNT &&
              countSavedRoutes() < MINIMUM_USABLE_ROUTE_COUNT) ||
            (targetRouteCount > 0 && targetReady())) await flush();
        if (usableMilestoneEnabled && countSavedRoutes() >= MINIMUM_USABLE_ROUTE_COUNT &&
            coverageStale) {
          // The milestone is based on the published pack, not routes still in
          // memory. Recheck the actual fleet and parked-position capacity.
          coverage = assess();
          coverageStale = false;
        }
        notify({ phase: 'accepted', accepted, attempts, coverage,
          routeCount: countRoutes(), targetRouteCount, composition: composition() });
        status = (targetRouteCount > 0 ? targetReady() : coverage.ready) ? 'ready' :
          usableMilestoneEnabled && usableNow()
            ? 'usable' : 'incomplete';
        if (status === 'usable') notify({ phase: 'usable', status, coverage,
          routeCount: countRoutes(), savedRouteCount: countSavedRoutes(),
          composition: composition() });
      }
      if (status === 'incomplete' && bulkAllowed &&
          attemptsWithoutGain() >= MAX_LOCAL_ATTEMPTS_WITHOUT_GAIN) await advanceRound();
    }
    // Publish the final batch on cancel, provider failure, or request-budget exhaustion.
    await flush();
    if (coverageStale) coverage = assess();
    if (pendingRejectedCount > 0) await persistAttempted();
    if (status === 'incomplete' && maxRequests > 0 && attempts >= maxRequests) status = 'request-limit';
    if (targetRouteCount > 0 && targetReady()) status = 'ready';
    else if (usableMilestoneEnabled && ['incomplete', 'request-limit'].includes(status) &&
        usableNow()) status = 'usable';
    return { status, packDigests: getPacks().map((pack) => pack.digest), coverage,
      routeCount: countRoutes(), savedRouteCount: countSavedRoutes(), targetRouteCount,
      minimumUsableRouteCount: MINIMUM_USABLE_ROUTE_COUNT,
      composition: composition(), attempts, accepted, rejected, attemptBudget: maxRequests,
      candidateCount, remainingCandidates, planningRound,
      planningRoundLimit: bulkAllowed ? MAX_LOCAL_PLANNING_ROUNDS : 1,
      attemptsSinceAccepted: attempts - lastAcceptedAttempt,
      statusDetail: status === 'search-stalled'
        ? `Three varied planning rounds produced no new verified route. Check the selected road region or try a wider area.`
        : status === 'candidates-exhausted'
          ? `All available planning rounds for this road graph were exhausted. Adjust the road region to seek more routes.`
          : status === 'usable'
            ? `This saved route library supports the configured fleet now. You can transmit and add more routes later toward the ${targetRouteCount.toLocaleString('en-US')}-route catalog.`
          : null,
      resumeAvailable: ['usable', 'request-limit', 'canceled', 'provider-unavailable',
        'road-attributes-unavailable'].includes(status) };
  }
}

module.exports = { RoutePreparationCoordinator, catalogTargetReady };
