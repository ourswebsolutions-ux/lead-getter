'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { WhatsAppClient } = require('../src/whatsapp/client');
const { WhatsAppVerifier } = require('../src/whatsapp/verifier');
const { useEncryptedAuthState } = require('../src/whatsapp/auth-state');
const { LeadStore } = require('../src/database/db');

const key = crypto.randomBytes(32);
const cipher = {
  encrypt: (t) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const e = Buffer.concat([c.update(t, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), e]);
  },
  decrypt: (b) => {
    const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  },
};
const made = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-wa-test-'));
  made.push(d);
  return d;
};
test.after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tick = () => new Promise((r) => setTimeout(r, 5));
const until = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await tick();
  }
};

// A stand-in for the Baileys module: sockets are controlled by the test.
function fakeBaileys() {
  const sockets = [];
  const DisconnectReason = { connectionClosed: 428, connectionLost: 408, connectionReplaced: 440, timedOut: 408, loggedOut: 401, badSession: 500, restartRequired: 515, forbidden: 403 };
  const real = { initAuthCreds: () => ({ noiseKey: { private: 'secret-noise-key' } }), BufferJSON: { replacer: undefined, reviver: undefined }, proto: { Message: { AppStateSyncKeyData: { fromObject: (o) => o } } } };
  const mod = {
    ...real,
    DisconnectReason,
    Browsers: { appropriate: (b) => ['Linux', b, '1'] },
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    makeCacheableSignalKeyStore: (k) => k,
    default: (opts) => {
      const sock = { ev: new EventEmitter(), opts, user: null, ended: false, results: new Map(), sent: [] };
      sock.end = async () => (sock.ended = true);
      sock.logout = async () => (sock.loggedOut = true);
      sock.onWhatsApp = async (n) => sock.results.get(n);
      sock.sendMessage = async (jid, content) => {
        sock.sent.push({ jid, content });
        return sock.sendResult === undefined ? { key: { id: 'MSG1' } } : sock.sendResult;
      };
      sockets.push(sock);
      return sock;
    },
  };
  const close = (sock, code) => sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: code } } } });
  const open = (sock, user = { id: '923001112223:5@s.whatsapp.net', name: 'Ali' }) => {
    sock.user = user;
    sock.ev.emit('connection.update', { connection: 'open' });
  };
  return { mod, sockets, close, open, DisconnectReason };
}

function client(fake, dir = tmp()) {
  const c = new WhatsAppClient({ dir, cipher, loadBaileys: async () => fake.mod, delays: [5, 5] });
  const states = [];
  c.on('state', (s) => states.push(s.state));
  return { c, states, dir };
}

test('QR is shown as an image; unscanned QR codes expire into "qr_expired"', async () => {
  const fake = fakeBaileys();
  const { c, states } = client(fake);
  await c.connect();
  const sock = fake.sockets[0];
  assert.equal(sock.opts.logger.level, 'silent', 'no protocol logging');
  assert.equal(sock.opts.markOnlineOnConnect, false);
  sock.ev.emit('connection.update', { qr: '2@abc,def,ghi' });
  await until(() => c.state === 'qr');
  assert.match(c.snapshot().qr, /^data:image\/png;base64,/);
  fake.close(sock, fake.DisconnectReason.timedOut);
  await until(() => c.state === 'qr_expired');
  assert.equal(c.snapshot().qr, null);
  assert.equal(fake.sockets.length, 1, 'no automatic retry after expiry: the user asks for a new QR');
  assert.deepEqual(states, ['connecting', 'qr', 'qr_expired']);
});

test('linked account, connection loss with spaced retries, then reconnected', async () => {
  const fake = fakeBaileys();
  const { c } = client(fake);
  await c.connect();
  fake.open(fake.sockets[0]);
  await until(() => c.state === 'open');
  assert.deepEqual(c.snapshot().account, { id: '923001112223', name: 'Ali' });
  fake.close(fake.sockets[0], fake.DisconnectReason.connectionLost);
  await until(() => c.state === 'reconnecting');
  await until(() => fake.sockets.length === 2);
  fake.open(fake.sockets[1]);
  await until(() => c.state === 'open');
});

test('retries are limited, then a clear error', async () => {
  const fake = fakeBaileys();
  const { c } = client(fake);
  await c.connect();
  fake.open(fake.sockets[0]);
  await until(() => c.state === 'open');
  for (let i = 0; i < 3; i++) {
    const s = fake.sockets[fake.sockets.length - 1];
    fake.close(s, fake.DisconnectReason.connectionLost);
    await until(() => fake.sockets.length === i + 2 || c.state === 'error');
  }
  await until(() => c.state === 'error');
  assert.match(c.snapshot().error, /Could not reconnect/);
  assert.equal(fake.sockets.length, 3, 'two retries (delays list), not endless');
});

test('logged out from the phone: session deleted, no reconnect', async () => {
  const fake = fakeBaileys();
  const { c, dir } = client(fake);
  await c.connect();
  fake.open(fake.sockets[0]);
  await until(() => c.state === 'open');
  fake.close(fake.sockets[0], fake.DisconnectReason.loggedOut);
  await until(() => c.state === 'logged_out');
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fake.sockets.length, 1);
});

test('session replaced elsewhere stops instead of fighting over it', async () => {
  const fake = fakeBaileys();
  const { c } = client(fake);
  await c.connect();
  fake.open(fake.sockets[0]);
  await until(() => c.state === 'open');
  fake.close(fake.sockets[0], fake.DisconnectReason.connectionReplaced);
  await until(() => c.state === 'error');
  assert.match(c.snapshot().error, /opened somewhere else/);
  assert.equal(fake.sockets.length, 1);
});

test('number check: available only on a positive answer; empty answer = unavailable; no answer = failure', async () => {
  const fake = fakeBaileys();
  const { c } = client(fake);
  await assert.rejects(c.check('+923001234567'), (e) => e.code === 'not_connected');
  await c.connect();
  fake.open(fake.sockets[0]);
  await until(() => c.state === 'open');
  const sock = fake.sockets[0];
  sock.results.set('923001234567', [{ jid: '923001234567@s.whatsapp.net', exists: true }]);
  assert.equal(await c.check('+923001234567'), 'available');
  sock.results.set('923007654321', []);
  assert.equal(await c.check('+923007654321'), 'unavailable');
  sock.results.set('923009999999', [{ jid: '923001111111@s.whatsapp.net', exists: true }]); // someone else
  assert.equal(await c.check('+923009999999'), 'unavailable');
  sock.results.set('923008888888', undefined);
  await assert.rejects(c.check('+923008888888'), /no answer/);
});

test('send: one message to the number, success only with a WhatsApp message id', async () => {
  const fake = fakeBaileys();
  const { c } = client(fake);
  await c.connect();
  fake.open(fake.sockets[0]);
  await until(() => c.state === 'open');
  const sock = fake.sockets[0];
  assert.equal(await c.send('+923001234567', 'Hello'), 'MSG1');
  assert.deepEqual(sock.sent, [{ jid: '923001234567@s.whatsapp.net', content: { text: 'Hello' } }]);
  sock.sendResult = null;
  await assert.rejects(c.send('+923001234567', 'Hi'), /did not confirm/);
});

test('session files are encrypted, owner-only, and read back', async () => {
  const dir = tmp();
  const fakeMod = fakeBaileys().mod;
  const a = await useEncryptedAuthState(dir, cipher, fakeMod);
  a.state.creds.registered = true;
  await a.saveCreds();
  await a.state.keys.set({ session: { 'abc:1': { k: 'secret-session' } } });
  for (const f of fs.readdirSync(dir)) {
    const raw = fs.readFileSync(path.join(dir, f));
    assert.ok(!raw.toString('latin1').includes('secret'), `${f} is not plaintext`);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600);
  }
  const b = await useEncryptedAuthState(dir, cipher, fakeMod);
  assert.equal(b.state.creds.registered, true);
  assert.deepEqual((await b.state.keys.get('session', ['abc:1']))['abc:1'], { k: 'secret-session' });
  assert.equal(b.isRegistered(), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

const lead = (n, phoneRaw) => ({ placeKey: `0x${n}:0x1`, mapsUrl: 'u', name: `L${n}`, phoneRaw, address: 'Lahore, Pakistan', websiteStatus: 'no_website' });

test('verifier: checks queued numbers in the background, records results and failures', async () => {
  const store = new LeadStore(':memory:');
  store.save(lead(1, '03001234567'));
  store.save(lead(2, '03007654321'));
  store.save(lead(3, '03009999999'));
  store.save(lead(4, '0300')); // invalid: never checked
  const answers = { '+923001234567': 'available', '+923007654321': 'unavailable' };
  const fakeClient = {
    state: 'open',
    check: async (p) => {
      if (p === '+923009999999') throw new Error('WhatsApp did not answer in time');
      return answers[p];
    },
  };
  const results = [];
  const v = new WhatsAppVerifier({ client: fakeClient, store, onResult: (p, s) => results.push([p, s]), timings: { interval: 1, idle: 5 } });
  v.start();
  await until(() => results.length === 3);
  v.stop();
  const byName = Object.fromEntries(store.listLeads().map((l) => [l.name, l.whatsapp]));
  assert.deepEqual(byName, { L1: 'available', L2: 'unavailable', L3: 'failed', L4: 'not_checked' });
  assert.match(store.listLeads().find((l) => l.name === 'L3').whatsappDetail, /did not answer/);
  assert.deepEqual(store.phonesToCheck(10, new Date(0).toISOString()), [], 'failed numbers wait before a retry');
  assert.deepEqual(store.phonesToCheck(10, new Date(Date.now() + 1000).toISOString()), ['+923009999999'], 'then are retried');
  assert.deepEqual(store.whatsappProgress(), { total: 3, checked: 2, available: 1, failed: 1 });
});

test('verifier pauses while disconnected and never records that as a failed check', async () => {
  const store = new LeadStore(':memory:');
  store.save(lead(1, '03001234567'));
  let calls = 0;
  const fakeClient = { state: 'open', check: async () => { calls++; throw Object.assign(new Error('WhatsApp is not connected.'), { code: 'not_connected' }); } };
  const v = new WhatsAppVerifier({ client: fakeClient, store, timings: { interval: 1, idle: 50 } });
  v.start();
  await until(() => calls >= 1);
  v.stop();
  assert.equal(store.listLeads()[0].whatsapp, 'not_checked');
});

test('earlier manual marks are re-checked automatically; schema v3 keeps old results', () => {
  const store = new LeadStore(':memory:');
  store.save(lead(1, '03001234567'));
  store.setWhatsAppStatus('+923001234567', 'available', 'manual');
  assert.deepEqual(store.phonesToCheck(5, new Date().toISOString()), ['+923001234567']);
  store.setWhatsAppResult('+923001234567', 'unavailable', 'baileys');
  assert.equal(store.listLeads()[0].whatsapp, 'unavailable');
  assert.equal(store.listLeads()[0].whatsappMethod, 'baileys');
  assert.throws(() => store.setWhatsAppResult('03001234567', 'available', 'baileys'), /validated/);
  store.recordMessage({ businessId: 1, phone: '+923001234567', body: 'Hi', waId: 'X1', status: 'sent' }, '2026-10-21T10:00:00.000Z');
  assert.deepEqual({ ...store.lastMessageTo('+923001234567') }, { sentAt: '2026-10-21T10:00:00.000Z', waId: 'X1' });
});

test('progress never counts an earlier manual mark as a confirmed WhatsApp number', () => {
  const store = new LeadStore(':memory:');
  store.save(lead(1, '03001234567'));
  store.setWhatsAppStatus('+923001234567', 'available', 'manual');
  assert.deepEqual(store.whatsappProgress(), { total: 1, checked: 0, available: 0, failed: 0 });
});
