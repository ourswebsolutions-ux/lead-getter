'use strict';

// WhatsApp chats and the outreach campaign, in the lead database (tables
// from schema version 4). Message text is encrypted with the OS keychain
// cipher before it is written; only this computer's account can read it.

const { laterStatus } = require('../whatsapp/messages');

class ChatStore {
  // db: node:sqlite DatabaseSync; cipher: { encrypt(text) -> Buffer, decrypt(Buffer) -> text }
  constructor(db, cipher) {
    this.db = db;
    this.cipher = cipher;
  }

  enc(text) {
    return text == null ? null : this.cipher.encrypt(String(text));
  }

  dec(buf) {
    if (buf == null) return null;
    try {
      return this.cipher.decrypt(Buffer.from(buf));
    } catch {
      return null; // e.g. a database copied from another computer
    }
  }

  // Stores messages (live or from a history sync) and keeps each chat's
  // summary. unreadIncrement: count new incoming messages as unread.
  // Returns the chats that changed.
  addMessages(list, { unreadIncrement = false } = {}) {
    const changed = new Set();
    const insert = this.db.prepare(
      `INSERT INTO wa_chat_messages (jid, id, from_me, sender, ts, kind, body, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (jid, id) DO NOTHING`,
    );
    const chat = this.db.prepare(
      `INSERT INTO wa_chats (jid, phone, name, last_ts, last_preview, last_from_me, unread) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (jid) DO UPDATE SET
         phone = COALESCE(wa_chats.phone, excluded.phone),
         name = COALESCE(wa_chats.name, excluded.name),
         last_ts = CASE WHEN excluded.last_ts >= COALESCE(wa_chats.last_ts, 0) THEN excluded.last_ts ELSE wa_chats.last_ts END,
         last_preview = CASE WHEN excluded.last_ts >= COALESCE(wa_chats.last_ts, 0) THEN excluded.last_preview ELSE wa_chats.last_preview END,
         last_from_me = CASE WHEN excluded.last_ts >= COALESCE(wa_chats.last_ts, 0) THEN excluded.last_from_me ELSE wa_chats.last_from_me END,
         unread = wa_chats.unread + excluded.unread`,
    );
    this.db.exec('BEGIN');
    try {
      for (const m of list) {
        const r = insert.run(m.jid, m.id, m.fromMe ? 1 : 0, m.fromMe ? null : m.pushName, m.ts, m.kind, this.enc(m.text), m.status);
        if (r.changes !== 1) continue; // already stored (duplicate event or re-sync)
        chat.run(m.jid, m.phone, m.fromMe ? null : m.pushName, m.ts, this.enc(m.text), m.fromMe ? 1 : 0, unreadIncrement && !m.fromMe ? 1 : 0);
        changed.add(m.jid);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return [...changed];
  }

  // Chat metadata from WhatsApp (history sync, chats.upsert/update,
  // contacts): names and unread counts. Never invents a chat's messages.
  upsertChat({ jid, phone = null, name = null, unread = null, lastTs = null }) {
    this.db
      .prepare(
        `INSERT INTO wa_chats (jid, phone, name, last_ts, unread) VALUES (?, ?, ?, ?, COALESCE(?, 0))
         ON CONFLICT (jid) DO UPDATE SET
           phone = COALESCE(excluded.phone, wa_chats.phone),
           name = COALESCE(excluded.name, wa_chats.name),
           last_ts = MAX(COALESCE(wa_chats.last_ts, 0), COALESCE(excluded.last_ts, 0)),
           unread = COALESCE(?, wa_chats.unread)`,
      )
      .run(jid, phone, name, lastTs, unread, unread);
  }

  setStatus(jid, id, status) {
    const row = this.db.prepare('SELECT status FROM wa_chat_messages WHERE jid = ? AND id = ?').get(jid, id);
    if (!row) return false;
    const next = laterStatus(row.status, status);
    if (next === row.status) return false;
    this.db.prepare('UPDATE wa_chat_messages SET status = ? WHERE jid = ? AND id = ?').run(next, jid, id);
    return true;
  }

  markRead(jid) {
    this.db.prepare('UPDATE wa_chats SET unread = 0 WHERE jid = ?').run(jid);
  }

  setAvatar(jid, avatar, now = Date.now()) {
    this.db.prepare('UPDATE wa_chats SET avatar = ?, avatar_checked_at = ? WHERE jid = ?').run(avatar, now, jid);
  }

  // Chats that have at least one message, newest first, with the matching
  // lead (by phone) when there is one.
  listChats({ search = '', limit = 300 } = {}) {
    const rows = this.db
      .prepare(
        `SELECT c.jid, c.phone, c.name, c.last_ts, c.last_preview, c.last_from_me, c.unread, c.avatar, c.avatar_checked_at,
                b.id AS lead_id, b.name AS lead_name
         FROM wa_chats c
         LEFT JOIN businesses b ON b.id = (SELECT id FROM businesses WHERE phone = c.phone AND qualified = 1 ORDER BY id LIMIT 1)
         WHERE c.last_ts IS NOT NULL
         ORDER BY c.last_ts DESC LIMIT ?`,
      )
      .all(limit);
    const q = search.trim().toLowerCase();
    const out = rows.map((r) => ({
      jid: r.jid,
      phone: r.phone,
      name: r.name,
      leadId: r.lead_id,
      leadName: r.lead_name,
      lastTs: r.last_ts,
      lastText: this.dec(r.last_preview),
      lastFromMe: Boolean(r.last_from_me),
      unread: r.unread,
      avatar: r.avatar,
      avatarCheckedAt: r.avatar_checked_at,
    }));
    if (!q) return out;
    const digits = q.replace(/\D/g, '');
    return out.filter((c) => [c.name, c.leadName, c.lastText].some((v) => v && v.toLowerCase().includes(q)) || (digits.length >= 3 && (c.phone || '').includes(digits)));
  }

  chat(jid) {
    return this.listChats({ limit: 100000 }).find((c) => c.jid === jid) || null;
  }

  // Messages of one chat in chronological order (the latest `limit`).
  messages(jid, { limit = 200, before = null } = {}) {
    const rows = this.db
      .prepare(
        `SELECT id, from_me, sender, ts, kind, body, status FROM wa_chat_messages
         WHERE jid = ? AND (? IS NULL OR ts < ?) ORDER BY ts DESC, rowid DESC LIMIT ?`,
      )
      .all(jid, before, before, limit);
    return rows.reverse().map((r) => ({ id: r.id, fromMe: Boolean(r.from_me), sender: r.sender, ts: r.ts, kind: r.kind, text: this.dec(r.body), status: r.status }));
  }

  oldestMessage(jid) {
    const r = this.db.prepare('SELECT id, from_me, ts FROM wa_chat_messages WHERE jid = ? ORDER BY ts ASC LIMIT 1').get(jid);
    return r ? { id: r.id, fromMe: Boolean(r.from_me), ts: r.ts } : null;
  }

  // Latest incoming message ids (for read receipts).
  unreadIncoming(jid, limit = 20) {
    return this.db.prepare('SELECT id FROM wa_chat_messages WHERE jid = ? AND from_me = 0 ORDER BY ts DESC LIMIT ?').all(jid, limit).map((r) => r.id);
  }

  hasIncomingSince(jid, since) {
    return Boolean(this.db.prepare('SELECT 1 FROM wa_chat_messages WHERE jid = ? AND from_me = 0 AND ts > ? LIMIT 1').get(jid, since));
  }

  jidForPhone(phone) {
    return this.db.prepare('SELECT jid FROM wa_chats WHERE phone = ? ORDER BY last_ts DESC LIMIT 1').get(phone)?.jid || null;
  }
}

class OutreachStore {
  constructor(db) {
    this.db = db;
  }

  tx(fn) {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // --- campaigns ---------------------------------------------------------------

  createCampaign(name, config, now = Date.now()) {
    const r = this.db.prepare('INSERT INTO outreach_campaigns (name, config, created_at, updated_at) VALUES (?, ?, ?, ?)').run(name, JSON.stringify(config), now, now);
    return Number(r.lastInsertRowid);
  }

  campaign(id) {
    const r = this.db.prepare('SELECT * FROM outreach_campaigns WHERE id = ?').get(id);
    return r ? toCampaign(r) : null;
  }

  campaigns() {
    return this.db.prepare('SELECT * FROM outreach_campaigns ORDER BY created_at, id').all().map(toCampaign);
  }

  saveCampaign(c, now = Date.now()) {
    this.db
      .prepare('UPDATE outreach_campaigns SET name = ?, config = ?, status = ?, pause_reason = ?, next_due_at = ?, current_phone = ?, failures = ?, updated_at = ? WHERE id = ?')
      .run(c.name, JSON.stringify(c.config), c.status, c.pauseReason ?? null, c.nextDueAt ?? null, c.current ?? null, c.failures ?? 0, now, c.id);
  }

  // Removes the campaign, its queue and its settings. Real sends stay in the
  // contact history (with the campaign's name); simulated ones go.
  deleteCampaign(id) {
    this.tx(() => {
      const c = this.campaign(id);
      if (!c) return;
      this.db.prepare('UPDATE outreach_sends SET campaign_name = COALESCE(campaign_name, ?), campaign_id = NULL WHERE campaign_id = ? AND test = 0').run(c.name, id);
      this.db.prepare('DELETE FROM outreach_sends WHERE campaign_id = ? AND test = 1').run(id);
      this.db.prepare('DELETE FROM outreach_contacts WHERE campaign_id = ?').run(id);
      this.db.prepare('DELETE FROM outreach_campaigns WHERE id = ?').run(id);
    });
  }

  // Back to a fresh, stopped campaign with the same settings: its queue and
  // progress are cleared. Real sends stay, so everyone already messaged
  // remains "previously contacted" and this campaign can never send them the
  // same message again.
  resetCampaign(id, now = Date.now()) {
    this.tx(() => {
      const c = this.campaign(id);
      if (!c) return;
      this.db.prepare('DELETE FROM outreach_contacts WHERE campaign_id = ?').run(id);
      this.db.prepare('DELETE FROM outreach_sends WHERE campaign_id = ? AND test = 1').run(id);
      this.saveCampaign({ ...c, status: 'stopped', pauseReason: null, nextDueAt: null, current: null, failures: 0 }, now);
    });
  }

  // --- global contact history (all campaigns, kept forever) -----------------------

  isOptedOut(phone) {
    return Boolean(this.db.prepare('SELECT 1 FROM outreach_optouts WHERE phone = ?').get(phone));
  }

  optOut(phone, reason, now = Date.now()) {
    this.tx(() => {
      this.db.prepare('INSERT INTO outreach_optouts (phone, reason, at) VALUES (?, ?, ?) ON CONFLICT (phone) DO NOTHING').run(phone, reason, now);
      this.db.prepare("UPDATE outreach_contacts SET state = 'opted_out', updated_at = ?, note = ? WHERE phone = ?").run(now, reason, phone);
    });
  }

  // A real message reached (or may have reached) WhatsApp for this number,
  // in any campaign, optionally other than `exceptCampaign`. Only a definite
  // failure doesn't count.
  wasContacted(phone, exceptCampaign = null) {
    return Boolean(
      this.db.prepare("SELECT 1 FROM outreach_sends WHERE phone = ? AND test = 0 AND status <> 'failed' AND (? IS NULL OR campaign_id IS NULL OR campaign_id <> ?) LIMIT 1").get(phone, exceptCampaign, exceptCampaign),
    );
  }

  contactedPhones() {
    return new Set(this.db.prepare("SELECT DISTINCT phone FROM outreach_sends WHERE test = 0 AND status <> 'failed'").all().map((r) => r.phone));
  }

  // One row per number ever messaged for real: the best status WhatsApp
  // confirmed (read > delivered > sent; 'unknown' when a send was
  // interrupted), when, how many messages, and in which campaign.
  history() {
    const rows = this.db
      .prepare(
        `SELECT s.phone, s.stage, s.status, COALESCE(s.sent_at, s.created_at) AS at, COALESCE(c.name, s.campaign_name) AS campaign
         FROM outreach_sends s LEFT JOIN outreach_campaigns c ON c.id = s.campaign_id
         WHERE s.test = 0 AND s.status <> 'failed' ORDER BY at`,
      )
      .all();
    const rank = { read: 5, delivered: 4, sent: 3, unknown: 2, pending: 1 };
    const out = new Map();
    for (const r of rows) {
      const h = out.get(r.phone) || { phone: r.phone, messages: 0, status: null, firstAt: r.at, lastAt: r.at, campaign: r.campaign };
      h.messages++;
      h.lastAt = r.at;
      h.campaign = r.campaign;
      if ((rank[r.status] || 0) > (rank[h.status] || 0)) h.status = r.status;
      out.set(r.phone, h);
    }
    const leads = this.db.prepare("SELECT phone, MIN(name) AS name FROM businesses WHERE phone LIKE '+%' GROUP BY phone").all();
    const names = new Map(leads.map((l) => [l.phone, l.name]));
    return [...out.values()].map((h) => ({ ...h, leadName: names.get(h.phone) || null, optedOut: this.isOptedOut(h.phone) })).sort((a, b) => b.lastAt - a.lastAt);
  }

  // --- campaign contacts ----------------------------------------------------------

  // Adds numbers to a campaign. Opted-out numbers, numbers already in it and
  // (unless allowPrevious) numbers contacted before are skipped.
  addContacts(campaignId, list, { allowPrevious = false } = {}, now = Date.now()) {
    let added = 0;
    const skipped = { optedOut: 0, previous: 0, duplicate: 0 };
    this.tx(() => {
      const ins = this.db.prepare(
        `INSERT INTO outreach_contacts (campaign_id, phone, lead_id, name, stage, state, added_at, updated_at) VALUES (?, ?, ?, ?, 0, 'queued', ?, ?)
         ON CONFLICT (campaign_id, phone) DO NOTHING`,
      );
      const seen = new Set();
      for (const c of list) {
        if (seen.has(c.phone)) {
          skipped.duplicate++;
          continue;
        }
        seen.add(c.phone);
        if (this.isOptedOut(c.phone)) skipped.optedOut++;
        else if (!allowPrevious && this.wasContacted(c.phone)) skipped.previous++;
        else if (ins.run(campaignId, c.phone, c.leadId ?? null, c.name ?? null, now, now).changes === 1) added++;
        else skipped.duplicate++;
      }
    });
    return { added, skipped: skipped.optedOut + skipped.previous + skipped.duplicate, skippedDetail: skipped };
  }

  contact(campaignId, phone) {
    const r = this.db.prepare('SELECT * FROM outreach_contacts WHERE campaign_id = ? AND phone = ?').get(campaignId, phone);
    return r ? toContact(r) : null;
  }

  contacts(campaignId) {
    return this.db.prepare('SELECT * FROM outreach_contacts WHERE campaign_id = ? ORDER BY added_at, rowid').all(campaignId).map(toContact);
  }

  // A number in any campaign (for replies and receipts).
  contactsByPhone(phone) {
    return this.db.prepare('SELECT * FROM outreach_contacts WHERE phone = ?').all(phone).map(toContact);
  }

  setContact(campaignId, phone, fields, now = Date.now()) {
    const cols = Object.keys(fields);
    if (!cols.length) return;
    const map = { state: 'state', name: 'name', stage: 'stage', lastSentAt: 'last_sent_at', note: 'note' };
    const set = cols.map((k) => `${map[k]} = ?`).join(', ');
    this.db.prepare(`UPDATE outreach_contacts SET ${set}, updated_at = ? WHERE campaign_id = ? AND phone = ?`).run(...cols.map((k) => fields[k]), now, campaignId, phone);
  }

  removeContact(campaignId, phone) {
    this.db.prepare("DELETE FROM outreach_contacts WHERE campaign_id = ? AND phone = ? AND stage = 0 AND state IN ('queued', 'excluded', 'skipped')").run(campaignId, phone);
  }

  // --- sends --------------------------------------------------------------------

  // Reserves one stage for one contact in one campaign before anything is
  // sent. Returns the send id, or null when that stage was already sent or
  // might have been (pending / unknown / sent...), so it can never be sent
  // twice. Only a definite failure is reused for a retry.
  reserve({ campaignId, campaignName = null, phone, stage, test, day, now = Date.now() }) {
    return this.tx(() => {
      const failed = this.db.prepare("SELECT id FROM outreach_sends WHERE campaign_id = ? AND phone = ? AND stage = ? AND test = ? AND status = 'failed'").get(campaignId, phone, stage, test ? 1 : 0);
      if (failed) {
        this.db.prepare("UPDATE outreach_sends SET status = 'pending', error = NULL, wa_id = NULL, day = ?, created_at = ?, sent_at = NULL WHERE id = ?").run(day, now, failed.id);
        return failed.id;
      }
      try {
        const r = this.db
          .prepare("INSERT INTO outreach_sends (campaign_id, campaign_name, phone, stage, test, day, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)")
          .run(campaignId, campaignName, phone, stage, test ? 1 : 0, day, now);
        return Number(r.lastInsertRowid);
      } catch (err) {
        if (/UNIQUE/.test(err.message)) return null;
        throw err;
      }
    });
  }

  // Frees a reservation that certainly never reached WhatsApp.
  release(id) {
    this.db.prepare("DELETE FROM outreach_sends WHERE id = ? AND status = 'pending'").run(id);
  }

  markSent(id, waId, now = Date.now()) {
    this.db.prepare("UPDATE outreach_sends SET status = 'sent', wa_id = ?, sent_at = ? WHERE id = ?").run(waId, now, id);
  }

  markFailed(id, error, status = 'failed') {
    this.db.prepare('UPDATE outreach_sends SET status = ?, error = ? WHERE id = ?').run(status, String(error).slice(0, 300), id);
  }

  // Delivery receipts: only WhatsApp's own receipts move a message on.
  updateStatus(waId, status) {
    const row = this.db.prepare('SELECT id, status FROM outreach_sends WHERE wa_id = ?').get(waId);
    if (!row) return false;
    const next = laterStatus(row.status === 'unknown' ? 'sent' : row.status, status);
    if (next === row.status) return false;
    this.db.prepare('UPDATE outreach_sends SET status = ? WHERE id = ?').run(next, row.id);
    return true;
  }

  // Unique real (or, for test runs, simulated) recipients on `day`, across
  // all campaigns: the daily limit can't be multiplied by campaigns.
  recipientsOn(day, test) {
    return this.db.prepare("SELECT COUNT(DISTINCT phone) n FROM outreach_sends WHERE day = ? AND test = ? AND status <> 'failed'").get(day, test ? 1 : 0).n;
  }

  messagedOn(phone, day, test) {
    return Boolean(this.db.prepare("SELECT 1 FROM outreach_sends WHERE phone = ? AND day = ? AND test = ? AND status <> 'failed'").get(phone, day, test ? 1 : 0));
  }

  // The latest campaign message (all campaigns): the gap to the next
  // contact is measured from it.
  lastSendAt(test) {
    return this.db.prepare("SELECT MAX(COALESCE(sent_at, created_at)) t FROM outreach_sends WHERE test = ? AND status <> 'failed'").get(test ? 1 : 0).t || null;
  }

  // Reservations left 'pending' by a crash or a forced quit: whether they
  // reached WhatsApp is unknown, so they are never sent again.
  settleInterrupted(olderThan) {
    const rows = this.db.prepare("SELECT id, campaign_id, phone FROM outreach_sends WHERE status = 'pending' AND created_at < ?").all(olderThan);
    for (const r of rows) {
      this.markFailed(r.id, 'Lead Finder closed while this message was being sent; it may or may not have been delivered.', 'unknown');
      this.db
        .prepare("UPDATE outreach_contacts SET state = 'uncertain', note = 'Interrupted while sending; check the chat before continuing.' WHERE campaign_id = ? AND phone = ? AND state IN ('queued', 'active')")
        .run(r.campaign_id, r.phone);
    }
    return rows.length;
  }

  sends({ campaignId, test, limit = 200 } = {}) {
    return this.db
      .prepare(
        `SELECT s.*, c.name, c.lead_id FROM outreach_sends s LEFT JOIN outreach_contacts c ON c.campaign_id = s.campaign_id AND c.phone = s.phone
         WHERE s.campaign_id = ? AND s.test = ? ORDER BY s.created_at DESC, s.id DESC LIMIT ?`,
      )
      .all(campaignId, test ? 1 : 0, limit)
      .map((r) => ({ id: r.id, phone: r.phone, stage: r.stage, day: r.day, status: r.status, waId: r.wa_id, error: r.error, createdAt: r.created_at, sentAt: r.sent_at, name: r.name, leadId: r.lead_id }));
  }

  // Leaving test mode: forget this campaign's simulated progress (real sends
  // and opt-outs stay).
  clearTest(campaignId) {
    this.tx(() => {
      this.db.prepare('DELETE FROM outreach_sends WHERE campaign_id = ? AND test = 1').run(campaignId);
      const real = this.db
        .prepare("SELECT phone, MAX(stage) s, MAX(COALESCE(sent_at, created_at)) t FROM outreach_sends WHERE campaign_id = ? AND test = 0 AND status <> 'failed' GROUP BY phone")
        .all(campaignId);
      const byPhone = new Map(real.map((r) => [r.phone, r]));
      for (const c of this.contacts(campaignId)) {
        const r = byPhone.get(c.phone);
        const stage = r ? r.s : 0;
        // Progress always comes from real sends; a status the user (or the
        // contact) chose is kept.
        const keep = ['opted_out', 'excluded', 'replied', 'skipped'].includes(c.state);
        this.setContact(campaignId, c.phone, { stage, lastSentAt: r ? r.t : null, ...(keep ? {} : { state: stage === 0 ? 'queued' : stage >= 3 ? 'done' : 'active' }) });
      }
    });
  }
}

function toCampaign(r) {
  let config = {};
  try {
    config = JSON.parse(r.config);
  } catch {}
  return { id: r.id, name: r.name, config, status: r.status, pauseReason: r.pause_reason, nextDueAt: r.next_due_at, current: r.current_phone, failures: r.failures, createdAt: r.created_at, updatedAt: r.updated_at };
}

function toContact(r) {
  return { campaignId: r.campaign_id, phone: r.phone, leadId: r.lead_id, name: r.name, stage: r.stage, state: r.state, lastSentAt: r.last_sent_at, addedAt: r.added_at, updatedAt: r.updated_at, note: r.note };
}

module.exports = { ChatStore, OutreachStore };
