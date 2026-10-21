'use strict';

// One-time setup: creates the licence signing key in server/.env (if not
// present) and writes the matching public key into the desktop app's
// src/main/license-config.json. The private key never leaves server/.env.
//   node scripts/setup.js [--public-url https://licence.example.com]

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const envFile = path.join(__dirname, '..', '.env');
const appConfig = path.join(__dirname, '..', '..', 'src', 'main', 'license-config.json');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};

let env = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
const get = (k) => (env.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim();
const set = (k, v) => {
  env = new RegExp(`^${k}=`, 'm').test(env) ? env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : `${env.trimEnd()}\n${k}=${v}\n`;
};

let priv = get('LICENSE_PRIVATE_KEY');
if (!priv) {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  priv = Buffer.from(privateKey.export({ format: 'pem', type: 'pkcs8' })).toString('base64');
  set('LICENSE_PRIVATE_KEY', priv);
  console.log('Created a new licence signing key.');
}
const publicUrl = arg('--public-url');
if (publicUrl) set('PUBLIC_BASE_URL', publicUrl.replace(/\/$/, ''));
fs.writeFileSync(envFile, env, { mode: 0o600 });

const pub = crypto.createPublicKey(crypto.createPrivateKey(Buffer.from(priv, 'base64').toString('utf8')));
const config = { serverUrl: get('PUBLIC_BASE_URL') || `http://127.0.0.1:${get('PORT') || 8787}`, publicKey: pub.export({ format: 'der', type: 'spki' }).toString('base64') };
fs.writeFileSync(appConfig, `${JSON.stringify(config, null, 2)}\n`);
console.log(`App configured for ${config.serverUrl} (written to src/main/license-config.json).`);
