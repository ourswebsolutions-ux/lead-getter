'use strict';
// Shared E2E helpers: an in-process licence server (test keys, captured
// mail), unlocking through the real lock screen, and test-side activation
// of a device's licence directly in the server database.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../../server/src/app');
const { testSupabase } = require('../supabase-harness');

async function startLicenseServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-lic-'));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const mails = [];
  const sb = await testSupabase();
  const store = sb.store;
  const config = { publicBaseUrl: 'http://placeholder', adminEmail: 'info.axoraweb@gmail.com', paymentInstructions: 'Pay by JazzCash to 0300-0000000', licensePrivateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }) };
  const server = createApp({ config, store, storage: sb.storage, mailer: { send: async (m) => mails.push(m) }, logger: { error() {} } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  config.publicBaseUrl = url;
  return {
    url,
    mails,
    store,
    env: { LEAD_FINDER_LICENSE_URL: url, LEAD_FINDER_LICENSE_PUBKEY: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') },
    // SQL in the test schema (e.g. to expire a licence or use up a trial).
    sql: (text, params) => store.q(text, params),
    // What an approval does: a licence row for the device.
    async activate(deviceId, plan = 'monthly', expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString()) {
      const now = new Date().toISOString();
      const appId = `LF-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
      await store.q('insert into $S.devices (id, public_key, created_at, last_seen_at) values ($1, $2, $3, $3) on conflict do nothing', [deviceId, 'test', now]);
      await store.q("insert into $S.applications (id, device_id, plan, message, screenshot_type, screenshot_size, screenshot_sha256, status, created_at) values ($1, $2, $3, 'test', 'image/png', 0, 'x', 'approved', $4)", [appId, deviceId, plan, now]);
      await store.q(
        'insert into $S.licenses (device_id, plan, application_id, activated_at, expires_at) values ($1, $2, $3, $4, $5) on conflict (device_id) do update set plan = excluded.plan, application_id = excluded.application_id, expires_at = excluded.expires_at',
        [deviceId, plan, appId, now, plan === 'lifetime' ? null : expiresAt],
      );
    },
    async close() {
      server.close();
      await sb.drop();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Sets the PIN on first launch (enter + confirm) or unlocks with it.
async function unlock(win, pin = '1357') {
  const dialog = win.getByRole('dialog', { name: /Create your PIN|Enter your PIN/ });
  await dialog.waitFor({ timeout: 20_000 });
  const creating = /Create/.test(await dialog.getAttribute('aria-label'));
  await win.keyboard.type(pin, { delay: 30 });
  if (creating) {
    await win.getByRole('dialog', { name: 'Confirm your PIN' }).waitFor();
    await win.keyboard.type(pin, { delay: 30 });
  }
  await win.getByRole('heading', { name: 'Lead Finder' }).waitFor();
}

async function deviceIdOf(win) {
  return (await win.evaluate(() => window.leadFinder.subscriptionStatus())).deviceId;
}

module.exports = { startLicenseServer, unlock, deviceIdOf };
