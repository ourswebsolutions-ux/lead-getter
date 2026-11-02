'use strict';

// Several linked WhatsApp accounts for Outreach. The first is the account
// linked before (the existing session: it also checks numbers and feeds the
// Chats view); more can be added, each with its own encrypted session in its
// own folder, its own QR code, state, connect / disconnect / unlink.
//
// Replies and delivery receipts of every account reach Outreach ('incoming',
// 'status'); the same WhatsApp number cannot be linked twice.
//
// Events: 'change' (the list), 'incoming' ({ accountId, phone, text }), 'status' ({ accountId, id, status }).

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const path = require('node:path');
const { wipeSession } = require('./auth-state');

const PRIMARY = 'primary';
const MAX_ACCOUNTS = 10;

class WhatsAppAccounts extends EventEmitter {
  // primary: the existing WhatsAppClient; makeClient(dir): a new WhatsAppClient;
  // state: { get, set } (app_state); baseDir: where added accounts' sessions live.
  constructor({ primary, makeClient, state, baseDir }) {
    super();
    this.primary = primary;
    this.makeClient = makeClient;
    this.state = state;
    this.baseDir = baseDir;
    this.clients = new Map([[PRIMARY, primary]]);
    primary.on('state', () => this.onState(PRIMARY));
    for (const a of this.saved()) this.attach(a.id);
  }

  // Added accounts (the primary one is always there): [{ id, label }].
  saved() {
    const list = this.state.get('waAccounts');
    return Array.isArray(list) ? list.filter((a) => a && /^[a-f0-9]{8}$/.test(a.id)) : [];
  }

  labels() {
    return this.state.get('waAccountLabels') || {};
  }

  dirOf(id) {
    return path.join(this.baseDir, id);
  }

  attach(id) {
    const client = this.makeClient(this.dirOf(id));
    this.clients.set(id, client);
    client.on('state', () => this.onState(id));
    // Replies and receipts for Outreach (live messages only, not history).
    client.on('chat-messages', (list, { live } = {}) => {
      if (!live) return;
      for (const m of list) if (!m.fromMe && m.phone) this.emit('incoming', { accountId: id, phone: m.phone, text: m.text || '' });
    });
    client.on('chat-status', (list) => list.forEach((s) => this.emit('status', { accountId: id, id: s.id, status: s.status })));
    return client;
  }

  onState(id) {
    const client = this.clients.get(id);
    // The same WhatsApp number in two slots: the newer one is unlinked.
    const number = client?.state === 'open' ? client.account?.id : null;
    if (number && id !== PRIMARY) {
      const twin = [...this.clients].find(([other, c]) => other !== id && c.state === 'open' && c.account?.id === number);
      if (twin) {
        client.error = `This WhatsApp (+${number}) is already connected in Lead Finder.`;
        client.logout().catch(() => {});
      }
    }
    this.emit('change', this.list());
  }

  client(id) {
    return this.clients.get(id || PRIMARY) || null;
  }

  has(id) {
    return this.clients.has(id);
  }

  ready(id) {
    return this.client(id)?.state === 'open';
  }

  async send(id, phone, text) {
    const c = this.client(id);
    if (!c || c.state !== 'open') {
      const err = new Error('This WhatsApp account is not connected.');
      err.code = 'not_connected';
      throw err;
    }
    return c.send(phone, text);
  }

  list() {
    const labels = this.labels();
    return [...this.clients].map(([id, c], i) => {
      const snap = c.snapshot();
      return {
        id,
        primary: id === PRIMARY,
        label: labels[id] || (snap.account?.name ? snap.account.name : `WhatsApp ${i + 1}`),
        state: snap.state,
        qr: snap.qr,
        number: snap.account?.id ? `+${snap.account.id}` : null,
        name: snap.account?.name || null,
        error: snap.error || c.error || null,
      };
    });
  }

  // A new slot: connected at once, so its QR code shows.
  async add() {
    if (this.clients.size >= MAX_ACCOUNTS) return { ok: false, error: `Up to ${MAX_ACCOUNTS} WhatsApp accounts can be connected.` };
    const id = crypto.randomBytes(4).toString('hex');
    this.state.set('waAccounts', [...this.saved(), { id }]);
    const client = this.attach(id);
    this.emit('change', this.list());
    await client.connect();
    return { ok: true, id };
  }

  async connect(id) {
    const c = this.client(id);
    if (!c) return { ok: false, error: 'That WhatsApp account no longer exists.' };
    c.error = null;
    await c.connect();
    return { ok: true };
  }

  async disconnect(id) {
    const c = this.client(id);
    if (!c) return { ok: false, error: 'That WhatsApp account no longer exists.' };
    await c.disconnect();
    return { ok: true };
  }

  // Unlinks an added account and deletes its session (the first account is unlinked from its own panel).
  async remove(id) {
    if (id === PRIMARY) return { ok: false, error: 'Unlink the first account from the WhatsApp panel at the top.' };
    const c = this.client(id);
    if (!c) return { ok: false, error: 'That WhatsApp account no longer exists.' };
    await c.logout().catch(() => c.disconnect().catch(() => {}));
    await wipeSession(this.dirOf(id)).catch(() => {});
    this.clients.delete(id);
    this.state.set('waAccounts', this.saved().filter((a) => a.id !== id));
    const labels = this.labels();
    delete labels[id];
    this.state.set('waAccountLabels', labels);
    this.emit('change', this.list());
    return { ok: true };
  }

  rename(id, label) {
    if (!this.clients.has(id)) return { ok: false, error: 'That WhatsApp account no longer exists.' };
    const labels = this.labels();
    const clean = String(label || '').trim().slice(0, 40);
    if (clean) labels[id] = clean;
    else delete labels[id];
    this.state.set('waAccountLabels', labels);
    this.emit('change', this.list());
    return { ok: true };
  }

  // Added accounts linked before reconnect by themselves (the primary has its own start-up).
  async reconnectSaved() {
    for (const [id, c] of this.clients) if (id !== PRIMARY && (await c.hasSession())) c.connect().catch(() => {});
  }

  async disconnectAll() {
    for (const [id, c] of this.clients) if (id !== PRIMARY) await c.disconnect().catch(() => {});
  }
}

module.exports = { WhatsAppAccounts, PRIMARY };
