'use strict';

const EARTH_RADIUS_KM = 6371.0088;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalizeLongitude(longitude) {
  return ((longitude + 540) % 360) - 180;
}

function distributePosition(baseLatitude, baseLongitude, index, total) {
  const fraction = (index + 0.5) / Math.max(1, total);
  const radiusKm = 0.15 + 12 * Math.sqrt(fraction);
  const angle = index * GOLDEN_ANGLE;
  const northKm = Math.cos(angle) * radiusKm;
  const eastKm = Math.sin(angle) * radiusKm;
  const latitude = clamp(baseLatitude + northKm / 111.32, -89.9, 89.9);
  const longitudeScale = Math.max(0.05, Math.cos(latitude * Math.PI / 180));
  const longitude = normalizeLongitude(baseLongitude + eastKm / (111.32 * longitudeScale));
  return { latitude, longitude };
}

function coordinateOnLoop(center, angle, radiusKm, shape) {
  const northKm = Math.sin(angle) * radiusKm * shape;
  const eastKm = Math.cos(angle) * radiusKm;
  const latitude = clamp(center.latitude + northKm / 111.32, -89.9, 89.9);
  const longitudeScale = Math.max(0.05, Math.cos(latitude * Math.PI / 180));
  return {
    latitude,
    longitude: normalizeLongitude(center.longitude + eastKm / (111.32 * longitudeScale))
  };
}

function bearingDegrees(from, to) {
  const lat1 = from.latitude * Math.PI / 180;
  const lat2 = to.latitude * Math.PI / 180;
  const deltaLon = (to.longitude - from.longitude) * Math.PI / 180;
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function haversineKm(from, to) {
  const lat1 = from.latitude * Math.PI / 180;
  const lat2 = to.latitude * Math.PI / 180;
  const deltaLat = lat2 - lat1;
  const deltaLon = (to.longitude - from.longitude) * Math.PI / 180;
  const a = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

class RouteModel {
  constructor({ index, total, imei, baseLatitude, baseLongitude, moving }) {
    this.moving = Boolean(moving);
    this.hash = fnv1a(imei);
    this.center = distributePosition(baseLatitude, baseLongitude, index, total);
    this.radiusKm = 0.7 + ((this.hash >>> 8) % 170) / 100;
    this.shape = 0.55 + ((this.hash >>> 20) % 25) / 100;
    this.baseSpeed = 28 + ((this.hash >>> 16) % 31);
    this.phase = (this.hash / 0xffffffff) * Math.PI * 2;
    this.angle = this.phase;
    this.tick = 0;
    this.lastTimestampMs = 0;
    this.position = this.moving
      ? coordinateOnLoop(this.center, this.angle, this.radiusKm, this.shape)
      : { ...this.center };
  }

  nextPoint(nowMs = Date.now()) {
    const safeNow = Math.max(nowMs, this.lastTimestampMs + (this.lastTimestampMs ? 1 : 0));
    const elapsedSeconds = this.lastTimestampMs === 0
      ? 0
      : clamp((safeNow - this.lastTimestampMs) / 1000, 0, 60);
    const previous = this.position;

    let speedKph = 0;
    let course = this.moving ? bearingDegrees(
      previous,
      coordinateOnLoop(this.center, this.angle + 0.001, this.radiusKm, this.shape)
    ) : 0;

    if (this.moving) {
      speedKph = clamp(
        this.baseSpeed + 5 * Math.sin(this.tick / 8 + this.phase),
        20,
        65
      );
      const distanceKm = speedKph * elapsedSeconds / 3600;
      this.angle = (this.angle + distanceKm / this.radiusKm) % (Math.PI * 2);
      this.position = coordinateOnLoop(this.center, this.angle, this.radiusKm, this.shape);
      if (elapsedSeconds > 0) course = bearingDegrees(previous, this.position);
    }

    this.lastTimestampMs = safeNow;
    this.tick += 1;
    const satellites = 8 + ((this.hash + this.tick) % 5);

    return {
      latitude: round6(this.position.latitude),
      longitude: round6(this.position.longitude),
      speedKph: round1(speedKph),
      course: Math.round(course) % 360,
      satellites,
      valid: true,
      deviceTimeISO: new Date(safeNow).toISOString()
    };
  }
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function round6(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

module.exports = {
  RouteModel,
  bearingDegrees,
  distributePosition,
  fnv1a,
  haversineKm
};

