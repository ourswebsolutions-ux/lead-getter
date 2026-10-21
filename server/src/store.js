'use strict';

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
  id               TEXT PRIMARY KEY,
  device_id        TEXT NOT NULL REFERENCES devices(id),
  plan             TEXT NOT NULL,
  message          TEXT NOT NULL,
  email            TEXT,
  email_verified   INTEGER NOT NULL DEFAULT 0,
  screenshot_file  TEXT NOT NULL,
  screenshot_type  TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'cancelled')),
  created_at       TEXT NOT NULL,
  decided_at       TEXT
);
CREATE INDEX IF NOT EXISTS applications_device ON applications (device_id, created_at);
CREATE TABLE IF NOT EXISTS action_tokens (
  hash           TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  action         TEXT NOT NULL CHECK (action IN ('approve', 'cancel', 'verify_email')),
  expires_at     TEXT NOT NULL,
  used_at        TEXT
);
CREATE TABLE IF NOT EXISTS licenses (
  device_id      TEXT PRIMARY KEY REFERENCES devices(id),
  plan           TEXT NOT NULL,
  application_id TEXT NOT NULL REFERENCES applications(id),
  activated_at   TEXT NOT NULL,
  expires_at     TEXT
);
CREATE TABLE IF NOT EXISTS seen_requests (
  sig_hash   TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
`;

class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
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

  // Replay protection: each signed request is accepted once.
  rememberRequest(sigHash, nowMs, ttlMs) {
    this.q('DELETE FROM seen_requests WHERE expires_at < ?').run(nowMs);
    try {
      this.q('INSERT INTO seen_requests (sig_hash, expires_at) VALUES (?, ?)').run(sigHash, nowMs + ttlMs);
      return true;
    } catch {
      return false;
    }
  }

  upsertDevice(id, publicKey, now) {
    const row = this.q('SELECT public_key FROM devices WHERE id = ?').get(id);
    if (row && row.public_key !== publicKey) throw new Error('device key mismatch');
    if (row) this.q('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, id);
    else this.q('INSERT INTO devices (id, public_key, created_at, last_seen_at) VALUES (?, ?, ?, ?)').run(id, publicKey, now, now);
  }
}

module.exports = { Store };
