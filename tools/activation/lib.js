'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ENV_FILE = process.env.ACTIVATION_ENV_FILE || path.join(__dirname, '.env');

// Settings from .env; variables already set in the environment win.
function loadEnv() {
  const env = {};
  if (fs.existsSync(ENV_FILE)) {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
  }
  for (const k of Object.keys(process.env)) if (/^[A-Z0-9_]+$/.test(k)) env[k] = process.env[k];
  return env;
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

// The app's activation settings from .env, or the list of what is missing.
function appSettings(env) {
  const missing = ['ADMIN_EMAIL', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'ACTIVATION_SECRET'].filter((k) => !env[k]);
  if (env.ADMIN_EMAIL && !EMAIL_RE.test(env.ADMIN_EMAIL)) missing.push('ADMIN_EMAIL (not an email address)');
  return {
    missing,
    settings: {
      secret: env.ACTIVATION_SECRET,
      adminEmail: env.ADMIN_EMAIL,
      smtp: { host: env.SMTP_HOST, port: Number(env.SMTP_PORT), user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.SMTP_FROM || env.SMTP_USER },
    },
  };
}

module.exports = { ENV_FILE, loadEnv, appSettings };
