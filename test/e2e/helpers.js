'use strict';
// Shared E2E helpers: an in-process licence server (test keys, captured
// mail), unlocking through the real lock screen, and test-side activation
// of a device's licence directly in the server database.

const crypto = require('node:crypto');
const { createApp } = require('../../server/src/app');
const { testLicenseStore } = require('../license-harness');

async function startLicenseServer() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const mails = [];
  const sb = testLicenseStore();
  const store = sb.store;
  const config = { publicBaseUrl: 'http://placeholder', adminEmail: 'info.axoraweb@gmail.com', paymentInstructions: 'Pay by JazzCash to 0300-0000000', licensePrivateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }) };
  const sent = []; // every email (code emails included)
  const server = createApp({ config, store, mailer: { send: async (m) => (sent.push(m), m.to === config.adminEmail && mails.push(m)) }, logger: { error() {} } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  config.publicBaseUrl = url;
  return {
    url,
    mails, // to the administrator
    sent, // every email
    server,
    store,
    env: { LEAD_FINDER_LICENSE_URL: url, LEAD_FINDER_LICENSE_PUBKEY: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') },
    // SQL in the server database (e.g. to expire a licence or use up a trial).
    sql: (text, params = []) => store.q(text).run(...params),
    // What a completed activation leaves: an active subscription with a plan.
    async activate(deviceId, plan = 'monthly', expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString()) {
      const now = new Date().toISOString();
      store.q('INSERT OR IGNORE INTO devices (id, public_key, created_at, last_seen_at) VALUES (?, ?, ?, ?)').run(deviceId, 'test', now, now);
      store
        .q(`INSERT INTO subscriptions (device_id, plan, status, activated_at, expires_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?)
            ON CONFLICT (device_id) DO UPDATE SET plan = excluded.plan, status = 'active', expires_at = excluded.expires_at, updated_at = excluded.updated_at`)
        .run(deviceId, plan, now, plan === 'lifetime' || plan === 'free' ? null : expiresAt, now);
    },
    async close() {
      server.close();
      sb.drop();
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
