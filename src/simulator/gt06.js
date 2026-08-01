'use strict';

const MAX_RX_BUFFER = 64 * 1024;
const MAX_FRAME_SIZE = 4 * 1024;
const CRC_TABLE = buildCrcTable();

function buildCrcTable() {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (crc >> 1) ^ 0x8408 : crc >> 1;
    }
    table[i] = crc;
  }
  return table;
}

function crc16itu(buffer, start = 0, end = buffer.length) {
  let crc = 0xffff;
  for (let index = start; index < end; index += 1) {
    crc = (crc >> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff];
  }
  return crc ^ 0xffff;
}

function encodeImeiBcd(imei) {
  if (!/^\d{15}$/.test(imei)) {
    throw new Error('GT06 IMEI must contain exactly 15 digits');
  }

  const padded = `0${imei}`;
  const result = Buffer.alloc(8);
  for (let index = 0; index < 8; index += 1) {
    result[index] = (Number(padded[index * 2]) << 4) | Number(padded[index * 2 + 1]);
  }
  return result;
}

function decodeImeiBcd(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length !== 8) {
    throw new Error('BCD IMEI must be exactly 8 bytes');
  }
  let digits = '';
  for (const byte of buffer) {
    digits += String((byte >> 4) & 0x0f);
    digits += String(byte & 0x0f);
  }
  return digits.replace(/^0/, '');
}

function buildFrame(data, serial) {
  if (!Buffer.isBuffer(data) || data.length < 1) {
    throw new Error('GT06 frame data must be a non-empty Buffer');
  }
  const payloadLength = data.length + 4;
  if (payloadLength > 255) {
    throw new Error('GT06 short frame payload exceeds 255 bytes');
  }

  const frame = Buffer.alloc(2 + 1 + data.length + 2 + 2 + 2);
  frame[0] = 0x78;
  frame[1] = 0x78;
  frame[2] = payloadLength;
  data.copy(frame, 3);

  const serialOffset = 3 + data.length;
  frame.writeUInt16BE(serial & 0xffff, serialOffset);
  const crcOffset = serialOffset + 2;
  frame.writeUInt16BE(crc16itu(frame, 2, crcOffset), crcOffset);
  frame[crcOffset + 2] = 0x0d;
  frame[crcOffset + 3] = 0x0a;
  return frame;
}

function buildLogin(imei, serial) {
  const data = Buffer.alloc(11);
  data[0] = 0x01;
  encodeImeiBcd(imei).copy(data, 1);
  data.writeUInt16BE(0x0001, 9);
  return buildFrame(data, serial);
}

function buildHeartbeat(serial, ignition) {
  const terminalInfo = 0x04 | (ignition ? 0x02 : 0x00);
  return buildFrame(Buffer.from([
    0x13,
    terminalInfo,
    0x04,
    0x04,
    0x00,
    0x01
  ]), serial);
}

function buildLocation(serial, point) {
  const data = Buffer.alloc(19);
  let offset = 0;
  data[offset++] = 0x12;

  const timestamp = new Date(point.deviceTimeISO || point.timestamp || Date.now());
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error('Location timestamp is invalid');
  }

  data[offset++] = timestamp.getUTCFullYear() - 2000;
  data[offset++] = timestamp.getUTCMonth() + 1;
  data[offset++] = timestamp.getUTCDate();
  data[offset++] = timestamp.getUTCHours();
  data[offset++] = timestamp.getUTCMinutes();
  data[offset++] = timestamp.getUTCSeconds();

  const satellites = Math.max(0, Math.min(15, Math.round(point.satellites ?? 10)));
  data[offset++] = (0x0c << 4) | satellites;
  data.writeUInt32BE(Math.round(Math.abs(point.latitude) * 1_800_000), offset);
  offset += 4;
  data.writeUInt32BE(Math.round(Math.abs(point.longitude) * 1_800_000), offset);
  offset += 4;
  data[offset++] = Math.max(0, Math.min(255, Math.round(point.speedKph)));

  let courseStatus = Math.round(point.course) & 0x03ff;
  if (point.valid !== false) courseStatus |= 0x1000;
  courseStatus |= 0x2000;
  if (point.latitude >= 0) courseStatus |= 0x0400;
  if (point.longitude < 0) courseStatus |= 0x0800;
  data.writeUInt16BE(courseStatus, offset);

  return buildFrame(data, serial);
}

function buildCommandResponse(serial, serverFlag, content) {
  const contentBuffer = Buffer.from(String(content).slice(0, 180), 'ascii');
  const commandLength = 4 + contentBuffer.length + 2;
  const data = Buffer.alloc(1 + 1 + 4 + contentBuffer.length + 2);
  let offset = 0;
  data[offset++] = 0x15;
  data[offset++] = commandLength;
  data.writeUInt32BE(serverFlag >>> 0, offset);
  offset += 4;
  contentBuffer.copy(data, offset);
  offset += contentBuffer.length;
  data.writeUInt16BE(0x0001, offset);
  return buildFrame(data, serial);
}

function buildAck(protocol, serial) {
  return buildFrame(Buffer.from([protocol & 0xff]), serial);
}

function parseServerCommand(frame) {
  if (!frame || frame.protocol !== 0x80 || frame.data.length < 9) return null;
  const commandLength = frame.data.readUInt32BE(1);
  const serverFlag = frame.data.readUInt32BE(5);
  const commandStart = 9;
  const commandEnd = commandStart + commandLength;
  if (commandLength > 512 || commandEnd > frame.data.length) return null;
  return {
    serverFlag,
    command: frame.data.subarray(commandStart, commandEnd).toString('ascii')
  };
}

class FrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.malformedFrames = 0;
  }

  feed(chunk) {
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) return [];
    this.buffer = this.buffer.length === 0
      ? chunk
      : Buffer.concat([this.buffer, chunk], this.buffer.length + chunk.length);

    if (this.buffer.length > MAX_RX_BUFFER) {
      this.buffer = this.buffer.subarray(this.buffer.length - MAX_RX_BUFFER);
      this.malformedFrames += 1;
    }

    const frames = [];
    while (this.buffer.length >= 2) {
      const start = findHeader(this.buffer);
      if (start < 0) {
        const last = this.buffer[this.buffer.length - 1];
        this.buffer = last === 0x78 || last === 0x79
          ? this.buffer.subarray(this.buffer.length - 1)
          : Buffer.alloc(0);
        break;
      }

      if (start > 0) {
        this.buffer = this.buffer.subarray(start);
        this.malformedFrames += 1;
      }

      const isLong = this.buffer[0] === 0x79;
      const headerLength = isLong ? 4 : 3;
      if (this.buffer.length < headerLength) break;

      const payloadLength = isLong ? this.buffer.readUInt16BE(2) : this.buffer[2];
      const totalLength = headerLength + payloadLength + 2;
      if (payloadLength < 5 || totalLength > MAX_FRAME_SIZE) {
        this.buffer = this.buffer.subarray(1);
        this.malformedFrames += 1;
        continue;
      }
      if (this.buffer.length < totalLength) break;

      const raw = this.buffer.subarray(0, totalLength);
      const crcOffset = totalLength - 4;
      const footerIsValid = raw[totalLength - 2] === 0x0d && raw[totalLength - 1] === 0x0a;
      const expectedCrc = raw.readUInt16BE(crcOffset);
      const actualCrc = crc16itu(raw, 2, crcOffset);
      if (!footerIsValid || expectedCrc !== actualCrc) {
        this.buffer = this.buffer.subarray(1);
        this.malformedFrames += 1;
        continue;
      }

      const dataOffset = headerLength;
      const serialOffset = totalLength - 6;
      const data = Buffer.from(raw.subarray(dataOffset, serialOffset));
      frames.push({
        protocol: data[0],
        serial: raw.readUInt16BE(serialOffset),
        data,
        raw: Buffer.from(raw),
        longHeader: isLong
      });
      this.buffer = this.buffer.subarray(totalLength);
    }
    return frames;
  }
}

function findHeader(buffer) {
  for (let index = 0; index < buffer.length - 1; index += 1) {
    const first = buffer[index];
    if ((first === 0x78 || first === 0x79) && buffer[index + 1] === first) {
      return index;
    }
  }
  return -1;
}

module.exports = {
  FrameDecoder,
  buildAck,
  buildCommandResponse,
  buildFrame,
  buildHeartbeat,
  buildLocation,
  buildLogin,
  crc16itu,
  decodeImeiBcd,
  encodeImeiBcd,
  parseServerCommand
};

