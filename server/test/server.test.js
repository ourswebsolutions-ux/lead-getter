'use strict';
// Standalone server checks (run in server/: npm test). The full
// application/approval suite lives in the app repo (test/subscription.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/app');
const { PgStore } = require('../src/db');
const { StorageClient } = require('../src/storage');
const c = require('../src/crypto');

test('plans, signed requests, application email, single-use approval, signed licence', async (t) => {
  // A throwaway schema and bucket in the configured Supabase project.
  if (!process.env.SUPABASE_DB_URL) return t.skip('Supabase not configured (.env)');
  const id = crypto.randomBytes(4).toString('hex');
  const store = new PgStore({ connectionString: process.env.SUPABASE_DB_URL, ca: fs.readFileSync(path.join(__dirname, '..', process.env.SUPABASE_DB_CA || 'certs/supabase-root-2021-ca.crt'), 'utf8'), schema: `lf_test_${id}`, max: 2 });
  const storage = new StorageClient({ url: process.env.SUPABASE_URL, secretKey: process.env.SUPABASE_SECRET_KEY, bucket: `lf-test-${id}` });
  await store.migrate();
  await storage.ensureBucket();
  const server = createApp({
    config: { publicBaseUrl: 'http://x', adminEmail: 'admin@example.com', licensePrivateKey: crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) },
    store,
    storage,
    mailer: { send: async (m) => (mails.push(m), {}) },
    logger: { error() {} },
  });
  const mails = [];
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    server.close();
    const names = (await store.pool.query('select name from storage.objects where bucket_id = $1', [storage.bucket])).rows.map((r) => r.name);
    await storage.dropTestBucket(names);
    await store.pool.query(`drop schema if exists "lf_test_${id}" cascade`);
    await store.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const plans = await (await fetch(`${base}/api/plans`)).json();
  assert.deepEqual(plans.plans.map((p) => p.price), [3000, 10000, 20000]);
  assert.equal((await fetch(`${base}/api/license?nonce=${'a'.repeat(20)}`)).status, 401, 'unsigned request refused');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pk = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const signed = (method, pq, body) => {
    const ts = String(Date.now());
    const nonce = crypto.randomBytes(16).toString('base64url');
    const sig = crypto.sign(null, c.requestDigest(method, pq, ts, nonce, body || ''), privateKey).toString('base64');
    return fetch(`${base}${pq}`, { method, body, headers: { 'x-lf-key': pk, 'x-lf-ts': ts, 'x-lf-nonce': nonce, 'x-lf-sig': sig, 'content-type': 'application/json' } });
  };
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(64)]);
  const res = await signed('POST', '/api/applications', JSON.stringify({ plan: 'lifetime', message: 'Paid', screenshot: { data: png.toString('base64') } }));
  assert.equal(res.status, 201);
  assert.equal(mails[0].to, 'admin@example.com');
  const approve = mails[0].html.match(/href="http:\/\/x(\/admin\/applications\/[^"?]+\/approve)\?token=([^"]+)"/);
  const post = () => fetch(`${base}${approve[1]}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${approve[2]}` });
  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 409, 'single use');
  const { token } = await (await signed('GET', `/api/license?nonce=${'b'.repeat(20)}`)).json();
  const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
  assert.equal(payload.subscription.state, 'active');
  assert.equal(payload.subscription.expiresAt, null);
  assert.equal(payload.deviceId, c.deviceIdFromKey(pk));
});
