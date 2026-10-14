'use strict';

const { abortError } = require('./provider-budget');

const ENDPOINT = 'https://valhalla1.openstreetmap.de/route';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function safeCostingOptions(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !['use_highways', 'use_distance'].includes(key)) ||
      Object.values(value).some((number) => !Number.isFinite(number) || number < 0 || number > 1)) {
    throw new Error('Invalid Valhalla costing options');
  }
  return { ...value };
}

function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function checkDepth(value, depth = 0) {
  if (depth > 32) throw new Error('Valhalla JSON nesting exceeds limit');
  if (Array.isArray(value)) {
    if (value.length > 100_000) throw new Error('Valhalla JSON array exceeds limit');
    for (const item of value) checkDepth(item, depth + 1);
  } else if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length > 1000) throw new Error('Valhalla JSON object exceeds limit');
    for (const key of keys) checkDepth(value[key], depth + 1);
  }
}

class PublicValhallaProvider {
  constructor({ budget, enabled = false, clientId = 'openvts.io', appVersion = '1.0.0', fetchImpl = globalThis.fetch } = {}) {
    if (!budget || typeof budget.run !== 'function' || typeof fetchImpl !== 'function') throw new Error('Provider needs budget and fetch');
    if (!/^[a-zA-Z0-9.-]{3,80}$/.test(clientId) || !/^[a-zA-Z0-9._-]{1,32}$/.test(appVersion)) {
      throw new Error('Invalid public routing client identity');
    }
    this.budget = budget;
    this.id = 'fossgis-valhalla-public';
    this.bulkAllowed = false;
    this.enabled = enabled === true;
    this.clientId = clientId;
    this.appVersion = appVersion;
    this.fetchImpl = fetchImpl;
  }

  async fetchRoute(candidate, { signal, actionId } = {}) {
    if (!this.enabled) {
      const error = new Error('Public route preparation disabled pending operator permission');
      error.code = 'PROVIDER_DISABLED';
      throw error;
    }
    if (!candidate || !Array.isArray(candidate.locations) || candidate.locations.length < 2 || candidate.locations.length > 8) {
      throw new Error('Invalid Valhalla candidate locations');
    }
    const locations = candidate.locations.map((point) => {
      const lat = point.latitude ?? point.lat;
      const lon = point.longitude ?? point.lon;
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        throw new Error('Invalid Valhalla candidate coordinate');
      }
      return { lat, lon };
    });
    const body = { locations, costing: 'auto', units: 'kilometers' };
    const costingOptions = safeCostingOptions(candidate.costingOptions);
    if (costingOptions) body.costing_options = { auto: costingOptions };
    if (candidate.alternates && locations.length === 2) body.alternates = Math.min(2, Math.max(0, Math.floor(candidate.alternates)));
    if (candidate.alternates && locations.length !== 2) throw new Error('Multipoint Valhalla alternates are unsupported');
    return this.budget.run(actionId, async (budgetSignal) => {
      if (budgetSignal?.aborted) throw abortError();
      const timeout = AbortSignal.timeout(20_000);
      const combined = budgetSignal ? AbortSignal.any([budgetSignal, timeout]) : timeout;
      const response = await this.fetchImpl(ENDPOINT, {
        method: 'POST', redirect: 'error', cache: 'no-store', signal: combined,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json',
          'X-Client-Id': this.clientId, 'User-Agent': `OpenVTS-GPS-Device-Farm/${this.appVersion} (https://openvts.io)` },
        body: JSON.stringify(body)
      });
      if (response.url && response.url !== ENDPOINT) throw new Error('Unexpected routing endpoint redirect');
      if (response.status === 429) {
        const error = new Error('Valhalla rate limited this installation');
        error.status = 429;
        error.retryAfterMs = retryAfterMs(response.headers.get('retry-after'));
        throw error;
      }
      if (!response.ok) {
        const error = new Error(`Valhalla returned HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('Valhalla response exceeds byte limit');
      const chunks = [];
      let bytes = 0;
      if (!response.body?.getReader) throw new Error('Valhalla response is not streamable');
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) throw new Error('Valhalla response exceeds byte limit');
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const parsed = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
      checkDepth(parsed);
      return parsed;
    }, { signal });
  }
}

module.exports = { PublicValhallaProvider, ENDPOINT, retryAfterMs, safeCostingOptions };
