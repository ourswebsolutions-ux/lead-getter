'use strict';

// Finding bridges on the local network without typing addresses: a bridge
// announces itself every 2 seconds by UDP multicast (239.255.76.70:47670) on
// each of its network interfaces; Lead Finder listens. An announcement is
// only a hint (name, port, identity fingerprint, a short status): nothing is
// trusted until the signed, encrypted handshake (secure.js) proves who it is.

const dgram = require('node:dgram');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const GROUP = '239.255.76.70';
const PORT = 47670;
const EVERY_MS = 2_000;
const GONE_MS = 7_000;

const lanAddresses = () =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);

// A bridge's announcement. status(): a short summary ({ bluetooth, hfRole, phone, audio }).
class Beacon {
  constructor({ fingerprint, name, port, status = () => ({}), group = GROUP, udpPort = PORT, every = EVERY_MS, addresses = lanAddresses }) {
    Object.assign(this, { fingerprint, name, port, status, group, udpPort, every, addresses });
    this.socket = null;
    this.timer = null;
  }

  start() {
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('error', () => {});
    this.socket.bind(() => {
      this.socket.setMulticastTTL(1); // the local network only
      this.socket.setMulticastLoopback(true);
      this.send();
      this.timer = setInterval(() => this.send(), this.every);
    });
  }

  send() {
    const msg = Buffer.from(JSON.stringify({ lfb: 1, fp: this.fingerprint, name: this.name, port: this.port, status: this.status() }));
    const addrs = this.addresses();
    for (const a of addrs.length ? addrs : ['127.0.0.1']) {
      try {
        this.socket.setMulticastInterface(a);
        this.socket.send(msg, this.udpPort, this.group);
      } catch {}
    }
  }

  stop() {
    clearInterval(this.timer);
    try {
      this.socket?.close();
    } catch {}
    this.socket = null;
  }
}

// Lead Finder's side. Events: 'found' (bridge), 'update' (bridge), 'lost' (bridge).
// A bridge: { fingerprint, name, host, port, status, seenAt }.
class Listener extends EventEmitter {
  constructor({ group = GROUP, udpPort = PORT, goneAfter = GONE_MS, addresses = lanAddresses } = {}) {
    super();
    Object.assign(this, { group, udpPort, goneAfter, addresses });
    this.bridges = new Map();
    this.socket = null;
    this.sweep = null;
  }

  start() {
    if (this.socket) return;
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = s;
    s.on('error', (e) => this.emit('error', e));
    s.on('message', (buf, rinfo) => this.onMessage(buf, rinfo));
    s.bind(this.udpPort, () => {
      for (const a of [...this.addresses(), '127.0.0.1']) {
        try {
          s.addMembership(this.group, a);
        } catch {}
      }
    });
    this.sweep = setInterval(() => this.forgetOld(), 1_000);
  }

  onMessage(buf, rinfo) {
    let m;
    try {
      m = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (m?.lfb !== 1 || !/^[0-9a-f]{16}$/.test(m.fp) || !Number.isInteger(m.port) || m.port < 1 || m.port > 65535) return;
    const known = this.bridges.get(m.fp);
    const b = { fingerprint: m.fp, name: String(m.name || 'Lead Finder bridge').slice(0, 80), host: rinfo.address, port: m.port, status: m.status && typeof m.status === 'object' ? m.status : {}, seenAt: Date.now() };
    this.bridges.set(m.fp, b);
    this.emit(known ? 'update' : 'found', b);
  }

  forgetOld() {
    const now = Date.now();
    for (const [fp, b] of this.bridges) {
      if (now - b.seenAt > this.goneAfter) {
        this.bridges.delete(fp);
        this.emit('lost', b);
      }
    }
  }

  list() {
    return [...this.bridges.values()];
  }

  stop() {
    clearInterval(this.sweep);
    try {
      this.socket?.close();
    } catch {}
    this.socket = null;
    this.bridges.clear();
  }
}

module.exports = { Beacon, Listener, GROUP, PORT };
