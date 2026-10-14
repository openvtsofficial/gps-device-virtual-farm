'use strict';

const { parentPort } = require('node:worker_threads');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DeviceFarm } = require('./device-farm');
const { validateConfig } = require('./config');
const { RoutePackStore, MAX_ACTIVE_ROUTE_POINTS } = require('../road/route-pack-store');
const { RoadCheckpointStore } = require('../main/road-checkpoint-store');

let farm = null;
let stopping = false;
let checkpointStore = null;
let checkpointTimer = null;
let checkpointInFlight = null;

function send(message) {
  parentPort?.postMessage(message);
}

async function stopFarm(requestId) {
  if (stopping) return;
  stopping = true;
  try {
    if (checkpointTimer) clearInterval(checkpointTimer);
    checkpointTimer = null;
    const metrics = farm ? await farm.stop() : null;
    if (checkpointInFlight) await checkpointInFlight;
    if (farm && checkpointStore) await checkpointStore.save(farm.checkpointStates());
    farm = null;
    if (checkpointStore) await checkpointStore.close();
    checkpointStore = null;
    send({ type: 'stopped', requestId, metrics });
  } catch (error) {
    send({ type: 'error', requestId, message: error.message, stack: error.stack });
  } finally {
    stopping = false;
  }
}

function checkpointIdentity(config) {
  const digests = [...config.road.selectedRoutePackDigests].sort();
  return {
    routePackDigest: createHash('sha256').update(digests.join('|')).digest('hex'),
    runId: createHash('sha256').update(`${config.scenarioSeed}|${digests.join('|')}`).digest('hex').slice(0, 32)
  };
}

async function loadRoadContext(config, context) {
  if (config.movementMode !== 'real-road') return {};
  if (!context || typeof context.dataDirectory !== 'string' || !path.isAbsolute(context.dataDirectory)) {
    throw new Error('Real-road playback needs a trusted route-pack directory');
  }
  const store = new RoutePackStore(path.join(context.dataDirectory, 'road-routes'));
  const roadPacks = [];
  let remainingPoints = MAX_ACTIVE_ROUTE_POINTS;
  for (const digest of config.road.selectedRoutePackDigests) {
    const pack = await store.loadPack(digest, undefined, { pointBudget: remainingPoints });
    roadPacks.push(pack);
    remainingPoints -= pack.pointCount;
  }
  checkpointStore = new RoadCheckpointStore(context.dataDirectory, checkpointIdentity(config));
  const saved = await checkpointStore.load();
  return { roadPacks, restoredRoadStates: saved?.states || null };
}

function startCheckpointTimer() {
  if (!checkpointStore) return;
  checkpointTimer = setInterval(() => {
    if (!farm || checkpointInFlight) return;
    checkpointInFlight = checkpointStore.save(farm.checkpointStates())
      .catch((error) => send({ type: 'log', entry: {
        timestamp: new Date().toISOString(), level: 'error', source: 'Checkpoint',
        message: 'Road progress checkpoint failed', details: { message: error.message }
      } }))
      .finally(() => { checkpointInFlight = null; });
  }, 15_000);
}

parentPort?.on('message', async (message) => {
  try {
    if (message.type === 'start') {
      if (farm) throw new Error('A simulation is already running');
      const config = validateConfig(message.config);
      const dependencies = await loadRoadContext(config, message.roadContext);
      farm = new DeviceFarm(config, dependencies);
      farm.on('log', (entry) => send({ type: 'log', entry }));
      farm.on('metrics', (metrics) => send({ type: 'metrics', metrics }));
      const metrics = farm.start({ deferPump: Boolean(checkpointStore) });
      if (checkpointStore) {
        await checkpointStore.save(farm.checkpointStates());
        farm.activate();
        startCheckpointTimer();
      }
      send({ type: 'started', requestId: message.requestId, metrics });
      return;
    }

    if (message.type === 'stop') {
      await stopFarm(message.requestId);
      return;
    }

    if (message.type === 'snapshot') {
      send({
        type: 'snapshot',
        requestId: message.requestId,
        metrics: farm?.snapshot() || null
      });
    }
  } catch (error) {
    send({
      type: 'error',
      requestId: message.requestId,
      message: error.message,
      stack: error.stack
    });
  }
});

process.on('uncaughtException', (error) => {
  send({ type: 'fatal', message: error.message, stack: error.stack });
});

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  send({ type: 'fatal', message: error.message, stack: error.stack });
});

