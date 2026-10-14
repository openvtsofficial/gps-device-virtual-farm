'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { allocateRoadFleet, countUniqueParkedPositionCapacity,
  countParkedPositionCapacityForPacks,
  PARKED_ANCHOR_RADIUS_METERS,
  PARKED_MIN_SEPARATION_METERS } = require('../src/simulator/road-allocator');
const { RoadMovementModel, pointAtDistance } = require('../src/simulator/road-movement');
const { haversineKm } = require('../src/simulator/geo');
const { DeviceFarm } = require('../src/simulator/device-farm');
const { FrameDecoder, buildAck, buildLocation } = require('../src/simulator/gt06');
const { evaluateCoverage } = require('../src/road/route-capacity');

function route(id, regionId, { closedLoop = true, span = 0.01,
  latitude = 28, longitude = 77 } = {}) {
  const points = closedLoop ? [
    { latitude, longitude },
    { latitude, longitude: longitude + span },
    { latitude: latitude + span, longitude: longitude + span },
    { latitude: latitude + span, longitude },
    { latitude, longitude }
  ] : [
    { latitude, longitude },
    { latitude, longitude: longitude + span },
    { latitude: latitude + span, longitude: longitude + span }
  ];
  const cumulativeMeters = [0];
  for (let index = 1; index < points.length; index += 1) {
    cumulativeMeters.push(cumulativeMeters[index - 1] +
      haversineKm(points[index - 1], points[index]) * 1000);
  }
  return {
    id, regionId, family: 'urban', closedLoop, points, cumulativeMeters,
    lengthMeters: cumulativeMeters.at(-1), digest: `digest-${id}`,
    parkedAnchors: [0, points.length - 2]
  };
}

function pack(id, weight, routes) {
  return {
    digest: `pack-${id}`,
    region: { id, fleetWeight: weight },
    routes,
    parkedAnchors: routes.flatMap((item) => item.parkedAnchors.map((pointIndex) => ({
      routeId: item.id, pointIndex,
      latitude: item.points[pointIndex].latitude,
      longitude: item.points[pointIndex].longitude
    })))
  };
}

function imeis(count) {
  return Array.from({ length: count }, (_, index) =>
    `3589888888${String(index).padStart(5, '0')}`);
}

function assertMinimumGroundGap(points, minimumMeters) {
  const ordered = [...points].sort((left, right) => left.latitude - right.latitude);
  for (let index = 0; index < ordered.length; index += 1) {
    for (let other = index + 1; other < ordered.length; other += 1) {
      // A degree of latitude is at least 110 km everywhere on Earth.
      if ((ordered[other].latitude - ordered[index].latitude) * 110_000 > minimumMeters) break;
      const distance = haversineKm(ordered[index], ordered[other]) * 1000;
      assert.ok(distance >= minimumMeters,
        `parked vehicles are only ${distance.toFixed(3)} m apart`);
    }
  }
}

test('allocator spreads deterministic moving and parked assignments across weighted packs', () => {
  const packs = [
    pack('north', 0.75, [route('n1', 'north'), route('n2', 'north')]),
    pack('south', 0.25, [route('s1', 'south')])
  ];
  const options = { packs, imeis: imeis(20), movingCount: 12, seed: 'scenario' };
  const first = allocateRoadFleet(options);
  const second = allocateRoadFleet(options);
  assert.deepEqual(first, second);
  assert.equal(first.assignments.length, 20);
  assert.equal(new Set(first.assignments.slice(0, 12).map((item) => item.routeId)).size, 3);
  assert.equal(first.assignments.filter((item) => item.regionId === 'south' && item.moving).length, 3);
  assert.ok(first.assignments.slice(12).every((item) => item.parkedAnchor && !item.moving));
  assert.ok(first.assignments.every((item) => item.routePackDigest === `pack-${item.regionId}`));
  const cursors = first.assignments.slice(0, 12).map((item) =>
    `${item.routeId}:${item.cursorMeters.toFixed(3)}`);
  assert.equal(new Set(cursors).size, cursors.length);
});

test('allocator rejects insufficient or duplicated route capacity', () => {
  const short = route('short', 'only', { span: 0.0002 });
  assert.throws(() => allocateRoadFleet({
    pack: pack('only', 1, [short]), imeis: imeis(5), movingCount: 5
  }), /capacity insufficient/);
  assert.throws(() => allocateRoadFleet({
    pack: pack('only', 1, [short, { ...short }]), imeis: imeis(2), movingCount: 1
  }), /Duplicate route/);
});

test('continuous-motion allocation uses only legal closed tours', () => {
  const selectedPack = pack('only', 1, [
    route('closed', 'only'), route('destination', 'only', { closedLoop: false })
  ]);
  const allocation = allocateRoadFleet({
    pack: selectedPack, imeis: imeis(10), movingCount: 8,
    requireContinuousMotion: true
  });
  assert.ok(allocation.assignments.slice(0, 8).every((item) => item.routeId === 'closed'));
  const openOnly = pack('only', 1, [route('destination', 'only', { closedLoop: false })]);
  assert.throws(() => allocateRoadFleet({
    pack: openOnly, imeis: imeis(2), movingCount: 1,
    requireContinuousMotion: true
  }), /capacity insufficient/);
});

test('allocator retains compatible checkpoint assignments and rejects changed pack identity', () => {
  const selectedPack = pack('only', 1, [route('a', 'only'), route('b', 'only')]);
  const initial = allocateRoadFleet({
    pack: selectedPack, imeis: imeis(6), movingCount: 3, seed: 'first'
  });
  const again = allocateRoadFleet({
    pack: selectedPack, imeis: imeis(8), movingCount: 3, seed: 'different',
    restoredAssignments: new Map(initial.assignments.map((item) => [item.imei, item]))
  });
  assert.deepEqual(again.assignments.slice(0, 6), initial.assignments);
  const changed = { ...selectedPack, digest: 'other-digest' };
  assert.throws(() => allocateRoadFleet({
    pack: changed, imeis: imeis(6), movingCount: 3,
    restoredAssignments: initial.assignments
  }), /incompatible/);
  assert.throws(() => allocateRoadFleet({
    pack: selectedPack, imeis: imeis(8), movingCount: 4,
    restoredAssignments: initial.assignments
  }), /Moving\/parked role changed/);
});

test('allocator repairs only floating-point cursor drift at a saved route boundary', () => {
  const selectedRoute = route('boundary', 'only');
  const selectedPack = pack('only', 1, [selectedRoute]);
  const [imei] = imeis(1);
  const original = allocateRoadFleet({ pack: selectedPack,
    imeis: [imei], movingCount: 0 }).assignments[0];
  const checkpoint = new RoadMovementModel({ route: selectedRoute,
    assignment: original }).checkpoint();
  const endpoint = selectedRoute.points.at(-1);
  const justPastEnd = { ...checkpoint,
    cursorMeters: selectedRoute.lengthMeters + 7e-12,
    parkedAnchor: { pointIndex: 0,
      latitude: endpoint.latitude, longitude: endpoint.longitude },
    lastQueuedLatitude: endpoint.latitude,
    lastQueuedLongitude: endpoint.longitude };
  const restored = allocateRoadFleet({ pack: selectedPack,
    imeis: [imei], movingCount: 0, restoredAssignments: [justPastEnd] }).assignments[0];
  assert.equal(restored.cursorMeters, selectedRoute.lengthMeters);
  const model = new RoadMovementModel({ route: selectedRoute,
    assignment: restored, checkpoint: restored });
  assert.equal(model.proposePoint(1_000_000).gpsPoint.speedKph, 0);
  assert.equal(justPastEnd.cursorMeters > selectedRoute.lengthMeters, true);

  const materiallyPastEnd = { ...justPastEnd,
    cursorMeters: selectedRoute.lengthMeters + 0.001 };
  assert.throws(() => allocateRoadFleet({ pack: selectedPack,
    imeis: [imei], movingCount: 0,
    restoredAssignments: [materiallyPastEnd] }), /incompatible/);
});

test('3,000-device road fleet spaces every parked IMEI at least 50 m apart and restores checkpoints', () => {
  const routes = Array.from({ length: 400 }, (_, index) => route(`city-${index}`, 'only', {
    span: 0.02,
    latitude: 28 + Math.floor(index / 5) * 0.03,
    longitude: 77 + (index % 5) * 0.03
  }));
  const selectedPack = pack('only', 1, routes);
  const devices = imeis(3_000);
  const options = { pack: selectedPack, imeis: devices, movingCount: 750, seed: 'fleet-3000' };
  const initial = allocateRoadFleet(options);
  const routeById = new Map(routes.map((item) => [item.id, item]));
  const rounded = new Set();
  const transmitted = new Set();
  const displayPoints = [];
  const transmittedPoints = [];
  const checkpoints = [];
  const decoder = new FrameDecoder();
  for (const assignment of initial.assignments.slice(750)) {
    const selectedRoute = routeById.get(assignment.routeId);
    const model = new RoadMovementModel({ route: selectedRoute, assignment });
    const proposal = model.proposePoint(1_000_000);
    model.commitQueuedPoint(proposal.nextStateToken);
    const gps = proposal.gpsPoint;
    assert.equal(gps.speedKph, 0);
    const onRoad = pointAtDistance(selectedRoute, assignment.cursorMeters);
    assert.equal(gps.latitude, Number(onRoad.latitude.toFixed(6)));
    assert.equal(gps.longitude, Number(onRoad.longitude.toFixed(6)));
    const anchorCursor = selectedRoute.cumulativeMeters[assignment.parkedAnchor.pointIndex];
    const delta = Math.abs(anchorCursor - assignment.cursorMeters);
    assert.ok(Math.min(delta, selectedRoute.lengthMeters - delta) <=
      PARKED_ANCHOR_RADIUS_METERS + 1e-6);
    const roundedKey = `${gps.latitude},${gps.longitude}`;
    assert.ok(!rounded.has(roundedKey), `duplicate displayed coordinate ${roundedKey}`);
    rounded.add(roundedKey);
    displayPoints.push(gps);
    const [frame] = decoder.feed(buildLocation(1, gps));
    const courseStatus = frame.data.readUInt16BE(17);
    transmittedPoints.push({
      latitude: frame.data.readUInt32BE(8) / 1_800_000 * (courseStatus & 0x0400 ? 1 : -1),
      longitude: frame.data.readUInt32BE(12) / 1_800_000 * (courseStatus & 0x0800 ? -1 : 1)
    });
    const wireKey = `${frame.data.readUInt32BE(8)}:${frame.data.readUInt32BE(12)}:` +
      `${frame.data.readUInt16BE(17) & 0x0c00}`;
    assert.ok(!transmitted.has(wireKey), `duplicate GT06 coordinate ${wireKey}`);
    transmitted.add(wireKey);
    checkpoints.push(model.checkpoint());
  }
  assert.equal(rounded.size, 2_250);
  assert.equal(transmitted.size, 2_250);
  assertMinimumGroundGap(displayPoints, PARKED_MIN_SEPARATION_METERS);
  assertMinimumGroundGap(transmittedPoints, PARKED_MIN_SEPARATION_METERS);
  const resumed = allocateRoadFleet({ ...options,
    restoredAssignments: [...initial.assignments.slice(0, 750), ...checkpoints] });
  assert.deepEqual(resumed.assignments.slice(750), checkpoints);
});

test('saved parked checkpoints less than 50 m apart are separated on their verified road', () => {
  const selectedRoute = route('city', 'only');
  const selectedPack = pack('only', 1, [selectedRoute]);
  const devices = imeis(2);
  const original = allocateRoadFleet({ pack: selectedPack,
    imeis: devices, movingCount: 0 }).assignments[0];
  const firstModel = new RoadMovementModel({ route: selectedRoute, assignment: original });
  firstModel.commitQueuedPoint(firstModel.proposePoint(1_000_000).nextStateToken);
  const first = firstModel.checkpoint();
  const nearCursor = (first.cursorMeters + 10) % selectedRoute.lengthMeters;
  const nearPoint = pointAtDistance(selectedRoute, nearCursor);
  const near = { ...first, imei: devices[1], cursorMeters: nearCursor,
    lastQueuedLatitude: Number(nearPoint.latitude.toFixed(6)),
    lastQueuedLongitude: Number(nearPoint.longitude.toFixed(6)) };
  const resumed = allocateRoadFleet({ pack: selectedPack,
    imeis: devices, movingCount: 0, restoredAssignments: [first, near] }).assignments;
  assert.deepEqual(resumed[0], first);
  assert.equal(resumed[1].schemaVersion, undefined);
  const positions = resumed.map((assignment) => {
    const model = new RoadMovementModel({ route: selectedRoute, assignment,
      ...(assignment.schemaVersion === 1 ? { checkpoint: assignment } : {}) });
    return model.proposePoint(2_000_000).gpsPoint;
  });
  assertMinimumGroundGap(positions, PARKED_MIN_SEPARATION_METERS);
});

test('old duplicate parked checkpoints retain the first position and relocate only collisions on road', () => {
  const selectedRoute = route('city', 'only');
  const selectedPack = pack('only', 1, [selectedRoute]);
  const devices = imeis(8);
  const initial = allocateRoadFleet({ pack: selectedPack, imeis: devices, movingCount: 0 });
  const firstModel = new RoadMovementModel({ route: selectedRoute, assignment: initial.assignments[0] });
  firstModel.commitQueuedPoint(firstModel.proposePoint(1_000_000).nextStateToken);
  const oldCheckpoint = firstModel.checkpoint();
  const restoredAssignments = devices.map((imei) => ({ ...oldCheckpoint, imei }));
  const migrated = allocateRoadFleet({ pack: selectedPack, imeis: devices,
    movingCount: 0, restoredAssignments });
  assert.deepEqual(migrated.assignments[0], oldCheckpoint);
  assert.ok(migrated.assignments.slice(1).every((assignment) => assignment.schemaVersion === undefined));
  const locations = migrated.assignments.map((assignment) => {
    const model = new RoadMovementModel({ route: selectedRoute, assignment,
      ...(assignment.schemaVersion === 1 ? { checkpoint: assignment } : {}) });
    const gps = model.proposePoint(2_000_000).gpsPoint;
    return `${gps.latitude},${gps.longitude}`;
  });
  assert.equal(new Set(locations).size, devices.length);
  assert.equal(locations[0], `${oldCheckpoint.lastQueuedLatitude},${oldCheckpoint.lastQueuedLongitude}`);
});

test('insufficient distinct on-road stationary positions fail rather than repeat coordinates', () => {
  const short = route('short', 'only', { span: 0.0002 });
  const selectedPack = pack('only', 1, [short]);
  const capacity = countUniqueParkedPositionCapacity([short], 300);
  assert.ok(capacity < 300);
  assert.throws(() => allocateRoadFleet({ pack: selectedPack,
    imeis: imeis(300), movingCount: 0 }), /Unique parked road positions insufficient/);
});

test('long city routes use additional verified vertices to fit spaced parked vehicles', () => {
  const sparse = route('long-city', 'only', { span: 0.02 });
  const points = [];
  for (let side = 0; side < sparse.points.length - 1; side += 1) {
    for (let step = 0; step < 10; step += 1) {
      const fraction = step / 10;
      points.push({
        latitude: sparse.points[side].latitude * (1 - fraction) +
          sparse.points[side + 1].latitude * fraction,
        longitude: sparse.points[side].longitude * (1 - fraction) +
          sparse.points[side + 1].longitude * fraction
      });
    }
  }
  points.push(sparse.points.at(-1));
  const cumulativeMeters = [0];
  for (let index = 1; index < points.length; index += 1) {
    cumulativeMeters.push(cumulativeMeters[index - 1] +
      haversineKm(points[index - 1], points[index]) * 1000);
  }
  const selectedRoute = { ...sparse, points, cumulativeMeters,
    lengthMeters: cumulativeMeters.at(-1), parkedAnchors: [0, points.length - 2] };
  const selectedPack = pack('only', 1, [selectedRoute]);
  const parked = allocateRoadFleet({ pack: selectedPack,
    imeis: imeis(40), movingCount: 0 }).assignments;
  assert.ok(parked.some((assignment) =>
    !selectedRoute.parkedAnchors.includes(assignment.parkedAnchor.pointIndex)));
  const parkedPoints = parked.map((assignment) => {
    const model = new RoadMovementModel({ route: selectedRoute, assignment });
    return model.proposePoint(1_000_000).gpsPoint;
  });
  assertMinimumGroundGap(parkedPoints, PARKED_MIN_SEPARATION_METERS);
});

test('stationary capacity preflight counts overlapping regions only once', () => {
  const firstRegion = { id: 'first', centerLatitude: 28, centerLongitude: 77,
    radiusKm: 10, fleetWeight: 0.5 };
  const secondRegion = { ...firstRegion, id: 'second' };
  const firstRoute = route('first-route', 'first', { span: 0.002 });
  const secondRoute = { ...firstRoute, id: 'second-route', regionId: 'second' };
  const report = evaluateCoverage([
    { region: firstRegion, routes: [firstRoute] },
    { region: secondRegion, routes: [secondRoute] }
  ], { regions: [firstRegion, secondRegion], parkedDevices: 16, minZones: 0 });
  assert.ok(report.regions.every((region) => region.parkedPositionCapacity >= 8));
  assert.ok(report.parkedPositionCapacity < 16);
  assert.ok(report.deficits.some((deficit) => deficit.includes('across selected regions')));
});

test('stationary spacing checks short routes across the antimeridian', () => {
  const east = route('east', 'only', { longitude: 179.99985, span: 0.00005 });
  const west = route('west', 'only', { longitude: -179.99985, span: 0.00005 });
  const selectedPack = pack('only', 1, [east, west]);
  assert.equal(countUniqueParkedPositionCapacity([east, west], 2), 1);
  assert.throws(() => allocateRoadFleet({ pack: selectedPack,
    imeis: imeis(2), movingCount: 0 }), /Unique parked road positions insufficient/);
});

test('stationary spacing checks geographically close polar routes', () => {
  const first = route('first', 'polar', {
    latitude: 89.999, longitude: 0, span: 0.00005
  });
  const second = route('second', 'polar', {
    latitude: 89.999, longitude: 10, span: 0.00005
  });
  assert.equal(countUniqueParkedPositionCapacity([first, second], 2), 1);
});

test('parked capacity preflight follows the same seeded anchor order as allocation', () => {
  const starts = [
    [28.000376, 77.00024, -0.0011320643703341578, -0.000984088543485761],
    [27.999848, 76.999712, 0.0014672214011007083, -0.0003118675362266398],
    [28.000096, 76.999896, -0.000633927392611049, 0.0013594616805549752]
  ];
  const routes = starts.map(([latitude, longitude, dLon, dLat], index) => {
    const points = [{ latitude, longitude },
      { latitude: latitude + dLat, longitude: longitude + dLon }];
    const lengthMeters = haversineKm(points[0], points[1]) * 1000;
    return { id: `r${index}`, regionId: 'one', family: 'local',
      closedLoop: false, points, cumulativeMeters: [0, lengthMeters],
      lengthMeters, parkedAnchors: [0], digest: `digest-r${index}` };
  });
  const region = { id: 'one', centerLatitude: 28, centerLongitude: 77,
    radiusKm: 2, fleetWeight: 1 };
  const selectedPack = { digest: 'pack', region, routes,
    parkedAnchors: routes.map((item) => ({ routeId: item.id, pointIndex: 0,
      latitude: item.points[0].latitude, longitude: item.points[0].longitude })) };
  const available = countParkedPositionCapacityForPacks([selectedPack], 8,
    { seed: 'case17' });
  assert.ok(available < 8);
  assert.throws(() => allocateRoadFleet({ pack: selectedPack,
    imeis: imeis(8), movingCount: 0, seed: 'case17' }), /parked road positions insufficient/);
  const report = evaluateCoverage([selectedPack], {
    regions: [region], parkedDevices: 8, minDistinctRoutes: 0,
    minZones: 0, scenarioSeed: 'case17'
  });
  assert.equal(report.parkedPositionCapacity, available);
  assert.equal(report.ready, false);

  const sevenImeis = imeis(7);
  const fresh = allocateRoadFleet({ pack: selectedPack,
    imeis: sevenImeis, movingCount: 0, seed: 'case17' });
  const alternate = allocateRoadFleet({ pack: selectedPack,
    imeis: sevenImeis, movingCount: 0, seed: 'alt0' });
  assert.notDeepEqual(alternate.assignments[2], fresh.assignments[2]);
  const alternateRoute = routes.find((item) => item.id === alternate.assignments[2].routeId);
  const alternateCheckpoint = new RoadMovementModel({ route: alternateRoute,
    assignment: alternate.assignments[2] }).checkpoint();
  const resumed = allocateRoadFleet({ pack: selectedPack,
    imeis: sevenImeis, movingCount: 0, seed: 'case17',
    restoredAssignments: [alternateCheckpoint] });
  assert.deepEqual(resumed.assignments, fresh.assignments);

  const movingPoints = [{ latitude: 28.01, longitude: 77.01 },
    { latitude: 28.01, longitude: 77.03 }];
  const movingLength = haversineKm(movingPoints[0], movingPoints[1]) * 1000;
  const movingRoute = { id: 'moving', regionId: 'one', family: 'intercity',
    closedLoop: false, points: movingPoints,
    cumulativeMeters: [0, movingLength], lengthMeters: movingLength,
    parkedAnchors: [], digest: 'digest-moving' };
  const mixedPack = { ...selectedPack, routes: [...routes, movingRoute] };
  const mixedImeis = imeis(8);
  const mixedFresh = allocateRoadFleet({ pack: mixedPack,
    imeis: mixedImeis, movingCount: 1, seed: 'case17' });
  const mixedAlternate = allocateRoadFleet({ pack: mixedPack,
    imeis: mixedImeis, movingCount: 1, seed: 'alt0' });
  const movingCheckpoint = new RoadMovementModel({ route: movingRoute,
    assignment: mixedAlternate.assignments[0] }).checkpoint();
  const parkedAlternate = mixedAlternate.assignments[3];
  const parkedRoute = routes.find((item) => item.id === parkedAlternate.routeId);
  const parkedCheckpoint = new RoadMovementModel({ route: parkedRoute,
    assignment: parkedAlternate }).checkpoint();
  const mixedResumed = allocateRoadFleet({ pack: mixedPack,
    imeis: mixedImeis, movingCount: 1, seed: 'case17',
    restoredAssignments: [movingCheckpoint, parkedCheckpoint] });
  assert.deepEqual(mixedResumed.assignments[0], movingCheckpoint);
  assert.deepEqual(mixedResumed.assignments.slice(1), mixedFresh.assignments.slice(1));
});

test('road model proposes without advancing until queued and follows route geometry', () => {
  const selectedRoute = route('a', 'only');
  const assignment = allocateRoadFleet({
    pack: pack('only', 1, [selectedRoute]), imeis: imeis(1), movingCount: 1
  }).assignments[0];
  const model = new RoadMovementModel({ route: selectedRoute, assignment });
  const first = model.proposePoint(1_000_000);
  assert.equal(model.checkpoint().cursorMeters, assignment.cursorMeters);
  assert.equal(model.proposePoint(1_000_001), first);
  assert.throws(() => model.commitQueuedPoint({}), /stale/);
  model.commitQueuedPoint(first.nextStateToken);
  assert.throws(() => model.commitQueuedPoint(first.nextStateToken), /stale/);
  const next = model.proposePoint(1_010_000);
  model.commitQueuedPoint(next.nextStateToken);
  const state = model.checkpoint();
  assert.ok(state.cursorMeters > assignment.cursorMeters);
  assert.deepEqual(
    [next.gpsPoint.latitude, next.gpsPoint.longitude],
    [Number(pointAtDistance(selectedRoute, state.cursorMeters).latitude.toFixed(6)),
      Number(pointAtDistance(selectedRoute, state.cursorMeters).longitude.toFixed(6))]
  );
  assert.ok(next.gpsPoint.speedKph > 0);
});

test('open journey reaches terminal without reverse or wrap; closed tour wraps only when validated', () => {
  const open = route('open', 'only', { closedLoop: false, span: 0.0001 });
  const assignment = allocateRoadFleet({
    pack: pack('only', 1, [open]), imeis: imeis(1), movingCount: 1,
    minSpacingMeters: 5
  }).assignments[0];
  const model = new RoadMovementModel({ route: open, assignment });
  model.commitQueuedPoint(model.proposePoint(1_000_000).nextStateToken);
  for (let tick = 1; tick <= 10; tick += 1) {
    const proposal = model.proposePoint(1_000_000 + tick * 10_000);
    model.commitQueuedPoint(proposal.nextStateToken);
  }
  assert.equal(model.checkpoint().phase, 'terminal');
  assert.equal(model.checkpoint().cursorMeters, open.lengthMeters);
  const held = model.proposePoint(2_000_000);
  assert.equal(held.gpsPoint.speedKph, 0);
  assert.equal(held.gpsPoint.latitude, Number(open.points.at(-1).latitude.toFixed(6)));

  const invalid = { ...open, closedLoop: true };
  assert.throws(() => new RoadMovementModel({ route: invalid, assignment }), /endpoint gap/);
  const loop = route('loop', 'only', { span: 0.0001 });
  const loopAssignment = allocateRoadFleet({
    pack: pack('only', 1, [loop]), imeis: imeis(1), movingCount: 1,
    minSpacingMeters: 5
  }).assignments[0];
  const loopModel = new RoadMovementModel({ route: loop, assignment: loopAssignment });
  loopModel.commitQueuedPoint(loopModel.proposePoint(1_000_000).nextStateToken);
  for (let tick = 1; tick <= 10; tick += 1) {
    const proposal = loopModel.proposePoint(1_000_000 + tick * 10_000);
    loopModel.commitQueuedPoint(proposal.nextStateToken);
  }
  assert.ok(loopModel.checkpoint().completedTours > 0);
  assert.notEqual(loopModel.checkpoint().phase, 'terminal');
});

test('road model freezes across outages and restores its exact committed cursor', () => {
  const selectedRoute = route('a', 'only');
  const assignment = allocateRoadFleet({
    pack: pack('only', 1, [selectedRoute]), imeis: imeis(1), movingCount: 1
  }).assignments[0];
  const model = new RoadMovementModel({ route: selectedRoute, assignment });
  model.commitQueuedPoint(model.proposePoint(1_000_000).nextStateToken);
  model.commitQueuedPoint(model.proposePoint(1_010_000).nextStateToken);
  const before = model.checkpoint();
  assert.ok(before.currentSpeedMps > 0);
  const restoredWhileMoving = new RoadMovementModel({
    route: selectedRoute, assignment, checkpoint: before
  });
  const firstAfterRestart = restoredWhileMoving.proposePoint(2_000_000);
  assert.equal(firstAfterRestart.gpsPoint.latitude, before.lastQueuedLatitude);
  assert.equal(firstAfterRestart.gpsPoint.longitude, before.lastQueuedLongitude);
  assert.equal(firstAfterRestart.gpsPoint.speedKph, 0);
  model.onTransportUnavailable();
  model.onTransportAvailable(5_000_000);
  const resumed = model.proposePoint(5_000_000, 5_000_000);
  assert.equal(model.checkpoint().cursorMeters, before.cursorMeters);
  assert.equal(resumed.gpsPoint.latitude, before.lastQueuedLatitude);
  assert.equal(resumed.gpsPoint.longitude, before.lastQueuedLongitude);
  model.commitQueuedPoint(resumed.nextStateToken);
  assert.equal(model.checkpoint().cursorMeters, before.cursorMeters);

  const restored = new RoadMovementModel({
    route: selectedRoute, assignment, checkpoint: model.checkpoint()
  });
  assert.equal(restored.checkpoint().cursorMeters, before.cursorMeters);
  assert.equal(restored.checkpoint().routePackDigest, assignment.routePackDigest);
  const next = restored.proposePoint(5_000_001);
  assert.equal(next.gpsPoint.latitude, before.lastQueuedLatitude);
  assert.equal(next.gpsPoint.longitude, before.lastQueuedLongitude);
  assert.equal(next.gpsPoint.speedKph, 0);
  assert.ok(Date.parse(next.gpsPoint.deviceTimeISO) > before.lastQueuedWallUtcMs);
});

test('parked vehicle stays at its eligible anchor with speed zero', () => {
  const selectedRoute = route('a', 'only');
  const assignment = allocateRoadFleet({
    pack: pack('only', 1, [selectedRoute]), imeis: imeis(1), movingCount: 0
  }).assignments[0];
  const model = new RoadMovementModel({ route: selectedRoute, assignment });
  const first = model.proposePoint(1_000_000);
  model.commitQueuedPoint(first.nextStateToken);
  const next = model.proposePoint(1_300_000);
  assert.equal(next.gpsPoint.latitude, first.gpsPoint.latitude);
  assert.equal(next.gpsPoint.longitude, first.gpsPoint.longitude);
  assert.equal(next.gpsPoint.speedKph, 0);
});

test('prepared stop marker holds the same road point before continuing', () => {
  const selectedRoute = { ...route('stops', 'only', { closedLoop: false, span: 0.001 }),
    stopMeters: [10] };
  const assignment = {
    imei: imeis(1)[0], moving: true, regionId: 'only',
    routeId: selectedRoute.id, routeDigest: selectedRoute.digest,
    routePackDigest: 'pack-only', cursorMeters: 0,
    speedSeed: 5, stopSeed: 0
  };
  const model = new RoadMovementModel({ route: selectedRoute, assignment });
  model.commitQueuedPoint(model.proposePoint(1_000_000).nextStateToken);
  const arrival = model.proposePoint(1_005_000);
  model.commitQueuedPoint(arrival.nextStateToken);
  assert.equal(model.checkpoint().phase, 'dwelling');
  assert.equal(model.checkpoint().cursorMeters, 10);
  assert.equal(arrival.gpsPoint.speedKph, 0);
  const dwell = model.proposePoint(1_006_000);
  model.commitQueuedPoint(dwell.nextStateToken);
  assert.equal(dwell.gpsPoint.latitude, arrival.gpsPoint.latitude);
  assert.equal(dwell.gpsPoint.longitude, arrival.gpsPoint.longitude);
  model.commitQueuedPoint(model.proposePoint(1_016_000).nextStateToken);
  const resumed = model.proposePoint(1_026_000);
  model.commitQueuedPoint(resumed.nextStateToken);
  assert.ok(model.checkpoint().cursorMeters > 10);
});

test('depot leg endpoints become validated dwell stops', () => {
  const selectedRoute = { ...route('depot', 'only', { closedLoop: false, span: 0.001 }),
    family: 'depot', legEndIndices: [1, 2] };
  const assignment = {
    imei: imeis(1)[0], moving: true, regionId: 'only',
    routeId: selectedRoute.id, routeDigest: selectedRoute.digest,
    routePackDigest: 'pack-only', cursorMeters: 0
  };
  const model = new RoadMovementModel({ route: selectedRoute, assignment });
  model.commitQueuedPoint(model.proposePoint(1_000_000).nextStateToken);
  for (let tick = 1; tick <= 5 && model.checkpoint().phase !== 'dwelling'; tick += 1) {
    model.commitQueuedPoint(model.proposePoint(1_000_000 + tick * 10_000).nextStateToken);
  }
  assert.equal(model.checkpoint().phase, 'dwelling');
  assert.equal(model.checkpoint().cursorMeters, selectedRoute.cumulativeMeters[1]);
});

test('corrupt checkpoint cannot put a moving vehicle behind its next stop', () => {
  const selectedRoute = { ...route('stops', 'only', { closedLoop: false }), stopMeters: [100] };
  const assignment = {
    imei: imeis(1)[0], moving: true, regionId: 'only',
    routeId: selectedRoute.id, routeDigest: selectedRoute.digest,
    routePackDigest: 'pack-only', cursorMeters: 0
  };
  const model = new RoadMovementModel({ route: selectedRoute, assignment });
  const checkpoint = { ...model.checkpoint(), cursorMeters: 200, nextStopIndex: 0 };
  assert.throws(() => new RoadMovementModel({
    route: selectedRoute, assignment, checkpoint
  }), /incompatible/);
});

test('road farm streams cached positions through in-memory GT06 ACK transport', async () => {
  class AckSocket extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.decoder = new FrameDecoder();
    }
    setNoDelay() {}
    setKeepAlive() {}
    connect() { setImmediate(() => this.emit('connect')); }
    write(packet) {
      for (const frame of this.decoder.feed(packet)) {
        if (frame.protocol === 0x01) {
          setImmediate(() => this.emit('data', buildAck(frame.protocol, frame.serial)));
        }
      }
      return true;
    }
    destroy() { this.destroyed = true; setImmediate(() => this.emit('close')); }
  }
  const selectedRoute = route('cached', 'default');
  const selectedPack = pack('default', 1, [selectedRoute]);
  selectedPack.digest = 'a'.repeat(64);
  const config = {
    deviceCount: 4, movingPercent: 25, movementMode: 'real-road',
    road: { regionMode: 'single', radiusKm: 50,
      selectedRoutePackDigests: [selectedPack.digest], requireEnterpriseDiversityGate: false }
  };
  const farm = new DeviceFarm(config, { roadPacks: [selectedPack], netModule: { Socket: AckSocket } });
  try {
    farm.start();
    const deadline = Date.now() + 3000;
    while (farm.snapshot().online !== 4 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(farm.snapshot().online, 4);
    assert.ok(farm.snapshot().locationPackets >= 4);
    const saved = farm.checkpointStates();
    assert.equal(saved.length, 4);
    assert.equal(saved[0].routePackDigest, selectedPack.digest);
    assert.equal(saved[0].imei, imeis(1)[0].slice(0, 10) + '00001');
  } finally {
    await farm.stop();
  }
});
