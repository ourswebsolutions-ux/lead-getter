'use strict';

// Subscription data in a local SQLite file (node:sqlite, no extra
// dependency). Times are ISO strings from the server clock, so tests can
// control them; ISO strings in UTC compare correctly as text.
//
// Everything that must happen once (an open activation request per
// installation, using a one-time code, charging a lead) is a conditional
// write or a unique key inside a transaction, so concurrent requests can't
// both succeed.

const { DatabaseSync } = require('node:sqlite');
const { PLANS, planExpiry } = require('./plans');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  public_key   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS seen_requests (
  sig_hash   TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
-- The plan an installation has (no row: Free).
CREATE TABLE IF NOT EXISTS subscriptions (
  device_id     TEXT PRIMARY KEY REFERENCES devices(id),
  plan          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'inactive')),
  activation_id TEXT,
  activated_at  TEXT,
  expires_at    TEXT,
  suspended_at  TEXT,
  updated_at    TEXT NOT NULL
);
-- Activation requests: the plan asked for and the current 4-digit code
-- (as a hash), which is emailed to the administrator only. open_for is the
-- device id while the request is open and NULL afterwards: one open request
-- per installation.
CREATE TABLE IF NOT EXISTS activations (
  id               TEXT PRIMARY KEY,
  device_id        TEXT NOT NULL REFERENCES devices(id),
  machine_id       TEXT NOT NULL,
  open_for         TEXT UNIQUE,
  plan             TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending', 'activated', 'cancelled', 'expired')),
  otp_hash         TEXT,
  otp_expires_at   TEXT,
  otp_attempts     INTEGER NOT NULL DEFAULT 0,
  otp_sent_at      TEXT,
  otp_sends        INTEGER NOT NULL DEFAULT 0,
  otp_window_start TEXT,
  created_at       TEXT NOT NULL,
  activated_at     TEXT
);
CREATE INDEX IF NOT EXISTS activations_device ON activations (device_id, created_at);
-- Daily qualified-lead allowance: one counter per account, day and bucket
-- (total, or maps/facebook for Free), and every charged lead once per
-- account (a retry, restart or the other source finding it is not charged).
CREATE TABLE IF NOT EXISTS credit_usage (
  account TEXT NOT NULL,
  day     TEXT NOT NULL,
  bucket  TEXT NOT NULL,
  used    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account, day, bucket)
);
CREATE TABLE IF NOT EXISTS credit_leads (
  account    TEXT NOT NULL,
  lead_key   TEXT NOT NULL,
  day        TEXT NOT NULL,
  bucket     TEXT NOT NULL,
  source     TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account, lead_key)
);
CREATE INDEX IF NOT EXISTS credit_leads_day ON credit_leads (account, day);
CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  target  TEXT NOT NULL,
  details TEXT
);
`;

const MAX_OTP_ATTEMPTS = 5;

class Exhausted extends Error {}

class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    const old = this.db.prepare("SELECT 1 FROM pragma_table_info('applications') WHERE name = 'screenshot_file'").get();
    if (old) throw new Error(`${file} was created by an older version of the licence server. Move it aside and start again.`);
    this.db.exec(SCHEMA);
    this.importLicences();
  }

  // Subscriptions approved by the earlier payment-screenshot flow (table
  // licenses) carry over once.
  importLicences() {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'licenses'").get()) return;
    this.db.exec(`INSERT OR IGNORE INTO subscriptions (device_id, plan, status, activated_at, expires_at, updated_at)
      SELECT device_id, plan, 'active', activated_at, expires_at, activated_at FROM licenses`);
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

  q(sql) {
    return this.db.prepare(sql);
  }

  close() {
    this.db.close();
  }

  // --- request authentication ------------------------------------------------

  // Replay protection: each signed request is accepted once.
  rememberRequest(sigHash, nowMs, ttlMs) {
    this.q('DELETE FROM seen_requests WHERE expires_at < ?').run(nowMs);
    return this.q('INSERT OR IGNORE INTO seen_requests (sig_hash, expires_at) VALUES (?, ?)').run(sigHash, nowMs + ttlMs).changes === 1;
  }

  upsertDevice(id, publicKey, now) {
    const row = this.q('SELECT public_key FROM devices WHERE id = ?').get(id);
    if (row && row.public_key !== publicKey) throw new Error('device key mismatch');
    if (row) this.q('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, id);
    else this.q('INSERT INTO devices (id, public_key, created_at, last_seen_at) VALUES (?, ?, ?, ?)').run(id, publicKey, now, now);
  }

  // --- subscriptions -------------------------------------------------------------

  // { state: 'active'|'expired'|'suspended'|'inactive'|'none', plan, expiresAt, activatedAt }
  subscription(deviceId, now) {
    const r = this.q('SELECT * FROM subscriptions WHERE device_id = ?').get(deviceId);
    if (!r) return { state: 'none' };
    const expired = r.status === 'active' && r.expires_at && r.expires_at <= now;
    return { state: expired ? 'expired' : r.status, plan: r.plan, expiresAt: r.expires_at, activatedAt: r.activated_at };
  }

  // Administrator: suspend, restore (active) or revoke (inactive = Free).
  setSubscriptionStatus(deviceId, status, now) {
    return this.q(`UPDATE subscriptions SET status = ?, suspended_at = CASE WHEN ? = 'suspended' THEN COALESCE(suspended_at, ?) ELSE NULL END, updated_at = ? WHERE device_id = ?`).run(status, status, now, now, deviceId).changes === 1;
  }

  // --- activation requests ---------------------------------------------------------

  activation(id) {
    return this.q('SELECT * FROM activations WHERE id = ?').get(id) || null;
  }

  // The installation's open request. One whose code has expired is closed
  // first (the next request starts a new one).
  openActivation(deviceId, now) {
    return this.tx(() => {
      this.q(`UPDATE activations SET status = 'expired', open_for = NULL, otp_hash = NULL WHERE open_for = ? AND otp_expires_at <= ?`).run(deviceId, now);
      return this.q('SELECT * FROM activations WHERE open_for = ?').get(deviceId) || null;
    });
  }

  latestActivation(deviceId) {
    return this.q('SELECT * FROM activations WHERE device_id = ? ORDER BY created_at DESC LIMIT 1').get(deviceId) || null;
  }

  countActivationsSince(deviceId, since) {
    return this.q('SELECT count(*) n FROM activations WHERE device_id = ? AND created_at >= ?').get(deviceId, since).n;
  }

  // A new request with its first code. An open request for another plan is
  // replaced; one for the same plan is kept: { row, created }.
  createActivation(r) {
    return this.tx(() => {
      const open = this.q('SELECT * FROM activations WHERE open_for = ?').get(r.deviceId);
      if (open && open.plan === r.plan) return { row: open, created: false };
      if (open) this.q(`UPDATE activations SET status = 'cancelled', open_for = NULL, otp_hash = NULL WHERE id = ?`).run(open.id);
      this.q(
        `INSERT INTO activations (id, device_id, machine_id, open_for, plan, status, otp_hash, otp_expires_at, otp_sent_at, otp_sends, otp_window_start, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, 1, ?, ?)`,
      ).run(r.id, r.deviceId, r.machineId, r.deviceId, r.plan, r.otpHash, r.otpExpiresAt, r.now, r.now, r.now);
      return { row: this.activation(r.id), created: true };
    });
  }

  // A replacement code, limited by a cooldown and a number per day.
  replaceOtp({ id, otpHash, otpExpiresAt, now, cooldownMs, maxPerDay }) {
    return this.tx(() => {
      const r = this.activation(id);
      if (!r || r.status !== 'pending') return { error: 'not_open' };
      const next = r.otp_sent_at ? Date.parse(r.otp_sent_at) + cooldownMs : 0;
      if (next > Date.parse(now)) return { error: 'cooldown', retryAt: new Date(next).toISOString() };
      const windowFresh = r.otp_window_start && Date.parse(now) - Date.parse(r.otp_window_start) < 86_400_000;
      if (windowFresh && r.otp_sends >= maxPerDay) return { error: 'limit' };
      this.q(`UPDATE activations SET otp_hash = ?, otp_expires_at = ?, otp_attempts = 0, otp_sent_at = ?, otp_sends = ?, otp_window_start = ? WHERE id = ?`).run(
        otpHash,
        otpExpiresAt,
        now,
        windowFresh ? r.otp_sends + 1 : 1,
        windowFresh ? r.otp_window_start : now,
        id,
      );
      return { row: this.activation(id) };
    });
  }

  // Undoes a request whose email could not be sent (nobody has the code).
  cancelActivation(id) {
    return this.q(`UPDATE activations SET status = 'cancelled', open_for = NULL, otp_hash = NULL WHERE id = ? AND open_for IS NOT NULL`).run(id).changes === 1;
  }

  // Uses up one attempt of the current code before it is compared, so even
  // simultaneous guesses can't exceed the limit. The row, or null when no
  // attempt is left.
  claimOtpAttempt(id, deviceId) {
    const n = this.q(
      `UPDATE activations SET otp_attempts = otp_attempts + 1
       WHERE id = ? AND device_id = ? AND status = 'pending' AND otp_hash IS NOT NULL AND otp_attempts < ?`,
    ).run(id, deviceId, MAX_OTP_ATTEMPTS).changes;
    return n === 1 ? this.activation(id) : null;
  }

  // The code was right: uses it up and activates the request's plan, in one
  // transaction. { subscription } or { error: 'invalid'|'expired'|'not_open' }.
  activateWithOtp({ id, deviceId, otpHash, matches, now }) {
    return this.tx(() => {
      const r = this.activation(id);
      if (!r || r.device_id !== deviceId || r.status !== 'pending' || !r.otp_hash) return { error: 'not_open' };
      if (!matches(r.otp_hash, otpHash)) return { error: 'invalid' };
      if (r.otp_expires_at <= now) return { error: 'expired' };
      const lic = licenceFor(PLANS[r.plan] || PLANS.free, this.subscription(deviceId, now), now);
      this.q(`UPDATE activations SET status = 'activated', open_for = NULL, otp_hash = NULL, activated_at = ? WHERE id = ?`).run(now, id);
      this.q(
        `INSERT INTO subscriptions (device_id, plan, status, activation_id, activated_at, expires_at, suspended_at, updated_at)
         VALUES (?, ?, 'active', ?, ?, ?, NULL, ?)
         ON CONFLICT (device_id) DO UPDATE SET plan = excluded.plan, status = 'active', activation_id = excluded.activation_id,
           activated_at = excluded.activated_at, expires_at = excluded.expires_at, suspended_at = NULL, updated_at = excluded.updated_at`,
      ).run(deviceId, lic.plan, id, now, lic.expiresAt, now);
      return { subscription: this.subscription(deviceId, now) };
    });
  }

  // --- daily allowance -------------------------------------------------------------

  // Charges one qualified lead, atomically:
  //   the same lead (account + key) again    { granted: true, duplicate: true }, not charged
  //   room left today (or no limit)          { granted: true }, charged
  //   the counter is at its limit            { granted: false }, nothing written
  reserveCredit({ account, key, day, bucket, limit, source, deviceId, now }) {
    try {
      return this.tx(() => {
        const added = this.q(
          `INSERT INTO credit_leads (account, lead_key, day, bucket, source, device_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (account, lead_key) DO NOTHING`,
        ).run(account, key, day, bucket, source, deviceId, now).changes;
        if (!added) return { granted: true, duplicate: true };
        this.q('INSERT INTO credit_usage (account, day, bucket, used) VALUES (?, ?, ?, 0) ON CONFLICT DO NOTHING').run(account, day, bucket);
        const ok =
          limit === null
            ? this.q('UPDATE credit_usage SET used = used + 1 WHERE account = ? AND day = ? AND bucket = ?').run(account, day, bucket).changes
            : this.q('UPDATE credit_usage SET used = used + 1 WHERE account = ? AND day = ? AND bucket = ? AND used < ?').run(account, day, bucket, limit).changes;
        if (!ok) throw new Exhausted();
        return { granted: true, duplicate: false };
      });
    } catch (err) {
      if (err instanceof Exhausted) return { granted: false, duplicate: false };
      throw err;
    }
  }

  // Today's counters ({ total } or { maps, facebook }) and the leads
  // charged today by source.
  usageToday(account, day) {
    const counters = {};
    for (const r of this.q('SELECT bucket, used FROM credit_usage WHERE account = ? AND day = ?').all(account, day)) counters[r.bucket] = r.used;
    const bySource = { maps: 0, facebook: 0 };
    for (const r of this.q('SELECT source, count(*) n FROM credit_leads WHERE account = ? AND day = ? GROUP BY source').all(account, day)) bySource[r.source] = r.n;
    return { counters, bySource };
  }

  discovered(account) {
    return this.q('SELECT count(*) n FROM credit_leads WHERE account = ?').get(account).n;
  }

  // --- audit -------------------------------------------------------------------------

  audit({ at, actor, action, target, details }) {
    this.q('INSERT INTO audit_log (at, actor, action, target, details) VALUES (?, ?, ?, ?, ?)').run(at, actor, action, target, details ? JSON.stringify(details) : null);
  }

  auditLog(limit = 100) {
    return this.q('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
  }
}

// The subscription an activation gives. Free is set as it is; a lifetime
// subscription stays lifetime; renewing the same plan before it runs out
// continues from its current end.
function licenceFor(plan, cur, now) {
  if (plan.id === 'free') return { plan: 'free', expiresAt: null };
  if (cur?.state === 'active' && cur.plan === 'lifetime') return { plan: 'lifetime', expiresAt: null };
  const from = cur?.state === 'active' && cur.plan === plan.id && cur.expiresAt && cur.expiresAt > now ? new Date(cur.expiresAt) : new Date(now);
  return { plan: plan.id, expiresAt: planExpiry(plan, from) };
}

module.exports = { Store, licenceFor, MAX_OTP_ATTEMPTS };
