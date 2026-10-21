'use strict';

// Supabase Postgres access (session pooler, TLS verified against Supabase's
// root CA). All tables live in a private schema; times are passed in from
// the server clock so tests can control them.

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,40}$/;
const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString());

class PgStore {
  constructor({ connectionString, ca, schema = 'leadfinder', max = 5 }) {
    if (!SCHEMA_RE.test(schema)) throw new Error('Invalid schema name');
    this.schema = schema;
    this.pool = new Pool({
      connectionString,
      ssl: ca ? { ca, rejectUnauthorized: true } : undefined,
      max,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    });
    // An idle connection dropped by the pooler must not crash the server.
    this.pool.on('error', () => {});
  }

  sql(text) {
    return text.replaceAll('$S.', `"${this.schema}".`);
  }

  q(text, params = []) {
    return this.pool.query(this.sql(text), params);
  }

  async tx(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const out = await fn((text, params = []) => client.query(this.sql(text), params));
      await client.query('commit');
      return out;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }

  // Applies the SQL files in db/migrations once each (tracked per schema).
  async migrate({ cron = false } = {}) {
    const dir = path.join(__dirname, '..', 'db', 'migrations');
    await this.pool.query(`create schema if not exists "${this.schema}"`);
    await this.pool.query(`create table if not exists "${this.schema}".schema_migrations (version text primary key, applied_at timestamptz not null default now())`);
    const done = new Set((await this.pool.query(`select version from "${this.schema}".schema_migrations`)).rows.map((r) => r.version));
    const applied = [];
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file) || (file.includes('cron') && !cron)) continue;
      const text = fs.readFileSync(path.join(dir, file), 'utf8').replaceAll('__SCHEMA__', this.schema);
      await this.tx(async (q) => {
        await q(text);
        await q(`insert into "${this.schema}".schema_migrations (version) values ($1)`, [file]);
      });
      applied.push(file);
    }
    return applied;
  }

  // --- request authentication ------------------------------------------------

  async rememberRequest(sigHash, nowMs, ttlMs) {
    const r = await this.q('insert into $S.seen_requests (sig_hash, expires_at) values ($1, $2) on conflict do nothing', [sigHash, nowMs + ttlMs]);
    return r.rowCount === 1;
  }

  async upsertDevice(id, publicKey, now) {
    const r = await this.q(
      `insert into $S.devices (id, public_key, created_at, last_seen_at) values ($1, $2, $3, $3)
       on conflict (id) do update set last_seen_at = excluded.last_seen_at where $S.devices.public_key = excluded.public_key`,
      [id, publicKey, now],
    );
    if (r.rowCount !== 1) throw new Error('device key mismatch');
  }

  // --- subscription state ------------------------------------------------------

  async license(deviceId) {
    const r = (await this.q('select plan, activated_at, expires_at from $S.licenses where device_id = $1', [deviceId])).rows[0];
    return r ? { plan: r.plan, activatedAt: iso(r.activated_at), expiresAt: iso(r.expires_at) } : null;
  }

  async latestApplication(deviceId) {
    const a = (await this.q('select id, plan, status, created_at, decided_at from $S.applications where device_id = $1 order by created_at desc, seq desc limit 1', [deviceId])).rows[0];
    return a ? { id: a.id, plan: a.plan, status: a.status, createdAt: iso(a.created_at), decidedAt: iso(a.decided_at) } : null;
  }

  async pendingCount(deviceId) {
    return Number((await this.q("select count(*) n from $S.applications where device_id = $1 and status = 'pending'", [deviceId])).rows[0].n);
  }

  async trialUsed(machineId) {
    return (await this.q('select used from $S.trials where machine_id = $1', [machineId])).rows[0]?.used || 0;
  }

  // Atomically uses one free search; false when none are left.
  async consumeTrial(machineId, limit, now) {
    const r = await this.q(
      `insert into $S.trials (machine_id, used, updated_at) values ($1, 1, $3)
       on conflict (machine_id) do update set used = $S.trials.used + 1, updated_at = excluded.updated_at
       where $S.trials.used < $2`,
      [machineId, limit, now],
    );
    return r.rowCount === 1;
  }

  // --- applications ------------------------------------------------------------

  async countApplicationsSince(deviceId, since) {
    return Number((await this.q('select count(*) n from $S.applications where device_id = $1 and created_at >= $2', [deviceId, since])).rows[0].n);
  }

  async createApplication(app, tokens) {
    await this.tx(async (q) => {
      await q(
        `insert into $S.applications (id, device_id, plan, message, email, screenshot_path, screenshot_type, screenshot_size, screenshot_sha256, status, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10)`,
        [app.id, app.deviceId, app.plan, app.message, app.email, app.screenshotPath, app.screenshotType, app.screenshotSize, app.screenshotSha256, app.createdAt],
      );
      for (const t of tokens) {
        await q('insert into $S.action_tokens (hash, application_id, action, created_at, expires_at) values ($1, $2, $3, $4, $5)', [t.hash, app.id, t.action, app.createdAt, t.expiresAt]);
      }
    });
  }

  // Only for an application whose approval email could not be sent (no one
  // has seen it). Explicit id; tokens go with it (on delete cascade).
  async discardUnsentApplication(id) {
    await this.q("delete from $S.applications where id = $1 and status = 'pending' and decided_at is null", [id]);
  }

  async application(id) {
    const a = (await this.q('select * from $S.applications where id = $1', [id])).rows[0];
    return a ? { ...a, created_at: iso(a.created_at), decided_at: iso(a.decided_at), screenshot_deleted_at: iso(a.screenshot_deleted_at) } : null;
  }

  async token(hash) {
    const t = (await this.q('select * from $S.action_tokens where hash = $1', [hash])).rows[0];
    return t ? { ...t, expires_at: iso(t.expires_at), used_at: iso(t.used_at), created_at: iso(t.created_at) } : null;
  }

  async addTokens(applicationId, tokens, now) {
    await this.tx(async (q) => {
      for (const t of tokens) {
        await q('insert into $S.action_tokens (hash, application_id, action, created_at, expires_at) values ($1, $2, $3, $4, $5)', [t.hash, applicationId, t.action, now, t.expiresAt]);
      }
    });
  }

  async lastTokenIssued(applicationId) {
    return iso((await this.q("select max(created_at) m from $S.action_tokens where application_id = $1 and action in ('approve', 'cancel')", [applicationId])).rows[0].m);
  }

  // Approve or cancel in one transaction with row locks. decide(appRow,
  // licence) supplies the new licence for approvals.
  async decide({ id, tokenHash, action, now, licenceFor }) {
    return this.tx(async (q) => {
      const t = (await q('select * from $S.action_tokens where hash = $1 for update', [tokenHash])).rows[0];
      if (!t || t.application_id !== id || t.action !== action) return { error: 'invalid' };
      if (t.used_at) return { error: 'used' };
      if (new Date(t.expires_at) < new Date(now)) return { error: 'expired' };
      const app = (await q('select * from $S.applications where id = $1 for update', [id])).rows[0];
      await q("update $S.action_tokens set used_at = $2 where application_id = $1 and action in ('approve', 'cancel') and used_at is null", [id, now]);
      if (app.status !== 'pending') return { error: 'processed', status: app.status };
      await q('update $S.applications set status = $2, decided_at = $3 where id = $1', [id, action === 'approve' ? 'approved' : 'cancelled', now]);
      if (action !== 'approve') return { ok: true, app };
      const cur = (await q('select * from $S.licenses where device_id = $1 for update', [app.device_id])).rows[0];
      const lic = licenceFor(app, cur ? { plan: cur.plan, expiresAt: iso(cur.expires_at) } : null);
      await q(
        `insert into $S.licenses (device_id, plan, application_id, activated_at, expires_at) values ($1, $2, $3, $4, $5)
         on conflict (device_id) do update set plan = excluded.plan, application_id = excluded.application_id, activated_at = excluded.activated_at, expires_at = excluded.expires_at`,
        [app.device_id, lic.plan, id, now, lic.expiresAt],
      );
      return { ok: true, app, licence: lic };
    });
  }

  async verifyEmail(tokenHash, now) {
    return this.tx(async (q) => {
      const t = (await q("select * from $S.action_tokens where hash = $1 and action = 'verify_email' for update", [tokenHash])).rows[0];
      if (!t || t.used_at || new Date(t.expires_at) < new Date(now)) return false;
      await q('update $S.action_tokens set used_at = $2 where hash = $1', [tokenHash, now]);
      await q('update $S.applications set email_verified = true where id = $1', [t.application_id]);
      return true;
    });
  }

  // --- maintenance -------------------------------------------------------------

  async cleanupDb(now) {
    return (await this.q('select $S.cleanup_db($1) r', [now])).rows[0].r;
  }

  // Screenshots of decided applications older than the retention period.
  // Pending applications are never selected.
  async screenshotsDue(before, limit) {
    return (
      await this.q(
        `select id, screenshot_path from $S.applications
         where status in ('approved', 'cancelled') and decided_at < $1
           and screenshot_deleted_at is null and screenshot_path is not null
         order by decided_at limit $2`,
        [before, limit],
      )
    ).rows;
  }

  async markScreenshotsDeleted(ids, now) {
    if (!ids.length) return 0;
    const r = await this.q(
      "update $S.applications set screenshot_deleted_at = $2 where id = any($1) and status in ('approved', 'cancelled') and screenshot_deleted_at is null",
      [ids, now],
    );
    return r.rowCount;
  }

  // Objects in our bucket under applications/ that no application refers
  // to (e.g. an upload whose database insert failed), older than `before`.
  async orphanObjects(bucket, before, limit) {
    return (
      await this.q(
        `select o.name from storage.objects o
         where o.bucket_id = $1 and o.name like 'applications/%' and o.created_at < $2
           and not exists (select 1 from $S.applications a where a.screenshot_path = o.name)
         order by o.created_at limit $3`,
        [bucket, before, limit],
      )
    ).rows.map((r) => r.name);
  }

  async usage() {
    const db = (await this.q('select pg_database_size(current_database()) b')).rows[0].b;
    const st = (await this.q("select coalesce(sum((metadata->>'size')::bigint), 0) b from storage.objects")).rows[0].b;
    return { dbBytes: Number(db), storageBytes: Number(st) };
  }

  async alertLevel(kind) {
    return (await this.q('select level, sent_at from $S.usage_alerts where kind = $1', [kind])).rows[0] || null;
  }

  async setAlertLevel(kind, level, now) {
    await this.q('insert into $S.usage_alerts (kind, level, sent_at) values ($1, $2, $3) on conflict (kind) do update set level = excluded.level, sent_at = excluded.sent_at', [kind, level, now]);
  }

  async log(job, ok, details, now) {
    await this.q('insert into $S.maintenance_log (ran_at, job, ok, details) values ($1, $2, $3, $4)', [now, job, ok, JSON.stringify(details)]);
  }
}

module.exports = { PgStore, SCHEMA_RE };
