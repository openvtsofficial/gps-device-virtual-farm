'use strict';

const net = require('node:net');
const {
  FrameDecoder,
  buildCommandResponse,
  buildHeartbeat,
  buildLocation,
  buildLogin,
  parseServerCommand
} = require('./gt06');
const { RouteModel, fnv1a } = require('./geo');

const SessionState = Object.freeze({
  PENDING: 'PENDING',
  CONNECTING: 'CONNECTING',
  LOGIN_SENT: 'LOGIN_SENT',
  ONLINE: 'ONLINE',
  BACKOFF: 'BACKOFF',
  STOPPED: 'STOPPED'
});

class DeviceSession {
  constructor({ index, total, imei, moving, farm, netModule = net }) {
    this.index = index;
    this.imei = imei;
    this.moving = moving;
    this.farm = farm;
    this.config = farm.config;
    this.netModule = netModule;
    this.state = SessionState.PENDING;
    this.socket = null;
    this.socketToken = 0;
    this.socketConnected = false;
    this.decoder = new FrameDecoder();
    this.decoderMalformedCount = 0;
    this.serial = 1;
    this.loginAttempts = 0;
    this.lastLoginSerial = 0;
    this.reconnectAttempt = 0;
    this.nextHeartbeatAt = Number.POSITIVE_INFINITY;
    this.nextLocationAt = Number.POSITIVE_INFINITY;
    this.nextActionAt = Number.POSITIVE_INFINITY;
    this.scheduleVersion = 0;
    this.backpressured = false;
    this.disposed = false;
    this.hash = fnv1a(imei);
    this.route = new RouteModel({
      index,
      total,
      imei,
      baseLatitude: this.config.baseLatitude,
      baseLongitude: this.config.baseLongitude,
      moving
    });
  }

  schedule(at) {
    if (this.disposed || !this.farm.running) return;
    this.nextActionAt = at;
    this.scheduleVersion += 1;
    this.farm.schedule(this, at, this.scheduleVersion);
  }

  handleDue(now) {
    if (this.disposed || !this.farm.running) return;

    switch (this.state) {
      case SessionState.PENDING:
      case SessionState.BACKOFF:
        this.#connect(now);
        break;
      case SessionState.CONNECTING:
        this.#beginReconnect(now, 'connect timeout');
        break;
      case SessionState.LOGIN_SENT:
        if (this.loginAttempts < this.config.maxLoginAttempts) {
          this.farm.logDevice(this, 'warn', 'Login ACK timeout; retrying', {
            attempt: this.loginAttempts + 1
          });
          this.#sendLogin(now);
        } else {
          this.#beginReconnect(now, 'login acknowledgement timeout');
        }
        break;
      case SessionState.ONLINE:
        this.#sendOnlinePackets(now);
        break;
      default:
        break;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduleVersion += 1;
    this.#destroySocket();
    this.#setState(SessionState.STOPPED);
    this.nextActionAt = Number.POSITIVE_INFINITY;
  }

  #connect(now) {
    this.#destroySocket();
    this.decoder = new FrameDecoder();
    this.decoderMalformedCount = 0;
    this.loginAttempts = 0;
    this.backpressured = false;
    this.#setState(SessionState.CONNECTING);

    const token = ++this.socketToken;
    let socket;
    try {
      socket = new this.netModule.Socket();
      this.socket = socket;
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 60_000);
      socket.once('connect', () => this.#onConnect(token));
      socket.on('data', (chunk) => this.#onData(token, chunk));
      socket.on('drain', () => this.#onDrain(token));
      socket.on('error', (error) => this.#onError(token, error));
      socket.once('close', () => this.#onClose(token));
      socket.connect(this.config.port, this.config.host);
      this.schedule(now + this.config.connectTimeoutMs);
    } catch (error) {
      this.farm.recordError(error);
      this.#beginReconnect(now, error.message || 'connection failed');
    }
  }

  #onConnect(token) {
    if (!this.#isCurrentSocket(token)) return;
    this.socketConnected = true;
    this.farm.recordSocketDelta(1);
    this.farm.logDevice(this, 'info', 'TCP connected');
    this.#sendLogin(Date.now());
  }

  #sendLogin(now) {
    if (!this.socketConnected) {
      this.#beginReconnect(now, 'socket unavailable before login');
      return;
    }
    this.#setState(SessionState.LOGIN_SENT);
    this.loginAttempts += 1;
    this.lastLoginSerial = this.#nextSerial();
    const packet = buildLogin(this.imei, this.lastLoginSerial);
    if (!this.#writePacket('login', packet)) return;
    this.schedule(now + this.config.loginAckTimeoutMs);
  }

  #sendOnlinePackets(now) {
    if (this.backpressured) {
      this.schedule(now + 100);
      return;
    }

    if (now >= this.nextHeartbeatAt) {
      const heartbeat = buildHeartbeat(this.#nextSerial(), this.moving);
      this.#writePacket('heartbeat', heartbeat);
      this.nextHeartbeatAt = now + this.config.heartbeatIntervalMs;
    }

    if (now >= this.nextLocationAt) {
      const point = this.route.nextPoint(now);
      const location = buildLocation(this.#nextSerial(), point);
      this.#writePacket('location', location);
      this.nextLocationAt = now + (
        this.moving ? this.config.movingIntervalMs : this.config.parkedIntervalMs
      );
    }

    this.schedule(Math.min(this.nextHeartbeatAt, this.nextLocationAt));
  }

  #writePacket(type, packet) {
    if (!this.socket || !this.socketConnected || this.socket.destroyed) {
      this.#beginReconnect(Date.now(), 'write attempted without a connected socket');
      return false;
    }

    try {
      const accepted = this.socket.write(packet);
      this.backpressured = !accepted;
      this.farm.recordPacket(type, packet.length);
      return true;
    } catch (error) {
      this.farm.recordError(error);
      this.#beginReconnect(Date.now(), error.message || 'socket write failed');
      return false;
    }
  }

  #onData(token, chunk) {
    if (!this.#isCurrentSocket(token)) return;
    this.farm.recordBytesReceived(chunk.length);
    const malformedBefore = this.decoder.malformedFrames;
    const frames = this.decoder.feed(chunk);
    const malformedDelta = this.decoder.malformedFrames - malformedBefore;
    if (malformedDelta > 0) this.farm.recordMalformed(malformedDelta);

    for (const frame of frames) {
      this.farm.recordAcknowledgement(frame.protocol);

      if (frame.protocol === 0x01 && this.state === SessionState.LOGIN_SENT) {
        if (frame.serial !== this.lastLoginSerial) {
          this.farm.logDevice(this, 'warn', 'Login ACK serial differs from request', {
            expected: this.lastLoginSerial,
            received: frame.serial
          });
        }
        this.#promoteOnline(Date.now());
        continue;
      }

      if (frame.protocol === 0x80) {
        this.#handleCommand(frame);
      }
    }
  }

  #promoteOnline(now) {
    this.reconnectAttempt = 0;
    this.#setState(SessionState.ONLINE);
    this.farm.logDevice(this, 'info', 'GT06 login acknowledged; device online');
    this.nextHeartbeatAt = now;
    this.nextLocationAt = now;
    this.#sendOnlinePackets(now);
  }

  #handleCommand(frame) {
    const command = parseServerCommand(frame);
    if (!command || this.state !== SessionState.ONLINE) return;
    const trimmed = command.command.trim();
    const response = /^(STATUS|GETINFO|PARAM)/i.test(trimmed)
      ? `${trimmed}=Success!`
      : trimmed;
    const packet = buildCommandResponse(this.#nextSerial(), command.serverFlag, response);
    if (this.#writePacket('commandResponse', packet)) {
      this.farm.logDevice(this, 'info', 'Server command answered', { command: trimmed });
    }
  }

  #onDrain(token) {
    if (!this.#isCurrentSocket(token)) return;
    this.backpressured = false;
    if (this.state === SessionState.ONLINE) {
      this.schedule(Math.min(Date.now(), this.nextHeartbeatAt, this.nextLocationAt));
    }
  }

  #onError(token, error) {
    if (!this.#isCurrentSocket(token) || this.disposed) return;
    this.farm.recordError(error);
    this.farm.logDevice(this, 'error', 'Socket error', {
      code: error.code || 'UNKNOWN',
      message: error.message
    });
    this.#beginReconnect(Date.now(), error.code || 'socket error');
  }

  #onClose(token) {
    if (!this.#isCurrentSocket(token) || this.disposed) return;
    this.#markSocketDisconnected();
    this.socket = null;
    if (this.state !== SessionState.BACKOFF && this.state !== SessionState.STOPPED) {
      this.#beginReconnect(Date.now(), 'socket closed');
    }
  }

  #beginReconnect(now, reason) {
    if (this.disposed || !this.farm.running || this.state === SessionState.STOPPED) return;
    this.#destroySocket();
    this.#setState(SessionState.BACKOFF);

    const exponent = Math.min(this.reconnectAttempt, 16);
    const capped = Math.min(
      this.config.reconnectBaseMs * (2 ** exponent),
      this.config.reconnectMaxMs
    );
    const deterministicFraction = ((this.hash + this.reconnectAttempt * 2654435761) >>> 0) / 0xffffffff;
    const delay = Math.round(capped * (0.5 + deterministicFraction * 0.5));
    this.reconnectAttempt += 1;
    this.farm.recordReconnect();
    this.farm.logDevice(this, 'warn', 'Connection scheduled for retry', {
      reason,
      delayMs: delay,
      attempt: this.reconnectAttempt
    });
    this.schedule(now + delay);
  }

  #destroySocket() {
    const socket = this.socket;
    this.socket = null;
    this.socketToken += 1;
    this.#markSocketDisconnected();
    if (!socket) return;
    socket.removeAllListeners();
    socket.on('error', () => {});
    if (!socket.destroyed) socket.destroy();
  }

  #markSocketDisconnected() {
    if (!this.socketConnected) return;
    this.socketConnected = false;
    this.farm.recordSocketDelta(-1);
  }

  #isCurrentSocket(token) {
    return !this.disposed && token === this.socketToken && this.socket !== null;
  }

  #setState(nextState) {
    if (this.state === nextState) return;
    const previous = this.state;
    this.state = nextState;
    this.farm.setSessionState(previous, nextState);
  }

  #nextSerial() {
    const current = this.serial;
    this.serial = (this.serial + 1) & 0xffff;
    if (this.serial === 0) this.serial = 1;
    return current;
  }
}

module.exports = {
  DeviceSession,
  SessionState
};

