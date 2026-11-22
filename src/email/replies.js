'use strict';

// Replies to email campaigns, read from each sending account's own inbox
// (IMAP over TLS, with the account's own login, kept in the vault). Only
// messages from people the account emailed are looked at; a reply is
// recorded on their email, and one asking to unsubscribe ("unsubscribe",
// "remove me", "not interested", "mat bhejo"...) opts them out of every
// campaign. Nothing is changed in the mailbox (messages are not marked
// read, moved or deleted) and nothing is downloaded beyond the first 64 KB
// of each matching message.

const EVERY = 10 * 60_000;
const FIRST = 60_000;
const LOOK_BACK = 14 * 24 * 3600_000;
const STATE_KEY = 'email.replies';

// An unsubscribe request, in the subject or the reply's own text (quoted
// earlier messages are ignored).
const UNSUBSCRIBE = /\b(unsubscribe|un-subscribe|opt[\s-]?out|remove me|remove my (email|address)|take me off|stop (emailing|sending|contacting)|do not (email|contact)|don'?t (email|contact)|no more emails?|not interested|mat bhej(o|ain|en)?|band kar(o|do|ein)|nahi chahiye|نہیں چاہیے|ان سبسکرائب)\b/i;
const STOP_ONLY = /^\s*(stop|remove|unsubscribe|no)\s*[.!]?\s*$/i;

function ownText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) continue;
    if (/^\s*On .+wrote:\s*$/i.test(l) || /^-{2,}\s*Original Message/i.test(l) || /^\s*From:\s/i.test(l)) break;
    out.push(l);
  }
  return out.join('\n').trim().slice(0, 2000);
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
        try {
          text = (await simpleParser(msg.source)).text || '';
        } catch {}
        yield { from, subject: msg.envelope?.subject || '', text, date: msg.envelope?.date ? new Date(msg.envelope.date).getTime() : null, messageId: msg.envelope?.messageId || `uid:${msg.uid}` };
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
}

class ReplyWatcher {
  // accounts: EmailAccounts; campaigns: EmailCampaigns; state: { get, set };
  // openInbox(login, since) -> async iterator (imapInbox; replaceable in tests).
  // onReply({ accountId, from, subject, text, messageId, date }): a reply from
  // someone the account emailed (for the Inbox); onOther(same): any other
  // message (the admin answering a reply alert).
  constructor({ accounts, campaigns, state, openInbox = imapInbox, clock = () => Date.now(), log = () => {}, every = EVERY, first = FIRST, onReply = null, onOther = null }) {
    Object.assign(this, { accounts, campaigns, state, openInbox, clock, log, every, first, onReply, onOther });
    this.timer = null;
    this.running = null;
  }

  start() {
    const loop = () => {
      this.timer = setTimeout(async () => {
        await this.checkAll().catch((err) => this.log(`email replies: ${err.message}`));
        loop();
      }, this.timer ? this.every : this.first);
      this.timer.unref?.();
    };
    loop();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
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

  async check(accountId) {
    const login = this.accounts.inbox(accountId);
    if (!login) return { skipped: true };
    const sent = this.campaigns.sentAddresses(accountId);
    if (!sent.size) return { skipped: true };
    const seen = this.state.get(STATE_KEY) || {};
    const since = Math.max(seen[accountId] || 0, this.clock() - LOOK_BACK) - 24 * 3600_000; // IMAP SINCE is by day
    const started = this.clock();
    let replies = 0;
    let unsubscribed = 0;
    try {
      for await (const m of this.openInbox(login, since)) {
        const from = String(m.from || '').trim().toLowerCase();
        if (!sent.has(from)) {
          await Promise.resolve(this.onOther?.({ accountId, from, subject: m.subject, text: ownText(m.text), messageId: m.messageId, date: m.date })).catch(() => {});
          continue;
        }
        const unsubscribe = isUnsubscribe(m.subject, m.text);
        const r = this.campaigns.recordReply(from, { subject: m.subject, unsubscribe, at: m.date || this.clock() });
        if (!unsubscribe) await Promise.resolve(this.onReply?.({ accountId, from, subject: m.subject, text: ownText(m.text), messageId: m.messageId, date: m.date })).catch(() => {});
        if (r.first) replies++;
        if (r.unsubscribed) unsubscribed++;
      }
      this.accounts.setImapStatus(accountId, 'ok', 'Replies checked');
      this.state.set(STATE_KEY, { ...(this.state.get(STATE_KEY) || {}), [accountId]: started });
      if (replies || unsubscribed) this.log(`email replies: ${replies} new, ${unsubscribed} unsubscribed`);
      return { replies, unsubscribed };
    } catch (err) {
      const why = /auth|login|credentials|invalid/i.test(`${err.authenticationFailed ? 'auth' : ''} ${err.responseText || err.message}`) ? 'the inbox rejected the login (IMAP may be off for this account)' : /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|timeout/i.test(`${err.code} ${err.message}`) ? 'the inbox server could not be reached' : 'the inbox could not be read';
      this.accounts.setImapStatus(accountId, 'failed', why);
      this.log(`email replies: ${why}`);
      return { error: why };
    }
  }
}

module.exports = { ReplyWatcher, imapInbox, isUnsubscribe, ownText };
