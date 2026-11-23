'use strict';

// Email verification before outreach: every address a campaign may email is
// checked first, and only addresses that pass are ever sent to.
//
// The checks, in order:
//   syntax      a well-formed address (else: invalid, no network used)
//   disposable  a throwaway mail service (the list of FGRibreau/mailchecker,
//               MIT, also used by Reacher): risky, no network used
//   DNS / MX    the domain exists and has a mail server (none: invalid)
//   mailbox     the domain's mail server is asked whether the mailbox exists
//               (SMTP RCPT TO, no message sent), with a random address first
//               to recognise servers that accept every address (catch-all);
//               either from this computer (src/browser/email-verify.js) or
//               through the user's own Reacher server (reacherhq/
//               check-if-email-exists, MIT) when this computer cannot reach
//               mail servers on port 25
//   role        info@, sales@ ... (Reacher's list, src/email/data/roles.txt):
//               shown; counted as risky only when the user asks
//
// Statuses: valid (the mail server confirmed the mailbox), invalid, risky
// (disposable, full mailbox, or a role address when asked), unknown (no
// clear answer: a timeout, a blocked connection, a refusal for the sender's
// reputation, never taken as "invalid"), catch_all (the server accepts any
// address). Only valid is sent to; risky, unknown and catch-all can each be
// allowed by the user; invalid never.
//
// Results are kept (valid 30 days, invalid 90, risky and catch-all 30,
// unknown 1) and an address is not checked again before then. Temporary
// answers (greylisting, timeouts, DNS failures) are asked again later, up to
// three times. Each domain is asked one conversation at a time, a few
// seconds apart, and a few domains at once.

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { EmailVerifier, validSyntax } = require('../browser/email-verify');

const DAY = 24 * 3600_000;
const TTL = { valid: 30 * DAY, invalid: 90 * DAY, risky: 30 * DAY, catch_all: 30 * DAY, unknown: DAY };
const RETRY = [15 * 60_000, 60 * 60_000, 6 * 3600_000]; // temporary answers asked again after
const STATUSES = ['valid', 'invalid', 'risky', 'unknown', 'catch_all'];
const OPTIONAL = ['risky', 'unknown', 'catch_all']; // the user may allow these
const STATE_KEY = 'email.verification';
const SECRET_KEY = 'email.reacherSecret';
const PER_SESSION = 10; // addresses of one domain asked in one conversation
const DOMAIN_GAP = 3_000; // between two conversations with the same domain
const ENGINE_LIFE = 3600_000; // its knowledge of domains (catch-all, port 25 blocked) is renewed hourly
const LOG_KEEP = 2000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS email_verifications (
  email TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  status TEXT,
  reason TEXT,
  code INTEGER,
  detail TEXT,
  role INTEGER NOT NULL DEFAULT 0,
  disposable INTEGER NOT NULL DEFAULT 0,
  engine TEXT,
  checked_at INTEGER,
  expires_at INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS email_verifications_due ON email_verifications (state, next_at);
CREATE INDEX IF NOT EXISTS email_verifications_status ON email_verifications (status);
CREATE TABLE IF NOT EXISTS email_verify_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  detail TEXT
);
`;

let roles = null;
function isRole(email) {
  roles ||= new Set(fs.readFileSync(path.join(__dirname, 'data', 'roles.txt'), 'utf8').split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter(Boolean));
  const local = String(email).split('@')[0].toLowerCase();
  return roles.has(local) || roles.has(local.split('+')[0]);
}

let disposableSet = null;
function isDisposable(email) {
  disposableSet ||= require('mailchecker/platform/node').blacklist();
  let d = String(email).split('@')[1] || '';
  for (;;) {
    if (disposableSet.has(d)) return true;
    const i = d.indexOf('.');
    if (i < 0) return false;
    d = d.slice(i + 1);
  }
}

const normal = (e) => String(e || '').trim().toLowerCase();

class EmailVerification extends EventEmitter {
  // db: node:sqlite; state: { get, set } (app_state); vault: { get, set, delete } for the Reacher secret;
  // makeEngine(opts) -> an EmailVerifier (tests: one talking to a local mail server);
  // newEmails(limit) -> addresses of saved leads never checked; sender() -> an address for MAIL FROM.
  constructor({ db, state, vault = null, makeEngine = (o) => new EmailVerifier(o), newEmails = () => [], sender = () => '', clock = () => Date.now(), log = () => {}, concurrency = 3, sweepEvery = 60_000 }) {
    super();
    Object.assign(this, { db, state, vault, makeEngine, newEmails, sender, clock, logLine: log, concurrency, sweepEvery });
    this.db.exec(SCHEMA);
    // Interrupted checks (the app ended) are asked again.
    this.db.prepare("UPDATE email_verifications SET state = 'queued' WHERE state = 'checking'").run();
    this.engine = null;
    this.engineAt = 0;
    this.port25 = 'unknown'; // ok | blocked | unknown (only for checks from this computer)
    this.busyDomains = new Set();
    this.domainNext = new Map();
    this.running = 0;
    this.waiters = new Map(); // email -> [resolve]
    this.timer = null;
    this.sweepTimer = null;
    this.started = false;
    this.session = { done: 0 }; // checks finished since the queue was last empty
  }

  // --- settings ------------------------------------------------------------------------

  settings() {
    const s = this.state.get(STATE_KEY) || {};
    const allow = {};
    for (const k of OPTIONAL) allow[k] = s.allow?.[k] === true;
    return { engine: s.engine === 'reacher' ? 'reacher' : 'local', reacherUrl: typeof s.reacherUrl === 'string' ? s.reacherUrl : '', hasSecret: Boolean(this.secret()), allow, roleRisky: s.roleRisky === true };
  }

  secret() {
    try {
      return this.vault?.get(SECRET_KEY) || null;
    } catch {
      return null;
    }
  }

  // patch: { engine, reacherUrl, secret ('' removes it), allow: { risky, unknown, catch_all }, roleRisky }.
  save(patch = {}) {
    const prev = this.settings();
    const next = { ...prev, allow: { ...prev.allow } };
    if (patch.engine === 'local' || patch.engine === 'reacher') next.engine = patch.engine;
    if (typeof patch.reacherUrl === 'string') {
      const raw = patch.reacherUrl.trim();
      if (raw) {
        let u;
        try {
          u = new URL(raw);
        } catch {}
        if (!u || !/^https?:$/.test(u.protocol)) return { ok: false, error: 'The Reacher address must start with http:// or https://' };
        next.reacherUrl = u.toString().replace(/\/$/, '');
      } else next.reacherUrl = '';
    }
    if (next.engine === 'reacher' && !next.reacherUrl) return { ok: false, error: 'Enter your Reacher server’s address.' };
    if (patch.allow && typeof patch.allow === 'object') for (const k of OPTIONAL) if (typeof patch.allow[k] === 'boolean') next.allow[k] = patch.allow[k];
    if (typeof patch.roleRisky === 'boolean') next.roleRisky = patch.roleRisky;
    if (typeof patch.secret === 'string' && this.vault) {
      if (patch.secret.trim()) this.vault.set(SECRET_KEY, patch.secret.trim().slice(0, 500));
      else this.vault.delete?.(SECRET_KEY);
    }
    this.state.set(STATE_KEY, { engine: next.engine, reacherUrl: next.reacherUrl, allow: next.allow, roleRisky: next.roleRisky });
    const engineChanged = next.engine !== prev.engine || next.reacherUrl !== prev.reacherUrl || typeof patch.secret === 'string';
    if (engineChanged) {
      this.engine = null;
      this.port25 = 'unknown';
      // Addresses the old way could not answer for are asked again the new way.
      this.db.prepare("UPDATE email_verifications SET state = 'queued', attempts = 0, next_at = 0, expires_at = 0 WHERE status = 'unknown' OR (status IS NULL AND state = 'done')").run();
      this.kick();
    }
    // Role addresses: their status follows the setting at once.
    if (next.roleRisky !== prev.roleRisky) {
      if (next.roleRisky) this.db.prepare("UPDATE email_verifications SET status = 'risky', reason = 'a role address (info@, sales@...): set as risky in the verification settings' WHERE role = 1 AND status = 'valid'").run();
      else this.db.prepare("UPDATE email_verifications SET status = 'valid', reason = 'the mail server confirmed the mailbox' WHERE role = 1 AND status = 'risky' AND disposable = 0 AND reason LIKE 'a role address%'").run();
    }
    this.emit('policy', this.settings());
    this.emit('change');
    return { ok: true, settings: this.settings() };
  }

  // The statuses that may be emailed (valid always; the others when allowed).
  allowed() {
    const s = this.settings();
    return ['valid', ...OPTIONAL.filter((k) => s.allow[k])];
  }

  // --- results -------------------------------------------------------------------------

  row(email) {
    return this.db.prepare('SELECT * FROM email_verifications WHERE email = ?').get(normal(email)) || null;
  }

  static view(r, now) {
    if (!r) return { status: null, state: 'none' };
    return { status: r.status, reason: r.reason, code: r.code, detail: r.detail, role: Boolean(r.role), disposable: Boolean(r.disposable), engine: r.engine, checkedAt: r.checked_at, expiresAt: r.expires_at, fresh: Boolean(r.status) && r.expires_at > now, state: r.state, nextAt: r.state === 'queued' && r.attempts ? r.next_at : null };
  }

  statusOf(email) {
    return EmailVerification.view(this.row(email), this.clock());
  }

  // Map(email -> view) for many addresses.
  lookup(emails) {
    const now = this.clock();
    const out = new Map();
    const list = [...new Set([...emails].map(normal).filter(Boolean))];
    for (let i = 0; i < list.length; i += 500) {
      const part = list.slice(i, i + 500);
      for (const r of this.db.prepare(`SELECT * FROM email_verifications WHERE email IN (${part.map(() => '?').join(',')})`).all(...part)) out.set(r.email, EmailVerification.view(r, now));
    }
    return out;
  }

  // May a campaign email go to this address now? (Its result is fresh and allowed.)
  allows(email) {
    const r = this.row(email);
    return Boolean(r && r.status && r.expires_at > this.clock() && this.allowed().includes(r.status));
  }

  // A fresh result that is not allowed: never sent (shown with its reason).
  excluded(email) {
    const r = this.row(email);
    return Boolean(r && r.status && r.expires_at > this.clock() && !this.allowed().includes(r.status) && r.state === 'done');
  }

  // Totals over every address checked or waiting: { valid, invalid, risky, unknown, catch_all, queued, checking, total }.
  counts() {
    const out = { valid: 0, invalid: 0, risky: 0, unknown: 0, catch_all: 0, queued: 0, checking: 0, total: 0 };
    for (const r of this.db.prepare('SELECT status, state, COUNT(*) AS n FROM email_verifications GROUP BY status, state').all()) {
      out.total += r.n;
      if (r.state === 'queued') out.queued += r.n;
      else if (r.state === 'checking') out.checking += r.n;
      else if (r.status && r.status in out) out[r.status] += r.n;
    }
    return out;
  }

  status() {
    const s = this.settings();
    const c = this.counts();
    const pending = c.queued + c.checking;
    return { settings: s, counts: c, allowed: this.allowed(), port25: s.engine === 'local' ? this.port25 : null, progress: { pending, done: this.session.done, total: this.session.done + pending }, running: this.started };
  }

  logs(limit = 100) {
    return this.db.prepare('SELECT at, email, status, reason, detail FROM email_verify_log ORDER BY id DESC LIMIT ?').all(limit);
  }

  // --- queue ---------------------------------------------------------------------------

  // Addresses to check (those with a fresh result, or already waiting, are left alone).
  enqueue(emails, { priority = 0, force = false } = {}) {
    const now = this.clock();
    const ins = this.db.prepare("INSERT INTO email_verifications (email, domain, state, priority, added_at) VALUES (?, ?, 'queued', ?, ?) ON CONFLICT (email) DO NOTHING");
    const again = this.db.prepare(`UPDATE email_verifications SET state = 'queued', attempts = 0, next_at = 0, priority = MAX(priority, ?) WHERE email = ? AND state = 'done' AND (${force ? '1' : 'expires_at <= ?'})`);
    const raise = this.db.prepare("UPDATE email_verifications SET priority = MAX(priority, ?) WHERE email = ? AND state = 'queued'");
    let added = 0;
    this.db.exec('BEGIN');
    try {
      for (const raw of emails) {
        const e = normal(raw);
        if (!e || e.length > 254) continue;
        const domain = e.split('@')[1] || '';
        if (ins.run(e, domain, priority, now).changes) added++;
        else if ((force ? again.run(priority, e) : again.run(priority, e, now)).changes) added++;
        else if (priority) raise.run(priority, e);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    if (added) {
      this.emit('change');
      this.kick();
    }
    return added;
  }

  // Checks these addresses first and waits for them (at most `timeout`): Map(email -> view).
  async ensure(emails, { timeout = 30_000 } = {}) {
    const list = [...new Set([...emails].map(normal).filter(Boolean))];
    this.enqueue(list, { priority: 9 });
    const now = this.clock();
    const waiting = list.filter((e) => {
      const r = this.row(e);
      return r && (r.state !== 'done' || !(r.expires_at > now)) && !(r.state === 'queued' && r.attempts > 0 && r.next_at > now);
    });
    if (waiting.length) {
      await new Promise((resolve) => {
        let left = waiting.length;
        const t = setTimeout(done, timeout);
        t.unref?.();
        function done() {
          clearTimeout(t);
          resolve();
        }
        for (const e of waiting) {
          const arr = this.waiters.get(e) || [];
          arr.push(() => --left <= 0 && done());
          this.waiters.set(e, arr);
        }
        this.kick();
      });
    }
    return this.lookup(list);
  }

  // Checked again now: every address, or those with these statuses.
  recheck(statuses = null) {
    const list = Array.isArray(statuses) ? statuses.filter((s) => STATUSES.includes(s)) : null;
    const where = list ? `status IN (${list.map(() => '?').join(',')})` : 'status IS NOT NULL';
    const n = this.db.prepare(`UPDATE email_verifications SET state = 'queued', attempts = 0, next_at = 0, expires_at = 0, priority = MAX(priority, 1) WHERE state = 'done' AND ${where}`).run(...(list || [])).changes;
    this.engine = null; // what it learnt about domains is forgotten too
    this.emit('change');
    this.kick();
    return n;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.kick();
    const sweep = () => {
      this.sweepTimer = setTimeout(() => {
        this.sweep();
        sweep();
      }, this.sweepEvery);
      this.sweepTimer.unref?.();
    };
    this.sweep();
    sweep();
  }

  stop() {
    this.started = false;
    clearTimeout(this.timer);
    clearTimeout(this.sweepTimer);
    this.timer = null;
  }

  // Newly found lead emails: checked in the background.
  sweep() {
    try {
      const list = this.newEmails(500) || [];
      if (list.length) this.enqueue(list);
    } catch (err) {
      this.logLine(`email verification: leads not read: ${err.message}`);
    }
  }

  kick() {
    if (!this.started && !this.waiters.size) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.pump(), 0);
    this.timer.unref?.();
  }

  engineNow() {
    const now = Date.now();
    if (!this.engine || now - this.engineAt > ENGINE_LIFE) {
      const s = this.settings();
      const from = normal(this.sender());
      this.engine = this.makeEngine({ from: validSyntax(from) ? from : '', ...(s.engine === 'reacher' ? { reacherUrl: s.reacherUrl, reacherSecret: this.secret() } : {}) });
      this.engineAt = now;
    }
    return this.engine;
  }

  // Starts checks for due addresses: a few domains at once, each one at a time.
  pump() {
    const now = this.clock();
    const real = Date.now(); // the pace towards each domain is real time
    if (this.running >= this.concurrency) return;
    const due = this.db.prepare("SELECT email, domain FROM email_verifications WHERE state = 'queued' AND next_at <= ? ORDER BY priority DESC, added_at, email LIMIT 400").all(now);
    let soonest = Infinity;
    const byDomain = new Map();
    for (const r of due) {
      if (this.busyDomains.has(r.domain)) continue;
      const at = this.domainNext.get(r.domain) || 0;
      if (at > real) {
        soonest = Math.min(soonest, now + (at - real));
        continue;
      }
      if (!byDomain.has(r.domain)) byDomain.set(r.domain, []);
      const arr = byDomain.get(r.domain);
      if (arr.length < PER_SESSION) arr.push(r.email);
    }
    for (const [domain, emails] of byDomain) {
      if (this.running >= this.concurrency) break;
      this.running++;
      this.busyDomains.add(domain);
      this.checkBatch(domain, emails)
        .catch((err) => this.logLine(`email verification: ${err.message}`))
        .finally(() => {
          this.running--;
          this.busyDomains.delete(domain);
          this.domainNext.set(domain, Date.now() + DOMAIN_GAP);
          this.kick();
        });
    }
    // Later: the next domain's turn, or the next retry.
    const retry = this.db.prepare("SELECT MIN(next_at) AS t FROM email_verifications WHERE state = 'queued' AND next_at > ?").get(now)?.t;
    const next = Math.min(soonest, retry || Infinity);
    if (next < Infinity && (this.started || this.waiters.size)) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.pump(), Math.max(200, next - now + 50));
      this.timer.unref?.();
    }
    if (!due.length && !this.running) this.session.done = 0;
  }

  async checkBatch(domain, emails) {
    const mark = this.db.prepare("UPDATE email_verifications SET state = 'checking' WHERE email = ? AND state = 'queued'");
    for (const e of emails) mark.run(e);
    this.emit('change');
    // No network needed: malformed and disposable addresses.
    const results = new Map();
    const ask = [];
    for (const e of emails) {
      if (!validSyntax(e)) results.set(e, { status: 'invalid', reason: 'not a valid email address' });
      else if (isDisposable(e)) results.set(e, { status: 'risky', reason: 'a disposable (temporary) email service', disposable: true });
      else ask.push(e);
    }
    const s = this.settings();
    const engineName = s.engine === 'reacher' ? 'reacher' : 'local';
    if (ask.length) {
      const engine = this.engineNow();
      // Asked for real each time (its own memory of answers is for one search only).
      for (const e of ask) engine.results?.delete(e);
      let got;
      try {
        got = await engine.checkDomain(domain, ask);
      } catch (err) {
        got = new Map(ask.map((e) => [e, { status: 'unknown', reason: `the check failed: ${err.message}`, temporary: true }]));
      }
      if (engineName === 'local') {
        if (engine.blocked) this.port25 = 'blocked';
        else if ([...got.values()].some((r) => r.code || ['verified', 'catch_all'].includes(r.status) || (r.status === 'invalid' && /mailbox/.test(r.reason || '')))) this.port25 = 'ok';
      }
      for (const e of ask) results.set(e, got.get(e) || { status: 'unknown', reason: 'no answer', temporary: true });
    }
    const now = this.clock();
    const done = this.db.prepare("UPDATE email_verifications SET status = ?, reason = ?, code = ?, detail = ?, role = ?, disposable = ?, engine = ?, checked_at = ?, expires_at = ?, state = 'done', attempts = attempts + 1, next_at = 0 WHERE email = ?");
    const later = this.db.prepare("UPDATE email_verifications SET reason = ?, code = ?, detail = ?, engine = ?, checked_at = ?, state = 'queued', attempts = attempts + 1, next_at = ? WHERE email = ?");
    const logIns = this.db.prepare('INSERT INTO email_verify_log (at, email, status, reason, detail) VALUES (?, ?, ?, ?, ?)');
    const finished = [];
    for (const e of emails) {
      const r = results.get(e);
      const before = this.row(e);
      const role = isRole(e) || Boolean(r.role);
      const disposable = Boolean(r.disposable) || isDisposable(e);
      // Asked again later: a temporary answer, while tries are left (not when port 25 is blocked: that does not pass).
      if (r.status === 'unknown' && r.temporary && !r.blocked && (before?.attempts || 0) < RETRY.length) {
        const at = now + RETRY[before?.attempts || 0];
        later.run(r.reason, r.code || null, r.detail || null, engineName, now, at, e);
        logIns.run(now, e, 'retry', `${r.reason}; asked again at ${new Date(at).toISOString()}`, r.detail || null);
        continue;
      }
      let status;
      let reason = r.reason;
      if (r.status === 'verified') {
        status = 'valid';
        if (disposable) [status, reason] = ['risky', 'a disposable (temporary) email service'];
        else if (role && s.roleRisky) [status, reason] = ['risky', 'a role address (info@, sales@...): set as risky in the verification settings'];
      } else if (r.status === 'invalid') status = 'invalid';
      else if (r.status === 'catch_all') status = 'catch_all';
      else if (r.status === 'risky') status = 'risky';
      else if (r.fullInbox) status = 'risky';
      else status = 'unknown';
      done.run(status, reason || null, r.code || null, r.detail || null, role ? 1 : 0, disposable ? 1 : 0, engineName, now, now + TTL[status], e);
      logIns.run(now, e, status, reason || null, r.detail || null);
      finished.push({ email: e, status });
      this.session.done++;
    }
    this.db.prepare(`DELETE FROM email_verify_log WHERE id <= (SELECT MAX(id) FROM email_verify_log) - ${LOG_KEEP}`).run();
    for (const e of emails) {
      const r = this.row(e);
      if (r?.state === 'done' || (r?.state === 'queued' && r.attempts > 0)) {
        for (const fn of this.waiters.get(e) || []) fn();
        this.waiters.delete(e);
      }
    }
    if (finished.length) this.emit('verified', finished);
    this.emit('change');
  }
}

// The address of a lead a campaign would email, chosen with the results:
// an address that may be emailed first, then one still to be checked, then
// (excluded) the first. emails: the lead's addresses in its own order.
function chooseEmail(emails, verification) {
  if (!emails.length) return { email: '', state: 'none' };
  if (!verification) return { email: emails[0], state: 'unchecked' };
  const seen = verification.lookup(emails);
  const allowed = verification.allowed();
  const ok = emails.find((e) => {
    const v = seen.get(e);
    return v && v.fresh && allowed.includes(v.status);
  });
  if (ok) return { email: ok, state: 'allowed' };
  const open = emails.find((e) => {
    const v = seen.get(e);
    return !v || !v.fresh || v.state !== 'done';
  });
  if (open) return { email: open, state: 'unchecked' };
  return { email: emails[0], state: 'excluded', status: seen.get(emails[0])?.status, reason: seen.get(emails[0])?.reason };
}

module.exports = { EmailVerification, chooseEmail, isRole, isDisposable, STATUSES, TTL };
