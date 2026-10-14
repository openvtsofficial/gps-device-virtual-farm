'use strict';

function resolveRoadPreparationSource({ input, localHealth, localProvider, publicProvider,
  publicEnabled }) {
  if (!input || (input.source !== 'local' && input.source !== 'public')) {
    throw new Error('Choose a route preparation source');
  }
  if (input.source === 'local') {
    if (localHealth?.ready !== true) {
      const error = new Error('The app could not prepare its local road graph. Check the map download or build error and try again.');
      error.code = 'LOCAL_ROUTER_UNAVAILABLE';
      throw error;
    }
    return { provider: localProvider, targetRouteCount: input.targetRouteCount ?? 2000,
      maxRequests: input.maxRequests ?? 4000 };
  }
  if (!publicEnabled) {
    throw new Error('Public demo route preparation is disabled. Use the bundled road engine.');
  }
  if (input.targetRouteCount !== undefined && input.targetRouteCount !== 0) {
    throw new Error('A large route catalog requires the local routing source');
  }
  return { provider: publicProvider, targetRouteCount: 0,
    maxRequests: input.maxRequests ?? 30 };
}

module.exports = { resolveRoadPreparationSource };
