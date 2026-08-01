'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { validateConfig } = require('../simulator/config');

class SimulatorController {
  constructor(callbacks = {}) {
    this.worker = null;
    this.pending = new Map();
    this.requestSequence = 0;
    this.callbacks = callbacks;
    this.running = false;
  }

  async start(inputConfig) {
    if (this.worker) throw new Error('A simulation is already active');
    const config = validateConfig(inputConfig);
    const workerPath = path.join(__dirname, '..', 'simulator', 'worker.js');
    this.worker = new Worker(workerPath);
    this.worker.on('message', (message) => this.#onMessage(message));
    this.worker.on('error', (error) => this.#onWorkerFailure(error));
    this.worker.on('exit', (code) => this.#onWorkerExit(code));

    try {
      const result = await this.#request('start', { config }, 30_000);
      this.running = true;
      return result;
    } catch (error) {
      await this.#terminateWorker();
      throw error;
    }
  }

  async stop() {
    if (!this.worker) return null;
    let result = null;
    try {
      result = await this.#request('stop', {}, 30_000);
    } finally {
      this.running = false;
      await this.#terminateWorker();
    }
    return result;
  }

  #request(type, payload, timeoutMs) {
    if (!this.worker) return Promise.reject(new Error('Simulation worker is unavailable'));
    const requestId = ++this.requestSequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${type} request timed out`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout });
      this.worker.postMessage({ type, requestId, ...payload });
    });
  }

  #onMessage(message) {
    if (message.type === 'log') {
      this.callbacks.onLog?.(message.entry);
      return;
    }
    if (message.type === 'metrics') {
      this.callbacks.onMetrics?.(message.metrics);
      return;
    }
    if (message.type === 'fatal') {
      const error = new Error(message.message);
      this.callbacks.onFatal?.(error);
      this.#rejectAll(error);
      this.running = false;
      this.#terminateWorker().catch(() => {});
      return;
    }

    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.requestId);
    if (message.type === 'error') {
      pending.reject(new Error(message.message));
    } else {
      pending.resolve(message.metrics ?? null);
    }
  }

  #onWorkerFailure(error) {
    this.callbacks.onFatal?.(error);
    this.#rejectAll(error);
    this.running = false;
  }

  #onWorkerExit(code) {
    const wasUnexpected = this.worker !== null;
    this.worker = null;
    if (code !== 0 && wasUnexpected) {
      const error = new Error(`Simulation worker exited with code ${code}`);
      this.callbacks.onFatal?.(error);
      this.#rejectAll(error);
    }
    this.running = false;
  }

  #rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async #terminateWorker() {
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
  }
}

module.exports = { SimulatorController };
