'use strict';

// For release checks (CI): the real licence server code, served under
// /lead-getter exactly like production, with a throwaway signing key and no
// email. Installed apps are pointed at it to prove that a packaged build
// loads plans and verifies a signed status once the server answers there.
//   node scripts/ci-licence-server.js <work dir> [port]
// Writes <work dir>/pubkey.txt (the throwaway public key) and
// <work dir>/url.txt, then keeps running.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server/src/app');
const { Store } = require('../server/src/store');
const { Uploads } = require('../server/src/uploads');

const dir = path.resolve(process.argv[2] || 'ci-licence');
const port = Number(process.argv[3] || 8799);
fs.mkdirSync(dir, { recursive: true });
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const url = `http://127.0.0.1:${port}/lead-getter`;
const config = { publicBaseUrl: url, adminEmail: 'ci@example.invalid', paymentInstructions: '', licensePrivateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }) };
const mailer = { send: async () => ({}), verify: async () => true }; // no email in CI
const server = createApp({ config, store: new Store(path.join(dir, 'subscriptions.db')), storage: new Uploads(path.join(dir, 'uploads')), mailer, logger: { error: (m) => console.error(m) } });
server.listen(port, '127.0.0.1', () => {
  fs.writeFileSync(path.join(dir, 'pubkey.txt'), publicKey.export({ format: 'der', type: 'spki' }).toString('base64'));
  fs.writeFileSync(path.join(dir, 'url.txt'), url);
  console.log(`CI licence server on ${url}`);
});
