'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { app } = require('electron');

const asarArgument = process.argv.find((argument) => argument.endsWith('.asar'));

app.whenReady().then(() => {
  if (!asarArgument) throw new Error('Pass the packaged app.asar path');
  const workerPath = path.join(path.resolve(asarArgument), 'src', 'simulator', 'worker.js');
  const worker = new Worker(workerPath);
  const timeout = setTimeout(() => {
    process.stderr.write('Packaged worker test timed out\n');
    worker.terminate().finally(() => app.exit(1));
  }, 10_000);

  worker.on('message', (message) => {
    if (message.type === 'started') {
      process.stdout.write(`${JSON.stringify({
        status: 'packaged-worker-started',
        totalDevices: message.metrics.totalDevices,
        target: message.metrics.target
      })}\n`);
      worker.postMessage({ type: 'stop', requestId: 2 });
    } else if (message.type === 'stopped') {
      clearTimeout(timeout);
      worker.terminate().finally(() => app.exit(0));
    } else if (message.type === 'error' || message.type === 'fatal') {
      clearTimeout(timeout);
      process.stderr.write(`${message.message}\n`);
      worker.terminate().finally(() => app.exit(1));
    }
  });
  worker.on('error', (error) => {
    clearTimeout(timeout);
    process.stderr.write(`${error.stack || error.message}\n`);
    app.exit(1);
  });
  worker.postMessage({
    type: 'start',
    requestId: 1,
    config: {
      host: '127.0.0.1',
      port: 9,
      deviceCount: 1,
      connectionRatePerSecond: 1
    }
  });
});

