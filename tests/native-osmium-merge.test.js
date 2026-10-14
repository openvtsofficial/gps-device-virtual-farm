'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { runNativeMerge } = require('../src/road/bundled-graph-manager');

const osmium = path.join(__dirname, '..', 'vendor', 'osmium', 'runtime', 'osmium.exe');
const node = (id, lon) =>
  `<node id="${id}" lat="28.61" lon="${lon}" version="1" timestamp="2026-10-12T20:21:35Z"/>`;
const way = (id, first, second) =>
  `<way id="${id}" version="1" timestamp="2026-10-12T20:21:35Z"><nd ref="${first}"/><nd ref="${second}"/><tag k="highway" v="residential"/></way>`;
const osm = (body) =>
  `<?xml version="1.0" encoding="UTF-8"?><osm version="0.6" generator="gps-road-test">${body}</osm>`;
const roadSection = (first, last) =>
  Array.from({ length: last - first + 1 }, (_, index) =>
    node(first + index, 77.2 + (first + index) / 10_000)).join('') +
  Array.from({ length: last - first }, (_, index) =>
    way(first + index, first + index, first + index + 1)).join('');

test('bundled Osmium merges adjacent PBFs and deduplicates shared OSM objects',
  { skip: process.platform !== 'win32' }, async (t) => {
    const testsDir = path.join(__dirname, '..', '.runtime', 'tests');
    await fs.mkdir(testsDir, { recursive: true });
    const folder = await fs.mkdtemp(path.join(testsDir, 'osmium-merge-'));
    t.after(() => fs.rm(folder, { recursive: true, force: true }));
    const sources = [path.join(folder, 'west'), path.join(folder, 'east')];
    await fs.writeFile(`${sources[0]}.osm`, osm(roadSection(1, 2000)));
    await fs.writeFile(`${sources[1]}.osm`, osm(roadSection(1900, 4000)));
    for (const source of sources) {
      execFileSync(osmium, ['cat', `${source}.osm`, '-o', `${source}.osm.pbf`],
        { windowsHide: true });
    }
    const merged = path.join(folder, 'merged.osm.pbf');
    await runNativeMerge({ binaryPath: osmium,
      sourcePaths: sources.map((source) => `${source}.osm.pbf`), destinationPath: merged });
    const count = (kind) => Number(execFileSync(osmium,
      ['fileinfo', '-e', '-g', `data.count.${kind}`, merged],
      { encoding: 'utf8', windowsHide: true }).trim());
    assert.equal(count('nodes'), 4000);
    assert.equal(count('ways'), 3999);
  });
