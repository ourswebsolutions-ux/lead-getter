'use strict';

// Email campaigns: one subject and body (personalised with {name},
// {business}, {email}) sent from one of the user's SMTP accounts to leads
// from the Leads database that have a valid email address.
//
// Safety rules (enforced here, whatever the window or the assistant sends):
//   - one email at a time per SMTP account, with the campaign's delay
//     between emails (default 60 s, at least 10 s) and its daily limit
//     (default 100 a day);
//   - each recipient is reserved in the database before the email is sent,
//     so nobody gets the same campaign twice (restarts, retries, duplicates);
//     an email interrupted by a crash is marked "uncertain" and never resent
//     automatically;
//   - an address emailed by another campaign is skipped unless the campaign
//     allows previously contacted people; opted-out addresses never get
//     anything, whatever the settings;
//   - every email carries an unsubscribe line and a List-Unsubscribe header;
//   - a login or connection failure pauses the campaign (nothing is lost);
//     three failed emails in a row pause it too;
//   - sending needs an active plan (canSend).
//
// Everything is kept in the lead database, so campaigns, their progress and
// their history survive restarts; running campaigns go on after a restart.

const { EventEmitter } = require('node:events');
const { isEmail } = require('./accounts');
const { extractName, cleanBusiness } = require('../whatsapp/templates');
const { leadFacts } = require('../ai/lead-facts');
const { newTrackId } = require('./tracking');

// accountIds: the accounts it sends from, in turn (each with its own delay and daily limit).
// aiWrite: each email written by the AI from the body (the user's instructions)
// and the business's details; the text is kept on the recipient.
// trackClicks: links go through the user's click tracking address (tracking.js), when it is set up.
const DEFAULTS = { delaySeconds: 60, dailyLimit: 100, allowPrevious: false, attachments: [], html: null, accountIds: [], senderNext: {}, senderDown: {}, aiWrite: false, trackClicks: true };
const SYNC_EVERY = 60_000; // category campaigns look for new leads with an email
const LIMITS = { delay: { min: 10, max: 3600 }, daily: { min: 1, max: 2000 }, attachments: 10, attachmentBytes: 20 * 1024 * 1024, recipients: 20_000 };
const MAX_ATTEMPTS = 3;
const RETRY_AFTER = 30 * 60_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS email_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  pause_reason TEXT,
  account_id TEXT,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '{}',
  next_due_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS email_recipients (
  campaign_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  lead_id INTEGER,
  name TEXT,
  business TEXT,
  state TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER,
  error TEXT,
  message_id TEXT,
  sent_at INTEGER,
  sent_day TEXT,
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, email)
);
CREATE INDEX IF NOT EXISTS email_recipients_email ON email_recipients (email, state);
CREATE INDEX IF NOT EXISTS email_recipients_day ON email_recipients (sent_day);
CREATE TABLE IF NOT EXISTS email_optouts (
  email TEXT PRIMARY KEY,
  reason TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  level TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS email_log_campaign ON email_log (campaign_id, id);
CREATE TABLE IF NOT EXISTS email_clicks (
  id TEXT PRIMARY KEY,
  campaign_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  url TEXT NOT NULL,
  at INTEGER NOT NULL,
  ua TEXT,
  bot INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS email_clicks_campaign ON email_clicks (campaign_id, email);
CREATE TABLE IF NOT EXISTS email_test_sends (
  message_id TEXT PRIMARY KEY,
  campaign_id INTEGER NOT NULL,
  account TEXT NOT NULL,
  email TEXT NOT NULL,
  subject TEXT,
  text TEXT,
  at INTEGER NOT NULL
);
`;

// A link scanner opens links seconds after delivery; a person does not.
const SCANNER_WINDOW = 15_000;

const PLACEHOLDER = /\{\s*(name|business|business name|email|first name)\s*\}/gi;

// The day (YYYY-MM-DD) on this computer's calendar.
function dayOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Placeholders filled; one that has no value is removed with its spacing
// ("Hello {name}," -> "Hello,").
function render(template, values) {
  const out = String(template || '').replace(PLACEHOLDER, (_, k) => {
    const key = k.toLowerCase().replace(/\s+/g, ' ');
    const v = key === 'business name' ? values.business : key === 'first name' ? values.name : values[key];
    return v ? String(v) : '\u0000';
  });
  return out
    .replace(/[ \t]*\u0000[ \t]*(?=[,.!?;:])/g, '')
    .replace(/[ \t]*\u0000/g, '')
    .replace(/[ \t]{2,}/g, ' ');
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const looksHtml = (s) => /<\/?(p|div|br|a|b|strong|i|em|u|ul|ol|li|h[1-6]|table|tr|td|span|img|hr|blockquote)\b[^>]*>/i.test(String(s || ''));

// Plain text as simple HTML: paragraphs, line breaks, links.
function textToHtml(text) {
  const linkify = (s) => esc(s).replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (u) => `<a href="${u}">${u}</a>`);
  return String(text)
    .split(/\n{2,}/)
    .map((p) => `<p>${linkify(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

// The user's HTML without what email clients block anyway (scripts,
// event handlers, javascript: links).
function cleanHtml(html) {
  return String(html)
    .replace(/<(script|style|iframe|object|embed|form)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|iframe|object|embed|form|meta|link)\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
}

function htmlToText(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => (label.replace(/<[^>]+>/g, '').trim() === href ? href : `${label} (${href})`))
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const UNSUBSCRIBE_TEXT = 'If you would rather not receive these emails, reply with “unsubscribe” and you will not be emailed again.';

// The email for one recipient: { subject, text, html }.
function compose({ subject, body }, values) {
  const s = render(subject, values).replace(/[\r\n]+/g, ' ').trim();
  const b = render(body, values);
  const html = looksHtml(b) ? cleanHtml(b) : textToHtml(b);
  const text = looksHtml(b) ? htmlToText(b) : b;
  return {
    subject: s,
    text: `${text.trim()}\n\n--\n${UNSUBSCRIBE_TEXT}`,
    html: `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2328">${html}<hr style="border:none;border-top:1px solid #ddd;margin:24px 0 12px"><p style="font-size:12px;color:#666">${esc(UNSUBSCRIBE_TEXT)}</p></body></html>`,
  };
}

// A lead's address to email: its main email, else the first valid one of
// the others. '' when it has none.
function emailOf(lead) {
  const all = [lead.email, ...(Array.isArray(lead.emails) ? lead.emails.map((e) => (typeof e === 'string' ? e : e?.email)) : [])];
  const ok = all.map((e) => String(e || '').trim().toLowerCase()).find((e) => isEmail(e) && !/@(example\.(com|org|net)|sentry\.io|wixpress\.com)$/i.test(e) && !/\.(png|jpe?g|gif|webp|svg)$/i.test(e));
  return ok || '';
}

// {name} and {business} for a lead: a person's first name; for a business
// the contact's first name, else a name in the business name (never invented).
function valuesOf(lead) {
  const person = lead.kind === 'person' || lead.source === 'linkedin' && lead.profileUrl;
  const name = person ? extractName(lead.name) : extractName(lead.contactName) || extractName(lead.podcastHost) || null;
  const b = cleanBusiness(person ? lead.companyName : lead.name);
  // A lead known only by its address or a person's name (imported emails) has no business name.
  const business = b && !b.includes('@') && !(!person && lead.contactName && b === cleanBusiness(lead.contactName)) ? b : null;
  return { name, business };
}

class EmailCampaigns extends EventEmitter {
  // db: node:sqlite DatabaseSync (the lead database); accounts: EmailAccounts;
  // files: FileLibrary (attachments); leads(filter) -> LeadStore.listLeads rows;
  // leadById(id); canSend() -> Promise<bool> (an active plan).
  // writer({ instructions, subject, sender, business }) -> Promise<{ subject, body }>:
  // the AI that writes personalised emails (null: not available).
  constructor({ db, accounts, files = null, leads = () => [], leadById = () => null, canSend = async () => true, clock = () => Date.now(), tickMs = 5000, writer = null, random = Math.random }) {
    super();
    Object.assign(this, { db, accounts, files, leads, leadById, canSend, clock, tickMs, writer, random });
    this.db.exec(SCHEMA);
    // Replies (read from the account's inbox by replies.js), the account that
    // sent each email, and the AI's text for each recipient.
    // Clicks: the recipient's tracking id (in their links), first click and count.
    // priority 1: imported by hand, sent before the rest of the waiting list.
    for (const col of ['replied_at INTEGER', 'reply_subject TEXT', 'sent_account TEXT', 'ai_subject TEXT', 'ai_body TEXT', 'track_id TEXT', 'clicked_at INTEGER', 'clicks INTEGER NOT NULL DEFAULT 0', 'priority INTEGER NOT NULL DEFAULT 0']) {
      try {
        this.db.exec(`ALTER TABLE email_recipients ADD COLUMN ${col}`);
      } catch {} // already there
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS email_recipients_track ON email_recipients (track_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS email_recipients_msgid ON email_recipients (message_id)');
    this.tracker = null; // ClickTracker (service.js)
    // A category campaign: the category's leads with an email, added as they come.
    try {
      this.db.exec('ALTER TABLE email_campaigns ADD COLUMN category TEXT');
    } catch {}
    this.syncedAt = new Map();
    this.aiFailures = new Map();
    this.busy = new Set(); // SMTP accounts sending right now
    this.timer = null;
    this.ticking = false;
    this.waiting = new Map(); // campaign id -> why it is not sending right now
  }

  // --- storage ----------------------------------------------------------------------

  row(id) {
    const r = this.db.prepare('SELECT * FROM email_campaigns WHERE id = ?').get(Number(id));
    if (!r) return null;
    let config = {};
    try {
      config = JSON.parse(r.config || '{}');
    } catch {}
    return { id: r.id, category: r.category || null, name: r.name, status: r.status, pauseReason: r.pause_reason, accountId: r.account_id, subject: r.subject, body: r.body, config: { ...DEFAULTS, ...config }, nextDueAt: r.next_due_at, failures: r.failures, createdAt: r.created_at, updatedAt: r.updated_at, startedAt: r.started_at, finishedAt: r.finished_at };
  }

  ids() {
    return this.db.prepare('SELECT id FROM email_campaigns ORDER BY id DESC').all().map((r) => r.id);
  }

  // The accounts a campaign sends from (those that still exist), in order.
  senders(c) {
    const list = c.config.accountIds?.length ? c.config.accountIds : c.accountId ? [c.accountId] : [];
    return [...new Set(list)].filter((id) => this.accounts.get(id));
  }

  // One field of the config, written on the latest row (sends run side by side).
  patchConfig(id, fn) {
    const c = this.row(id);
    if (!c) return;
    const config = { ...c.config };
    fn(config);
    this.setFields(id, { config });
  }

  setFields(id, fields) {
    const cols = { status: 'status', pauseReason: 'pause_reason', accountId: 'account_id', subject: 'subject', body: 'body', name: 'name', nextDueAt: 'next_due_at', failures: 'failures', startedAt: 'started_at', finishedAt: 'finished_at' };
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'config') {
        sets.push('config = ?');
        vals.push(JSON.stringify(v));
      } else if (cols[k]) {
        sets.push(`${cols[k]} = ?`);
        vals.push(v ?? null);
      }
    }
    sets.push('updated_at = ?');
    vals.push(this.clock());
    this.db.prepare(`UPDATE email_campaigns SET ${sets.join(', ')} WHERE id = ?`).run(...vals, Number(id));
  }

  log(id, level, text) {
    this.db.prepare('INSERT INTO email_log (campaign_id, at, level, text) VALUES (?, ?, ?, ?)').run(Number(id), this.clock(), level, String(text).slice(0, 500));
  }

  counts(id) {
    const rows = this.db.prepare('SELECT state, COUNT(*) AS n FROM email_recipients WHERE campaign_id = ? GROUP BY state').all(Number(id));
    const c = { queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0, uncertain: 0 };
    for (const r of rows) c[r.state] = r.n;
    c.total = Object.values(c).reduce((a, b) => a + b, 0);
    c.remaining = c.queued + c.sending + this.db.prepare('SELECT COUNT(*) AS n FROM email_recipients WHERE campaign_id = ? AND state = ? AND attempts < ? AND retry_at IS NOT NULL').get(Number(id), 'failed', MAX_ATTEMPTS).n;
    return c;
  }

  sentToday(accountId, campaignId = null, now = this.clock()) {
    const day = dayOf(now);
    if (campaignId && accountId) return this.db.prepare("SELECT COUNT(*) AS n FROM email_recipients WHERE campaign_id = ? AND sent_account = ? AND state = 'sent' AND sent_day = ?").get(Number(campaignId), accountId, day).n;
    if (campaignId) return this.db.prepare("SELECT COUNT(*) AS n FROM email_recipients WHERE campaign_id = ? AND state = 'sent' AND sent_day = ?").get(Number(campaignId), day).n;
    return this.db.prepare("SELECT COUNT(*) AS n FROM email_recipients r JOIN email_campaigns c ON c.id = r.campaign_id WHERE c.account_id = ? AND r.state = 'sent' AND r.sent_day = ?").get(accountId, day).n;
  }

  // --- campaigns ------------------------------------------------------------------

  create({ name = '', accountId = null, subject = '', body = '' } = {}) {
    const n = String(name || '').trim().slice(0, 80) || `Email campaign ${this.ids().length + 1}`;
    const now = this.clock();
    const r = this.db.prepare('INSERT INTO email_campaigns (name, status, account_id, subject, body, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(n, 'draft', null, '', '', JSON.stringify(DEFAULTS), now, now);
    const id = Number(r.lastInsertRowid);
    this.log(id, 'info', 'Campaign created');
    if (accountId || subject || body) {
      const u = this.update(id, { accountId, subject, body });
      if (!u.ok) return u;
    }
    this.emit('change', { id });
    return { ok: true, id, campaign: this.summary(id) };
  }

  // patch: { name, accountId, subject, body, delaySeconds, dailyLimit, allowPrevious, attachments: [fileId] }.
  update(id, patch = {}) {
    const c = this.row(id);
    if (!c) return { ok: false, error: 'That email campaign no longer exists.' };
    // While it runs, only its sending accounts can change (added or removed).
    if (c.status === 'running' && Object.keys(patch).some((k) => patch[k] !== undefined && k !== 'accountIds')) return { ok: false, error: 'Pause the campaign before changing it (sending accounts can be added while it runs).' };
    const fields = {};
    const config = { ...c.config };
    if (patch.accountIds !== undefined) {
      const ids = [...new Set((Array.isArray(patch.accountIds) ? patch.accountIds : []).map(String))].slice(0, 50);
      const missing = ids.find((x) => !this.accounts.get(x));
      if (missing) return { ok: false, error: 'One of the chosen email accounts does not exist.' };
      if (c.status === 'running' && !ids.length) return { ok: false, error: 'A running campaign needs at least one sending account.' };
      config.accountIds = ids;
      fields.accountId = ids[0] || null;
      config.senderDown = Object.fromEntries(Object.entries(config.senderDown || {}).filter(([k]) => ids.includes(k)));
      if (c.status === 'running') {
        const added = ids.filter((x) => !this.senders(c).includes(x));
        if (added.length) this.log(c.id, 'info', `Sending accounts added: ${added.map((x) => this.accounts.get(x).name).join(', ')}`);
      }
    }
    if (patch.name !== undefined) {
      const n = String(patch.name || '').trim().slice(0, 80);
      if (!n) return { ok: false, error: 'Give the campaign a name.' };
      fields.name = n;
    }
    if (patch.accountId !== undefined && patch.accountId !== null) {
      if (!this.accounts.get(String(patch.accountId))) return { ok: false, error: 'That email account does not exist.' };
      fields.accountId = String(patch.accountId);
      // One account chosen: it becomes the first sender (others kept).
      if (patch.accountIds === undefined) config.accountIds = [String(patch.accountId), ...(c.config.accountIds || []).filter((x) => x !== String(patch.accountId))];
    }
    if (patch.subject !== undefined) {
      const s = String(patch.subject || '').replace(/[\r\n]+/g, ' ').trim();
      if (s.length > 250) return { ok: false, error: 'The subject is too long (250 characters at most).' };
      fields.subject = s;
    }
    if (patch.body !== undefined) {
      const b = String(patch.body || '').replace(/\r\n/g, '\n');
      if (b.length > 100_000) return { ok: false, error: 'The email body is too long.' };
      fields.body = b;
    }
    if (patch.delaySeconds !== undefined) {
      const d = Math.round(Number(patch.delaySeconds));
      if (!Number.isFinite(d) || d < LIMITS.delay.min || d > LIMITS.delay.max) return { ok: false, error: `The delay between emails must be ${LIMITS.delay.min} to ${LIMITS.delay.max} seconds.` };
      config.delaySeconds = d;
    }
    if (patch.dailyLimit !== undefined) {
      const d = Math.round(Number(patch.dailyLimit));
      if (!Number.isFinite(d) || d < LIMITS.daily.min || d > LIMITS.daily.max) return { ok: false, error: `The daily limit must be ${LIMITS.daily.min} to ${LIMITS.daily.max} emails.` };
      config.dailyLimit = d;
    }
    if (patch.allowPrevious !== undefined) config.allowPrevious = Boolean(patch.allowPrevious);
    if (patch.aiWrite !== undefined) config.aiWrite = Boolean(patch.aiWrite);
    if (patch.trackClicks !== undefined) config.trackClicks = Boolean(patch.trackClicks);
    if (patch.attachments !== undefined) {
      const list = [];
      let bytes = 0;
      for (const fid of Array.isArray(patch.attachments) ? patch.attachments : []) {
        const id2 = typeof fid === 'string' ? fid : fid?.id;
        const f = this.files?.info(id2);
        if (!f) return { ok: false, error: 'An attached file is no longer available. Attach it again.' };
        if (list.some((x) => x.id === f.id)) continue;
        bytes += f.size;
        list.push({ id: f.id, name: f.name, mime: f.mime, size: f.size, kind: f.kind });
      }
      if (list.length > LIMITS.attachments) return { ok: false, error: `Up to ${LIMITS.attachments} attachments.` };
      if (bytes > LIMITS.attachmentBytes) return { ok: false, error: 'The attachments are larger than 20 MB in all; many email servers refuse that.' };
      config.attachments = list;
    }
    this.setFields(id, { ...fields, config });
    this.emit('change', { id });
    return { ok: true, campaign: this.summary(id) };
  }

  remove(id) {
    const c = this.row(id);
    if (!c) return { ok: false, error: 'That email campaign no longer exists.' };
    if (c.status === 'running') return { ok: false, error: 'Stop the campaign before deleting it.' };
    this.db.prepare('DELETE FROM email_recipients WHERE campaign_id = ?').run(c.id);
    this.db.prepare('DELETE FROM email_log WHERE campaign_id = ?').run(c.id);
    this.db.prepare('DELETE FROM email_clicks WHERE campaign_id = ?').run(c.id);
    this.db.prepare('DELETE FROM email_test_sends WHERE campaign_id = ?').run(c.id);
    this.db.prepare('DELETE FROM email_campaigns WHERE id = ?').run(c.id);
    this.emit('change', { id: c.id });
    return { ok: true };
  }

  // --- recipients ---------------------------------------------------------------

  isOptedOut(email) {
    return Boolean(this.db.prepare('SELECT 1 FROM email_optouts WHERE email = ?').get(String(email).toLowerCase()));
  }

  optOut(email, reason = 'Marked by you') {
    const e = String(email || '').trim().toLowerCase();
    if (!isEmail(e)) return { ok: false, error: 'Enter a valid email address.' };
    this.db.prepare('INSERT INTO email_optouts (email, reason, at) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING').run(e, String(reason).slice(0, 200), this.clock());
    // Not sent yet: skipped everywhere.
    this.db.prepare("UPDATE email_recipients SET state = 'skipped', error = 'Unsubscribed', updated_at = ? WHERE email = ? AND state IN ('queued', 'failed')").run(this.clock(), e);
    this.emit('change', { id: null });
    return { ok: true };
  }

  removeOptOut(email) {
    this.db.prepare('DELETE FROM email_optouts WHERE email = ?').run(String(email || '').trim().toLowerCase());
    this.emit('change', { id: null });
    return { ok: true };
  }

  optOuts() {
    return this.db.prepare('SELECT email, reason, at FROM email_optouts ORDER BY at DESC').all();
  }

  wasEmailed(email, exceptCampaign) {
    return Boolean(this.db.prepare("SELECT 1 FROM email_recipients WHERE email = ? AND campaign_id != ? AND state IN ('sent', 'uncertain', 'sending') LIMIT 1").get(email, Number(exceptCampaign)));
  }

  // Which leads of `list` can be added and why the others cannot.
  audience(id, list) {
    const c = this.row(id);
    const out = { ready: [], noEmail: 0, optedOut: 0, previous: 0, already: 0 };
    const seen = new Set();
    const inCampaign = new Set(this.db.prepare('SELECT email FROM email_recipients WHERE campaign_id = ?').all(c.id).map((r) => r.email));
    for (const lead of list) {
      const email = emailOf(lead);
      if (!email) {
        out.noEmail++;
        continue;
      }
      if (seen.has(email) || inCampaign.has(email)) {
        out.already++;
        continue;
      }
      seen.add(email);
      if (this.isOptedOut(email)) out.optedOut++;
      else if (!c.config.allowPrevious && this.wasEmailed(email, c.id)) out.previous++;
      else out.ready.push({ lead, email });
    }
    return out;
  }

  // Leads matching a Leads-table filter: { category, date, from, to, search, ids, website, source }.
  preview(id, filter = {}) {
    const c = this.row(id);
    if (!c) return { ok: false, error: 'That email campaign no longer exists.' };
    const a = this.audience(id, this.leads(filter));
    return { ok: true, ready: a.ready.length, noEmail: a.noEmail, optedOut: a.optedOut, previous: a.previous, already: a.already, sample: a.ready.slice(0, 10).map(({ lead, email }) => ({ id: lead.id, name: lead.name, email })) };
  }

  // internal: a running category campaign picking up its new leads.
  // first: put at the top of the waiting list (sent before the others).
  addLeads(id, filter = {}, { internal = false, first = false } = {}) {
    const c = this.row(id);
    if (!c) return { ok: false, error: 'That email campaign no longer exists.' };
    if (c.status === 'running' && !internal) return { ok: false, error: 'Pause the campaign before adding recipients.' };
    const a = this.audience(id, this.leads(filter));
    const room = LIMITS.recipients - this.counts(id).total;
    const take = a.ready.slice(0, Math.max(0, room));
    const now = this.clock();
    const ins = this.db.prepare('INSERT INTO email_recipients (campaign_id, email, lead_id, name, business, state, priority, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (campaign_id, email) DO NOTHING');
    let added = 0;
    this.db.exec('BEGIN');
    try {
      for (const { lead, email } of take) {
        const v = valuesOf(lead);
        added += ins.run(c.id, email, lead.id ?? null, v.name, v.business, 'queued', first ? 1 : 0, now, now).changes;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    if (added) this.log(c.id, 'info', `${added} recipient${added === 1 ? '' : 's'} added`);
    if (c.status === 'completed' && added && !c.category) this.setFields(c.id, { status: 'paused', pauseReason: 'new_recipients' });
    this.emit('change', { id: c.id });
    return { ok: true, added, noEmail: a.noEmail, optedOut: a.optedOut, previous: a.previous, already: a.already, overLimit: a.ready.length - take.length, campaign: this.summary(c.id) };
  }

  // Addresses already on the waiting list moved to its top -> how many moved.
  putFirst(id, emails) {
    const up = this.db.prepare("UPDATE email_recipients SET priority = 1, updated_at = ? WHERE campaign_id = ? AND email = ? AND state = 'queued' AND priority = 0");
    const now = this.clock();
    let moved = 0;
    for (const e of emails) moved += up.run(now, Number(id), String(e).toLowerCase()).changes;
    if (moved) this.emit('change', { id: Number(id) });
    return moved;
  }

  // Only recipients not emailed yet can be removed.
  removeRecipient(id, email) {
    const r = this.db.prepare("DELETE FROM email_recipients WHERE campaign_id = ? AND email = ? AND state IN ('queued', 'failed', 'skipped')").run(Number(id), String(email || '').toLowerCase());
    this.emit('change', { id: Number(id) });
    return r.changes ? { ok: true } : { ok: false, error: 'Only recipients who were not emailed yet can be removed.' };
  }

  clearQueue(id) {
    const r = this.db.prepare("DELETE FROM email_recipients WHERE campaign_id = ? AND state = 'queued'").run(Number(id));
    this.emit('change', { id: Number(id) });
    return { ok: true, removed: r.changes };
  }

  // Failed recipients go back in the queue (uncertain ones only when asked:
  // they may have received the email).
  retryFailed(id, { includeUncertain = false } = {}) {
    const c = this.row(id);
    if (!c) return { ok: false, error: 'That email campaign no longer exists.' };
    const states = includeUncertain ? "('failed', 'uncertain')" : "('failed')";
    const r = this.db.prepare(`UPDATE email_recipients SET state = 'queued', attempts = 0, retry_at = NULL, error = NULL, updated_at = ? WHERE campaign_id = ? AND state IN ${states}`).run(this.clock(), c.id);
    if (r.changes) {
      this.log(c.id, 'info', `${r.changes} failed recipient${r.changes === 1 ? '' : 's'} queued again`);
      if (c.status === 'completed') this.setFields(c.id, { status: 'paused', pauseReason: 'retry' });
    }
    this.emit('change', { id: c.id });
    return { ok: true, requeued: r.changes, campaign: this.summary(c.id) };
  }

  // --- controls -----------------------------------------------------------------

  problems(c) {
    const errs = [];
    const senders = this.senders(c);
    if (!senders.length) errs.push('Choose the email account it sends from.');
    else {
      const noPass = senders.filter((id) => !this.accounts.public(this.accounts.get(id)).hasPassword);
      if (noPass.length === senders.length) errs.push('The password of its email account is not saved on this computer.');
    }
    if (c.config.aiWrite) {
      if (!this.writer || (this.writerReady && !this.writerReady())) errs.push('Writing with AI needs a Groq or OpenRouter key in Settings > AI.');
      if (!c.body.trim()) errs.push('Write the instructions for the AI (what you offer, the tone, the language).');
    } else {
      if (!c.subject.trim()) errs.push('Write the subject.');
      if (!c.body.trim()) errs.push('Write the email.');
    }
    return errs;
  }

  async start(id) {
    const c = this.row(id);
    if (!c) return { ok: false, error: 'That email campaign no longer exists.' };
    if (c.status === 'running') return { ok: true, campaign: this.summary(id) };
    const errs = this.problems(c);
    if (errs.length) return { ok: false, error: errs.join(' ') };
    if (c.category) this.syncQueue(c, true);
    const n = this.counts(id);
    if (!c.category && !n.queued && !n.remaining) return { ok: false, error: 'There is nobody left to email in this campaign: add recipients first.' };
    if (!(await this.canSend())) return { ok: false, error: 'Sending emails needs an active plan.' };
    this.setFields(id, { status: 'running', pauseReason: null, failures: 0, nextDueAt: this.clock(), startedAt: c.startedAt || this.clock(), finishedAt: null, config: { ...c.config, senderDown: {}, senderNext: {} } });
    this.log(id, 'info', c.status === 'paused' ? 'Resumed' : 'Started');
    this.emit('change', { id: c.id });
    this.kick();
    return { ok: true, campaign: this.summary(id) };
  }

  resume(id) {
    const c = this.row(id);
    if (!c) return Promise.resolve({ ok: false, error: 'That email campaign no longer exists.' });
    if (c.status !== 'paused') return Promise.resolve({ ok: false, error: 'The campaign is not paused.' });
    return this.start(id);
  }

  pause(id, reason = 'user') {
    const c = this.row(id);
    if (!c) return { ok: false, error: 'That email campaign no longer exists.' };
    if (c.status !== 'running') return { ok: true, campaign: this.summary(id) };
    this.setFields(id, { status: 'paused', pauseReason: reason });
    this.log(id, reason === 'user' ? 'info' : 'warn', reason === 'user' ? 'Paused' : `Paused: ${PAUSE_TEXT[reason] || reason}`);
    this.waiting.delete(c.id);
    this.emit('change', { id: c.id });
    return { ok: true, campaign: this.summary(id) };
  }

  stop(id) {
    const c = this.row(id);
    if (!c) return { ok: false, error: 'That email campaign no longer exists.' };
    if (['draft', 'stopped'].includes(c.status)) return { ok: true, campaign: this.summary(id) };
    this.setFields(id, { status: 'stopped', pauseReason: null, finishedAt: this.clock() });
    this.log(id, 'info', 'Stopped');
    this.waiting.delete(c.id);
    this.emit('change', { id: c.id });
    return { ok: true, campaign: this.summary(id) };
  }

  // A test email of the campaign to one address (the first recipient's
  // details, else none). Not counted as a campaign email.
  async sendTest(id, to) {
    const c = this.row(id);
    if (!c) return { ok: false, error: 'That email campaign no longer exists.' };
    const errs = this.problems(c);
    if (errs.length) return { ok: false, error: errs.join(' ') };
    const from = this.senders(c)[0];
    const address = String(to || this.accounts.get(from).email).trim().toLowerCase();
    if (!isEmail(address)) return { ok: false, error: 'Enter a valid email address for the test.' };
    const r = this.db.prepare('SELECT * FROM email_recipients WHERE campaign_id = ? ORDER BY added_at LIMIT 1').get(c.id);
    let msg;
    try {
      msg = c.config.aiWrite ? compose(await this.aiText(c, r || { email: address, name: null, business: null }, { save: false }), { name: r?.name || null, business: r?.business || null, email: r?.email || address }) : compose(c, { name: r?.name || null, business: r?.business || null, email: r?.email || address });
    } catch (err) {
      return { ok: false, error: `The AI could not write the test email: ${err.message}.` };
    }
    // Its links are tracked too: a click shows in the campaign's history.
    if (this.tracking(c)) msg = { ...msg, ...this.tracker.rewrite(msg, `test-${c.id}`) };
    try {
      const res = await this.accounts.send(from, { to: address, subject: `[Test] ${msg.subject}`, text: msg.text, html: msg.html, attachments: this.attachments(c) });
      // Kept so a reply to it reaches the Inbox (the last 200 tests).
      if (res?.messageId) {
        this.db.prepare('INSERT OR REPLACE INTO email_test_sends (message_id, campaign_id, account, email, subject, text, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(res.messageId, c.id, from, address, `[Test] ${msg.subject}`, String(msg.text || '').slice(0, 8000), this.clock());
        this.db.prepare('DELETE FROM email_test_sends WHERE message_id NOT IN (SELECT message_id FROM email_test_sends ORDER BY at DESC LIMIT 200)').run();
      }
      this.log(c.id, 'info', `Test email sent to ${address}`);
      this.emit('change', { id: c.id });
      return { ok: true, to: address };
    } catch (err) {
      this.log(c.id, 'error', `Test email to ${address} failed: ${err.message}`);
      return { ok: false, error: `The test email was not sent: ${err.message}.` };
    }
  }

  attachments(c) {
    if (!this.files) return [];
    return (c.config.attachments || []).map((a) => {
      const f = this.files.read(a.id);
      return { filename: f.name, content: f.data, contentType: f.mime.split(';')[0] };
    });
  }

  // --- scheduler -------------------------------------------------------------------

  init() {
    // Emails interrupted by a crash or shutdown: they may have gone out.
    const n = this.db.prepare("UPDATE email_recipients SET state = 'uncertain', error = 'Interrupted while sending; it may have been delivered', updated_at = ? WHERE state = 'sending'").run(this.clock()).changes;
    if (n) for (const r of this.db.prepare('SELECT DISTINCT campaign_id AS id FROM email_recipients WHERE state = ?').all('uncertain')) this.log(r.id, 'warn', 'An email was interrupted by a restart; it is not sent again automatically');
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
    this.kick();
  }

  dispose() {
    clearInterval(this.timer);
    this.timer = null;
  }

  kick() {
    setImmediate(() => this.tick());
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    const jobs = [];
    try {
      const running = this.db.prepare("SELECT id FROM email_campaigns WHERE status = 'running' ORDER BY COALESCE(next_due_at, 0), id").all().map((r) => this.row(r.id));
      const now = this.clock();
      for (const c of running) {
        if (c.category) this.syncQueue(c);
        const next = this.nextRecipients(c, now, 50);
        // Nobody left: completed at once (no delay to wait for). A category
        // campaign stays on and waits for the category's new leads.
        if (!next.length) {
          if (this.db.prepare("SELECT 1 FROM email_recipients WHERE campaign_id = ? AND state = 'sending' LIMIT 1").get(c.id)) continue;
          const n = this.counts(c.id);
          if (!n.remaining && c.category) {
            this.waiting.set(c.id, 'new_leads');
            continue;
          }
          if (!n.remaining) {
            this.setFields(c.id, { status: 'completed', pauseReason: null, finishedAt: now });
            this.log(c.id, 'info', `Completed: ${n.sent} sent, ${n.failed} failed${n.uncertain ? `, ${n.uncertain} uncertain` : ''}, ${n.skipped} skipped`);
            this.waiting.delete(c.id);
            this.emit('completed', { id: c.id, name: c.name, counts: n });
            this.emit('change', { id: c.id });
          } else this.waiting.set(c.id, 'retry_later');
          continue;
        }
        // Each sending account in turn: its own delay and daily limit; one
        // email at a time per account (across campaigns).
        const why = new Set();
        // The sending accounts in a random order each round (none is always first).
        const order = this.senders(c);
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(this.random() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
        for (const acc of order) {
          if (!next.length) break;
          if (c.config.senderDown?.[acc]) {
            why.add('accounts_failing');
            continue;
          }
          if (this.busy.has(acc)) {
            why.add('delay');
            continue;
          }
          if ((c.config.senderNext?.[acc] || 0) > now) {
            why.add('delay');
            continue;
          }
          if (this.sentToday(acc, c.id, now) >= c.config.dailyLimit) {
            why.add('daily_limit');
            continue;
          }
          const r = next.shift();
          this.busy.add(acc);
          jobs.push(
            this.sendOne(c, r, acc)
              .catch((err) => this.emit('error', err))
              .finally(() => this.busy.delete(acc)),
          );
        }
        if (!jobs.length) this.waiting.set(c.id, why.has('delay') ? 'delay' : why.has('daily_limit') ? 'daily_limit' : why.has('accounts_failing') ? 'accounts_failing' : 'delay');
        else this.waiting.delete(c.id);
      }
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.ticking = false;
    }
    await Promise.all(jobs);
  }

  nextRecipients(c, now, n) {
    return [
      ...this.db.prepare("SELECT * FROM email_recipients WHERE campaign_id = ? AND state = 'queued' ORDER BY priority DESC, added_at, email LIMIT ?").all(c.id, n),
      ...this.db.prepare("SELECT * FROM email_recipients WHERE campaign_id = ? AND state = 'failed' AND attempts < ? AND retry_at IS NOT NULL AND retry_at <= ? ORDER BY retry_at LIMIT ?").all(c.id, MAX_ATTEMPTS, now, n),
    ].slice(0, n);
  }

  nextRecipient(c, now) {
    return (
      this.db.prepare("SELECT * FROM email_recipients WHERE campaign_id = ? AND state = 'queued' ORDER BY priority DESC, added_at, email LIMIT 1").get(c.id) ||
      this.db.prepare("SELECT * FROM email_recipients WHERE campaign_id = ? AND state = 'failed' AND attempts < ? AND retry_at IS NOT NULL AND retry_at <= ? ORDER BY retry_at LIMIT 1").get(c.id, MAX_ATTEMPTS, now) ||
      null
    );
  }

  async sendOne(c, r, accountId = this.senders(c)[0]) {
    const now = this.clock();
    const set = (fields) => {
      const cols = Object.keys(fields);
      this.db.prepare(`UPDATE email_recipients SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE campaign_id = ? AND email = ?`).run(...cols.map((k) => fields[k]), this.clock(), c.id, r.email);
    };
    // Checked again right before sending.
    if (this.isOptedOut(r.email)) return set({ state: 'skipped', error: 'Unsubscribed' });
    if (!c.config.allowPrevious && this.wasEmailed(r.email, c.id)) return set({ state: 'skipped', error: 'Already emailed by another campaign' });
    if (!(await this.canSend())) return this.pause(c.id, 'subscription');
    // Written by the AI first (nothing is reserved if that fails).
    let text = null;
    if (c.config.aiWrite) {
      try {
        text = await this.aiText(c, r);
        this.aiFailures.delete(c.id);
      } catch (err) {
        const n = (this.aiFailures.get(c.id) || 0) + 1;
        this.aiFailures.set(c.id, n);
        this.log(c.id, 'error', `AI could not write the email for ${r.email}: ${err.message}`);
        this.patchConfig(c.id, (cfg) => (cfg.senderNext = { ...(cfg.senderNext || {}), [accountId]: now + Math.max(30, c.config.delaySeconds) * 1000 }));
        if (['no_key', 'invalid_key', 'credits'].includes(err.code) || n >= 3) {
          this.aiFailures.delete(c.id);
          this.pause(c.id, 'ai');
        }
        this.emit('change', { id: c.id });
        return;
      }
    }
    // Reserved: from here on, it is never sent twice.
    const reserved = this.db.prepare("UPDATE email_recipients SET state = 'sending', attempts = attempts + 1, updated_at = ? WHERE campaign_id = ? AND email = ? AND state IN ('queued', 'failed')").run(now, c.id, r.email).changes;
    if (!reserved) return;
    this.patchConfig(c.id, (cfg) => (cfg.senderNext = { ...(cfg.senderNext || {}), [accountId]: now + c.config.delaySeconds * 1000 }));
    this.setFields(c.id, { nextDueAt: now + c.config.delaySeconds * 1000 });
    let msg = text ? compose({ subject: text.subject, body: text.body }, { name: r.name, business: r.business, email: r.email }) : compose(c, { name: r.name, business: r.business, email: r.email });
    if (this.tracking(c)) {
      const t = r.track_id || newTrackId();
      if (!r.track_id) set({ track_id: t });
      msg = { ...msg, ...this.tracker.rewrite(msg, t) };
    }
    const account = this.accounts.get(accountId);
    try {
      const res = await this.accounts.send(accountId, {
        to: r.email,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        attachments: this.attachments(c),
        headers: { 'List-Unsubscribe': `<mailto:${account.email}?subject=unsubscribe>` },
      });
      if (res.rejected?.length) throw Object.assign(new Error('the email server refused this address'), { code: 'EENVELOPE' });
      const at = this.clock();
      set({ state: 'sent', error: null, message_id: res.messageId || null, sent_at: at, sent_day: dayOf(at), retry_at: null, sent_account: accountId });
      this.setFields(c.id, { failures: 0 });
      this.emit('sent', { id: c.id, email: r.email });
    } catch (err) {
      const code = err?.code || '';
      const latest = this.row(c.id);
      if (['EAUTH', 'ECONNECTION', 'EDNS', 'no_password', 'no_account'].includes(code) || err.message === 'the email server could not be reached') {
        // Nothing was handed to the server: back in the queue. This account
        // stops sending for the campaign; the others go on. With none left,
        // the campaign waits for the user.
        set({ state: r.state === 'failed' ? 'failed' : 'queued', attempts: r.attempts });
        this.patchConfig(c.id, (cfg) => (cfg.senderDown = { ...(cfg.senderDown || {}), [accountId]: err.message }));
        const now2 = this.row(c.id);
        const left = this.senders(now2).filter((x) => !now2.config.senderDown?.[x]);
        const name = account?.name || accountId;
        if (left.length) {
          this.log(c.id, 'error', `${name}: ${err.message}; the other account${left.length === 1 ? '' : 's'} keep${left.length === 1 ? 's' : ''} sending`);
          this.emit('failed', { id: c.id, email: r.email, error: `${name}: ${err.message}`, paused: false });
          return;
        }
        this.log(c.id, 'error', `Paused: ${name}: ${err.message}`);
        if (latest?.status === 'running') this.pause(c.id, code === 'EAUTH' ? 'login' : 'connection');
        this.emit('failed', { id: c.id, email: r.email, error: err.message, paused: true });
        return;
      }
      const timeout = ['ETIMEDOUT', 'ESOCKET'].includes(code);
      const attempts = r.attempts + 1;
      const permanent = code === 'EENVELOPE' || (err.responseCode >= 500 && err.responseCode < 600);
      if (timeout) set({ state: 'uncertain', error: `${err.message} (it may still have been delivered)` });
      else set({ state: 'failed', error: err.message, retry_at: !permanent && attempts < MAX_ATTEMPTS ? this.clock() + RETRY_AFTER : null });
      const failures = (latest?.failures || 0) + 1;
      this.setFields(c.id, { failures });
      this.log(c.id, 'error', `${r.email}: ${err.message}`);
      this.emit('failed', { id: c.id, email: r.email, error: err.message, paused: failures >= 3 });
      if (failures >= 3 && latest?.status === 'running') this.pause(c.id, 'errors');
    } finally {
      this.emit('change', { id: c.id });
    }
  }

  // --- category campaigns ------------------------------------------------------------

  // The category's leads with an email that are not in its campaign yet.
  syncQueue(c, force = false) {
    const now = this.clock();
    if (!force && now - (this.syncedAt.get(c.id) || 0) < SYNC_EVERY) return 0;
    this.syncedAt.set(c.id, now);
    const r = this.addLeads(c.id, { category: c.category }, { internal: true });
    return r.added || 0;
  }

  campaignForCategory(key) {
    const r = this.db.prepare('SELECT id FROM email_campaigns WHERE category = ? ORDER BY id LIMIT 1').get(String(key));
    return r ? this.row(r.id) : null;
  }

  // The category's campaign, created (off) the first time it is opened.
  categoryCampaign(key, name) {
    const existing = this.campaignForCategory(key);
    if (existing) return { ok: true, id: existing.id };
    const r = this.create({ name: `${name} · email` });
    if (!r.ok) return r;
    this.db.prepare('UPDATE email_campaigns SET category = ? WHERE id = ?').run(String(key), r.id);
    this.emit('change', { id: r.id });
    return { ok: true, id: r.id };
  }

  // Every category with leads that have an email: { key, name, withEmail, notEmailed, campaign }.
  categoryStats(categories) {
    const leads = this.leads({});
    const emailed = new Set(this.db.prepare("SELECT DISTINCT email FROM email_recipients WHERE state IN ('sent', 'uncertain', 'sending')").all().map((r) => r.email));
    const out = new Map(categories.map((c) => [String(c.id), { key: String(c.id), name: c.name, withEmail: 0, notEmailed: 0 }]));
    out.set('none', { key: 'none', name: 'Uncategorized', withEmail: 0, notEmailed: 0 });
    for (const l of leads) {
      const e = emailOf(l);
      if (!e) continue;
      const row = out.get(l.categoryId == null ? 'none' : String(l.categoryId));
      if (!row) continue;
      row.withEmail++;
      if (!emailed.has(e) && !this.isOptedOut(e)) row.notEmailed++;
    }
    // Campaigns of categories with no emails left (or deleted categories):
    // removed when they never sent anything and are not on; kept (hidden) otherwise.
    for (const r of this.db.prepare('SELECT id, category FROM email_campaigns WHERE category IS NOT NULL').all()) {
      if ((out.get(r.category)?.withEmail || 0) > 0) continue;
      const c = this.row(r.id);
      const n = this.counts(r.id);
      if (!['running', 'paused'].includes(c.status) && !n.sent && !n.uncertain && !n.sending) this.remove(r.id);
    }
    return [...out.values()]
      .filter((x) => x.withEmail > 0)
      .map((x) => {
        const c = this.campaignForCategory(x.key);
        return { ...x, campaign: c ? this.summary(c) : null };
      });
  }

  // ON: the campaign runs and keeps adding the category's new leads; OFF: stopped.
  async setCategoryEnabled(key, name, on) {
    const cc = this.categoryCampaign(key, name);
    if (!cc.ok) return cc;
    return on ? this.start(cc.id) : this.stop(cc.id);
  }

  // --- AI-written emails -------------------------------------------------------------

  // What the AI may use about a business (only what the lead has).
  leadDetails(r) {
    const l = r.lead_id != null ? this.leadById(r.lead_id) : null;
    return leadFacts(l, { business: r.business, name: r.name, email: r.email });
  }

  // The AI's email for a recipient: written once, kept, reused on retries.
  async aiText(c, r, { save = true } = {}) {
    if (r.ai_body) return { subject: r.ai_subject || c.subject, body: r.ai_body };
    if (!this.writer) throw Object.assign(new Error('no AI key is saved'), { code: 'no_key' });
    const sender = this.accounts.get(this.senders(c)[0]);
    const out = await this.writer({ instructions: c.body, subject: '', sender: { name: sender?.senderName || sender?.name || '', email: sender?.email || '' }, business: this.leadDetails(r) });
    const subject = String(out?.subject || c.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
    const body = String(out?.body || '').trim().slice(0, 8000);
    if (!subject || body.length < 20) throw Object.assign(new Error('the AI did not write a usable email'), { code: 'ai_empty' });
    if (save) this.db.prepare('UPDATE email_recipients SET ai_subject = ?, ai_body = ? WHERE campaign_id = ? AND email = ?').run(subject, body, c.id, r.email);
    return { subject, body };
  }

  // --- replies -----------------------------------------------------------------------

  // The latest campaign email to an address: { campaignId, campaignName, leadId, name, business, text, subject }.
  lastSentTo(email) {
    const r = this.db.prepare("SELECT r.*, c.name AS campaign_name, c.subject AS c_subject, c.body AS c_body FROM email_recipients r JOIN email_campaigns c ON c.id = r.campaign_id WHERE r.email = ? AND r.state IN ('sent', 'uncertain') ORDER BY r.sent_at DESC LIMIT 1").get(String(email || '').toLowerCase());
    if (!r) return null;
    const msg = r.ai_body ? { subject: r.ai_subject, text: r.ai_body } : compose({ subject: r.c_subject, body: r.c_body }, { name: r.name, business: r.business, email: r.email });
    return { campaignId: r.campaign_id, campaignName: r.campaign_name, leadId: r.lead_id, name: r.name || r.business || null, business: r.business, subject: msg.subject, text: String(msg.text).split('\n--\n')[0] };
  }

  // Test emails were sent from this account (a reply to one goes to the Inbox).
  hasTestSends(accountId) {
    return Boolean(this.db.prepare('SELECT 1 FROM email_test_sends WHERE account = ? LIMIT 1').get(accountId));
  }

  // The campaign (or test) email one of these Message-IDs names (a reply's
  // In-Reply-To / References): { email, campaignId, campaignName, test, ... } or null.
  sentByMessageId(ids) {
    for (const id of [...(ids || [])].reverse()) {
      const r = this.db.prepare("SELECT r.email, r.campaign_id AS campaignId, c.name AS campaignName FROM email_recipients r JOIN email_campaigns c ON c.id = r.campaign_id WHERE r.message_id = ? AND r.state IN ('sent', 'uncertain') LIMIT 1").get(id);
      if (r) return { ...r, test: false };
      const t = this.db.prepare('SELECT t.email, t.campaign_id AS campaignId, c.name AS campaignName, t.subject, t.text FROM email_test_sends t LEFT JOIN email_campaigns c ON c.id = t.campaign_id WHERE t.message_id = ?').get(id);
      if (t) return { ...t, test: true };
    }
    return null;
  }

  // Addresses this account has emailed (for matching replies in its inbox).
  sentAddresses(accountId) {
    return new Set(this.db.prepare("SELECT DISTINCT r.email FROM email_recipients r JOIN email_campaigns c ON c.id = r.campaign_id WHERE COALESCE(r.sent_account, c.account_id) = ? AND r.state IN ('sent', 'uncertain')").all(accountId).map((r) => r.email));
  }

  // A reply from someone this account emailed: recorded on their latest
  // email; an unsubscribe request opts them out of every campaign.
  recordReply(email, { subject = '', unsubscribe = false, at = this.clock() } = {}) {
    const e = String(email || '').trim().toLowerCase();
    const r = this.db.prepare("SELECT campaign_id AS id, replied_at AS repliedAt FROM email_recipients WHERE email = ? AND state IN ('sent', 'uncertain') ORDER BY sent_at DESC LIMIT 1").get(e);
    if (!r) return { ok: false };
    const first = !r.repliedAt;
    if (first) {
      this.db.prepare('UPDATE email_recipients SET replied_at = ?, reply_subject = ? WHERE campaign_id = ? AND email = ?').run(at, String(subject).slice(0, 200), r.id, e);
      this.log(r.id, 'info', `${e} replied${subject ? `: “${String(subject).slice(0, 80)}”` : ''}`);
    }
    let unsubscribed = false;
    if (unsubscribe && !this.isOptedOut(e)) {
      this.optOut(e, 'Replied asking to unsubscribe');
      this.log(r.id, 'warn', `${e} asked to unsubscribe: never emailed again`);
      unsubscribed = true;
    }
    this.emit('change', { id: r.id });
    return { ok: true, first, unsubscribed, campaignId: r.id };
  }

  // Links in this campaign's emails are tracked now.
  tracking(c) {
    return Boolean(this.tracker?.active && c.config.trackClicks !== false);
  }

  // A click fetched from the tracking address: { id, t, url, at, ua, bot }.
  // Kept once (by its id); clicks by link scanners are kept but not counted.
  // Resolves { recorded: true } for a person's click.
  recordClick({ id, t, url, at, ua = '', bot = false }) {
    const test = /^test-(\d+)$/.exec(t);
    if (test) {
      const c = this.row(Number(test[1]));
      if (!c || this.db.prepare('SELECT 1 FROM email_clicks WHERE id = ?').get(id)) return { recorded: false };
      this.db.prepare('INSERT INTO email_clicks (id, campaign_id, email, url, at, ua, bot) VALUES (?, ?, ?, ?, ?, ?, 1)').run(id, c.id, '(test email)', url, at, ua);
      this.log(c.id, 'info', `Test email: link clicked (${url.slice(0, 120)})`);
      this.emit('change', { id: c.id });
      return { recorded: false, test: true };
    }
    const r = this.db.prepare('SELECT campaign_id, email, name, business, lead_id, sent_at, clicked_at FROM email_recipients WHERE track_id = ?').get(t);
    if (!r) return { recorded: false };
    const scanner = bot || (r.sent_at && at - r.sent_at >= 0 && at - r.sent_at < SCANNER_WINDOW);
    const added = this.db.prepare('INSERT OR IGNORE INTO email_clicks (id, campaign_id, email, url, at, ua, bot) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, r.campaign_id, r.email, url, at, ua, scanner ? 1 : 0).changes;
    if (!added || scanner) return { recorded: false };
    const first = !r.clicked_at;
    this.db.prepare('UPDATE email_recipients SET clicks = clicks + 1, clicked_at = COALESCE(clicked_at, ?) WHERE campaign_id = ? AND email = ?').run(at, r.campaign_id, r.email);
    if (first) this.log(r.campaign_id, 'info', `${r.email} clicked ${url.slice(0, 120)}`);
    this.emit('clicked', { id: r.campaign_id, email: r.email, name: r.name || r.business || null, business: r.business, leadId: r.lead_id, url, at, first });
    this.emit('change', { id: r.campaign_id });
    return { recorded: true, first };
  }

  // Who clicked (people only), latest first.
  clickers(id, limit = 20) {
    return this.db.prepare('SELECT email, name, business, clicks, clicked_at AS firstClickAt FROM email_recipients WHERE campaign_id = ? AND clicked_at IS NOT NULL ORDER BY clicked_at DESC LIMIT ?').all(Number(id), limit);
  }

  // A recipient's clicks (people only), latest first.
  clicksOf(id, email) {
    return this.db.prepare('SELECT url, at FROM email_clicks WHERE campaign_id = ? AND email = ? AND bot = 0 ORDER BY at DESC LIMIT 20').all(Number(id), String(email));
  }

  // --- for the window and the assistant -------------------------------------------

  summary(id) {
    const c = typeof id === 'object' ? id : this.row(id);
    if (!c) return null;
    const n = this.counts(c.id);
    const account = c.accountId ? this.accounts.get(c.accountId) : null;
    const senders = this.senders(c).map((id) => ({ id, name: this.accounts.get(id).name, email: this.accounts.get(id).email, down: c.config.senderDown?.[id] || null, sentToday: this.sentToday(id, c.id) }));
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      pauseReason: c.pauseReason,
      pauseText: c.pauseReason ? PAUSE_TEXT[c.pauseReason] || c.pauseReason : null,
      waiting: c.status === 'running' ? this.waiting.get(c.id) || null : null,
      accountId: c.accountId,
      accountName: senders.length > 1 ? `${senders.length} accounts` : account?.name || senders[0]?.name || null,
      accountIds: senders.map((x) => x.id),
      senders,
      category: c.category,
      aiWrite: Boolean(c.config.aiWrite),
      subject: c.subject,
      delaySeconds: c.config.delaySeconds,
      dailyLimit: c.config.dailyLimit,
      attachments: c.config.attachments || [],
      counts: n,
      sentToday: this.sentToday(null, c.id),
      replies: this.db.prepare('SELECT COUNT(*) AS n FROM email_recipients WHERE campaign_id = ? AND replied_at IS NOT NULL').get(c.id).n,
      clicks: this.db.prepare('SELECT COUNT(*) AS n FROM email_recipients WHERE campaign_id = ? AND clicked_at IS NOT NULL').get(c.id).n,
      trackClicks: c.config.trackClicks !== false,
      tracking: this.tracking(c),
      nextDueAt: c.nextDueAt,
      createdAt: c.createdAt,
      startedAt: c.startedAt,
      finishedAt: c.finishedAt,
    };
  }

  list() {
    return this.ids().map((id) => this.summary(id));
  }

  snapshot(id, { recipients = 500 } = {}) {
    const c = this.row(id);
    if (!c) return null;
    return {
      ...this.summary(c),
      body: c.body,
      allowPrevious: c.config.allowPrevious,
      problems: this.problems(c),
      recipients: this.db.prepare('SELECT email, lead_id AS leadId, name, business, state, attempts, error, sent_at AS sentAt, retry_at AS retryAt, replied_at AS repliedAt, clicked_at AS clickedAt, clicks, priority, ai_subject AS aiSubject, ai_body AS aiBody FROM email_recipients WHERE campaign_id = ? ORDER BY CASE state WHEN \'sending\' THEN 0 WHEN \'failed\' THEN 1 WHEN \'uncertain\' THEN 2 WHEN \'queued\' THEN 3 ELSE 4 END, CASE WHEN state = \'queued\' THEN -priority ELSE 0 END, CASE WHEN state = \'queued\' THEN added_at ELSE -updated_at END, email LIMIT ?').all(c.id, recipients),
      log: this.db.prepare('SELECT at, level, text FROM email_log WHERE campaign_id = ? ORDER BY id DESC LIMIT 100').all(c.id),
      limits: LIMITS,
    };
  }

  failedRecipients(id, limit = 50) {
    return this.db.prepare("SELECT email, name, state, attempts, error FROM email_recipients WHERE campaign_id = ? AND state IN ('failed', 'uncertain') ORDER BY updated_at DESC LIMIT ?").all(Number(id), limit);
  }

  // Preview of the email for the first recipient (or a sample lead).
  // With AI writing on: the AI's email for the first recipient (not kept).
  async render(id, { subject, body } = {}) {
    const c = this.row(id);
    if (!c) return { ok: false, error: 'That email campaign no longer exists.' };
    const r = this.db.prepare("SELECT * FROM email_recipients WHERE campaign_id = ? ORDER BY CASE WHEN state = 'queued' THEN 0 ELSE 1 END, priority DESC, added_at LIMIT 1").get(c.id);
    if (c.config.aiWrite) {
      if (!r) return { ok: false, error: 'Add recipients first: the AI writes for a real business.' };
      try {
        const t = await this.aiText({ ...c, subject: subject ?? c.subject, body: body ?? c.body }, { ...r, ai_body: null }, { save: false });
        return { ok: true, to: r.email, ai: true, ...compose(t, { name: r.name, business: r.business, email: r.email }) };
      } catch (err) {
        return { ok: false, error: `The AI could not write it: ${err.message}.` };
      }
    }
    const msg = compose({ subject: subject ?? c.subject, body: body ?? c.body }, { name: r?.name || null, business: r?.business || null, email: r?.email || 'recipient@example.com' });
    return { ok: true, to: r?.email || null, ...msg };
  }
}

const PAUSE_TEXT = {
  user: 'paused by you',
  login: 'the email account rejected the login; check its password',
  accounts_failing: 'its email accounts are failing',
  ai: 'the AI could not write the emails (check Settings > AI)',
  connection: 'the email server could not be reached',
  errors: 'three emails in a row failed',
  subscription: 'sending needs an active plan',
  shutdown: 'Lead Finder was closed',
  new_recipients: 'new recipients were added',
  retry: 'failed recipients were queued again',
};

module.exports = { EmailCampaigns, compose, render, emailOf, valuesOf, textToHtml, htmlToText, cleanHtml, dayOf, DEFAULTS, LIMITS, MAX_ATTEMPTS, UNSUBSCRIBE_TEXT };
