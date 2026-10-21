'use strict';

// Subscription data in a local SQLite file (node:sqlite, no extra
// dependency). Times are ISO strings from the server clock, so tests can
// control them; ISO strings in UTC compare correctly as text.

const { DatabaseSync } = require('node:sqlite');

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
CREATE TABLE IF NOT EXISTS applications (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,  -- insertion order, breaks timestamp ties
  id                TEXT NOT NULL UNIQUE,
  device_id         TEXT NOT NULL REFERENCES devices(id),
  plan              TEXT NOT NULL,
  message           TEXT NOT NULL DEFAULT '',
  email             TEXT,
  email_verified    INTEGER NOT NULL DEFAULT 0,
  screenshot_path   TEXT,
  screenshot_type   TEXT NOT NULL,
  screenshot_size   INTEGER NOT NULL,
  screenshot_sha256 TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'cancelled')),
  created_at        TEXT NOT NULL,
  decided_at        TEXT
);
CREATE INDEX IF NOT EXISTS applications_device ON applications (device_id, created_at);
CREATE TABLE IF NOT EXISTS action_tokens (
  hash           TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  action         TEXT NOT NULL CHECK (action IN ('approve', 'cancel', 'verify_email')),
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  used_at        TEXT
);
CREATE INDEX IF NOT EXISTS action_tokens_app ON action_tokens (application_id);
CREATE TABLE IF NOT EXISTS licenses (
  device_id      TEXT PRIMARY KEY REFERENCES devices(id),
  plan           TEXT NOT NULL,
  application_id TEXT NOT NULL REFERENCES applications(id),
  activated_at   TEXT NOT NULL,
  expires_at     TEXT
);
CREATE TABLE IF NOT EXISTS trials (
  machine_id TEXT PRIMARY KEY,
  used       INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS seen_requests (
  sig_hash   TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
`;

class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    const old = this.db.prepare("SELECT 1 FROM pragma_table_info('applications') WHERE name = 'screenshot_file'").get();
    if (old) throw new Error(`${file} was created by an older version of the licence server. Move it aside and start again.`);
    this.db.exec(SCHEMA);
  }

  tx(fn) {
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

  // --- subscription state ------------------------------------------------------

  license(deviceId) {
    const r = this.q('SELECT plan, activated_at, expires_at FROM licenses WHERE device_id = ?').get(deviceId);
    return r ? { plan: r.plan, activatedAt: r.activated_at, expiresAt: r.expires_at } : null;
  }

  latestApplication(deviceId) {
    const a = this.q('SELECT id, plan, status, created_at, decided_at FROM applications WHERE device_id = ? ORDER BY created_at DESC, seq DESC LIMIT 1').get(deviceId);
    return a ? { id: a.id, plan: a.plan, status: a.status, createdAt: a.created_at, decidedAt: a.decided_at } : null;
  }

  // The customer's email from their latest application that has one.
  latestEmail(deviceId) {
    return this.q('SELECT email FROM applications WHERE device_id = ? AND email IS NOT NULL ORDER BY created_at DESC, seq DESC LIMIT 1').get(deviceId)?.email || null;
  }

  pendingCount(deviceId) {
    return this.q("SELECT count(*) n FROM applications WHERE device_id = ? AND status = 'pending'").get(deviceId).n;
  }

  trialUsed(machineId) {
    return this.q('SELECT used FROM trials WHERE machine_id = ?').get(machineId)?.used || 0;
  }

  // Atomically uses one free search; false when none are left.
  consumeTrial(machineId, limit, now) {
    const r = this.q(
      `INSERT INTO trials (machine_id, used, updated_at) VALUES (?, 1, ?)
       ON CONFLICT (machine_id) DO UPDATE SET used = used + 1, updated_at = excluded.updated_at WHERE used < ?`,
    ).run(machineId, now, limit);
    return r.changes === 1;
  }

  // --- applications ------------------------------------------------------------

  countApplicationsSince(deviceId, since) {
    return this.q('SELECT count(*) n FROM applications WHERE device_id = ? AND created_at >= ?').get(deviceId, since).n;
  }

  createApplication(app, tokens) {
    this.tx(() => {
      this.q(
        `INSERT INTO applications (id, device_id, plan, message, email, screenshot_path, screenshot_type, screenshot_size, screenshot_sha256, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      ).run(app.id, app.deviceId, app.plan, app.message, app.email, app.screenshotPath, app.screenshotType, app.screenshotSize, app.screenshotSha256, app.createdAt);
      this.insertTokens(app.id, tokens, app.createdAt);
    });
  }

  insertTokens(applicationId, tokens, now) {
    const ins = this.q('INSERT INTO action_tokens (hash, application_id, action, created_at, expires_at) VALUES (?, ?, ?, ?, ?)');
    for (const t of tokens) ins.run(t.hash, applicationId, t.action, now, t.expiresAt);
  }

  // Only for an application whose approval email could not be sent (no one
  // has seen it). Explicit id; tokens go with it (ON DELETE CASCADE).
  discardUnsentApplication(id) {
    this.q("DELETE FROM applications WHERE id = ? AND status = 'pending' AND decided_at IS NULL").run(id);
  }

  application(id) {
    return this.q('SELECT * FROM applications WHERE id = ?').get(id) || null;
  }

  token(hash) {
    return this.q('SELECT * FROM action_tokens WHERE hash = ?').get(hash) || null;
  }

  addTokens(applicationId, tokens, now) {
    this.tx(() => this.insertTokens(applicationId, tokens, now));
  }

  lastTokenIssued(applicationId) {
    return this.q("SELECT max(created_at) m FROM action_tokens WHERE application_id = ? AND action IN ('approve', 'cancel')").get(applicationId).m;
  }

  // Approve or cancel in one transaction. licenceFor(appRow, current)
  // supplies the new licence for approvals.
  decide({ id, tokenHash, action, now, licenceFor }) {
    return this.tx(() => {
      const t = this.q('SELECT * FROM action_tokens WHERE hash = ?').get(tokenHash);
      if (!t || t.application_id !== id || t.action !== action) return { error: 'invalid' };
      if (t.used_at) return { error: 'used' };
      if (t.expires_at < now) return { error: 'expired' };
      const app = this.q('SELECT * FROM applications WHERE id = ?').get(id);
      this.q("UPDATE action_tokens SET used_at = ? WHERE application_id = ? AND action IN ('approve', 'cancel') AND used_at IS NULL").run(now, id);
      if (app.status !== 'pending') return { error: 'processed', status: app.status };
      this.q('UPDATE applications SET status = ?, decided_at = ? WHERE id = ?').run(action === 'approve' ? 'approved' : 'cancelled', now, id);
      if (action !== 'approve') return { ok: true, app };
      const cur = this.q('SELECT plan, expires_at FROM licenses WHERE device_id = ?').get(app.device_id);
      const lic = licenceFor(app, cur ? { plan: cur.plan, expiresAt: cur.expires_at } : null);
      this.q(
        `INSERT INTO licenses (device_id, plan, application_id, activated_at, expires_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (device_id) DO UPDATE SET plan = excluded.plan, application_id = excluded.application_id, activated_at = excluded.activated_at, expires_at = excluded.expires_at`,
      ).run(app.device_id, lic.plan, id, now, lic.expiresAt);
      return { ok: true, app, licence: lic };
    });
  }

  verifyEmail(tokenHash, now) {
    return this.tx(() => {
      const t = this.q("SELECT * FROM action_tokens WHERE hash = ? AND action = 'verify_email'").get(tokenHash);
      if (!t || t.used_at || t.expires_at < now) return false;
      this.q('UPDATE action_tokens SET used_at = ? WHERE hash = ?').run(now, tokenHash);
      this.q('UPDATE applications SET email_verified = 1 WHERE id = ?').run(t.application_id);
      return true;
    });
  }
}

module.exports = { Store };
