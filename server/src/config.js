'use strict';

const path = require('node:path');

// All settings come from the environment (see .env.example).
function loadConfig(env = process.env) {
  const missing = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SUBSCRIPTION_ADMIN_EMAIL', 'PUBLIC_BASE_URL', 'LICENSE_PRIVATE_KEY'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  return {
    port: Number(env.PORT || 8787),
    host: env.HOST || '127.0.0.1',
    publicBaseUrl: env.PUBLIC_BASE_URL,
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
    adminEmail: env.SUBSCRIPTION_ADMIN_EMAIL,
    paymentInstructions: env.PAYMENT_INSTRUCTIONS || '',
    licensePrivateKey: Buffer.from(env.LICENSE_PRIVATE_KEY, 'base64').toString('utf8'),
    smtp: { host: env.SMTP_HOST, port: Number(env.SMTP_PORT), user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.SMTP_FROM },
  };
}

module.exports = { loadConfig };
