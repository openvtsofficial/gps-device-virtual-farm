'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const roots = ['src', 'tests', 'scripts'];
const files = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute);
    if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute);
  }
}

for (const root of roots) walk(path.join(projectRoot, root));

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}

const html = fs.readFileSync(path.join(projectRoot, 'src', 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(projectRoot, 'src', 'renderer', 'app.js'), 'utf8');
const idListMatch = renderer.match(/Object\.fromEntries\(\[([\s\S]*?)\]\.map/);
if (!idListMatch) throw new Error('Could not inspect renderer element contract');
const ids = [...idListMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
for (const id of ids) {
  if (!html.includes(`id="${id}"`)) throw new Error(`Renderer expects missing element #${id}`);
}

process.stdout.write(`Syntax and renderer contract verified for ${files.length} JavaScript files.\n`);

