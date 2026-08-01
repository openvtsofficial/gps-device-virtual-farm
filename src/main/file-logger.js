'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

class FileLogger {
  constructor(userDataDirectory, options = {}) {
    this.directory = path.join(userDataDirectory, 'logs');
    this.filePath = path.join(this.directory, 'gps-device-farm.jsonl');
    this.maxBytes = options.maxBytes || 5 * 1024 * 1024;
    this.maxFiles = options.maxFiles || 3;
    this.queue = Promise.resolve();
    this.approximateBytes = 0;
  }

  async init() {
    await fs.mkdir(this.directory, { recursive: true });
    try {
      const stat = await fs.stat(this.filePath);
      this.approximateBytes = stat.size;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  write(entry) {
    const normalized = {
      timestamp: entry.timestamp || new Date().toISOString(),
      level: entry.level || 'info',
      source: entry.source || 'Application',
      message: String(entry.message || ''),
      ...(entry.details !== undefined ? { details: entry.details } : {})
    };
    const line = `${JSON.stringify(normalized)}\n`;
    const bytes = Buffer.byteLength(line);

    this.queue = this.queue
      .then(async () => {
        if (this.approximateBytes + bytes > this.maxBytes) await this.#rotate();
        await fs.appendFile(this.filePath, line, { encoding: 'utf8', mode: 0o600 });
        this.approximateBytes += bytes;
      })
      .catch(() => {});
    return this.queue;
  }

  async close() {
    await this.queue;
  }

  async #rotate() {
    for (let index = this.maxFiles; index >= 1; index -= 1) {
      const source = index === 1 ? this.filePath : `${this.filePath}.${index - 1}`;
      const destination = `${this.filePath}.${index}`;
      try {
        await fs.rm(destination, { force: true });
        await fs.rename(source, destination);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    this.approximateBytes = 0;
  }
}

module.exports = { FileLogger };

