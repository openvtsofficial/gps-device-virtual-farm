'use strict';

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED',
  'EPIPE', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET']);

function isRetryableLocalFailure(error, depth = 0) {
  if (!error || depth > 3 || error.name === 'AbortError' || error.status === 429) return false;
  if (Number.isInteger(error.status)) return RETRYABLE_HTTP_STATUSES.has(error.status);
  if (error.name === 'TimeoutError' || RETRYABLE_CODES.has(error.code)) return true;
  if (error.cause && isRetryableLocalFailure(error.cause, depth + 1)) return true;
  if (error.code === 'ROAD_ATTRIBUTES_UNAVAILABLE') return false;
  // The bundled native one-shot runner wraps process exits without an HTTP
  // status. A small bounded retry covers temporary native or transport faults.
  return depth === 0 && /^Bundled Valhalla failed:/.test(error.message || '');
}

function waitForLocalRetry(milliseconds, signal) {
  if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 10_000) {
    throw new Error('Invalid local road retry delay');
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('Road preparation canceled'), { name: 'AbortError' }));
      return;
    }
    const timer = setTimeout(done, milliseconds);
    function done() { signal?.removeEventListener('abort', abort); resolve(); }
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(Object.assign(new Error('Road preparation canceled'), { name: 'AbortError' }));
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

module.exports = { isRetryableLocalFailure, waitForLocalRetry };
