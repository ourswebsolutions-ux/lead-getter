'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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

function secretFrom(env) {
  const secret = Buffer.from(env.ACTIVATION_SECRET || '', 'base64');
  if (secret.length < 16) throw new Error('No activation secret yet. Run `npm run setup` first.');
  return secret;
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

// Sends to ADMIN_EMAIL only. With MAIL_OUTBOX_DIR (tests), writes the email
// to a file instead. SMTP credentials are never printed.
function createMailer(env) {
  if (!EMAIL_RE.test(env.ADMIN_EMAIL || '')) throw new Error('Set ADMIN_EMAIL in .env to the administrator\'s email address.');
  if (env.MAIL_OUTBOX_DIR) {
    const dir = path.resolve(__dirname, env.MAIL_OUTBOX_DIR);
    return {
      verify: async () => true,
      send: async ({ subject, text }) => {
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`);
        fs.writeFileSync(file, JSON.stringify({ to: env.ADMIN_EMAIL, subject, text }, null, 2), { mode: 0o600 });
      },
    };
  }
  const missing = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`Set ${missing.join(', ')} in .env (see .env.example).`);
  const nodemailer = require('nodemailer');
  const port = Number(env.SMTP_PORT);
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
    logger: false,
    debug: false,
  });
  return {
    verify: () => transport.verify(),
    send: ({ subject, text }) => transport.sendMail({ from: env.SMTP_FROM || env.SMTP_USER, to: env.ADMIN_EMAIL, subject, text }),
  };
}

module.exports = { ENV_FILE, loadEnv, secretFrom, createMailer };
