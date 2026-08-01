'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { DEFAULT_CONFIG } = require('../simulator/constants');
const { publicSettings, validateConfig } = require('../simulator/config');

class SettingsStore {
  constructor(userDataDirectory) {
    this.directory = userDataDirectory;
    this.filePath = path.join(userDataDirectory, 'settings.json');
    this.settings = publicSettings(DEFAULT_CONFIG);
  }

  async load() {
    await fs.mkdir(this.directory, { recursive: true });
    let raw;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.#write(this.settings);
      return { ...this.settings };
    }

    try {
      const parsed = JSON.parse(raw);
      this.settings = publicSettings(validateConfig({ ...DEFAULT_CONFIG, ...parsed }));
    } catch (error) {
      // Invalid or obsolete values must not prevent the desktop app from opening.
      this.settings = publicSettings(DEFAULT_CONFIG);
      await this.#write(this.settings);
    }
    return { ...this.settings };
  }

  get() {
    return { ...this.settings };
  }

  async save(input) {
    const validated = publicSettings(validateConfig({
      ...DEFAULT_CONFIG,
      ...this.settings,
      ...pickSettings(input)
    }));
    await this.#write(validated);
    this.settings = validated;
    return { ...this.settings };
  }

  async #write(settings) {
    const temporaryPath = `${this.filePath}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    await fs.rename(temporaryPath, this.filePath);
  }
}

function pickSettings(input = {}) {
  return {
    ...(input.host !== undefined ? { host: input.host } : {}),
    ...(input.port !== undefined ? { port: input.port } : {}),
    ...(input.deviceCount !== undefined ? { deviceCount: input.deviceCount } : {}),
    ...(input.baseLatitude !== undefined ? { baseLatitude: input.baseLatitude } : {}),
    ...(input.baseLongitude !== undefined ? { baseLongitude: input.baseLongitude } : {}),
    ...(input.connectionRatePerSecond !== undefined
      ? { connectionRatePerSecond: input.connectionRatePerSecond }
      : {}),
    ...(input.logDetail !== undefined ? { logDetail: input.logDetail } : {})
  };
}

module.exports = {
  SettingsStore,
  pickSettings
};
