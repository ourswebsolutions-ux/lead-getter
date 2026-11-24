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
const { chooseEmail } = require('./verification');
const { checkFollowups, checkSchedule, inWindow, nextWindow, pauseMs, withSignature, FOLLOWUP_DEFAULTS, SCHEDULE_DEFAULTS, DAY } = require('./sequence');

// How a verification result is named in a recipient's reason.
const VERIFY_LABEL = { valid: 'Valid', invalid: 'Invalid', risky: 'Risky', unknown: 'Unknown', catch_all: 'Catch-all' };

// accountIds: the accounts it sends from, in turn (each with its own delay and daily limit).
// aiWrite: each email written by the AI from the body (the user's instructions)
// and the business's details; the text is kept on the recipient.
// trackClicks: links go through the user's click tracking address (tracking.js), when it is set up.
// followups: steps after the first email; schedule: sending days/hours; delayMaxSeconds: a random
// pause up to this; maxPerDay: the campaign's emails a day (all accounts); signature: every email ends with it.
const DEFAULTS = { delaySeconds: 60, delayMaxSeconds: null, dailyLimit: 100, maxPerDay: null, allowPrevious: false, attachments: [], html: null, accountIds: [], senderNext: {}, senderDown: {}, aiWrite: false, trackClicks: true, followups: FOLLOWUP_DEFAULTS, schedule: SCHEDULE_DEFAULTS, signature: '' };
const SYNC_EVERY = 60_000; // category campaigns look for new leads with an email
const LIMITS = { delay: { min: 10, max: 3600 }, daily: { min: 1, max: 2000 }, attachments: 10, attachmentBytes: 20 * 1024 * 1024, recipients: 20_000 };
const MAX_ATTEMPTS = 3;
const RETRY_AFTER = 15 * 60_000; // a temporary failure: tried again after 15, then 30 minutes (doubling)

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
CREATE TABLE IF NOT EXISTS email_followups (
  campaign_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  step INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  due_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER,
  error TEXT,
  subject TEXT,
  body TEXT,
  message_id TEXT,
  sent_account TEXT,
  sent_at INTEGER,
  sent_day TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, email, step)
);
CREATE INDEX IF NOT EXISTS email_followups_due ON email_followups (campaign_id, state, due_at);
CREATE INDEX IF NOT EXISTS email_followups_msgid ON email_followups (message_id);
CREATE INDEX IF NOT EXISTS email_followups_day ON email_followups (sent_day);
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
// signature: the sender's sign-off, added at the end unless the body already ends with it.
function compose({ subject, body }, values, signature = '') {
  const s = render(subject, values).replace(/[\r\n]+/g, ' ').trim();
  const raw = render(body, values);
  const b = signature && !looksHtml(raw) ? withSignature(raw, signature) : raw;
  const sigHtml = signature && looksHtml(raw) ? `<p>${esc(signature).replace(/\n/g, '<br>')}</p>` : '';
  const html = (looksHtml(b) ? cleanHtml(b) : textToHtml(b)) + sigHtml;
  const text = looksHtml(b) ? withSignature(htmlToText(b), signature) : b;
  return {
    subject: s,
    text: `${text.trim()}\n\n--\n${UNSUBSCRIBE_TEXT}`,
    html: `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2328">${html}<hr style="border:none;border-top:1px solid #ddd;margin:24px 0 12px"><p style="font-size:12px;color:#666">${esc(UNSUBSCRIBE_TEXT)}</p></body></html>`,
  };
}

// A lead's address to email: its main email, else the first valid one of
// the others. '' when it has none.
// Every usable address of a lead, best first.
function emailsOf(lead) {
  const all = [lead.email, ...(Array.isArray(lead.emails) ? lead.emails.map((e) => (typeof e === 'string' ? e : e?.email)) : [])];
  return [...new Set(all.map((e) => String(e || '').trim().toLowerCase()).filter((e) => isEmail(e) && !/@(example\.(com|org|net)|sentry\.io|wixpress\.com)$/i.test(e) && !/\.(png|jpe?g|gif|webp|svg)$/i.test(e)))];
}

function emailOf(lead) {
  return emailsOf(lead)[0] || '';
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

// The mail server refused the address itself (not the sender, not the connection).
function isRecipientRefusal(err) {
  const t = `${err?.responseCode || ''} ${err?.response || ''} ${err?.message || ''}`;
  return (err?.code === 'EENVELOPE' && !(err.responseCode >= 400 && err.responseCode < 500)) || (/\b55[0-3]\b/.test(t) && /\b5\.1\.\d\b|user unknown|unknown user|no such (user|mailbox)|does not exist|mailbox (unavailable|not found)|recipient (rejected|unknown|not found)|address rejected|invalid recipient/i.test(t) && !/spam|block|policy|reputation|spamhaus/i.test(t));
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
    // verify_skip 1: skipped because its email did not pass verification (back in the queue if it later does).
    for (const col of ['replied_at INTEGER', 'reply_subject TEXT', 'sent_account TEXT', 'ai_subject TEXT', 'ai_body TEXT', 'track_id TEXT', 'clicked_at INTEGER', 'clicks INTEGER NOT NULL DEFAULT 0', 'priority INTEGER NOT NULL DEFAULT 0', 'verify_skip INTEGER NOT NULL DEFAULT 0', 'sent_subject TEXT', 'sent_text TEXT', 'bounced_at INTEGER', 'bounce_reason TEXT', 'stopped_at INTEGER', 'interest TEXT', 'auto_reply_at INTEGER']) {
      try {
        this.db.exec(`ALTER TABLE email_recipients ADD COLUMN ${col}`);
      } catch {} // already there
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS email_recipients_track ON email_recipients (track_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS email_recipients_msgid ON email_recipients (message_id)');
    this.tracker = null; // ClickTracker (service.js)
    // EmailVerification (service.js): nobody is emailed without it, and only
    // addresses whose verification the user allows (valid, by default).
    this.verification = null;
    // A category campaign: the category's leads with an email, added as they come.
    try {
      this.db.exec('ALTER TABLE email_campaigns ADD COLUMN category TEXT');
    } catch {}
    this.syncedAt = new Map();
    this.aiFailures = new Map();
    this.busy = new Set(); // SMTP accounts sending right now
    this.sendingNow = new Set(); // campaigns with an email on its way right now
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

  // Emails sent today (first emails and follow-ups): by an account in a
  // campaign, by a campaign, or by an account in all campaigns.
  sentToday(accountId, campaignId = null, now = this.clock()) {
    const day = dayOf(now);
    const count = (where, params) =>
      this.db.prepare(`SELECT COUNT(*) AS n FROM email_recipients WHERE state = 'sent' AND sent_day = ? AND ${where}`).get(day, ...params).n +
      this.db.prepare(`SELECT COUNT(*) AS n FROM email_followups WHERE state = 'sent' AND sent_day = ? AND ${where}`).get(day, ...params).n;
    if (campaignId && accountId) return count('campaign_id = ? AND sent_account = ?', [Number(campaignId), accountId]);
    if (campaignId) return count('campaign_id = ?', [Number(campaignId)]);
    return count('sent_account = ?', [accountId]);
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
    // While it runs, only its sending accounts, follow-ups, schedule and daily maximum can change.
    const live = ['accountIds', 'followups', 'schedule', 'maxPerDay'];
    if (c.status === 'running' && Object.keys(patch).some((k) => patch[k] !== undefined && !live.includes(k))) return { ok: false, error: 'Pause the campaign before changing it (sending accounts, follow-ups and the schedule can be changed while it runs).' };
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
    if (patch.delayMaxSeconds !== undefined) {
      if (patch.delayMaxSeconds === null || patch.delayMaxSeconds === '' || Number(patch.delayMaxSeconds) === 0) config.delayMaxSeconds = null;
      else {
        const d = Math.round(Number(patch.delayMaxSeconds));
        const min = config.delaySeconds;
        if (!Number.isFinite(d) || d < min || d > LIMITS.delay.max) return { ok: false, error: `The random pause must be from the delay (${Math.round(min / 6) / 10} min) up to ${LIMITS.delay.max / 60} minutes.` };
        config.delayMaxSeconds = d === min ? null : d;
      }
    }
    if (config.delayMaxSeconds && config.delayMaxSeconds < config.delaySeconds) config.delayMaxSeconds = null;
    if (patch.maxPerDay !== undefined) {
      if (patch.maxPerDay === null || patch.maxPerDay === '' || Number(patch.maxPerDay) === 0) config.maxPerDay = null;
      else {
        const d = Math.round(Number(patch.maxPerDay));
        if (!Number.isFinite(d) || d < 1 || d > 20_000) return { ok: false, error: 'The campaign’s daily maximum must be 1 to 20000 emails (empty: no maximum).' };
        config.maxPerDay = d;
      }
    }
    if (patch.followups !== undefined) {
      const f = checkFollowups(patch.followups);
      if (!f.ok) return f;
      config.followups = f.value;
    }
    if (patch.schedule !== undefined) {
      const sc = checkSchedule(patch.schedule);
      if (!sc.ok) return sc;
      config.schedule = sc.value;
    }
    if (patch.signature !== undefined) config.signature = String(patch.signature || '').replace(/\r\n/g, '\n').trim().slice(0, 500);
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
    // Follow-ups changed: the leads' next ones follow the new steps.
    if (patch.followups !== undefined) this.syncFollowups(this.row(id));
    this.emit('change', { id });
    return { ok: true, campaign: this.summary(id) };
  }

  // A copy of a campaign: its emails, follow-ups, schedule and settings
  // (not its recipients, history or category).
  duplicate(id) {
    const c = this.row(id);
    if (!c) return { ok: false, error: 'That email campaign no longer exists.' };
    const now = this.clock();
    const config = { ...c.config, senderNext: {}, senderDown: {}, senderLast: {} };
    const name = `${c.name.replace(/ · email$/, '')} (copy)`.slice(0, 80);
    const r = this.db.prepare('INSERT INTO email_campaigns (name, status, account_id, subject, body, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(name, 'draft', c.accountId, c.subject, c.body, JSON.stringify(config), now, now);
    const nid = Number(r.lastInsertRowid);
    this.log(nid, 'info', `Created as a copy of “${c.name}”`);
    this.emit('change', { id: nid });
    return { ok: true, id: nid, campaign: this.summary(nid) };
  }

  remove(id) {
    const c = this.row(id);
    if (!c) return { ok: false, error: 'That email campaign no longer exists.' };
    if (c.status === 'running') return { ok: false, error: 'Stop the campaign before deleting it.' };
    this.db.prepare('DELETE FROM email_recipients WHERE campaign_id = ?').run(c.id);
    this.db.prepare('DELETE FROM email_log WHERE campaign_id = ?').run(c.id);
    this.db.prepare('DELETE FROM email_clicks WHERE campaign_id = ?').run(c.id);
    this.db.prepare('DELETE FROM email_test_sends WHERE campaign_id = ?').run(c.id);
    this.db.prepare('DELETE FROM email_followups WHERE campaign_id = ?').run(c.id);
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
    // unverified: their email failed verification (excludedBy: how many per status).
    const out = { ready: [], noEmail: 0, optedOut: 0, previous: 0, already: 0, unverified: 0, excludedBy: {} };
    const seen = new Set();
    const inCampaign = new Set(this.db.prepare('SELECT email FROM email_recipients WHERE campaign_id = ?').all(c.id).map((r) => r.email));
    for (const lead of list) {
      const emails = emailsOf(lead);
      if (!emails.length) {
        out.noEmail++;
        continue;
      }
      if (emails.some((e) => seen.has(e) || inCampaign.has(e))) {
        out.already++;
        continue;
      }
      // The lead's address that passed verification, else one still to be checked.
      const pick = chooseEmail(emails, this.verification);
      const email = pick.email;
      seen.add(email);
      if (this.isOptedOut(email)) out.optedOut++;
      else if (!c.config.allowPrevious && this.wasEmailed(email, c.id)) out.previous++;
      else if (pick.state === 'excluded') {
        out.unverified++;
        out.excludedBy[pick.status] = (out.excludedBy[pick.status] || 0) + 1;
      } else out.ready.push({ lead, email, verified: pick.state === 'allowed' });
    }
    return out;
  }

  // Leads matching a Leads-table filter: { category, date, from, to, search, ids, website, source }.
  preview(id, filter = {}) {
    const c = this.row(id);
    if (!c) return { ok: false, error: 'That email campaign no longer exists.' };
    const a = this.audience(id, this.leads(filter));
    return { ok: true, ready: a.ready.length, verified: a.ready.filter((x) => x.verified).length, noEmail: a.noEmail, optedOut: a.optedOut, previous: a.previous, already: a.already, unverified: a.unverified, excludedBy: a.excludedBy, sample: a.ready.slice(0, 10).map(({ lead, email, verified }) => ({ id: lead.id, name: lead.name, email, verified })) };
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
    const toCheck = [];
    this.db.exec('BEGIN');
    try {
      for (const { lead, email, verified } of take) {
        const v = valuesOf(lead);
        const n = ins.run(c.id, email, lead.id ?? null, v.name, v.business, 'queued', first ? 1 : 0, now, now).changes;
        added += n;
        if (n && !verified) toCheck.push(email);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    // Their emails are verified now (before any can be sent).
    if (toCheck.length) this.verification?.enqueue(toCheck, { priority: 2 });
    if (added) this.log(c.id, 'info', `${added} recipient${added === 1 ? '' : 's'} added`);
    if (a.unverified) this.log(c.id, 'info', `${a.unverified} lead${a.unverified === 1 ? '' : 's'} not added: their email did not pass verification`);
    if (c.status === 'completed' && added && !c.category) this.setFields(c.id, { status: 'paused', pauseReason: 'new_recipients' });
    this.emit('change', { id: c.id });
    return { ok: true, added, noEmail: a.noEmail, optedOut: a.optedOut, previous: a.previous, already: a.already, unverified: a.unverified, excludedBy: a.excludedBy, overLimit: a.ready.length - take.length, campaign: this.summary(c.id) };
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
    if (!c.category && !n.queued && !n.remaining && !this.followupCounts(id).pending && !(c.config.followups?.on && this.db.prepare("SELECT 1 FROM email_recipients WHERE campaign_id = ? AND state = 'sent' LIMIT 1").get(c.id))) return { ok: false, error: 'There is nobody left to email in this campaign: add recipients first.' };
    if (!(await this.canSend())) return { ok: false, error: 'Sending emails needs an active plan.' };
    this.setFields(id, { status: 'running', pauseReason: null, failures: 0, nextDueAt: this.clock(), startedAt: c.startedAt || this.clock(), finishedAt: null, config: { ...c.config, senderDown: {}, senderNext: {}, resumedAt: this.clock() } });
    this.syncFollowups(this.row(id));
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
    const r = this.db.prepare("SELECT * FROM email_recipients WHERE campaign_id = ? ORDER BY CASE WHEN state = 'queued' THEN 0 ELSE 1 END, priority DESC, added_at, email LIMIT 1").get(c.id);
    let msg;
    try {
      msg = c.config.aiWrite ? compose(await this.aiText(c, r || { email: address, name: null, business: null }, { save: false }), { name: r?.name || null, business: r?.business || null, email: r?.email || address }, c.config.signature) : compose(c, { name: r?.name || null, business: r?.business || null, email: r?.email || address }, c.config.signature);
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

  // Test run: every sending account of the campaign emails itself the email
  // a lead would get (the next waiting leads, one per account, AI-written
  // when the campaign is), marked as a test. Nothing is counted as sent and
  // no lead is emailed. -> { ok, results: [{ account, to, as, ok, error }] }.
  async testRun(id) {
    const c = this.row(id);
    if (!c) return { ok: false, error: 'That email campaign no longer exists.' };
    const errs = this.problems(c);
    if (errs.length) return { ok: false, error: errs.join(' ') };
    const senders = this.senders(c).slice(0, 10);
    const sample = this.db.prepare("SELECT * FROM email_recipients WHERE campaign_id = ? ORDER BY CASE WHEN state = 'queued' THEN 0 ELSE 1 END, priority DESC, added_at, email LIMIT ?").all(c.id, senders.length);
    const results = [];
    for (const [i, from] of senders.entries()) {
      const acc = this.accounts.get(from);
      const address = String(acc?.email || '').toLowerCase();
      const r = sample[i] || sample[0] || null;
      const as = r ? `${r.business || r.name || r.email} <${r.email}>` : null;
      const values = { name: r?.name || null, business: r?.business || null, email: r?.email || address };
      let msg;
      try {
        msg = c.config.aiWrite ? compose(await this.aiText(c, r || { email: address, name: null, business: null }, { save: false }), values, c.config.signature) : compose(c, values, c.config.signature);
      } catch (err) {
        results.push({ account: acc?.name || from, to: address, as, ok: false, error: `the AI could not write it: ${err.message}` });
        continue;
      }
      if (this.tracking(c)) msg = { ...msg, ...this.tracker.rewrite(msg, `test-${c.id}`) };
      const note = `Test run of “${c.name}”${as ? `: the email ${as} would get` : ''}. Not sent to any lead.`;
      const subject = `[Test run] ${msg.subject}`;
      const text = `${note}\n\n${msg.text}`;
      const html = msg.html ? `<p style="color:#666;font-size:12px">${note.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>${msg.html}` : undefined;
      try {
        const res = await this.accounts.send(from, { to: address, subject, text, html, attachments: this.attachments(c) });
        if (res?.messageId) this.db.prepare('INSERT OR REPLACE INTO email_test_sends (message_id, campaign_id, account, email, subject, text, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(res.messageId, c.id, from, address, subject, String(msg.text || '').slice(0, 8000), this.clock());
        results.push({ account: acc?.name || from, to: address, as, ok: true });
      } catch (err) {
        results.push({ account: acc?.name || from, to: address, as, ok: false, error: err.message });
      }
    }
    this.db.prepare('DELETE FROM email_test_sends WHERE message_id NOT IN (SELECT message_id FROM email_test_sends ORDER BY at DESC LIMIT 200)').run();
    const sent = results.filter((x) => x.ok).length;
    this.log(c.id, sent === results.length ? 'info' : 'warn', `Test run: ${sent} of ${results.length} sending account${results.length === 1 ? '' : 's'} emailed ${results.length === 1 ? 'itself' : 'themselves'}${results.some((x) => !x.ok) ? ` (${results.filter((x) => !x.ok).map((x) => `${x.account}: ${x.error}`).join('; ')})` : ''}`);
    this.emit('change', { id: c.id });
    return { ok: sent > 0, results, ...(sent ? {} : { error: `The test run failed: ${results.map((x) => `${x.account}: ${x.error}`).join('; ')}.` }) };
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
    const f = this.db.prepare("UPDATE email_followups SET state = 'uncertain', error = 'Interrupted while sending; it may have been delivered', updated_at = ? WHERE state = 'sending'").run(this.clock()).changes;
    if (f) for (const r of this.db.prepare("SELECT DISTINCT campaign_id AS id FROM email_followups WHERE state = 'uncertain'").all()) this.log(r.id, 'warn', 'A follow-up was interrupted by a restart; it is not sent again automatically');
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
        // The next addresses are verified first (waiting for them a little).
        await this.verifyHead(c);
        // Follow-ups of leads who replied, bounced, unsubscribed or were stopped: cancelled.
        this.sweepFollowups(c);
        const next = this.nextRecipients(c, this.clock(), 50);
        // Follow-ups that are due go before new first emails.
        const due = this.dueFollowups(c, this.clock(), 5);
        // Nobody left: completed at once (no delay to wait for). A category
        // campaign stays on and waits for the category's new leads.
        if (!next.length && !due.length) {
          if (this.db.prepare("SELECT 1 FROM email_recipients WHERE campaign_id = ? AND state = 'sending' LIMIT 1").get(c.id) || this.db.prepare("SELECT 1 FROM email_followups WHERE campaign_id = ? AND state = 'sending' LIMIT 1").get(c.id)) continue;
          const n = this.counts(c.id);
          const fu = this.followupCounts(c.id);
          if (!n.remaining && c.category) {
            this.waiting.set(c.id, fu.pending ? 'followups' : 'new_leads');
            continue;
          }
          // Addresses still being verified: not finished yet.
          if (n.queued) {
            this.waiting.set(c.id, 'verifying');
            continue;
          }
          // Follow-ups still to come (or waiting for a retry): not finished yet.
          if (fu.pending && c.config.followups?.on) {
            this.waiting.set(c.id, 'followups');
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
        // One email at a time per campaign: its delay is between any two of
        // its emails, whichever account sends them (with 5 accounts and 10
        // minutes, still one email every 10 minutes). The accounts take
        // turns, the one that sent least recently first (ties in a random
        // order), each within its own daily limit; an account sends one
        // email at a time (across campaigns).
        // Only on the campaign's sending days and hours (in its time zone);
        // outside them it waits and goes on by itself when they start.
        if (!inWindow(c.config.schedule, now)) {
          this.waiting.set(c.id, 'schedule');
          continue;
        }
        if (c.config.maxPerDay && this.sentToday(null, c.id, now) >= c.config.maxPerDay) {
          this.waiting.set(c.id, 'daily_limit');
          continue;
        }
        if ((c.nextDueAt || 0) > now || this.sendingNow.has(c.id)) {
          this.waiting.set(c.id, 'delay');
          continue;
        }
        const why = new Set();
        const order = this.senders(c);
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(this.random() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
        const last = c.config.senderLast || {};
        order.sort((a, b) => (last[a] || 0) - (last[b] || 0));
        let started = false;
        for (const acc of order) {
          if ((!next.length && !due.length) || started) break;
          if (c.config.senderDown?.[acc]) {
            why.add('accounts_failing');
            continue;
          }
          const a = this.accounts.get(acc);
          // Switched off by the user; or its connection / login check failed
          // since the campaign was last started (never used automatically then).
          if (!a || a.enabled === false) {
            why.add('accounts_off');
            continue;
          }
          if (a.status === 'failed' && (a.testedAt || 0) > (c.config.resumedAt || 0)) {
            why.add('accounts_failing');
            continue;
          }
          if (a.dailyLimit && this.sentToday(acc, null, now) >= a.dailyLimit) {
            why.add('daily_limit');
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
          this.busy.add(acc);
          this.sendingNow.add(c.id);
          started = true;
          jobs.push(
            (due.length ? this.sendFollowUp(c, due.shift(), acc) : this.sendOne(c, next.shift(), acc))
              .catch((err) => this.emit('error', err))
              .finally(() => {
                this.busy.delete(acc);
                this.sendingNow.delete(c.id);
              }),
          );
        }
        if (!started) this.waiting.set(c.id, why.has('delay') ? 'delay' : why.has('daily_limit') ? 'daily_limit' : why.has('accounts_failing') ? 'accounts_failing' : why.has('accounts_off') ? 'accounts_off' : 'delay');
        else this.waiting.delete(c.id);
      }
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.ticking = false;
    }
    await Promise.all(jobs);
  }

  // Only recipients whose email passed verification (a fresh result the user
  // allows): new ones, and failed ones due for another try.
  verifiedSql(now, column = 'email_recipients.email') {
    const allowed = this.verification ? this.verification.allowed() : [];
    if (!allowed.length) return { sql: '0', params: [] };
    return { sql: `EXISTS (SELECT 1 FROM email_verifications v WHERE v.email = ${column} AND v.status IN (${allowed.map(() => '?').join(',')}) AND v.expires_at > ?)`, params: [...allowed, now] };
  }

  nextRecipients(c, now, n) {
    const v = this.verifiedSql(now);
    return [
      ...this.db.prepare(`SELECT * FROM email_recipients WHERE campaign_id = ? AND state = 'queued' AND ${v.sql} ORDER BY priority DESC, added_at, email LIMIT ?`).all(c.id, ...v.params, n),
      ...this.db.prepare(`SELECT * FROM email_recipients WHERE campaign_id = ? AND state = 'failed' AND attempts < ? AND retry_at IS NOT NULL AND retry_at <= ? AND ${v.sql} ORDER BY retry_at LIMIT ?`).all(c.id, MAX_ATTEMPTS, now, ...v.params, n),
    ].slice(0, n);
  }

  nextRecipient(c, now) {
    return this.nextRecipients(c, now, 1)[0] || null;
  }

  // The first waiting recipients not verified yet: checked now (up to 30 s;
  // the rest go on in the background), then the results applied.
  async verifyHead(c) {
    if (!this.verification) return;
    const now = this.clock();
    const head = this.db.prepare("SELECT email FROM email_recipients WHERE campaign_id = ? AND (state = 'queued' OR (state = 'failed' AND attempts < ? AND retry_at IS NOT NULL AND retry_at <= ?)) ORDER BY state = 'failed', priority DESC, added_at, email LIMIT 10").all(c.id, MAX_ATTEMPTS, now).map((r) => r.email);
    // Follow-ups due now: their address checked again if its result expired.
    const fus = c.config.followups?.on ? this.db.prepare("SELECT email FROM email_followups WHERE campaign_id = ? AND state IN ('queued', 'failed') AND due_at <= ? LIMIT 5").all(c.id, now).map((r) => r.email) : [];
    const open = [...new Set([...head, ...fus])].filter((e) => !this.verification.allows(e) && !this.verification.excluded(e));
    if (open.length) await this.verification.ensure(open, { timeout: 30_000 });
    this.applyVerification(head);
    // A follow-up's address that now fails verification: that follow-up is not sent.
    for (const e of fus) if (this.verification.excluded(e)) {
      const v = this.verification.statusOf(e);
      this.cancelFollowups(c.id, e, `Not sent: email ${VERIFY_LABEL[v.status] || v.status}${v.reason ? ` (${v.reason})` : ''}`);
    }
  }

  // After verification: recipients whose email failed are skipped (with the
  // reason); those skipped for it whose email now passes (rechecked, or the
  // user allowed that status) are queued again. emails: these only (null: all).
  applyVerification(emails = null) {
    if (!this.verification) return;
    const now = this.clock();
    const allowed = this.verification.allowed();
    const list = emails ? [...new Set(emails)] : null;
    const only = list ? ` AND r.email IN (${list.map(() => '?').join(',')})` : '';
    if (list && !list.length) return;
    const inAllowed = allowed.map(() => '?').join(',');
    const changed = new Set();
    const bad = this.db.prepare(`SELECT r.campaign_id AS id, r.email, v.status, v.reason FROM email_recipients r JOIN email_verifications v ON v.email = r.email WHERE r.state IN ('queued', 'failed') AND v.state = 'done' AND v.expires_at > ? AND v.status NOT IN (${inAllowed})${only}`).all(now, ...allowed, ...(list || []));
    const skip = this.db.prepare("UPDATE email_recipients SET state = 'skipped', error = ?, verify_skip = 1, retry_at = NULL, updated_at = ? WHERE campaign_id = ? AND email = ? AND state IN ('queued', 'failed')");
    for (const r of bad) {
      if (skip.run(`Not sent: email ${VERIFY_LABEL[r.status] || r.status}${r.reason ? ` (${r.reason})` : ''}`, now, r.id, r.email).changes) changed.add(r.id);
    }
    const good = this.db.prepare(`SELECT r.campaign_id AS id, r.email FROM email_recipients r JOIN email_verifications v ON v.email = r.email WHERE r.state = 'skipped' AND r.verify_skip = 1 AND v.expires_at > ? AND v.status IN (${inAllowed})${only}`).all(now, ...allowed, ...(list || []));
    const back = this.db.prepare("UPDATE email_recipients SET state = 'queued', error = NULL, verify_skip = 0, attempts = 0, updated_at = ? WHERE campaign_id = ? AND email = ? AND state = 'skipped' AND verify_skip = 1");
    const requeued = new Set();
    for (const r of good) {
      if (this.isOptedOut(r.email)) continue;
      if (back.run(now, r.id, r.email).changes) {
        changed.add(r.id);
        requeued.add(r.id);
      }
    }
    for (const id of requeued) {
      const c = this.row(id);
      if (c?.status === 'completed' && !c.category) this.setFields(id, { status: 'paused', pauseReason: 'new_recipients' });
    }
    for (const id of changed) this.emit('change', { id });
  }

  async sendOne(c, r, accountId = this.senders(c)[0]) {
    const now = this.clock();
    const set = (fields) => {
      const cols = Object.keys(fields);
      this.db.prepare(`UPDATE email_recipients SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE campaign_id = ? AND email = ?`).run(...cols.map((k) => fields[k]), this.clock(), c.id, r.email);
    };
    // Checked again right before sending.
    if (this.isOptedOut(r.email)) return set({ state: 'skipped', error: 'Unsubscribed' });
    if (r.stopped_at) return set({ state: 'skipped', error: 'Stopped by you' });
    // Its email must have passed verification (here too, whatever chose it).
    if (!this.verification?.allows(r.email)) {
      if (this.verification?.excluded(r.email)) this.applyVerification([r.email]);
      else this.verification?.enqueue([r.email], { priority: 9 });
      return;
    }
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
    this.paced(c, accountId, now);
    const sig = c.config.signature || '';
    let msg = text ? compose({ subject: text.subject, body: text.body }, { name: r.name, business: r.business, email: r.email }, sig) : compose(c, { name: r.name, business: r.business, email: r.email }, sig);
    if (this.tracking(c)) {
      const t = r.track_id || newTrackId();
      if (!r.track_id) set({ track_id: t });
      msg = { ...msg, ...this.tracker.rewrite(msg, t) };
    }
    const account = this.accounts.get(accountId);
    // The last check before it leaves (the result may have changed meanwhile).
    if (!this.verification?.allows(r.email)) {
      set({ state: r.state === 'failed' ? 'failed' : 'queued', attempts: r.attempts });
      this.applyVerification([r.email]);
      return;
    }
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
      set({ state: 'sent', error: null, message_id: res.messageId || null, sent_at: at, sent_day: dayOf(at), retry_at: null, sent_account: accountId, sent_subject: msg.subject.slice(0, 250), sent_text: String(msg.text).split('\n--\n')[0].slice(0, 8000) });
      this.setFields(c.id, { failures: 0 });
      // Its first follow-up is scheduled (when the campaign has follow-ups).
      this.chainFollowups(this.row(c.id), r.email);
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
        // Nothing went out: another account may send it now.
        this.setFields(c.id, { nextDueAt: this.clock() });
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
      // Permanent: a 5xx answer (an address refused for now, 4xx, is tried again).
      const permanent = (err.responseCode >= 500 && err.responseCode < 600) || (code === 'EENVELOPE' && !(err.responseCode >= 400 && err.responseCode < 500));
      if (timeout) set({ state: 'uncertain', error: `${err.message} (it may still have been delivered)` });
      // Temporary: tried again later, waiting longer each time; permanent: never again.
      else set({ state: 'failed', error: err.message, retry_at: !permanent && attempts < MAX_ATTEMPTS ? this.clock() + RETRY_AFTER * 2 ** (attempts - 1) : null });
      // The mail server refused the address itself: a bounce (no more emails to it).
      if (permanent && isRecipientRefusal(err)) this.recordBounce({ email: r.email, campaignId: c.id, permanent: true, reason: err.message });
      const failures = (latest?.failures || 0) + 1;
      this.setFields(c.id, { failures });
      this.log(c.id, 'error', `${r.email}: ${err.message}`);
      this.emit('failed', { id: c.id, email: r.email, error: err.message, paused: failures >= 3 });
      if (failures >= 3 && latest?.status === 'running') this.pause(c.id, 'errors');
    } finally {
      this.emit('change', { id: c.id });
    }
  }


  // After an email (first or follow-up) leaves: the campaign's next one only
  // after its pause; this account's next one too.
  paced(c, accountId, now) {
    const gap = pauseMs(c.config, this.random);
    this.patchConfig(c.id, (cfg) => {
      cfg.senderNext = { ...(cfg.senderNext || {}), [accountId]: now + gap };
      cfg.senderLast = { ...(cfg.senderLast || {}), [accountId]: now };
    });
    this.setFields(c.id, { nextDueAt: now + gap });
  }

  // --- follow-ups --------------------------------------------------------------------

  // Waiting follow-ups { pending, due, sent, cancelled, uncertain, nextAt }.
  followupCounts(id, now = this.clock()) {
    const out = { pending: 0, due: 0, sent: 0, cancelled: 0, uncertain: 0, failed: 0, nextAt: null };
    for (const r of this.db.prepare('SELECT state, COUNT(*) AS n, MIN(due_at) AS first, SUM(CASE WHEN due_at <= ? THEN 1 ELSE 0 END) AS due FROM email_followups WHERE campaign_id = ? GROUP BY state').all(now, Number(id))) {
      if (r.state === 'queued') {
        out.pending += r.n;
        out.due += r.due;
        out.nextAt = r.first;
      } else if (r.state === 'failed') {
        const retry = this.db.prepare('SELECT COUNT(*) AS n FROM email_followups WHERE campaign_id = ? AND state = ? AND attempts < ? AND retry_at IS NOT NULL').get(Number(id), 'failed', MAX_ATTEMPTS).n;
        out.pending += retry;
        out.failed += r.n - retry;
      } else if (r.state in out) out[r.state] += r.n;
    }
    return out;
  }

  // Follow-ups due now whose address passed verification.
  dueFollowups(c, now, n) {
    if (!c.config.followups?.on) return [];
    const v = this.verifiedSql(now, 'f.email');
    return this.db
      .prepare(`SELECT f.* FROM email_followups f WHERE f.campaign_id = ? AND ((f.state = 'queued' AND f.due_at <= ?) OR (f.state = 'failed' AND f.attempts < ? AND f.retry_at IS NOT NULL AND f.retry_at <= ?)) AND ${v.sql} ORDER BY f.due_at, f.step, f.email LIMIT ?`)
      .all(c.id, now, MAX_ATTEMPTS, now, ...v.params, n);
  }

  // Why a lead gets no more emails from this campaign (null: it may).
  stopReason(r) {
    if (!r) return 'No longer in the campaign';
    if (r.replied_at) return 'Replied';
    if (r.bounced_at) return 'Bounced';
    if (this.isOptedOut(r.email)) return 'Unsubscribed';
    if (r.stopped_at) return 'Stopped by you';
    if (r.interest === 'not_interested') return 'Not interested';
    return null;
  }

  // The waiting follow-ups of a lead (or of every lead: email null) cancelled.
  cancelFollowups(campaignId, email, reason) {
    const now = this.clock();
    const r = email
      ? this.db.prepare("UPDATE email_followups SET state = 'cancelled', error = ?, updated_at = ? WHERE campaign_id = ? AND email = ? AND state IN ('queued', 'failed')").run(reason, now, Number(campaignId), email)
      : this.db.prepare("UPDATE email_followups SET state = 'cancelled', error = ?, updated_at = ? WHERE campaign_id = ? AND state IN ('queued', 'failed')").run(reason, now, Number(campaignId));
    if (r.changes) this.emit('change', { id: Number(campaignId) });
    return r.changes;
  }

  // Follow-ups of leads who replied, bounced, unsubscribed, were stopped or
  // are not interested: cancelled, with the reason.
  sweepFollowups(c) {
    const now = this.clock();
    const rows = this.db.prepare("SELECT DISTINCT f.email, r.replied_at, r.bounced_at, r.stopped_at, r.interest, r.email AS remail FROM email_followups f LEFT JOIN email_recipients r ON r.campaign_id = f.campaign_id AND r.email = f.email WHERE f.campaign_id = ? AND f.state IN ('queued', 'failed') AND (r.email IS NULL OR r.replied_at IS NOT NULL OR r.bounced_at IS NOT NULL OR r.stopped_at IS NOT NULL OR r.interest = 'not_interested' OR f.email IN (SELECT email FROM email_optouts))").all(c.id);
    for (const r of rows) this.cancelFollowups(c.id, r.email, this.stopReason(r.remail ? r : null));
    void now;
  }

  // A lead's next follow-up, after its last email: scheduled (or rescheduled
  // when the steps changed). Nothing for a lead who replied, bounced etc.
  chainFollowups(c, email, cache = null) {
    if (!c) return;
    const steps = c.config.followups?.on ? c.config.followups.steps : [];
    if (!steps.length) return;
    const r = this.db.prepare('SELECT * FROM email_recipients WHERE campaign_id = ? AND email = ?').get(c.id, email);
    if (!r || r.state !== 'sent' || this.stopReason(r)) return;
    const rows = cache?.get(email) || this.db.prepare('SELECT step, state, due_at, sent_at, updated_at FROM email_followups WHERE campaign_id = ? AND email = ?').all(c.id, email);
    const byStep = new Map(rows.map((x) => [x.step, x]));
    const now = this.clock();
    let prevAt = r.sent_at;
    for (let k = 1; k <= steps.length; k++) {
      const row = byStep.get(k);
      const due = prevAt + steps[k - 1].days * DAY;
      if (!row) {
        this.db.prepare("INSERT INTO email_followups (campaign_id, email, step, state, due_at, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?) ON CONFLICT (campaign_id, email, step) DO NOTHING").run(c.id, email, k, due, now, now);
        return;
      }
      if (row.state === 'sent' || row.state === 'uncertain') {
        prevAt = row.sent_at || row.updated_at;
        continue;
      }
      if (row.state === 'queued' && row.due_at !== due) this.db.prepare("UPDATE email_followups SET due_at = ?, updated_at = ? WHERE campaign_id = ? AND email = ? AND step = ? AND state = 'queued'").run(due, now, c.id, email, k);
      return;
    }
  }

  // Every lead's follow-ups follow the campaign's steps (after they changed,
  // or were turned on for leads emailed before).
  syncFollowups(c) {
    if (!c) return;
    const steps = c.config.followups?.on ? c.config.followups.steps : [];
    this.db.prepare("UPDATE email_followups SET state = 'cancelled', error = 'Removed from the sequence', updated_at = ? WHERE campaign_id = ? AND state IN ('queued', 'failed') AND step > ?").run(this.clock(), c.id, steps.length);
    if (!steps.length) return;
    const cache = new Map();
    for (const x of this.db.prepare('SELECT email, step, state, due_at, sent_at, updated_at FROM email_followups WHERE campaign_id = ?').all(c.id)) {
      if (!cache.has(x.email)) cache.set(x.email, []);
      cache.get(x.email).push(x);
    }
    this.db.exec('BEGIN');
    try {
      for (const r of this.db.prepare("SELECT email FROM email_recipients WHERE campaign_id = ? AND state = 'sent'").all(c.id)) this.chainFollowups(c, r.email, cache);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // The follow-up's text: the step's email (or, with AI on, written from the
  // step's prompt and the earlier emails), in the same thread ("Re: ...")
  // unless the step has its own subject. Kept on the follow-up once written.
  async followupText(c, r, f) {
    const step = c.config.followups.steps[f.step - 1];
    const values = { name: r.name, business: r.business, email: r.email };
    const thread = `Re: ${String(r.sent_subject || render(c.subject, values) || '').replace(/^(re:\s*)+/i, '')}`.trim();
    if (f.body) return { subject: f.subject || thread, body: f.body, ai: true };
    let subject = step.subject ? render(step.subject, values) : thread;
    let body = step.body;
    if (c.config.aiWrite) {
      if (!this.writer) throw Object.assign(new Error('no AI key is saved'), { code: 'no_key' });
      const earlier = [r.sent_text, ...this.db.prepare("SELECT body FROM email_followups WHERE campaign_id = ? AND email = ? AND step < ? AND state = 'sent' ORDER BY step").all(c.id, r.email, f.step).map((x) => x.body)].filter(Boolean);
      const sender = this.accounts.get(this.senders(c)[0]);
      const out = await this.writer({
        instructions: `${step.body}\n\n---\nThis is follow-up ${f.step} of an email sequence. The business has not replied to the earlier email${earlier.length > 1 ? 's' : ''} below. Write a short follow-up in the same thread that refers back to ${earlier.length > 1 ? 'them' : 'it'} naturally, without repeating ${earlier.length > 1 ? 'them' : 'it'}.\n\nEarlier email${earlier.length > 1 ? 's' : ''}:\n${earlier.map((t, i) => `[${i + 1}]\n${String(t).slice(0, 2500)}`).join('\n\n')}`,
        subject: step.subject || thread,
        sender: { name: sender?.senderName || sender?.name || '', email: sender?.email || '' },
        business: this.leadDetails(r),
        signature: c.config.signature || '',
      });
      body = String(out?.body || '').trim().slice(0, 8000);
      if (body.length < 10) throw Object.assign(new Error('the AI did not write a usable follow-up'), { code: 'ai_empty' });
      if (step.subject) subject = String(out?.subject || subject).replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
      this.db.prepare('UPDATE email_followups SET subject = ?, body = ? WHERE campaign_id = ? AND email = ? AND step = ?').run(subject, body, c.id, r.email, f.step);
      return { subject, body, ai: true };
    }
    return { subject, body, ai: false };
  }

  // One follow-up: checked again (reply, bounce, unsubscribe, stop,
  // verification), reserved (never sent twice), sent in the lead's thread.
  async sendFollowUp(c, f, accountId) {
    const now = this.clock();
    const set = (fields) => {
      const cols = Object.keys(fields);
      this.db.prepare(`UPDATE email_followups SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE campaign_id = ? AND email = ? AND step = ?`).run(...cols.map((k) => fields[k]), this.clock(), c.id, f.email, f.step);
    };
    const r = this.db.prepare('SELECT * FROM email_recipients WHERE campaign_id = ? AND email = ?').get(c.id, f.email);
    const stop = this.stopReason(r);
    if (stop) return this.cancelFollowups(c.id, f.email, stop);
    if (!c.config.followups?.steps?.[f.step - 1]) return set({ state: 'cancelled', error: 'Removed from the sequence' });
    if (!this.verification?.allows(f.email)) {
      if (this.verification?.excluded(f.email)) {
        const v = this.verification.statusOf(f.email);
        this.cancelFollowups(c.id, f.email, `Not sent: email ${VERIFY_LABEL[v.status] || v.status}${v.reason ? ` (${v.reason})` : ''}`);
      } else this.verification?.enqueue([f.email], { priority: 9 });
      return;
    }
    if (!(await this.canSend())) return this.pause(c.id, 'subscription');
    let text;
    try {
      text = await this.followupText(c, r, f);
      this.aiFailures.delete(c.id);
    } catch (err) {
      const n = (this.aiFailures.get(c.id) || 0) + 1;
      this.aiFailures.set(c.id, n);
      this.log(c.id, 'error', `AI could not write follow-up ${f.step} for ${f.email}: ${err.message}`);
      this.patchConfig(c.id, (cfg) => (cfg.senderNext = { ...(cfg.senderNext || {}), [accountId]: now + Math.max(30, c.config.delaySeconds) * 1000 }));
      if (['no_key', 'invalid_key', 'credits'].includes(err.code) || n >= 3) {
        this.aiFailures.delete(c.id);
        this.pause(c.id, 'ai');
      }
      this.emit('change', { id: c.id });
      return;
    }
    // Reserved: from here on, it is never sent twice.
    const reserved = this.db.prepare("UPDATE email_followups SET state = 'sending', attempts = attempts + 1, updated_at = ? WHERE campaign_id = ? AND email = ? AND step = ? AND state IN ('queued', 'failed')").run(now, c.id, f.email, f.step).changes;
    if (!reserved) return;
    this.paced(c, accountId, now);
    const values = { name: r.name, business: r.business, email: r.email };
    let msg = compose({ subject: text.subject, body: text.body }, values, c.config.signature || '');
    if (this.tracking(c)) {
      const t = r.track_id || newTrackId();
      if (!r.track_id) this.db.prepare('UPDATE email_recipients SET track_id = ? WHERE campaign_id = ? AND email = ?').run(t, c.id, r.email);
      msg = { ...msg, ...this.tracker.rewrite(msg, t) };
    }
    // In the lead's thread: it answers the earlier emails.
    const ids = [r.message_id, ...this.db.prepare("SELECT message_id FROM email_followups WHERE campaign_id = ? AND email = ? AND step < ? AND message_id IS NOT NULL ORDER BY step").all(c.id, f.email, f.step).map((x) => x.message_id)].filter(Boolean);
    const account = this.accounts.get(accountId);
    if (!this.verification?.allows(f.email)) {
      set({ state: f.state === 'failed' ? 'failed' : 'queued', attempts: f.attempts });
      return;
    }
    try {
      const res = await this.accounts.send(accountId, {
        to: f.email,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        headers: { 'List-Unsubscribe': `<mailto:${account.email}?subject=unsubscribe>` },
        ...(ids.length ? { inReplyTo: ids.at(-1), references: ids } : {}),
      });
      if (res.rejected?.length) throw Object.assign(new Error('the email server refused this address'), { code: 'EENVELOPE' });
      const at = this.clock();
      set({ state: 'sent', error: null, message_id: res.messageId || null, sent_at: at, sent_day: dayOf(at), retry_at: null, sent_account: accountId, subject: msg.subject.slice(0, 250), body: String(msg.text).split('\n--\n')[0].slice(0, 8000) });
      this.setFields(c.id, { failures: 0 });
      this.log(c.id, 'info', `Follow-up ${f.step} sent to ${f.email}`);
      this.chainFollowups(this.row(c.id), f.email);
      this.emit('sent', { id: c.id, email: f.email, step: f.step });
    } catch (err) {
      const code = err?.code || '';
      if (['EAUTH', 'ECONNECTION', 'EDNS', 'no_password', 'no_account'].includes(code) || err.message === 'the email server could not be reached') {
        set({ state: f.state === 'failed' ? 'failed' : 'queued', attempts: f.attempts });
        this.patchConfig(c.id, (cfg) => (cfg.senderDown = { ...(cfg.senderDown || {}), [accountId]: err.message }));
        this.setFields(c.id, { nextDueAt: this.clock() });
        const left = this.senders(this.row(c.id)).filter((x) => !this.row(c.id).config.senderDown?.[x]);
        this.log(c.id, 'error', `${account?.name || accountId}: ${err.message}${left.length ? '' : ' (paused)'}`);
        if (!left.length && this.row(c.id)?.status === 'running') this.pause(c.id, code === 'EAUTH' ? 'login' : 'connection');
        this.emit('failed', { id: c.id, email: f.email, error: err.message, paused: !left.length });
        return;
      }
      const timeout = ['ETIMEDOUT', 'ESOCKET'].includes(code);
      const attempts = f.attempts + 1;
      // Permanent: a 5xx answer (an address refused for now, 4xx, is tried again).
      const permanent = (err.responseCode >= 500 && err.responseCode < 600) || (code === 'EENVELOPE' && !(err.responseCode >= 400 && err.responseCode < 500));
      if (timeout) set({ state: 'uncertain', error: `${err.message} (it may still have been delivered)` });
      else set({ state: 'failed', error: err.message, retry_at: !permanent && attempts < MAX_ATTEMPTS ? this.clock() + RETRY_AFTER * 2 ** (attempts - 1) : null });
      if (permanent && isRecipientRefusal(err)) this.recordBounce({ email: f.email, campaignId: c.id, permanent: true, reason: err.message });
      this.log(c.id, 'error', `Follow-up ${f.step} to ${f.email}: ${err.message}`);
      this.emit('failed', { id: c.id, email: f.email, error: err.message, paused: false });
    } finally {
      this.emit('change', { id: c.id });
    }
  }

  // --- a lead in a campaign: stop, interest, timeline --------------------------------

  // Stops (or, on: false, allows again) every further email to a lead.
  stopLead(id, email, on = true) {
    const e = String(email || '').toLowerCase();
    const r = this.db.prepare('SELECT * FROM email_recipients WHERE campaign_id = ? AND email = ?').get(Number(id), e);
    if (!r) return { ok: false, error: 'That person is not in this campaign.' };
    const now = this.clock();
    if (on) {
      this.db.prepare('UPDATE email_recipients SET stopped_at = ?, updated_at = ? WHERE campaign_id = ? AND email = ?').run(now, now, r.campaign_id, e);
      this.db.prepare("UPDATE email_recipients SET state = 'skipped', error = 'Stopped by you', updated_at = ? WHERE campaign_id = ? AND email = ? AND state IN ('queued', 'failed')").run(now, r.campaign_id, e);
      this.cancelFollowups(r.campaign_id, e, 'Stopped by you');
      this.log(r.campaign_id, 'info', `${e}: sequence stopped by you`);
    } else {
      this.db.prepare('UPDATE email_recipients SET stopped_at = NULL, updated_at = ? WHERE campaign_id = ? AND email = ?').run(now, r.campaign_id, e);
      this.db.prepare("UPDATE email_recipients SET state = 'queued', error = NULL, attempts = 0, updated_at = ? WHERE campaign_id = ? AND email = ? AND state = 'skipped' AND error = 'Stopped by you'").run(now, r.campaign_id, e);
      this.db.prepare("UPDATE email_followups SET state = 'queued', error = NULL, attempts = 0, updated_at = ? WHERE campaign_id = ? AND email = ? AND state = 'cancelled' AND error = 'Stopped by you'").run(now, r.campaign_id, e);
      this.chainFollowups(this.row(r.campaign_id), e);
      this.log(r.campaign_id, 'info', `${e}: sequence resumed`);
      // A campaign that had finished goes on for this lead.
      const c = this.row(r.campaign_id);
      if (c.status === 'completed' && (this.followupCounts(c.id).pending || this.counts(c.id).queued)) {
        this.setFields(c.id, { status: 'running', finishedAt: null, nextDueAt: now });
        this.kick();
      }
    }
    this.emit('change', { id: r.campaign_id });
    return { ok: true };
  }

  // value: interested | not_interested | null. Not interested ends the sequence.
  setInterest(id, email, value) {
    const e = String(email || '').toLowerCase();
    const v = ['interested', 'not_interested'].includes(value) ? value : null;
    const r = this.db.prepare('UPDATE email_recipients SET interest = ?, updated_at = ? WHERE campaign_id = ? AND email = ?').run(v, this.clock(), Number(id), e);
    if (!r.changes) return { ok: false, error: 'That person is not in this campaign.' };
    if (v === 'not_interested') this.cancelFollowups(id, e, 'Not interested');
    this.emit('change', { id: Number(id) });
    return { ok: true };
  }

  // Everything that happened with a lead in a campaign, oldest first:
  // [{ at, kind, step, subject, text, state, error, account }].
  timeline(id, email) {
    const e = String(email || '').toLowerCase();
    const c = this.row(id);
    const r = this.db.prepare('SELECT * FROM email_recipients WHERE campaign_id = ? AND email = ?').get(Number(id), e);
    if (!c || !r) return null;
    const name = (acc) => (acc ? this.accounts.get(acc)?.email || acc : null);
    const out = [{ at: r.added_at, kind: 'added', text: `Added to “${c.name}”` }];
    const firstText = r.sent_text || r.ai_body || (r.state === 'sent' ? null : null);
    out.push({ at: r.sent_at || r.updated_at, kind: 'email', step: 0, subject: r.sent_subject || r.ai_subject || null, text: firstText, state: r.state, error: r.error, account: name(r.sent_account) });
    for (const f of this.db.prepare('SELECT * FROM email_followups WHERE campaign_id = ? AND email = ? ORDER BY step').all(c.id, e)) {
      out.push({ at: f.sent_at || (f.state === 'queued' ? f.due_at : f.updated_at), kind: 'followup', step: f.step, subject: f.subject, text: f.body, state: f.state, error: f.error, account: name(f.sent_account), dueAt: f.state === 'queued' ? f.due_at : null });
    }
    for (const k of this.db.prepare('SELECT url, at FROM email_clicks WHERE campaign_id = ? AND email = ? AND bot = 0 ORDER BY at').all(c.id, e)) out.push({ at: k.at, kind: 'click', text: k.url });
    if (r.replied_at) out.push({ at: r.replied_at, kind: 'reply', subject: r.reply_subject });
    if (r.auto_reply_at) out.push({ at: r.auto_reply_at, kind: 'auto_reply', text: 'An automatic reply (out of office): the sequence goes on' });
    if (r.bounced_at) out.push({ at: r.bounced_at, kind: 'bounce', text: r.bounce_reason });
    if (r.stopped_at) out.push({ at: r.stopped_at, kind: 'stopped', text: 'Sequence stopped by you' });
    return out.filter((x) => x.at).sort((a, b) => a.at - b.at || (a.step ?? 0) - (b.step ?? 0));
  }

  // The status of a lead in a campaign, from its records (see recipientRows).
  static leadStatus(r, fu, optedOut) {
    if (r.bounced_at) return 'bounced';
    if (optedOut) return 'unsubscribed';
    if (r.verify === 'excluded' && r.verifyStatus === 'invalid') return 'invalid';
    if (r.stopped_at) return 'stopped';
    if (r.interest === 'interested') return 'interested';
    if (r.interest === 'not_interested') return 'not_interested';
    if (r.replied_at) return 'replied';
    if (r.state === 'sending' || fu?.sending) return 'sending';
    if (fu?.queued) return 'followup_scheduled';
    if (r.clicked_at) return 'clicked';
    if (r.state === 'sent' && fu?.sent && !fu.queued) return 'sequence_completed';
    if (r.state === 'sent') return 'sent';
    if (r.state === 'failed') return r.retry_at ? 'retrying' : 'failed';
    if (r.state === 'uncertain') return 'uncertain';
    if (r.state === 'skipped') return r.verify_skip ? 'invalid' : 'skipped';
    if (r.state === 'queued') return r.verify === 'ready' ? 'ready' : 'new';
    return r.state;
  }

  // The whole email activity, from the records: { campaigns: {running, paused, completed, ...}, today, scheduled, ... }.
  dashboard() {
    const now = this.clock();
    const day = dayOf(now);
    const one = (sql, ...p) => this.db.prepare(sql).get(...p).n;
    const byStatus = {};
    for (const r of this.db.prepare('SELECT status, COUNT(*) AS n FROM email_campaigns GROUP BY status').all()) byStatus[r.status] = r.n;
    const sentFirst = one("SELECT COUNT(*) AS n FROM email_recipients WHERE state = 'sent'");
    const sentFollow = one("SELECT COUNT(*) AS n FROM email_followups WHERE state = 'sent'");
    const replies = one('SELECT COUNT(*) AS n FROM email_recipients WHERE replied_at IS NOT NULL');
    const bounced = one('SELECT COUNT(*) AS n FROM email_recipients WHERE bounced_at IS NOT NULL');
    const unsub = one("SELECT COUNT(*) AS n FROM email_recipients r WHERE r.state = 'sent' AND r.bounced_at IS NULL AND r.email IN (SELECT email FROM email_optouts)");
    const leads = one('SELECT COUNT(DISTINCT email) AS n FROM email_recipients');
    return {
      campaigns: { running: byStatus.running || 0, paused: byStatus.paused || 0, completed: byStatus.completed || 0, draft: byStatus.draft || 0, stopped: byStatus.stopped || 0 },
      leads,
      sentToday: one("SELECT COUNT(*) AS n FROM email_recipients WHERE state = 'sent' AND sent_day = ?", day) + one("SELECT COUNT(*) AS n FROM email_followups WHERE state = 'sent' AND sent_day = ?", day),
      scheduled: one("SELECT COUNT(*) AS n FROM email_recipients r JOIN email_campaigns c ON c.id = r.campaign_id WHERE r.state = 'queued' AND c.status IN ('running', 'paused')"),
      followupsPending: one("SELECT COUNT(*) AS n FROM email_followups WHERE state = 'queued'"),
      sent: sentFirst,
      followupsSent: sentFollow,
      replies,
      interested: one("SELECT COUNT(*) AS n FROM email_recipients WHERE interest = 'interested'"),
      failed: one("SELECT COUNT(*) AS n FROM email_recipients WHERE state = 'failed'") + one("SELECT COUNT(*) AS n FROM email_followups WHERE state = 'failed'"),
      bounced,
      unsubscribed: unsub,
      replyRate: sentFirst ? Math.round((replies / sentFirst) * 1000) / 10 : 0,
      bounceRate: sentFirst ? Math.round((bounced / sentFirst) * 1000) / 10 : 0,
      unsubscribeRate: sentFirst ? Math.round((unsub / sentFirst) * 1000) / 10 : 0,
    };
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
    const out = await this.writer({ instructions: c.body, subject: '', sender: { name: sender?.senderName || sender?.name || '', email: sender?.email || '' }, business: this.leadDetails(r), signature: c.config.signature || '' });
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
    const msg = r.sent_text ? { subject: r.sent_subject, text: r.sent_text } : r.ai_body ? { subject: r.ai_subject, text: r.ai_body } : compose({ subject: r.c_subject, body: r.c_body }, { name: r.name, business: r.business, email: r.email });
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
      const f = this.db.prepare("SELECT f.email, f.campaign_id AS campaignId, c.name AS campaignName, f.step FROM email_followups f JOIN email_campaigns c ON c.id = f.campaign_id WHERE f.message_id = ? AND f.state IN ('sent', 'uncertain') LIMIT 1").get(id);
      if (f) return { ...f, test: false };
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
    // A reply ends the lead's follow-ups.
    const cancelled = this.cancelFollowups(r.id, e, 'Replied');
    if (cancelled) this.log(r.id, 'info', `${e}: ${cancelled} follow-up${cancelled === 1 ? '' : 's'} cancelled (replied)`);
    let unsubscribed = false;
    if (unsubscribe && !this.isOptedOut(e)) {
      this.optOut(e, 'Replied asking to unsubscribe');
      this.log(r.id, 'warn', `${e} asked to unsubscribe: never emailed again`);
      unsubscribed = true;
    }
    this.emit('change', { id: r.id });
    return { ok: true, first, unsubscribed, campaignId: r.id };
  }

  // An automatic reply (out of office, autoresponder): noted on the lead;
  // its sequence goes on (it is not a reply from a person).
  recordAutoReply(email, { campaignId = null, at = this.clock() } = {}) {
    const e = String(email || '').trim().toLowerCase();
    const r = campaignId ? { id: Number(campaignId) } : this.db.prepare("SELECT campaign_id AS id FROM email_recipients WHERE email = ? AND state IN ('sent', 'uncertain') ORDER BY sent_at DESC LIMIT 1").get(e);
    if (!r) return { ok: false };
    const n = this.db.prepare('UPDATE email_recipients SET auto_reply_at = ? WHERE campaign_id = ? AND email = ?').run(at, r.id, e).changes;
    if (n) this.log(r.id, 'info', `${e}: automatic reply (out of office); the sequence goes on`);
    this.emit('change', { id: r.id });
    return { ok: Boolean(n), campaignId: r.id };
  }

  // A bounce (the mail server's delivery failure report, or a refusal while
  // sending). Permanent: the lead is marked bounced, gets no more emails
  // (in any campaign: it goes on the suppression list) and its address is
  // marked invalid. Temporary: only noted.
  recordBounce({ email, messageId = null, campaignId = null, permanent = true, reason = '', at = this.clock() }) {
    const match = messageId ? this.sentByMessageId([messageId]) : null;
    const e = String(match?.email || email || '').trim().toLowerCase();
    if (!e) return { ok: false };
    const r = match ? { id: match.campaignId } : campaignId ? { id: Number(campaignId) } : this.db.prepare("SELECT campaign_id AS id FROM email_recipients WHERE email = ? AND state IN ('sent', 'uncertain', 'failed') ORDER BY COALESCE(sent_at, updated_at) DESC LIMIT 1").get(e);
    if (!r) return { ok: false };
    const why = String(reason || 'delivery failed').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!permanent) {
      this.log(r.id, 'warn', `${e}: temporary delivery problem (${why})`);
      return { ok: true, campaignId: r.id, permanent: false };
    }
    const first = this.db.prepare('UPDATE email_recipients SET bounced_at = ?, bounce_reason = ? WHERE campaign_id = ? AND email = ? AND bounced_at IS NULL').run(at, why, r.id, e).changes;
    this.cancelFollowups(r.id, e, 'Bounced');
    if (!this.isOptedOut(e)) this.db.prepare('INSERT INTO email_optouts (email, reason, at) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING').run(e, `Bounced: ${why}`.slice(0, 300), at);
    this.db.prepare("UPDATE email_recipients SET state = 'skipped', error = ?, updated_at = ? WHERE email = ? AND state IN ('queued', 'failed')").run(`Bounced: ${why}`.slice(0, 300), at, e);
    this.verification?.markBounced?.(e, why);
    if (first) this.log(r.id, 'warn', `${e} bounced (${why}): no more emails to it`);
    this.emit('change', { id: r.id });
    return { ok: true, campaignId: r.id, permanent: true, first: Boolean(first) };
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
      verify: this.verifyCounts(c.id),
      followups: c.config.followups || FOLLOWUP_DEFAULTS,
      followupCounts: this.followupCounts(c.id),
      schedule: c.config.schedule || SCHEDULE_DEFAULTS,
      // Outside the sending days and hours: when they start again.
      windowOpensAt: c.status === 'running' && !inWindow(c.config.schedule, this.clock()) ? nextWindow(c.config.schedule, this.clock()) : null,
      delayMaxSeconds: c.config.delayMaxSeconds || null,
      maxPerDay: c.config.maxPerDay || null,
      signature: c.config.signature || '',
      bounced: this.db.prepare('SELECT COUNT(*) AS n FROM email_recipients WHERE campaign_id = ? AND bounced_at IS NOT NULL').get(c.id).n,
      interested: this.db.prepare("SELECT COUNT(*) AS n FROM email_recipients WHERE campaign_id = ? AND interest = 'interested'").get(c.id).n,
      unsubscribed: this.db.prepare("SELECT COUNT(*) AS n FROM email_recipients WHERE campaign_id = ? AND email IN (SELECT email FROM email_optouts) AND bounced_at IS NULL").get(c.id).n,
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
      recipients: this.recipientRows(c.id, recipients),
      log: this.db.prepare('SELECT at, level, text FROM email_log WHERE campaign_id = ? ORDER BY id DESC LIMIT 100').all(c.id),
      limits: LIMITS,
    };
  }

  // The recipients (waiting ones in sending order), each with its email's verification.
  recipientRows(id, limit) {
    const v = this.verification;
    const cols = 'r.email, r.lead_id AS leadId, r.name, r.business, r.state, r.attempts, r.error, r.sent_at AS sentAt, r.retry_at AS retryAt, r.replied_at AS repliedAt, r.clicked_at AS clickedAt, r.clicks, r.priority, r.ai_subject AS aiSubject, r.ai_body AS aiBody, r.bounced_at AS bouncedAt, r.bounce_reason AS bounceReason, r.stopped_at AS stoppedAt, r.interest, r.auto_reply_at AS autoReplyAt, r.verify_skip AS verifySkip';
    const verify = v ? ', v.status AS verifyStatus, v.reason AS verifyReason, v.state AS verifyState, v.expires_at AS verifyExpires, v.role AS verifyRole, v.next_at AS verifyNext' : '';
    const join = v ? ' LEFT JOIN email_verifications v ON v.email = r.email' : '';
    const base = this.db.prepare(`SELECT ${cols}${verify} FROM email_recipients r${join} WHERE r.campaign_id = ? ORDER BY CASE r.state WHEN 'sending' THEN 0 WHEN 'failed' THEN 1 WHEN 'uncertain' THEN 2 WHEN 'queued' THEN 3 ELSE 4 END, CASE WHEN r.state = 'queued' THEN -r.priority ELSE 0 END, CASE WHEN r.state = 'queued' THEN r.added_at ELSE -r.updated_at END, r.email LIMIT ?`).all(id, limit);
    // Follow-ups per lead: how many sent, the next one and when.
    const fu = new Map();
    for (const f of this.db.prepare('SELECT email, state, step, due_at FROM email_followups WHERE campaign_id = ?').all(id)) {
      const x = fu.get(f.email) || { sent: 0, queued: 0, sending: 0, nextAt: null, nextStep: null };
      if (f.state === 'sent' || f.state === 'uncertain') x.sent++;
      if (f.state === 'sending') x.sending++;
      if (f.state === 'queued') {
        x.queued++;
        if (x.nextAt == null || f.due_at < x.nextAt) [x.nextAt, x.nextStep] = [f.due_at, f.step];
      }
      fu.set(f.email, x);
    }
    const out = (r) => {
      const f = fu.get(r.email);
      const row = { ...r, followupsSent: f?.sent || 0, nextFollowupAt: f?.nextAt || null, nextFollowupStep: f?.nextStep || null };
      row.status = EmailCampaigns.leadStatus({ ...row, replied_at: r.repliedAt, bounced_at: r.bouncedAt, stopped_at: r.stoppedAt, clicked_at: r.clickedAt, retry_at: r.retryAt, verify_skip: r.verifySkip }, f, this.isOptedOut(r.email));
      return row;
    };
    const rows = base;
    if (!v) return rows.map(out);
    const now = this.clock();
    const allowed = v.allowed();
    // verify: ready (passed, may be sent) | checking | excluded | expired (checked again before sending).
    return rows.map((r) => {
      const fresh = r.verifyStatus && r.verifyExpires > now;
      const verify = !r.verifyStatus || r.verifyState !== 'done' ? 'checking' : !fresh ? 'expired' : allowed.includes(r.verifyStatus) ? 'ready' : 'excluded';
      return out({ ...r, verifyRole: Boolean(r.verifyRole), verify });
    });
  }

  // Waiting recipients by verification: { ready, checking, excluded } (excluded: skipped for it).
  verifyCounts(id) {
    if (!this.verification) return null;
    const v = this.verifiedSql(this.clock());
    const ready = this.db.prepare(`SELECT COUNT(*) AS n FROM email_recipients WHERE campaign_id = ? AND state = 'queued' AND ${v.sql}`).get(Number(id), ...v.params).n;
    const queued = this.db.prepare("SELECT COUNT(*) AS n FROM email_recipients WHERE campaign_id = ? AND state = 'queued'").get(Number(id)).n;
    const excluded = this.db.prepare("SELECT COUNT(*) AS n FROM email_recipients WHERE campaign_id = ? AND state = 'skipped' AND verify_skip = 1").get(Number(id)).n;
    return { ready, checking: queued - ready, excluded };
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
        return { ok: true, to: r.email, ai: true, ...compose(t, { name: r.name, business: r.business, email: r.email }, c.config.signature) };
      } catch (err) {
        return { ok: false, error: `The AI could not write it: ${err.message}.` };
      }
    }
    const msg = compose({ subject: subject ?? c.subject, body: body ?? c.body }, { name: r?.name || null, business: r?.business || null, email: r?.email || 'recipient@example.com' }, c.config.signature);
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

module.exports = { EmailCampaigns, compose, render, emailOf, emailsOf, valuesOf, textToHtml, htmlToText, cleanHtml, dayOf, DEFAULTS, LIMITS, MAX_ATTEMPTS, UNSUBSCRIBE_TEXT };
