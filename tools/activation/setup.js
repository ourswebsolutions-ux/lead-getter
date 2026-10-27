'use strict';

// Setup on the administrator's computer (run again after changing .env):
//   - copies .env.example to .env and creates ACTIVATION_SECRET (kept if it
//     exists; --new-secret replaces it, which ends existing activations in
//     builds made afterwards);
//   - writes src/main/activation-secret.json (git-ignored; packaged into
//     builds made here): the secret, ADMIN_EMAIL and the SMTP settings;
//   - writes the contact numbers into src/main/activation-config.json
//     (committed).
// GitHub release builds need the same file as the ACTIVATION_CONFIG
// repository secret (printed below).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ENV_FILE, loadEnv, appSettings } = require('./lib');

const mainDir = path.join(__dirname, '..', '..', 'src', 'main');

let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : fs.readFileSync(path.join(__dirname, '.env.example'), 'utf8');
const has = (k) => new RegExp(`^${k}=\\S`, 'm').test(text);
const set = (k, v) => {
  text = new RegExp(`^${k}=`, 'm').test(text) ? text.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : `${text.trimEnd()}\n${k}=${v}\n`;
};
if (!has('ACTIVATION_SECRET') || process.argv.includes('--new-secret')) {
  set('ACTIVATION_SECRET', crypto.randomBytes(32).toString('base64'));
  console.log('Created a new activation secret in .env. Back up .env.');
}
fs.writeFileSync(ENV_FILE, text, { mode: 0o600 });

const env = loadEnv();
const contact = { whatsapp: (env.CONTACT_WHATSAPP || '').replace(/\D/g, ''), phone: (env.CONTACT_PHONE || '').replace(/[^\d+]/g, '') };
fs.writeFileSync(path.join(mainDir, 'activation-config.json'), `${JSON.stringify({ contact }, null, 2)}\n`);

const { missing, settings } = appSettings(env);
if (missing.length) {
  console.error(`Fill in ${missing.join(', ')} in tools/activation/.env, then run npm run setup again.`);
  process.exit(1);
}
const out = path.join(mainDir, 'activation-secret.json');
fs.writeFileSync(out, `${JSON.stringify(settings)}\n`, { mode: 0o600 });
console.log('Wrote src/main/activation-secret.json (git-ignored). Test the email account with: npm run check-smtp');
console.log('For releases built on GitHub, from the repository folder: gh secret set ACTIVATION_CONFIG < src/main/activation-secret.json');
