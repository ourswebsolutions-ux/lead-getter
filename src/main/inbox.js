'use strict';

// The Inbox: conversations with leads who replied to a campaign, by email or
// WhatsApp, kept in the lead database. Only leads who replied appear. Each
// thread is one lead on one channel; messages are theirs ('in') and ours
// ('out': the campaign message they answered, and every reply sent from the
// app or by the admin on WhatsApp / email).
//
// Events: 'incoming' ({ thread, message }) for a new reply (the admin is told),
// 'change' ({ id }).

const { EventEmitter } = require('node:events');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inbox_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  address TEXT NOT NULL,
  name TEXT,
  lead_id INTEGER,
  campaign_id INTEGER,
  campaign_name TEXT,
  account TEXT,
  subject TEXT,
  last_at INTEGER NOT NULL,
  unread INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (channel, address)
);
CREATE TABLE IF NOT EXISTS inbox_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL,
  direction TEXT NOT NULL,
  text TEXT NOT NULL,
  subject TEXT,
  via TEXT,
  ext_id TEXT,
  at INTEGER NOT NULL,
  UNIQUE (thread_id, ext_id)
);
CREATE INDEX IF NOT EXISTS inbox_messages_thread ON inbox_messages (thread_id, id);
`;

const clip = (s, n) => String(s ?? '').slice(0, n);

class Inbox extends EventEmitter {
  constructor({ db, clock = () => Date.now() }) {
    super();
    Object.assign(this, { db, clock });
    this.db.exec(SCHEMA);
  }

  thread(id) {
    const t = this.db.prepare('SELECT * FROM inbox_threads WHERE id = ?').get(Number(id));
    return t ? this.view(t) : null;
  }

  view(t) {
    return { id: t.id, channel: t.channel, address: t.address, name: t.name, leadId: t.lead_id, campaignId: t.campaign_id, campaignName: t.campaign_name, account: t.account, subject: t.subject, lastAt: t.last_at, unread: t.unread, createdAt: t.created_at };
  }

  // A reply from a lead. ext_id (an email's Message-ID, a WhatsApp message
  // id) keeps the same reply from being added twice. sent: our campaign
  // message they answered (shown first, once).
  incoming({ channel, address, name = null, leadId = null, campaignId = null, campaignName = null, account = null, subject = null, text, extId = null, sent = null, at = this.clock() }) {
    const body = clip(String(text || '').trim(), 8000);
    if (!body || !address) return null;
    const addr = channel === 'email' ? String(address).toLowerCase() : String(address);
    let t = this.db.prepare('SELECT * FROM inbox_threads WHERE channel = ? AND address = ?').get(channel, addr);
    const isNew = !t;
    if (!t) {
      const r = this.db.prepare('INSERT INTO inbox_threads (channel, address, name, lead_id, campaign_id, campaign_name, account, subject, last_at, unread, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)').run(channel, addr, clip(name, 120) || null, leadId, campaignId, clip(campaignName, 120) || null, account, clip(subject, 250) || null, at, at);
      t = this.db.prepare('SELECT * FROM inbox_threads WHERE id = ?').get(Number(r.lastInsertRowid));
      if (sent) this.db.prepare("INSERT INTO inbox_messages (thread_id, direction, text, via, ext_id, at) VALUES (?, 'out', ?, 'campaign', 'campaign', ?)").run(t.id, clip(sent, 8000), Math.max(0, at - 1));
    }
    const r = this.db.prepare("INSERT INTO inbox_messages (thread_id, direction, text, subject, via, ext_id, at) VALUES (?, 'in', ?, ?, 'lead', ?, ?) ON CONFLICT (thread_id, ext_id) DO NOTHING").run(t.id, body, clip(subject, 250) || null, extId, at);
    if (!r.changes) return null; // already there
    this.db.prepare('UPDATE inbox_threads SET last_at = MAX(last_at, ?), unread = unread + 1, name = COALESCE(name, ?), subject = COALESCE(?, subject), campaign_id = COALESCE(campaign_id, ?), campaign_name = COALESCE(campaign_name, ?), account = COALESCE(account, ?), lead_id = COALESCE(lead_id, ?) WHERE id = ?').run(at, clip(name, 120) || null, clip(subject, 250) || null, campaignId, clip(campaignName, 120) || null, account, leadId, t.id);
    const thread = this.thread(t.id);
    const message = { id: Number(r.lastInsertRowid), direction: 'in', text: body, subject, at };
    this.emit('incoming', { thread, message, isNew });
    this.emit('change', { id: t.id });
    return { thread, message, isNew };
  }

  // Our reply, once it was sent. via: 'app' | 'admin-whatsapp' | 'admin-email' | 'assistant'.
  outgoing(threadId, text, { via = 'app', subject = null } = {}) {
    const t = this.thread(threadId);
    if (!t) return null;
    const at = this.clock();
    const r = this.db.prepare("INSERT INTO inbox_messages (thread_id, direction, text, subject, via, at) VALUES (?, 'out', ?, ?, ?, ?)").run(t.id, clip(text, 8000), subject, via, at);
    this.db.prepare('UPDATE inbox_threads SET last_at = ? WHERE id = ?').run(at, t.id);
    this.emit('change', { id: t.id });
    return { id: Number(r.lastInsertRowid) };
  }

  markRead(id) {
    this.db.prepare('UPDATE inbox_threads SET unread = 0 WHERE id = ?').run(Number(id));
    this.emit('change', { id: Number(id) });
    return { ok: true };
  }

  remove(id) {
    this.db.prepare('DELETE FROM inbox_messages WHERE thread_id = ?').run(Number(id));
    this.db.prepare('DELETE FROM inbox_threads WHERE id = ?').run(Number(id));
    this.emit('change', { id: Number(id) });
    return { ok: true };
  }

  // Threads, latest reply first, with their last message.
  threads({ channel = null, limit = 300 } = {}) {
    const rows = channel ? this.db.prepare('SELECT * FROM inbox_threads WHERE channel = ? ORDER BY last_at DESC, id DESC LIMIT ?').all(channel, limit) : this.db.prepare('SELECT * FROM inbox_threads ORDER BY last_at DESC, id DESC LIMIT ?').all(limit);
    const last = this.db.prepare('SELECT direction, text, at FROM inbox_messages WHERE thread_id = ? ORDER BY at DESC, id DESC LIMIT 1');
    return rows.map((t) => ({ ...this.view(t), last: last.get(t.id) || null }));
  }

  messages(threadId, limit = 500) {
    return this.db.prepare('SELECT id, direction, text, subject, via, at FROM inbox_messages WHERE thread_id = ? ORDER BY at, id LIMIT ?').all(Number(threadId), limit);
  }

  unreadCount() {
    return this.db.prepare('SELECT COALESCE(SUM(unread), 0) AS n FROM inbox_threads').get().n;
  }
}

module.exports = { Inbox };
