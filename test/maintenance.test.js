'use strict';
// Storage management against real Supabase (throwaway schema + bucket).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { testSupabase } = require('./supabase-harness');
const { runMaintenance } = require('../server/src/maintenance');

const DAY = 86_400_000;
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(64)]);
const ago = (now, days) => new Date(now.getTime() - days * DAY).toISOString();

test('controlled cleanup, retention and usage alerts', async (t) => {
  const sb = await testSupabase();
  if (!sb) return t.skip('Supabase not configured');
  t.after(() => sb.drop());
  const { store, storage } = sb;
  const now = new Date();
  await store.upsertDevice('dev1', 'key1', now.toISOString());

  // Applications with uploaded screenshots, created/decided at chosen times.
  const make = async (id, createdDaysAgo) => {
    const p = `applications/${id}/${crypto.randomBytes(4).toString('hex')}.png`;
    const data = png();
    await storage.upload(p, data, 'image/png');
    const tok = (action, hash = crypto.randomBytes(16).toString('hex')) => ({ hash, action, expiresAt: ago(now, createdDaysAgo - 7) });
    const tokens = [tok('approve', `${id}-approve`), tok('cancel', `${id}-cancel`), tok('verify_email', `${id}-verify`)];
    await store.createApplication({ id, deviceId: 'dev1', plan: 'monthly', message: '', email: null, screenshotPath: p, screenshotType: 'image/png', screenshotSize: data.length, screenshotSha256: 'x', createdAt: ago(now, createdDaysAgo) }, tokens);
    return p;
  };
  const decide = (id, action, daysAgo) =>
    store.decide({ id, tokenHash: `${id}-${action}`, action, now: ago(now, daysAgo), licenceFor: () => ({ plan: 'monthly', expiresAt: ago(now, daysAgo - 30) }) });
  const pOld = await make('LF-000000000A', 101); // approved 100 days ago
  const pRecent = await make('LF-000000000B', 11); // cancelled 10 days ago
  const pPending = await make('LF-000000000C', 200); // pending for 200 days
  assert.equal((await decide('LF-000000000A', 'approve', 100)).ok, true);
  assert.equal((await decide('LF-000000000B', 'cancel', 10)).ok, true);
  await store.consumeTrial('machine1', 3, now.toISOString());
  await store.rememberRequest('old-sig', now.getTime() - 60 * 60_000, 1000);
  await store.rememberRequest('fresh-sig', now.getTime(), 5 * DAY); // still valid at the (simulated) run
  // An upload no application refers to.
  const orphan = 'applications/LF-ORPHAN/abc.png';
  await storage.upload(orphan, png(), 'image/png');

  const mails = [];
  const config = {
    adminEmail: 'info.axoraweb@gmail.com',
    retention: { screenshotDays: 90 },
    usage: { dbLimitMB: 1, storageLimitMB: 100_000, alertPercents: [80, 90, 95] },
    maintenance: { maxDeletesPerRun: 200, dryRun: false },
  };
  const deps = { store, storage, mailer: { send: async (m) => mails.push(m) }, logger: { log() {}, error() {} } };
  const objects = async () => (await store.pool.query('select name from storage.objects where bucket_id = $1', [storage.bucket])).rows.map((r) => r.name).sort();

  // Dry run: reports, deletes nothing.
  const dry = await runMaintenance({ ...deps, config: { ...config, maintenance: { ...config.maintenance, dryRun: true } }, now: () => new Date(now.getTime() + 2 * DAY) });
  assert.equal(dry.screenshot_retention.due, 1);
  assert.equal(dry.orphan_uploads.found, 1);
  assert.equal((await objects()).length, 4, 'dry run removes nothing');
  assert.deepEqual(dry.usage.alerts, ['database:95% (dry run, not sent)']);
  assert.equal(mails.length, 0, 'dry run sends no email');

  // Real run, two days later (so the orphan is over a day old).
  const r = await runMaintenance({ ...deps, config, now: () => new Date(now.getTime() + 2 * DAY) });
  assert.deepEqual(r.screenshot_retention, { due: 1, objectsRemoved: 1, marked: 1 });
  assert.deepEqual(r.orphan_uploads, { found: 1, deleted: 1 });
  assert.deepEqual(await objects(), [pPending, pRecent].sort(), 'only the expired decided screenshot and the orphan are gone');
  const old = await store.application('LF-000000000A');
  assert.ok(old.screenshot_deleted_at, 'marked as removed');
  assert.equal(old.status, 'approved');
  assert.equal(old.screenshot_sha256, 'x', 'payment reference kept');
  assert.equal((await store.application('LF-000000000C')).status, 'pending', 'pending application untouched');
  assert.equal((await store.application('LF-000000000C')).screenshot_deleted_at, null);

  // Database cleanup: spent links of decided applications and verification
  // links go; the pending application's (expired) links stay.
  const tokens = (await store.pool.query(`select hash from "${store.schema}".action_tokens order by hash`)).rows.map((x) => x.hash);
  assert.deepEqual(tokens, ['LF-000000000C-approve', 'LF-000000000C-cancel']);
  const seen = (await store.pool.query(`select sig_hash from "${store.schema}".seen_requests`)).rows.map((x) => x.sig_hash);
  assert.deepEqual(seen, ['fresh-sig']);
  // Essential records untouched.
  assert.ok(await store.license('dev1'));
  assert.equal(await store.trialUsed('machine1'), 1);
  assert.equal(Number((await store.pool.query(`select count(*) n from "${store.schema}".applications`)).rows[0].n), 3);
  assert.equal(Number((await store.pool.query(`select count(*) n from "${store.schema}".devices`)).rows[0].n), 1);

  // Usage alert: database over the (tiny test) limit -> one email; not repeated.
  assert.ok(r.usage.dbPercent >= 95);
  assert.deepEqual(r.usage.alerts, ['database:95%']);
  assert.match(mails[0].subject, /Supabase database at \d+% of the Free Plan limit/);
  const r2 = await runMaintenance({ ...deps, config, now: () => new Date(now.getTime() + 3 * DAY) });
  assert.deepEqual(r2.usage.alerts, []);
  assert.equal(mails.length, 1);

  // Every step is logged.
  const jobs = (await store.pool.query(`select job, ok from "${store.schema}".maintenance_log`)).rows;
  for (const j of ['cleanup_db', 'screenshot_retention', 'orphan_uploads', 'usage']) assert.ok(jobs.some((x) => x.job === j && x.ok), j);

  // Storage deletion only ever accepts our application paths.
  await assert.rejects(storage.remove(['other/file.png']), /unexpected path/);
  await assert.rejects(storage.remove(['applications/../x']), /unexpected path/);
});
