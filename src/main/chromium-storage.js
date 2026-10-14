'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function assertWritableDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const probe = path.join(directory, `.write-probe-${process.pid}-${randomUUID()}`);
  const descriptor = fs.openSync(probe, 'wx');
  try {
    fs.writeSync(descriptor, 'ok');
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(probe);
  }
}

// Chromium opens its HTTP and GPU caches before app.whenReady(). Keep them out
// of the existing userData root, whose legacy cache directories can have stale
// permissions, while leaving settings, route packs and checkpoints in place.
function configureChromiumStorage(app, {
  platform = process.platform,
  env = process.env,
  developmentDirectory = path.resolve(__dirname, '..', '..', '.runtime', 'electron-session')
} = {}) {
  if (platform !== 'win32') return null;

  const candidates = [];
  if (!app.isPackaged) candidates.push(developmentDirectory);
  if (typeof env.LOCALAPPDATA === 'string' && path.isAbsolute(env.LOCALAPPDATA)) {
    candidates.push(path.join(env.LOCALAPPDATA, 'OpenVTS', 'GPS Device Farm', 'session-data'));
  }
  candidates.push(path.join(app.getPath('appData'), 'OpenVTS', 'GPS Device Farm', 'session-data'));

  for (const directory of candidates) {
    try {
      assertWritableDirectory(directory);
      app.setPath('sessionData', directory);
      return directory;
    } catch {
      // An existing directory may be read-only or owned by another Windows
      // identity. Leave it untouched and try a separate location.
    }
  }

  // A unique temporary profile still lets the UI open when both persistent
  // locations are unavailable. Chromium may discard its cache on this path.
  const temporary = fs.mkdtempSync(path.join(app.getPath('temp'), 'gps-device-farm-session-'));
  app.setPath('sessionData', temporary);
  return temporary;
}

module.exports = { configureChromiumStorage };
