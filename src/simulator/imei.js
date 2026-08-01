'use strict';

const { IMEI_START, LIMITS } = require('./constants');

function generateImei(index) {
  if (!Number.isInteger(index) || index < 0 || index >= LIMITS.maxDevices) {
    throw new Error(`IMEI index must be between 0 and ${LIMITS.maxDevices - 1}`);
  }

  return String(IMEI_START + BigInt(index)).padStart(15, '0');
}

function movingDeviceCount(total, movingPercent = 25) {
  return Math.ceil(total * (movingPercent / 100));
}

function generateVehicleType(index) {
  const types = ['TRUCK', 'CAR', 'BUS'];
  return types[index % 3];
}

function generateVehicleName(index, type) {
  const typeNames = { TRUCK: 'Truck', CAR: 'Car', BUS: 'Bus' };
  return `${typeNames[type]} ${index + 1}`;
}

function generateSimNumber(index) {
  const base = 9876543210n;
  return String(base + BigInt(index));
}

function generatePlateNumber(index) {
  const states = ['GJ', 'MH', 'DL', 'KA', 'TN', 'UP', 'RJ', 'WB', 'HR', 'PB'];
  const state = states[index % states.length];
  const district = String((index % 20) + 1).padStart(2, '0');
  const letters = String.fromCharCode(65 + (index % 26)) + String.fromCharCode(65 + ((index * 7) % 26));
  const number = String((index % 9999) + 1).padStart(4, '0');
  return `${state}${district}${letters}${number}`;
}

function generateVIN(index) {
  const prefixes = ['1HGCM', '2HGCM', '3FADP', '4T1BF', '5FNRL', '6G2VX'];
  const prefix = prefixes[index % prefixes.length];
  const suffix = String(82633000000n + BigInt(index));
  return `${prefix}${suffix.substring(0, 12)}`;
}

function generateManifest(count, movingPercent = 25) {
  if (!Number.isInteger(count) || count < 1 || count > LIMITS.maxDevices) {
    throw new Error(`Device count must be between 1 and ${LIMITS.maxDevices}`);
  }

  const moving = movingDeviceCount(count, movingPercent);
  return Array.from({ length: count }, (_, index) => {
    const deviceType = generateVehicleType(index);
    return {
      vehicleName: generateVehicleName(index, deviceType),
      imei: generateImei(index),
      simNumber: generateSimNumber(index),
      deviceType,
      plateNumber: generatePlateNumber(index),
      vin: generateVIN(index),
      behavior: index < moving ? 'MOVING' : 'PARKED'
    };
  });
}

function manifestAsCsv(count, movingPercent = 25) {
  const lines = ['vehicleName,imei,simNumber,deviceType,plateNumber,vin'];
  const manifest = generateManifest(count, movingPercent);
  for (const device of manifest) {
    lines.push(`${device.vehicleName},${device.imei},${device.simNumber},${device.deviceType},${device.plateNumber},${device.vin}`);
  }
  return `${lines.join('\r\n')}\r\n`;
}

function manifestAsJson(count, movingPercent = 25) {
  const manifest = generateManifest(count, movingPercent);
  return `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    protocol: 'GT06',
    deviceCount: count,
    movingDevices: movingDeviceCount(count, movingPercent),
    vehicles: manifest
  }, null, 2)}\n`;
}

module.exports = {
  generateImei,
  generateManifest,
  manifestAsCsv,
  manifestAsJson,
  movingDeviceCount
};

