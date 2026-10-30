'use strict';

// SMS through the connected phone over native Bluetooth Message Access
// (MAP): bt-helper.py drives obexd, the Linux MAP client. Messages are sent
// by pushing them to the phone's outbox (the phone sends them with its SIM),
// and the phone's inbox and sent messages are read into the app.
//
// MAP has no SIM choice: the phone sends with its default SMS SIM. Delivery
// reports come only when the phone sends MAP event reports.
//
// Events: 'state', 'changed' ({ phone }), 'incoming' ({ phone, body, contact }).

const { EventEmitter } = require('node:events');

const POLL_MS = 30_000;
// After a failed connection (the phone was still asking the user, or refused): try again.
const RETRY_MS = [20_000, 45_000, 90_000, 180_000];

// MAP lists a message with its sender or recipient: the other party's number.
const otherParty = (m, folder) => {
  const v = folder === 'inbox' ? m.senderAddress || m.sender || m.replyTo : m.recipientAddress || m.recipient;
  return String(v || '').replace(/[^\d+]/g, '');
};

// MAP timestamps: 20261030T221503 (local time), optionally with an offset.
function parseTimestamp(ts) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(String(ts || ''));
  if (!m) return Date.now();
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
}

function render(template, contact) {
  return String(template || '')
    .replace(/\{name\}/gi, contact?.name || '')
    .replace(/\{business\}/gi, contact?.business || contact?.name || '')
    .replace(/[ \t]+([,.!?])/g, '$1')
    .trim();
}

class Sms extends EventEmitter {
  constructor({ bluetooth, store, dialer, timers = { setTimeout, clearTimeout, setInterval, clearInterval }, now = () => Date.now() }) {
    super();
    this.bt = bluetooth;
    this.store = store;
    this.dialer = dialer;
    this.timers = timers;
    this.now = now;
    this.address = null;
    this.poll = null;
    this.pendingStatus = new Map(); // reports for messages not matched yet (handle -> status)
    this.retryTimer = null;
    this.retries = 0;
    this.s = { state: 'off', error: null }; // off | connecting | ready | denied | error
    dialer.on('state', (st) => this.onDialer(st));
    bluetooth.on('sms_message', (m) => m.address === this.address && this.onNotified(m.message));
    bluetooth.on('sms_status', (m) => m.address === this.address && this.onStatus(m));
  }

  state() {
    return { ...this.s, templates: this.templates() };
  }

  changed() {
    this.emit('state', this.state());
  }

  // Connects messages when the phone is connected for calls (and drops them when it is not).
  onDialer(st) {
    const address = st.link === 'ready' ? st.saved?.address : null;
    if (address === this.address) return;
    if (this.address) this.disconnect();
    if (address) {
      this.retries = 0;
      this.connect(address);
    }
  }

  // "Try again", or the next automatic retry.
  retry() {
    if (!this.address) return { ok: false, error: 'Connect your phone in the Dialer first.' };
    if (this.s.state === 'ready' || this.s.state === 'connecting') return { ok: true };
    this.timers.clearTimeout(this.retryTimer);
    this.connect(this.address);
    return { ok: true };
  }

  async connect(address) {
    this.address = address;
    this.s = { state: 'connecting', error: null };
    this.changed();
    try {
      await this.bt.request('map_connect', { address });
    } catch (err) {
      if (this.address !== address) return;
      let [kind, text] = /^(denied|obexd): (.*)$/s.exec(err.message)?.slice(1) || ['error', err.message];
      if (/timed out|timeout|no reply/i.test(text)) {
        text = 'The phone did not answer the request for its messages. If the phone shows "Allow access to your messages?", tap Allow. Lead Finder tries again by itself.';
      }
      // The phone may still be asking the user, or the user may allow it later: try again.
      const wait = RETRY_MS[Math.min(this.retries++, RETRY_MS.length - 1)];
      this.s = { state: kind === 'denied' ? 'denied' : 'error', error: text, retryAt: kind === 'obexd' ? null : this.now() + wait };
      this.changed();
      if (kind !== 'obexd') {
        this.timers.clearTimeout(this.retryTimer);
        this.retryTimer = this.timers.setTimeout(() => this.address === address && this.connect(address), wait);
      }
      return;
    }
    this.retries = 0;
    if (this.address !== address) return;
    this.s = { state: 'ready', error: null };
    this.changed();
    await this.sync().catch(() => {});
    this.timers.clearInterval(this.poll);
    this.poll = this.timers.setInterval(() => this.sync('inbox').catch(() => {}), POLL_MS);
  }

  disconnect() {
    const address = this.address;
    this.address = null;
    this.timers.clearTimeout(this.retryTimer);
    this.timers.clearInterval(this.poll);
    this.poll = null;
    this.s = { state: 'off', error: null };
    this.changed();
    if (address) this.bt.request('map_disconnect', { address }).catch(() => {});
  }

  // Reads new messages from the phone (the latest of each folder).
  async sync(only) {
    if (this.s.state !== 'ready') return 0;
    let added = 0;
    for (const folder of only ? [only] : ['inbox', 'sent']) {
      const list = await this.bt.request('map_list', { address: this.address, folder, max: folder === 'inbox' ? 50 : 30 });
      for (const m of list.sort((a, b) => parseTimestamp(a.timestamp) - parseTimestamp(b.timestamp))) {
        if (this.store.smsByHandle(`${folder}:${m.handle}`)) continue;
        if (await this.save(folder, m)) added++;
      }
    }
    return added;
  }

  async save(folder, m) {
    const phone = otherParty(m, folder);
    if (!phone) return false;
    let body = m.subject || '';
    try {
      body = await this.bt.request('map_get', { address: this.address, path: m.path, handle: m.handle });
    } catch {}
    if (folder === 'sent') {
      const claimed = this.store.claimSentSms({ phone, body, since: this.now() - 10 * 60_000, handle: `sent:${m.handle}` });
      if (claimed) {
        // In the phone's sent folder: it went out.
        if (claimed.status === 'submitted' || claimed.status === 'sending') this.store.updateSms(claimed.id, { status: 'sent' });
        this.applyPending(m.handle);
        this.emit('changed', { phone: claimed.phone });
        return false;
      }
    }
    const contact = this.store.contactByPhone(phone);
    const incoming = folder === 'inbox';
    const id = this.store.addSms({
      handle: `${folder}:${m.handle}`,
      phone,
      direction: incoming ? 'in' : 'out',
      body,
      status: incoming ? 'received' : 'sent',
      at: parseTimestamp(m.timestamp),
      leadId: contact?.kind === 'lead' ? contact.id : null,
      numberId: contact?.kind === 'number' ? contact.id : null,
      read: incoming ? Boolean(m.read) : true,
    });
    if (!id) return false;
    if (!incoming) this.applyPending(m.handle);
    // "STOP" (or similar) by SMS: no more messages to this number.
    if (incoming && /^\s*(stop|unsubscribe|opt[\s-]?out|cancel|band karo|bund karo)\s*[.!]?\s*$/i.test(body)) this.store.optOut?.(phone, 'SMS: ' + body.trim().slice(0, 40));
    this.emit('changed', { phone });
    if (incoming && !m.read) this.emit('incoming', { phone, body, contact });
    return true;
  }

  // A message the phone reported (MAP event: a new message).
  async onNotified(m) {
    const folder = /sent/i.test(m.folder || '') ? 'sent' : /inbox/i.test(m.folder || '') || !m.folder ? 'inbox' : null;
    if (!folder || this.store.smsByHandle(`${folder}:${m.handle}`)) return;
    await this.save(folder, m).catch(() => {});
  }

  // Sending / delivery reports for a message.
  onStatus({ handle, changed }) {
    const st = String(changed?.status || '').toLowerCase();
    const map = { 'delivery-success': 'delivered', 'sending-success': 'sent', 'delivery-failure': 'failed', 'sending-failure': 'failed' };
    if (!map[st]) return;
    const row = this.store.smsByHandle(`sent:${handle}`);
    if (!row) {
      // Not matched to a message yet: kept, and the sent folder is read now.
      this.pendingStatus.set(String(handle), map[st]);
      this.sync('sent').catch(() => {});
      return;
    }
    this.setStatus(row, map[st]);
  }

  setStatus(row, status) {
    // A delivery report is not undone by a later "sent" report.
    if ((row.status === 'delivered' || row.status === 'failed') && status === 'sent') return;
    this.store.updateSms(row.id, { status, error: status === 'failed' ? 'The phone could not send it.' : null });
    this.emit('changed', { phone: row.phone });
  }

  applyPending(handle) {
    const status = this.pendingStatus.get(String(handle));
    if (!status) return;
    this.pendingStatus.delete(String(handle));
    const row = this.store.smsByHandle(`sent:${handle}`);
    if (row) this.setStatus(row, status);
  }

  // Sends a text through the phone. Marks the lead or number SMS Seen once the phone accepted it.
  async send(rawPhone, text, { leadId = null, numberId = null } = {}) {
    const phone = String(rawPhone || '').replace(/[\s\-().]/g, '');
    const body = String(text || '').trim();
    if (!/^\+?\d{3,20}$/.test(phone)) return { ok: false, error: 'Enter a phone number.' };
    if (!body) return { ok: false, error: 'Write a message.' };
    if (body.length > 1600) return { ok: false, error: 'The message is too long (up to 1600 characters).' };
    if (this.store.isOptedOut?.(phone)) return { ok: false, error: 'This number opted out of messages.', optedOut: true };
    if (this.s.state !== 'ready') return { ok: false, error: this.s.error || 'Messages are not connected: connect your phone in the Dialer.' };
    const contact = leadId || numberId ? { kind: leadId ? 'lead' : 'number', id: leadId || numberId } : this.store.contactByPhone(phone);
    const lid = contact?.kind === 'lead' ? contact.id : null;
    const nid = contact?.kind === 'number' ? contact.id : null;
    const id = this.store.addSms({ phone, direction: 'out', body, status: 'sending', at: this.now(), leadId: lid, numberId: nid });
    this.emit('changed', { phone });
    try {
      await this.bt.request('map_push', { address: this.address, number: phone, text: body });
    } catch (err) {
      const reason = err.message.replace(/^(denied|obexd): /, '');
      this.store.updateSms(id, { status: 'failed', error: reason });
      this.emit('changed', { phone });
      return { ok: false, error: reason };
    }
    // The phone has it in its outbox (submitted); it is "sent" once the phone
    // reports it or lists it in its sent folder, "delivered" on a delivery report.
    this.store.updateSms(id, { status: 'submitted' });
    this.store.markSmsSeen({ leadId: lid, numberId: nid }, this.now());
    this.emit('changed', { phone, leadId: lid, numberId: nid });
    // The phone's sent copy (with its handle) comes in with the next sync.
    this.timers.setTimeout(() => this.sync('sent').catch(() => {}), 5_000);
    return { ok: true, id };
  }

  threads() {
    return this.store.smsThreads();
  }

  messages(phone) {
    this.store.markSmsRead(phone);
    return { messages: this.store.smsMessages(phone), contact: this.store.contactByPhone(phone) };
  }

  templates() {
    return this.store.getState('smsTemplates') || [];
  }

  saveTemplates(list) {
    const clean = (Array.isArray(list) ? list : [])
      .slice(0, 50)
      .map((t, i) => ({ id: String(t?.id || `t${Date.now()}${i}`).slice(0, 40), name: String(t?.name || '').trim().slice(0, 60), text: String(t?.text || '').slice(0, 1600) }))
      .filter((t) => t.name && t.text);
    this.store.setState('smsTemplates', clean);
    this.changed();
    return { ok: true, templates: clean };
  }
}

module.exports = { Sms, render, parseTimestamp, otherParty };
