'use strict';
// Bridges: the encrypted, signed link (a changed frame or another identity
// is refused), pairing with the same code on both sides, the relay of the
// Bluetooth helper (commands, events, the call's voice both ways), the call
// left on the phone when Lead Finder goes away, discovery on the network,
// and choosing / switching between this computer and bridges.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Identity, handshake } = require('../src/bridge/secure');
const { BridgeServer } = require('../src/bridge/server');
const { BridgeConnection } = require('../src/bridge/client');
const { Beacon, Listener } = require('../src/bridge/discovery');
const { PhoneLink } = require('../src/bridge/link');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lf-bridge-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(20)) if (fn()) return;
  assert.fail('condition not reached');
}

class FakeBt extends EventEmitter {
  constructor() {
    super();
    this.cmds = [];
    this.voice = [];
    this.running = true;
  }
  start() {
    setImmediate(() => {
      this.emit('hf_profile', { ok: true });
      this.emit('ready', { state: { adapter: { powered: true, name: 'bridge-laptop' }, devices: [{ address: 'AA:BB', name: 'vivo 1920', icon: 'phone', paired: true, connected: true, deviceClass: 0x5a020c, path: '/p' }], links: [] } });
    });
  }
  stop() {}
  async request(cmd, args) {
    this.cmds.push([cmd, args]);
    if (cmd === 'state') return { adapter: { powered: true }, devices: [] };
    if (cmd === 'link') setImmediate(() => this.emit('link_up', { address: args.address }));
    return true;
  }
  notify(cmd, args) {
    if (cmd === 'voice_out') this.voice.push(Buffer.from(args.data, 'base64'));
  }
}

test('secure link: same code on both sides, frames encrypted and checked, another identity refused', async () => {
  const a = new Identity(tmp(), 'Main PC');
  const b = new Identity(tmp(), 'Bridge');
  const server = net.createServer(async (s) => {
    try {
      const ch = await handshake(s, b, 'bridge');
      ch.on('message', (m) => ch.send({ echo: m }));
      ch.on('close', () => {});
    } catch {
      s.destroy(); // refused
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const sock = net.connect(server.address().port, '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));
  const ch = await handshake(sock, a, 'controller');
  assert.equal(ch.peer.fingerprint, b.fingerprint);
  assert.match(ch.sas, /^\d{6}$/);
  const got = new Promise((r) => ch.once('message', r));
  ch.send({ hello: 1 });
  assert.deepEqual(await got, { echo: { hello: 1 } });
  // A frame changed on the way is refused (the connection closes).
  const closed = new Promise((r) => ch.once('close', r));
  const c2 = net.connect(server.address().port, '127.0.0.1');
  await new Promise((r) => c2.once('connect', r));
  const ch2 = await handshake(c2, a, 'controller');
  ch2.on('close', () => {});
  const enc = [];
  const orig = c2.write.bind(c2);
  c2.write = (buf) => {
    enc.push(buf);
    const bad = Buffer.from(buf);
    bad[bad.length - 1] ^= 1;
    return orig(bad);
  };
  const serverClosed = new Promise((r) => ch2.once('close', r));
  ch2.send({ x: 1 });
  ch.close();
  await closed;
  await Promise.race([serverClosed, wait(1500)]);
  // The bridge refuses a Lead Finder that pretends to be a bridge; a peer with another identity is detected.
  const c3 = net.connect(server.address().port, '127.0.0.1');
  await new Promise((r) => c3.once('connect', r));
  await assert.rejects(handshake(c3, a, 'bridge'), /Both devices are a bridge/);
  const conn = new BridgeConnection({ identity: a, host: '127.0.0.1', port: server.address().port, fingerprint: '0000000000000000' });
  assert.equal(await conn.connect(), false);
  server.close();
});

async function bridgeSetup({ confirm = async () => true } = {}) {
  const bt = new FakeBt();
  const server = new BridgeServer({ bluetooth: bt, dir: tmp(), name: 'Office laptop', confirm, host: '127.0.0.1', beacon: false });
  const port = await server.start();
  const me = new Identity(tmp(), 'Main PC');
  return { bt, server, port, me };
}

test('pairing: the code is confirmed on both sides; then remembered; refused when the bridge says no', async () => {
  const { server, port, me } = await bridgeSetup();
  const conn = new BridgeConnection({ identity: me, host: '127.0.0.1', port });
  conn.on('pairing', ({ code }) => {
    assert.match(code, /^\d{6}$/);
    conn.confirmPairing(true);
  });
  assert.equal(await conn.connect(), true);
  assert.equal(conn.status.phone.name, 'vivo 1920');
  assert.equal(conn.status.audio, 'supported');
  conn.close();
  // Next time: no pairing.
  await until(() => !server.controller);
  const again = new BridgeConnection({ identity: me, host: '127.0.0.1', port });
  again.on('pairing', () => assert.fail('asked again'));
  assert.equal(await again.connect(), true);
  // A second Lead Finder while one uses it: busy.
  const other = new BridgeConnection({ identity: new Identity(tmp(), 'Other PC'), host: '127.0.0.1', port });
  other.on('pairing', () => other.confirmPairing(true));
  const closed = new Promise((r) => other.once('closed', r));
  assert.equal(await other.connect(), false);
  assert.equal((await closed).busy, true);
  again.close();
  server.stop();
  // The bridge refuses: no access.
  const refusing = await bridgeSetup({ confirm: async () => false });
  const c = new BridgeConnection({ identity: me, host: '127.0.0.1', port: refusing.port });
  c.on('pairing', () => c.confirmPairing(true));
  const why = new Promise((r) => c.once('closed', r));
  assert.equal(await c.connect(), false);
  assert.equal((await why).denied, true);
  refusing.server.stop();
});

test('relay: commands (only allowed ones), events, the voice both ways; the call stays on the phone when Lead Finder goes', async () => {
  const { bt, server, port, me } = await bridgeSetup();
  const conn = new BridgeConnection({ identity: me, host: '127.0.0.1', port });
  conn.on('pairing', () => conn.confirmPairing(true));
  await conn.connect();
  const up = new Promise((r) => conn.once('link_up', r));
  assert.equal(await conn.request('link', { address: 'AA:BB' }), true);
  assert.deepEqual(await up, { address: 'AA:BB' });
  await assert.rejects(conn.request('shutdown'), /Not allowed/);
  // The call's audio is always sent over the network.
  await conn.request('audio', { play: 'speaker', record: 'mic', muted: false });
  assert.deepEqual(bt.cmds.find(([c]) => c === 'audio')[1], { play: '', record: '', muted: false, remote: true });
  const heard = new Promise((r) => conn.once('voice', r));
  bt.emit('voice', { address: 'AA:BB', data: Buffer.from([1, 2, 3, 4]).toString('base64') });
  assert.deepEqual([...(await heard)], [1, 2, 3, 4]);
  conn.sendVoice(Buffer.from([9, 8]));
  await until(() => bt.voice.length === 1);
  assert.deepEqual([...bt.voice[0]], [9, 8]);
  await until(() => server.status().audio === 'verified'); // voice went both ways
  conn.close();
  await until(() => bt.cmds.some(([c]) => c === 'sco_disconnect'));
  assert.deepEqual(bt.cmds.filter(([c]) => c === 'audio').at(-1)[1].remote, false);
  server.stop();
});

test('discovery: a bridge announces itself; Lead Finder finds it with its address and status', async () => {
  const udpPort = 40000 + (process.pid % 20000);
  const listener = new Listener({ udpPort, addresses: () => [] });
  listener.start();
  await wait(100);
  const beacon = new Beacon({ fingerprint: '0123456789abcdef', name: 'Office laptop', port: 4567, status: () => ({ bluetooth: true, phone: { name: 'vivo' } }), udpPort, every: 100, addresses: () => ['127.0.0.1'] });
  const found = new Promise((r) => listener.once('found', r));
  beacon.start();
  const b = await Promise.race([found, wait(3000).then(() => null)]);
  beacon.stop();
  listener.stop();
  assert.ok(b, 'found on the network');
  assert.deepEqual({ fp: b.fingerprint, name: b.name, port: b.port, phone: b.status.phone.name }, { fp: '0123456789abcdef', name: 'Office laptop', port: 4567, phone: 'vivo' });
});

// --- choosing between this computer and bridges ---

class FakeConn extends EventEmitter {
  constructor(opts, status) {
    super();
    this.opts = opts;
    this.status = status;
    this.running = false;
    this.requests = [];
  }
  async connect() {
    this.running = true;
    return true;
  }
  async request(cmd, args) {
    this.requests.push([cmd, args]);
    return cmd === 'state' ? { adapter: { powered: true }, devices: [] } : true;
  }
  sendVoice() {}
  close() {
    this.running = false;
    this.emit('closed', { reason: 'gone' });
  }
}

function linkSetup({ local = null, callLive = () => false } = {}) {
  const identity = new Identity(tmp(), 'Main PC');
  const listener = new EventEmitter();
  listener.start = () => {};
  listener.stop = () => {};
  const conns = {};
  const statuses = {};
  const link = new PhoneLink({ local, identity, listener, callLive, connect: (o) => (conns[o.fingerprint] = new FakeConn(o, statuses[o.fingerprint])) });
  const announce = (fp, status) => {
    statuses[fp] = status;
    identity.trust(Buffer.from(fp.padEnd(32, '0')).toString('base64'), { name: fp });
    // Trusted by fingerprint: the stored fingerprint is that of the identity; use it.
    const stored = Object.values(identity.trusted()).at(-1).fingerprint;
    statuses[stored] = status;
    listener.emit('found', { fingerprint: stored, name: fp, host: '127.0.0.1', port: 1, status });
    return stored;
  };
  return { link, conns, announce };
}

test('the bridge with a connected phone is used; another one takes over when it goes; never during a call', async () => {
  let live = false;
  const { link, conns, announce } = linkSetup({ callLive: () => live });
  const switches = [];
  link.on('switched', (s) => switches.push(s));
  link.start();
  const noPhone = announce('nophone', { bluetooth: true, hfRole: 'ok', phone: null, audio: 'supported' });
  await until(() => link.active === noPhone);
  const withPhone = announce('withphone', { bluetooth: true, hfRole: 'ok', phone: { name: 'vivo' }, audio: 'supported' });
  await until(() => link.active === withPhone);
  assert.equal(link.remote, true);
  assert.equal(link.state().active.phone, 'vivo');
  // The call's audio is asked of the bridge for this window.
  await link.request('audio', { play: 'x', record: 'y', muted: false });
  assert.deepEqual(conns[withPhone].requests.find(([c]) => c === 'audio')[1], { play: '', record: '', muted: false, remote: true });
  // During a call: a better one appearing does not take over.
  live = true;
  conns[noPhone].status = { bluetooth: true, hfRole: 'ok', phone: { name: 'other' }, audio: 'verified' };
  conns[noPhone].emit('status', conns[noPhone].status);
  assert.equal(link.active, withPhone);
  // The one in use goes away: the next one is used, and the Dialer is told.
  live = false;
  conns[withPhone].close();
  await until(() => link.active === noPhone);
  assert.ok(switches.some((s) => s.from === withPhone));
  link.stop();
});

test('nothing on this computer and no bridge: the Dialer is told what to do', async () => {
  const { link } = linkSetup();
  const ready = new Promise((r) => link.once('ready', r));
  link.start();
  const st = (await ready).state;
  assert.equal(st.adapter, null);
  assert.match(st.message, /Lead Finder Bridge/);
  await assert.rejects(link.request('state'), /looking for a bridge/);
  link.stop();
});
