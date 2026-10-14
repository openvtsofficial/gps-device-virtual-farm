'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const {
  CheckpointCorruptError,
  CheckpointIncompatibleError,
  RoadCheckpointStore
} = require('../src/main/road-checkpoint-store');

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

async function temporaryStore(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(__dirname, '.road-checkpoint-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new RoadCheckpointStore(directory, {
    runId: 'scenario-1',
    routePackDigest: DIGEST_A,
    ...options
  });
  return { directory, store };
}

function vehicle(cursorMeters = 10) {
  return {
    imei: '358988888800001',
    regionId: 'metro',
    routeId: 'route-7',
    cursorMeters,
    phase: 'moving',
    lastQueuedPoint: { latitude: 12.9716, longitude: 77.5946 }
  };
}

test('writes atomic generations and restores the newest bound state', async (t) => {
  const { directory, store } = await temporaryStore(t, { maxGenerations: 2 });
  const states = [vehicle(10)];
  assert.equal(await store.load(), null);
  assert.deepEqual(await store.save(states), {
    generation: 1,
    createdAtUtc: (await store.load()).createdAtUtc,
    stateCount: 1
  });
  states[0].cursorMeters = 999;
  await store.save([vehicle(20)]);
  await store.save([vehicle(30)]);
  await store.close();

  const restored = await new RoadCheckpointStore(directory, {
    runId: 'scenario-1',
    routePackDigest: DIGEST_A
  }).load();
  assert.equal(restored.generation, 3);
  assert.equal(restored.routePackDigest, DIGEST_A);
  assert.equal(restored.states[0].cursorMeters, 30);
  assert.equal(restored.recoveredFromCorruption, false);
  const files = await fs.readdir(path.join(directory, 'road-vehicle-state', 'checkpoints'));
  assert.deepEqual(files.sort(), [
    'scenario-1-000000000002.json',
    'scenario-1-000000000003.json'
  ]);
});

test('recovers an older intact generation after an interrupted or corrupt write', async (t) => {
  const { directory, store } = await temporaryStore(t, { maxGenerations: 2 });
  await store.save([vehicle(10)]);
  await store.save([vehicle(20)]);
  const newest = path.join(store.directory, 'scenario-1-000000000002.json');
  await fs.writeFile(newest, '{"payload":', 'utf8');
  await fs.writeFile(`${newest}.half-written.tmp`, 'incomplete', 'utf8');

  const reopened = new RoadCheckpointStore(directory, {
    runId: 'scenario-1',
    routePackDigest: DIGEST_A,
    maxGenerations: 2
  });
  const recovered = await reopened.load();
  assert.equal(recovered.generation, 1);
  assert.equal(recovered.states[0].cursorMeters, 10);
  assert.equal(recovered.recoveredFromCorruption, true);
  const saved = await reopened.save([vehicle(40)]);
  assert.equal(saved.generation, 3);
  const files = await fs.readdir(reopened.directory);
  assert.ok(files.includes('scenario-1-000000000001.json'));
  assert.ok(files.includes('scenario-1-000000000003.json'));
  assert.ok(!files.includes('scenario-1-000000000002.json'));
});

test('refuses silent fresh start when every generation is corrupt', async (t) => {
  const { directory, store } = await temporaryStore(t);
  await store.save([vehicle()]);
  await fs.writeFile(
    path.join(store.directory, 'scenario-1-000000000001.json'),
    '{broken',
    'utf8'
  );
  const reopened = new RoadCheckpointStore(directory, {
    runId: 'scenario-1',
    routePackDigest: DIGEST_A
  });
  await assert.rejects(reopened.load(), CheckpointCorruptError);
  await assert.rejects(reopened.save([vehicle(100)]), CheckpointCorruptError);
});

test('detects a valid JSON snapshot whose checksum no longer matches', async (t) => {
  const { directory, store } = await temporaryStore(t);
  await store.save([vehicle(10)]);
  await store.save([vehicle(20)]);
  const file = path.join(store.directory, 'scenario-1-000000000002.json');
  const envelope = JSON.parse(await fs.readFile(file, 'utf8'));
  envelope.payload.states[0].cursorMeters = 20_000;
  await fs.writeFile(file, JSON.stringify(envelope), 'utf8');

  const reopened = new RoadCheckpointStore(directory, {
    runId: 'scenario-1',
    routePackDigest: DIGEST_A
  });
  const restored = await reopened.load();
  assert.equal(restored.generation, 1);
  assert.equal(restored.states[0].cursorMeters, 10);
  assert.equal(restored.recoveredFromCorruption, true);
});

test('rejects an intact checkpoint with an unsupported schema', async (t) => {
  const { directory, store } = await temporaryStore(t);
  await store.save([vehicle()]);
  const file = path.join(store.directory, 'scenario-1-000000000001.json');
  const envelope = JSON.parse(await fs.readFile(file, 'utf8'));
  envelope.payload.schemaVersion = 99;
  envelope.checksum = createHash('sha256')
    .update(JSON.stringify(envelope.payload))
    .digest('hex');
  await fs.writeFile(file, JSON.stringify(envelope), 'utf8');
  const reopened = new RoadCheckpointStore(directory, {
    runId: 'scenario-1',
    routePackDigest: DIGEST_A
  });
  await assert.rejects(reopened.load(), CheckpointIncompatibleError);
});

test('rejects a compatible-looking run with a different route pack digest', async (t) => {
  const { directory, store } = await temporaryStore(t);
  await store.save([vehicle()]);
  const reopened = new RoadCheckpointStore(directory, {
    runId: 'scenario-1',
    routePackDigest: DIGEST_B
  });
  await assert.rejects(reopened.load(), CheckpointIncompatibleError);
});

test('captures a batch immediately and flushes queued writes on close', async (t) => {
  const { directory, store } = await temporaryStore(t);
  const batch = [vehicle(12)];
  const pending = store.save(batch);
  batch[0].cursorMeters = 999;
  await store.close();
  await pending;
  await assert.rejects(store.save([vehicle(13)]), /closed/);
  const reopened = new RoadCheckpointStore(directory, {
    runId: 'scenario-1',
    routePackDigest: DIGEST_A
  });
  assert.equal((await reopened.load()).states[0].cursorMeters, 12);
});

test('rejects path traversal, duplicate IMEIs and non-finite state', async (t) => {
  const { directory, store } = await temporaryStore(t);
  assert.throws(() => new RoadCheckpointStore(directory, {
    runId: '../other', routePackDigest: DIGEST_A
  }), /runId/);
  await assert.rejects(store.save([vehicle(), vehicle()]), /Duplicate checkpoint IMEI/);
  await assert.rejects(store.save([vehicle(Number.NaN)]), /non-finite/);
  assert.equal(await store.load(), null);
});
