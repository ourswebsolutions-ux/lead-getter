'use strict';
// Real Supabase for tests: a throwaway schema (lf_test_*) and bucket
// (lf-test-*) per run, migrated like production and dropped afterwards.
// Credentials come from server/.env (never from the app).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PgStore } = require('../server/src/db');
const { StorageClient } = require('../server/src/storage');

function supabaseEnv() {
  const file = path.join(__dirname, '..', 'server', '.env');
  const env = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
  }
  return { ...env, ...process.env };
}

async function testSupabase() {
  const env = supabaseEnv();
  if (!env.SUPABASE_DB_URL || !env.SUPABASE_SECRET_KEY) return null;
  const id = crypto.randomBytes(4).toString('hex');
  const schema = `lf_test_${id}`;
  const store = new PgStore({ connectionString: env.SUPABASE_DB_URL, ca: fs.readFileSync(path.join(__dirname, '..', 'server', env.SUPABASE_DB_CA || 'certs/supabase-root-2021-ca.crt'), 'utf8'), schema, max: 3 });
  const storage = new StorageClient({ url: env.SUPABASE_URL, secretKey: env.SUPABASE_SECRET_KEY, bucket: `lf-test-${id}` });
  await store.migrate({ cron: false });
  await storage.ensureBucket();
  return {
    store,
    storage,
    async drop() {
      if (!/^lf_test_[0-9a-f]{8}$/.test(schema)) throw new Error('refusing to drop a non-test schema');
      const names = (await store.pool.query('select name from storage.objects where bucket_id = $1', [storage.bucket])).rows.map((r) => r.name);
      await storage.dropTestBucket(names);
      await store.pool.query(`drop schema if exists "${schema}" cascade`);
      await store.close();
    },
  };
}

module.exports = { testSupabase, supabaseEnv };
