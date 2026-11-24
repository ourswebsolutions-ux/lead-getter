'use strict';

// Replies to email campaigns, read from each sending account's own inbox
// (IMAP over TLS, with the account's own login, kept in the vault). Only
// messages from people the account emailed are looked at; a reply is
// recorded on their email, and one asking to unsubscribe ("unsubscribe",
// "remove me", "not interested", "mat bhejo"...) opts them out of every
// campaign. Nothing is changed in the mailbox (messages are not marked
// read, moved or deleted) and nothing is downloaded beyond the first 64 KB
// of each matching message.
//
// A reply is found by its sender (someone the account emailed) or by the
// email it answers (its In-Reply-To / References: our campaign or test
// email), so a reply from another address of the same business counts too.
// Each account's inbox is also watched live (IMAP IDLE): a new message is
// read within seconds; the regular check below is the fallback.

const EVERY = 3 * 60_000;
const FIRST = 20_000;
const SETTLE = 2_000; // a new message: read after this (several arriving together: one read)
const LOOK_BACK = 14 * 24 * 3600_000;
const STATE_KEY = 'email.replies';
const BOUNCES_KEY = 'email.bounces'; // bounce reports already counted (Message-IDs)

// An unsubscribe request, in the subject or the reply's own text (quoted
// earlier messages are ignored).
const UNSUBSCRIBE = /\b(unsubscribe|un-subscribe|opt[\s-]?out|remove me|remove my (email|address)|take me off|stop (emailing|sending|contacting)|do not (email|contact)|don'?t (email|contact)|no more emails?|not interested|mat bhej(o|ain|en)?|band kar(o|do|ein)|nahi chahiye|نہیں چاہیے|ان سبسکرائب)\b/i;
const STOP_ONLY = /^\s*(stop|remove|unsubscribe|no)\s*[.!]?\s*$/i;

function ownText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*>/.test(l)) continue;
    // "On ... wrote:" (Gmail wraps it over two or three lines when long).
    if (/^\s*On\s.+/i.test(l) && [1, 2, 3].some((n) => /wrote:\s*$/i.test(lines.slice(i, i + n).join(' ')))) break;
    if (/^-{2,}\s*Original Message/i.test(l) || /^_{10,}\s*$/.test(l) || /^\s*From:\s/i.test(l)) break;
    out.push(l);
  }
  return out.join('\n').trim().slice(0, 2000);
}

// An automatic reply (out of office, autoresponder, vacation): by the
// headers mail systems set on them (RFC 3834 Auto-Submitted, Microsoft's
// and others'), or a subject that says so. Not a reply from a person.
function isAutoReply(headers = {}, subject = '') {
  const h = (k) => String(headers[k] ?? '').toLowerCase();
  if (/auto-(replied|generated|notified)/.test(h('auto-submitted'))) return true;
  if (h('x-autoreply') || h('x-autorespond') || h('x-autoresponder')) return true;
  if (/auto_reply|autoreply/.test(h('precedence')) || /oof|autoreply/i.test(h('x-auto-response-suppress')) && /out of office|automatic reply/i.test(subject)) return true;
  return /^\s*(automatic reply|auto(matic)?[- ]?(reply|response|antwort)|autoreply|out of (the )?office|away from (the )?office|on (vacation|leave|holiday)|abwesenheit|réponse automatique|respuesta automática|risposta automatica|ooo\b)|\bout of (the )?office\b/i.test(String(subject || ''));
}

// A delivery failure report (bounce) from a mail server: { email, messageId,
// permanent, reason }, or null. The failed address is read from the report
// (Final-Recipient, or the words of common mail systems); the email it is
// about by the Message-ID of the original message inside it.
function parseBounce(m) {
  const raw = String(m.raw || m.text || '');
  const subject = String(m.subject || '');
  const dsn = /mailer-daemon|postmaster|mail delivery (sub)?system/i.test(`${m.from} ${m.fromName || ''}`) || /report-type="?delivery-status/i.test(raw) || /^\s*(undeliverable|undelivered mail|delivery status notification|mail delivery failed|returned mail|failure notice|delivery failure|message not delivered|address not found|delivery has failed|non[- ]?delivery)/i.test(subject);
  if (!dsn) return null;
  const pick = (re) => re.exec(raw)?.[1]?.replace(/[>.,;]+$/, '').toLowerCase() || null;
  const email = pick(/Final-Recipient:\s*rfc822;\s*<?([^\s<>;]+@[^\s<>;]+)/i) || pick(/Original-Recipient:\s*rfc822;\s*<?([^\s<>;]+@[^\s<>;]+)/i) || pick(/(?:wasn'?t|was not|couldn'?t be|could not be|failed to be) delivered to\s*<?([^\s<>]+@[^\s<>]+)/i) || pick(/<([^\s<>]+@[^\s<>]+)>:?\s*(?:host|recipient|user|5\d\d|said)/i) || pick(/^\s*([^\s<>@]+@[^\s<>@]+\.[a-z]{2,})\s*$/im);
  const body = raw.slice(raw.search(/\r?\n\r?\n/) + 1);
  const messageId = /^Message-ID:\s*(<[^>\s]+>)/im.exec(body)?.[1] || null;
  const status = /^Status:\s*([245])\.\d{1,3}\.\d{1,3}/im.exec(raw)?.[1];
  const delay = /\(delay\)|delayed|will (keep trying|retry)|not yet been delivered/i.test(`${subject} ${raw.slice(0, 4000)}`);
  const permanent = status ? status === '5' : !delay && /\b5\.\d\.\d+\b|\b55\d\b|permanent|does not exist|doesn'?t exist|user unknown|address not found|no such user|mailbox unavailable|recipient rejected|invalid recipient/i.test(raw);
  const reason = (/^Diagnostic-Code:\s*[^;\n]*;\s*([^\n]+)/im.exec(raw)?.[1] || (permanent ? 'the address does not accept email' : 'a temporary delivery problem')).replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!email && !messageId) return null;
  return { email, messageId, permanent, reason };
}

// The Message-IDs a message answers (its In-Reply-To and References).
function answers(m) {
  const all = `${m.inReplyTo || ''} ${Array.isArray(m.references) ? m.references.join(' ') : m.references || ''}`;
  return [...new Set(all.match(/<[^<>\s]+>/g) || [])].slice(-30);
}

function isUnsubscribe(subject, text) {
  const own = ownText(text);
  return UNSUBSCRIBE.test(String(subject || '').replace(/^\s*(re|aw|fwd?)\s*:\s*/gi, '')) || UNSUBSCRIBE.test(own) || STOP_ONLY.test(own);
}

// The inbox through imapflow: async iterator of { from, subject, text, date }
// for messages received since `since`.
async function* imapInbox({ account, pass }, since, { allowInsecure = false } = {}) {
  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  const insecure = allowInsecure && account.imapHost === '127.0.0.1';
  const client = new ImapFlow({ host: account.imapHost, port: account.imapPort, secure: !insecure, auth: { user: account.username, pass }, logger: false, connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 60_000, disableAutoIdle: true });
  client.on('error', () => {}); // reported by the failed call below
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      const uids = (await client.search({ since: new Date(since) }, { uid: true })) || [];
      const recent = uids.slice(-300);
      if (!recent.length) return;
      for await (const msg of client.fetch(recent, { uid: true, envelope: true, source: { maxLength: 65_536 } }, { uid: true })) {
        const from = msg.envelope?.from?.[0]?.address || '';
        let text = '';
        let references = null;
        const headers = {};
        try {
          const parsed = await simpleParser(msg.source);
          text = parsed.text || '';
          references = parsed.references || null;
          for (const k of ['auto-submitted', 'x-autoreply', 'x-autorespond', 'x-autoresponder', 'precedence', 'x-auto-response-suppress']) {
            const v = parsed.headers?.get(k);
            if (v != null) headers[k] = typeof v === 'object' ? v.value || JSON.stringify(v) : String(v);
          }
        } catch {}
        const subject = msg.envelope?.subject || '';
        yield { from, fromName: msg.envelope?.from?.[0]?.name || '', subject, text, raw: msg.source ? msg.source.toString('utf8') : '', auto: isAutoReply(headers, subject), date: msg.envelope?.date ? new Date(msg.envelope.date).getTime() : null, messageId: msg.envelope?.messageId || `uid:${msg.uid}`, inReplyTo: msg.envelope?.inReplyTo || null, references };
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
}

// The inbox kept open (IMAP IDLE): onNew() when a message arrives, onClose()
// when the connection ends. -> Promise<{ close }>.
async function watchInbox({ account, pass }, { onNew, onClose }, { allowInsecure = false } = {}) {
  const { ImapFlow } = require('imapflow');
  const insecure = allowInsecure && account.imapHost === '127.0.0.1';
  const client = new ImapFlow({ host: account.imapHost, port: account.imapPort, secure: !insecure, auth: { user: account.username, pass }, logger: false, connectionTimeout: 20_000, greetingTimeout: 20_000, autoIdleDelay: 1_000, maxIdleTime: 4 * 60_000 });
  let closed = false;
  client.on('error', () => {}); // the connection ends: onClose
  client.on('exists', (e) => {
    if (!e || e.count > (e.prevCount || 0)) onNew();
  });
  client.on('close', () => {
    if (!closed) onClose();
    closed = true;
  });
  await client.connect();
  await client.mailboxOpen('INBOX', { readOnly: true });
  return {
    close() {
      closed = true;
      return client.logout().catch(() => client.close());
    },
  };
}

class ReplyWatcher {
  // accounts: EmailAccounts; campaigns: EmailCampaigns; state: { get, set };
  // openInbox(login, since) -> async iterator (imapInbox; replaceable in tests).
  // onReply({ accountId, from, subject, text, messageId, date }): a reply from
  // someone the account emailed (for the Inbox); onOther(same): any other
  // message (the admin answering a reply alert).
  // openWatch(login, { onNew, onClose }) -> Promise<{ close }> (watchInbox; null: no live watching).
  constructor({ accounts, campaigns, state, openInbox = imapInbox, openWatch = null, clock = () => Date.now(), log = () => {}, every = EVERY, first = FIRST, onReply = null, onOther = null }) {
    Object.assign(this, { accounts, campaigns, state, openInbox, openWatch, clock, log, every, first, onReply, onOther });
    this.timer = null;
    this.running = null;
    this.checking = new Map(); // account id -> its check now
    this.live = new Map(); // account id -> { conn, retry, wait, due, stopped }
    this.stopped = true; // until start()
  }

  start() {
    this.stopped = false;
    const loop = () => {
      this.timer = setTimeout(async () => {
        await this.checkAll().catch((err) => this.log(`email replies: ${err.message}`));
        this.syncLive();
        loop();
      }, this.timer ? this.every : this.first);
      this.timer.unref?.();
    };
    loop();
    this.syncLive();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    for (const id of [...this.live.keys()]) this.unwatch(id);
  }

  // Accounts whose replies are looked for: reading replies on, and campaign
  // or test emails sent from them.
  watched(accountId) {
    return Boolean(this.accounts.inbox(accountId)) && (this.campaigns.sentAddresses(accountId).size > 0 || Boolean(this.campaigns.hasTestSends?.(accountId)));
  }

  // Live watching for every account that needs it (none for the others).
  syncLive() {
    if (!this.openWatch || this.stopped) return;
    const want = new Set(this.accounts.list().map((a) => a.id).filter((id) => this.watched(id)));
    for (const id of this.live.keys()) if (!want.has(id)) this.unwatch(id);
    for (const id of want) if (!this.live.has(id)) this.watch(id);
  }

  watch(accountId) {
    const w = { conn: null, retry: null, wait: 30_000, due: null, stopped: false };
    this.live.set(accountId, w);
    const again = () => {
      if (w.stopped || this.stopped) return;
      w.conn = null;
      clearTimeout(w.retry);
      w.retry = setTimeout(open, w.wait);
      w.retry.unref?.();
      w.wait = Math.min(w.wait * 2, 15 * 60_000);
    };
    const open = async () => {
      const login = this.accounts.inbox(accountId);
      if (!login || w.stopped) return void this.live.delete(accountId);
      try {
        const conn = await this.openWatch(login, { onNew: () => this.soon(accountId), onClose: again });
        if (w.stopped) return void conn.close();
        w.conn = conn;
        w.wait = 30_000;
        this.soon(accountId); // anything that came while not watching
      } catch {
        again(); // the regular check reports the inbox's problem
      }
    };
    open();
  }

  unwatch(accountId) {
    const w = this.live.get(accountId);
    if (!w) return;
    w.stopped = true;
    clearTimeout(w.retry);
    clearTimeout(w.due);
    w.conn?.close();
    this.live.delete(accountId);
  }

  // A new message in an account's inbox: read it shortly.
  soon(accountId) {
    const w = this.live.get(accountId);
    if (!w || w.due) return;
    w.due = setTimeout(() => {
      w.due = null;
      this.check(accountId).catch((err) => this.log(`email replies: ${err.message}`));
    }, SETTLE);
    w.due.unref?.();
  }

  // Every account that sent campaign emails. Resolves { checked, replies, unsubscribed }.
  checkAll() {
    if (this.running) return this.running;
    this.running = (async () => {
      const total = { checked: 0, replies: 0, unsubscribed: 0 };
      for (const a of this.accounts.list()) {
        const r = await this.check(a.id);
        if (!r.skipped) total.checked++;
        total.replies += r.replies || 0;
        total.unsubscribed += r.unsubscribed || 0;
      }
      return total;
    })().finally(() => (this.running = null));
    return this.running;
  }

  // One check at a time per account (a live alert during a regular check: read again after it).
  check(accountId) {
    const now = this.checking.get(accountId);
    if (now) {
      now.again = true;
      return now.p;
    }
    const entry = { again: false, p: null };
    entry.p = (async () => {
      let r;
      do {
        entry.again = false;
        r = await this.checkOnce(accountId);
      } while (entry.again);
      return r;
    })().finally(() => this.checking.delete(accountId));
    this.checking.set(accountId, entry);
    return entry.p;
  }

  async checkOnce(accountId) {
    const login = this.accounts.inbox(accountId);
    if (!login) return { skipped: true };
    const sent = this.campaigns.sentAddresses(accountId);
    if (!sent.size && !this.campaigns.hasTestSends?.(accountId)) return { skipped: true };
    const own = String(login.account.email || '').toLowerCase();
    const seen = this.state.get(STATE_KEY) || {};
    const since = Math.max(seen[accountId] || 0, this.clock() - LOOK_BACK) - 24 * 3600_000; // IMAP SINCE is by day
    const started = this.clock();
    let replies = 0;
    let unsubscribed = 0;
    let bounces = 0;
    try {
      for await (const m of this.openInbox(login, since)) {
        const from = String(m.from || '').trim().toLowerCase();
        // A delivery failure report about one of our emails: a bounce.
        const bounce = parseBounce(m);
        if (bounce) {
          const seenB = this.state.get(BOUNCES_KEY) || [];
          if (!seenB.includes(m.messageId)) {
            const r = this.campaigns.recordBounce?.(bounce);
            if (r?.ok) {
              bounces++;
              this.state.set(BOUNCES_KEY, [...seenB, m.messageId].slice(-1000));
            }
          }
          continue;
        }
        // The email it answers: one of ours (campaign or test), else its sender.
        const match = this.campaigns.sentByMessageId?.(answers(m)) || null;
        if (!match && (!sent.has(from) || from === own)) {
          await Promise.resolve(this.onOther?.({ accountId, from, subject: m.subject, text: ownText(m.text), messageId: m.messageId, date: m.date })).catch(() => {});
          continue;
        }
        const recipient = match?.email || from;
        // An automatic reply (out of office): noted; the sequence goes on, no Inbox alert.
        if (m.auto) {
          if (!match?.test) this.campaigns.recordAutoReply?.(recipient, { campaignId: match?.campaignId || null, at: m.date || this.clock() });
          continue;
        }
        // A reply to a test email (the user's own address) never unsubscribes anyone.
        const unsubscribe = !match?.test && isUnsubscribe(m.subject, m.text);
        const r = match?.test ? {} : this.campaigns.recordReply(recipient, { subject: m.subject, unsubscribe, at: m.date || this.clock() });
        // Shown in the Inbox, an unsubscribe request too (the person is opted out already).
        const text = ownText(m.text) || String(m.text || '').trim().slice(0, 2000) || String(m.subject || '').trim();
        await Promise.resolve(this.onReply?.({ accountId, from, recipient, match, subject: m.subject, text, unsubscribe, messageId: m.messageId, date: m.date })).catch(() => {});
        if (r.first) replies++;
        if (r.unsubscribed) unsubscribed++;
      }
      this.accounts.setImapStatus(accountId, 'ok', 'Replies checked');
      this.state.set(STATE_KEY, { ...(this.state.get(STATE_KEY) || {}), [accountId]: started });
      if (replies || unsubscribed || bounces) this.log(`email replies: ${replies} new, ${unsubscribed} unsubscribed, ${bounces} bounced`);
      return { replies, unsubscribed, ...(bounces ? { bounces } : {}) };
    } catch (err) {
      const why = /auth|login|credentials|invalid/i.test(`${err.authenticationFailed ? 'auth' : ''} ${err.responseText || err.message}`) ? 'the inbox rejected the login (IMAP may be off for this account)' : /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|timeout/i.test(`${err.code} ${err.message}`) ? 'the inbox server could not be reached' : 'the inbox could not be read';
      this.accounts.setImapStatus(accountId, 'failed', why);
      this.log(`email replies: ${why}`);
      return { error: why };
    }
  }
}

module.exports = { ReplyWatcher, imapInbox, watchInbox, isUnsubscribe, isAutoReply, parseBounce, ownText, answers };
