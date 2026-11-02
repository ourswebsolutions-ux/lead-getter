'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { WhatsAppAccounts, PRIMARY } = require('../src/whatsapp/accounts');

// A WhatsAppClient stand-in: connect() links the number it is given.
class FakeClient extends EventEmitter {
  constructor(dir, number) {
    super();
    this.dir = dir;
    this.number = number;
    this.state = 'disconnected';
    this.account = null;
    this.error = null;
    this.sent = [];
    this.session = false;
  }
  snapshot() {
    return { state: this.state, qr: null, account: this.account, error: null };
  }
  set(state) {
    this.state = state;
    this.emit('state', this.snapshot());
  }
  async connect() {
    this.account = { id: this.number, name: `Owner ${this.number.slice(-1)}` };
    this.session = true;
    this.set('open');
  }
  async disconnect() {
    this.set('disconnected');
  }
  async logout() {
    this.session = false;
    this.account = null;
    this.set('logged_out');
  }
  async hasSession() {
    return this.session;
  }
  async send(phone, text) {
    this.sent.push([phone, text]);
    return { id: `m${this.sent.length}` };
  }
}

function setup(numbers = ['923000000002', '923000000003']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-wa-accounts-'));
  const kv = new Map();
  const state = { get: (k) => kv.get(k), set: (k, v) => kv.set(k, v) };
  const primary = new FakeClient(path.join(dir, 'primary'), '923000000001');
  const made = [];
  const queue = [...numbers];
  const makeClient = (d) => {
    const c = new FakeClient(d, queue.shift() || '923000000009');
    made.push(c);
    return c;
  };
  const accounts = new WhatsAppAccounts({ primary, makeClient, state, baseDir: dir });
  return { accounts, primary, made, state, kv, dir, makeClient };
}

test('several accounts: each with its own state, connected and disconnected on its own', async () => {
  const { accounts, primary, made } = setup();
  await primary.connect();
  const a = await accounts.add();
  const b = await accounts.add();
  assert.ok(a.ok && b.ok);
  const list = accounts.list();
  assert.deepEqual(list.map((x) => [x.primary, x.state, x.number]), [[true, 'open', '+923000000001'], [false, 'open', '+923000000002'], [false, 'open', '+923000000003']]);
  await accounts.disconnect(a.id);
  assert.equal(accounts.ready(a.id), false);
  assert.equal(accounts.ready(PRIMARY), true);
  assert.equal(accounts.ready(b.id), true);
  await accounts.connect(a.id);
  assert.equal(accounts.ready(a.id), true);
  assert.equal(made.length, 2);
});

test('send goes through the chosen account; a disconnected one refuses', async () => {
  const { accounts, primary, made } = setup();
  await primary.connect();
  const a = await accounts.add();
  await accounts.send(a.id, '+923001234567', 'hi');
  assert.deepEqual(made[0].sent, [['+923001234567', 'hi']]);
  assert.deepEqual(primary.sent, []);
  await accounts.disconnect(a.id);
  await assert.rejects(accounts.send(a.id, '+923001234567', 'again'), (e) => e.code === 'not_connected');
  assert.equal(made[0].sent.length, 1);
});

test('replies and receipts of added accounts carry the account', async () => {
  const { accounts, primary, made } = setup();
  await primary.connect();
  const a = await accounts.add();
  const got = [];
  accounts.on('incoming', (m) => got.push(m));
  accounts.on('status', (m) => got.push(m));
  made[0].emit('chat-messages', [{ phone: '+923001234567', text: 'Ji', fromMe: false }, { phone: '+923001234567', text: 'mine', fromMe: true }], { live: true });
  made[0].emit('chat-messages', [{ phone: '+923001234567', text: 'old', fromMe: false }], { live: false });
  made[0].emit('chat-status', [{ id: 'm1', status: 'read' }]);
  assert.deepEqual(got, [{ accountId: a.id, phone: '+923001234567', text: 'Ji' }, { accountId: a.id, id: 'm1', status: 'read' }]);
});

test('the same WhatsApp number cannot be linked twice', async () => {
  const { accounts, primary } = setup(['923000000001']);
  await primary.connect();
  const a = await accounts.add();
  const row = accounts.list().find((x) => x.id === a.id);
  assert.equal(row.state, 'logged_out');
  assert.match(row.error, /already connected/);
  assert.equal(accounts.ready(PRIMARY), true);
});

test('accounts and labels are remembered; saved sessions reconnect; removing wipes the session', async () => {
  const { accounts, primary, state, kv, dir, makeClient } = setup();
  await primary.connect();
  const a = await accounts.add();
  accounts.rename(a.id, '  Sales line  ');
  assert.equal(accounts.list().find((x) => x.id === a.id).label, 'Sales line');
  fs.mkdirSync(path.join(dir, a.id), { recursive: true });

  // A new start: the same slots; reconnectSaved links those with a session.
  const again = new WhatsAppAccounts({ primary, makeClient: (d) => Object.assign(makeClient(d), { session: true }), state, baseDir: dir });
  assert.deepEqual(again.list().map((x) => x.id), [PRIMARY, a.id]);
  await again.reconnectSaved();
  await new Promise((r) => setImmediate(r));
  assert.equal(again.ready(a.id), true);
  assert.equal((await again.remove(PRIMARY)).ok, false, 'the first account is unlinked from its own panel');
  assert.ok((await again.remove(a.id)).ok);
  assert.equal(fs.existsSync(path.join(dir, a.id)), false);
  assert.deepEqual(kv.get('waAccounts'), []);
  assert.deepEqual(again.list().map((x) => x.id), [PRIMARY]);
});

test('at most 10 accounts', async () => {
  const { accounts } = setup([]);
  for (let i = 0; i < 9; i++) assert.ok((await accounts.add()).ok);
  const r = await accounts.add();
  assert.equal(r.ok, false);
  assert.match(r.error, /Up to 10/);
});
