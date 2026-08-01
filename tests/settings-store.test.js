'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SettingsStore } = require('../src/main/settings-store');

test('settings persist as validated JSON and reload', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gps-farm-settings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = new SettingsStore(directory);
  await first.load();
  await first.save({ host: 'gps.example.com', port: 6001, deviceCount: 20_000 });

  const second = new SettingsStore(directory);
  const loaded = await second.load();
  assert.equal(loaded.host, 'gps.example.com');
  assert.equal(loaded.port, 6001);
  assert.equal(loaded.deviceCount, 20_000);

  const onDisk = JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8'));
  assert.deepEqual(onDisk, loaded);
});

test('invalid persisted settings recover to safe defaults', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gps-farm-invalid-settings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify({
    host: 'https://unsafe.example.com',
    port: 99_999,
    deviceCount: -10
  }));
  const store = new SettingsStore(directory);
  const loaded = await store.load();
  assert.equal(loaded.host, '127.0.0.1');
  assert.equal(loaded.port, 5023);
  assert.equal(loaded.deviceCount, 100);
});

