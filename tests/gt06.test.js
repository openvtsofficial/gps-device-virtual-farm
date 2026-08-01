'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FrameDecoder,
  buildAck,
  buildHeartbeat,
  buildLocation,
  buildLogin,
  crc16itu,
  decodeImeiBcd
} = require('../src/simulator/gt06');

const SAMPLE_POINT = Object.freeze({
  latitude: 28.6139,
  longitude: 77.209,
  speedKph: 42,
  course: 123,
  satellites: 10,
  valid: true,
  deviceTimeISO: '2026-07-12T12:30:15.000Z'
});

test('CRC-16/ITU matches the X.25 check value', () => {
  assert.equal(crc16itu(Buffer.from('123456789')), 0x906e);
});

test('login frame carries the exact BCD IMEI and serial', () => {
  const decoder = new FrameDecoder();
  const [frame] = decoder.feed(buildLogin('358988888800001', 42));
  assert.equal(frame.protocol, 0x01);
  assert.equal(frame.serial, 42);
  assert.equal(decodeImeiBcd(frame.data.subarray(1, 9)), '358988888800001');
  assert.equal(frame.raw[0], 0x78);
  assert.equal(frame.raw.at(-2), 0x0d);
  assert.equal(frame.raw.at(-1), 0x0a);
});

test('heartbeat expresses moving ignition state', () => {
  const decoder = new FrameDecoder();
  const moving = decoder.feed(buildHeartbeat(1, true))[0];
  const parked = decoder.feed(buildHeartbeat(2, false))[0];
  assert.equal(moving.protocol, 0x13);
  assert.equal(moving.data[1] & 0x02, 0x02);
  assert.equal(parked.data[1] & 0x02, 0);
});

test('location frame round-trips coordinates, speed and course', () => {
  const [frame] = new FrameDecoder().feed(buildLocation(7, SAMPLE_POINT));
  assert.equal(frame.protocol, 0x12);
  const latitude = frame.data.readUInt32BE(8) / 1_800_000;
  const longitude = frame.data.readUInt32BE(12) / 1_800_000;
  const speed = frame.data[16];
  const courseStatus = frame.data.readUInt16BE(17);
  assert.ok(Math.abs(latitude - SAMPLE_POINT.latitude) < 0.000001);
  assert.ok(Math.abs(longitude - SAMPLE_POINT.longitude) < 0.000001);
  assert.equal(speed, 42);
  assert.equal(courseStatus & 0x03ff, 123);
  assert.equal(courseStatus & 0x1000, 0x1000);
  assert.equal(courseStatus & 0x2000, 0x2000);
});

test('decoder handles split and combined TCP chunks', () => {
  const first = buildAck(0x01, 1);
  const second = buildAck(0x13, 2);
  const decoder = new FrameDecoder();
  assert.equal(decoder.feed(first.subarray(0, 4)).length, 0);
  const frames = decoder.feed(Buffer.concat([first.subarray(4), second]));
  assert.deepEqual(frames.map((frame) => frame.protocol), [0x01, 0x13]);
});

test('decoder rejects CRC corruption and resynchronizes', () => {
  const corrupted = Buffer.from(buildAck(0x01, 1));
  corrupted[4] ^= 0xff;
  const valid = buildAck(0x13, 2);
  const decoder = new FrameDecoder();
  const frames = decoder.feed(Buffer.concat([corrupted, valid]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].protocol, 0x13);
  assert.ok(decoder.malformedFrames >= 1);
});

