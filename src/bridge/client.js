'use strict';

// Lead Finder's connection to one bridge (server.js) found on the local
// network. Once paired and welcomed it works like the local Bluetooth helper
// (bluetooth.js): request(cmd, args), the helper's events, and the call's
// voice ('voice' Buffers in, sendVoice() out). It also reports the bridge's
// status and the connection's round-trip time.
//
// Events: 'pairing' ({ code, name }) the user must compare and confirm
// (confirmPairing), 'welcome', 'status' (bridge status), 'rtt' (ms),
// 'closed' ({ reason, denied, busy }), plus the helper's events.

const net = require('node:net');
const { EventEmitter } = require('node:events');
const { handshake } = require('./secure');

const PING_MS = 4_000;

class BridgeConnection extends EventEmitter {
  constructor({ identity, host, port, fingerprint, name, timeout = 10_000 }) {
    super();
    Object.assign(this, { identity, host, port, fingerprint, name, timeout });
    this.ch = null;
    this.state = 'idle'; // idle | connecting | pairing | ready | closed
    this.status = {};
    this.rtt = null;
    this.pending = new Map();
    this.nextId = 1;
    this.pinger = null;
  }

  get running() {
    return this.state === 'ready';
  }

  connect() {
    this.state = 'connecting';
    return new Promise((resolve) => {
      const socket = net.connect({ host: this.host, port: this.port });
      const fail = (reason) => {
        if (this.state === 'closed') return;
        this.finish({ reason });
        resolve(false);
      };
      socket.setTimeout(this.timeout, () => !this.ch && (socket.destroy(), fail('The bridge did not answer.')));
      socket.once('error', (e) => !this.ch && fail(e.message));
      socket.once('connect', async () => {
        try {
          this.ch = await handshake(socket, this.identity, 'controller', { timeout: this.timeout });
        } catch (err) {
          socket.destroy();
          return fail(err.message);
        }
        socket.setTimeout(0);
        if (this.fingerprint && this.ch.peer.fingerprint !== this.fingerprint) {
          this.ch.close('another identity');
          return fail('The device answered with another identity.');
        }
        this.peer = this.ch.peer;
        this.ch.on('message', (m) => this.onMessage(m, resolve));
        this.ch.on('audio', (buf) => this.emit('voice', buf));
        this.ch.on('close', ({ reason }) => {
          this.finish({ reason });
          resolve(false);
        });
      });
    });
  }

  onMessage(m, resolve) {
    switch (m.t) {
      case 'pair':
        this.state = 'pairing';
        this.emit('pairing', { code: m.code, name: m.name || this.peer.name });
        return;
      case 'denied':
        this.finish({ reason: m.reason || 'Pairing was not allowed.', denied: true });
        return resolve(false);
      case 'busy':
        this.finish({ reason: `${m.by || 'Another Lead Finder'} is using this bridge.`, busy: true });
        return resolve(false);
      case 'welcome':
        // Trusted from now on (pairing finished or it was paired before).
        if (!this.identity.isTrusted(this.peer.id)) this.identity.trust(this.peer.id, { name: this.peer.name });
        this.state = 'ready';
        this.status = m.status || {};
        this.pinger = setInterval(() => this.ch?.send({ t: 'ping', at: Date.now() }), PING_MS);
        this.ch.send({ t: 'ping', at: Date.now() });
        this.emit('welcome', this.status);
        return resolve(true);
      case 'status':
        this.status = m.status || {};
        this.emit('status', this.status);
        return;
      case 'pong':
        this.rtt = Date.now() - Number(m.at);
        this.lastPong = Date.now();
        this.emit('rtt', this.rtt);
        return;
      case 'res': {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.result);
        else p.reject(new Error(m.error || 'The bridge refused.'));
        return;
      }
      case 'ev': {
        const { t, event, ...rest } = m;
        this.emit(event, rest);
        return;
      }
    }
  }

  // The user's answer after comparing the code shown here and on the bridge.
  confirmPairing(ok) {
    if (this.state !== 'pairing') return;
    this.ch.send({ t: ok ? 'pair-ok' : 'pair-no' });
  }

  request(cmd, args = {}, { timeout = cmd.startsWith('map_') || cmd === 'pair' || cmd === 'link' ? 120_000 : 30_000 } = {}) {
    if (this.state !== 'ready') return Promise.reject(new Error('The bridge is not connected.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The bridge did not answer.'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ch.send({ t: 'req', id, cmd, args });
    });
  }

  sendVoice(buf) {
    if (this.state === 'ready') this.ch.sendAudio(buf);
  }

  finish({ reason, denied = false, busy = false }) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    clearInterval(this.pinger);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('The bridge disconnected.'));
    }
    this.pending.clear();
    this.ch?.close(reason);
    this.emit('closed', { reason, denied, busy });
  }

  close() {
    this.finish({ reason: 'closed by Lead Finder' });
  }
}

module.exports = { BridgeConnection };
