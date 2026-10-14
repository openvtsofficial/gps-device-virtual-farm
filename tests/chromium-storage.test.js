'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { configureChromiumStorage } = require('../src/main/chromium-storage');

function fixture(t) {
  const base = path.resolve(__dirname, '..', '.runtime', 'tests');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'chromium-storage-'));
  t.after(() => {
    if (!root.startsWith(base + path.sep)) throw new Error('Refusing to remove outside test fixtures');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const appData = path.join(root, 'Roaming');
  const temp = path.join(root, 'Temp');
  fs.mkdirSync(appData);
  fs.mkdirSync(temp);
  const setPaths = [];
  const app = {
    isPackaged: false,
    getPath(name) {
      if (name === 'appData') return appData;
      if (name === 'temp') return temp;
      throw new Error(`Unexpected app path lookup: ${name}`);
    },
    setPath(name, directory) { setPaths.push([name, directory]); }
  };
  return { root, appData, temp, app, setPaths };
}

test('development uses a writable workspace cache without changing userData', (t) => {
  const { root, app, setPaths } = fixture(t);
  const developmentDirectory = path.join(root, 'workspace', '.runtime', 'electron-session');
  const selected = configureChromiumStorage(app, {
    platform: 'win32',
    env: { LOCALAPPDATA: path.join(root, 'Local') },
    developmentDirectory
  });
  assert.equal(selected, developmentDirectory);
  assert.deepEqual(setPaths, [['sessionData', developmentDirectory]]);
  assert.ok(fs.statSync(selected).isDirectory());
});

test('packaged Windows build uses a writable per-user local cache', (t) => {
  const { root, app, setPaths } = fixture(t);
  app.isPackaged = true;
  const local = path.join(root, 'Local');
  const selected = configureChromiumStorage(app, {
    platform: 'win32', env: { LOCALAPPDATA: local },
    developmentDirectory: path.join(root, 'ignored-workspace')
  });
  assert.equal(selected, path.join(local, 'OpenVTS', 'GPS Device Farm', 'session-data'));
  assert.deepEqual(setPaths, [['sessionData', selected]]);
  assert.equal(fs.existsSync(path.join(root, 'ignored-workspace')), false);
});

test('unwritable persistent cache locations fall back to an isolated temp profile', (t) => {
  const { root, app, appData, temp, setPaths } = fixture(t);
  app.isPackaged = true;
  const local = path.join(root, 'Local');
  fs.mkdirSync(local);
  fs.writeFileSync(path.join(local, 'OpenVTS'), 'blocking file');
  fs.writeFileSync(path.join(appData, 'OpenVTS'), 'blocking file');
  const selected = configureChromiumStorage(app, {
    platform: 'win32', env: { LOCALAPPDATA: local }
  });
  assert.ok(selected.startsWith(path.join(temp, 'gps-device-farm-session-')));
  assert.deepEqual(setPaths, [['sessionData', selected]]);
});

test('non-Windows platforms keep their existing Electron storage path', (t) => {
  const { app, setPaths } = fixture(t);
  assert.equal(configureChromiumStorage(app, { platform: 'linux' }), null);
  assert.deepEqual(setPaths, []);
});
