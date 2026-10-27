'use strict';

// One-time setup on the administrator's computer:
//   - copies .env.example to .env and creates the activation secret in it
//     (kept if it already exists; --new-secret replaces it, which makes
//     codes from the old secret stop working in app versions built
//     afterwards, and ends existing activations there);
//   - writes the secret into src/main/activation-secret.json (git-ignored;
//     packaged into local builds) and the contact numbers into
//     src/main/activation-config.json (committed).
// Releases built on GitHub need the same value as the ACTIVATION_SECRET
// repository secret (see README).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ENV_FILE } = require('./lib');

const mainDir = path.join(__dirname, '..', '..', 'src', 'main');

let env = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : fs.readFileSync(path.join(__dirname, '.env.example'), 'utf8');
const get = (k) => (env.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim().replace(/^"(.*)"$/, '$1');
const set = (k, v) => {
  env = new RegExp(`^${k}=`, 'm').test(env) ? env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : `${env.trimEnd()}\n${k}=${v}\n`;
};

let secret = get('ACTIVATION_SECRET');
if (!secret || process.argv.includes('--new-secret')) {
  secret = crypto.randomBytes(32).toString('base64');
  set('ACTIVATION_SECRET', secret);
  console.log('Created a new activation secret in .env. Back up .env.');
}
fs.writeFileSync(ENV_FILE, env, { mode: 0o600 });

fs.writeFileSync(path.join(mainDir, 'activation-secret.json'), `${JSON.stringify({ secret })}\n`, { mode: 0o600 });
const contact = { whatsapp: (get('CONTACT_WHATSAPP') || '').replace(/\D/g, ''), phone: (get('CONTACT_PHONE') || '').replace(/[^\d+]/g, '') };
fs.writeFileSync(path.join(mainDir, 'activation-config.json'), `${JSON.stringify({ contact }, null, 2)}\n`);
console.log('Wrote src/main/activation-secret.json (git-ignored) and the contact numbers to src/main/activation-config.json.');
console.log('For releases built on GitHub, set the same secret: gh secret set ACTIVATION_SECRET (paste the ACTIVATION_SECRET value from .env).');
