'use strict';

const { parentPort } = require('node:worker_threads');
const { DeviceFarm } = require('./device-farm');

let farm = null;
let stopping = false;

function send(message) {
  parentPort?.postMessage(message);
}

async function stopFarm(requestId) {
  if (stopping) return;
  stopping = true;
  try {
    const metrics = farm ? await farm.stop() : null;
    farm = null;
    send({ type: 'stopped', requestId, metrics });
  } catch (error) {
    send({ type: 'error', requestId, message: error.message, stack: error.stack });
  } finally {
    stopping = false;
  }
}

parentPort?.on('message', async (message) => {
  try {
    if (message.type === 'start') {
      if (farm) throw new Error('A simulation is already running');
      farm = new DeviceFarm(message.config);
      farm.on('log', (entry) => send({ type: 'log', entry }));
      farm.on('metrics', (metrics) => send({ type: 'metrics', metrics }));
      const metrics = farm.start();
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

