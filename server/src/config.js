'use strict';

const fs = require('node:fs');
const path = require('node:path');

const list = (v, d) => (v ? v.split(',').map((x) => Number(x.trim())).filter((n) => n > 0 && n <= 100) : d);

// All settings come from the environment (see .env.example). The Supabase
// secret key and database password are only ever read here, on the server.
function loadConfig(env = process.env) {
  const mail = env.BREVO_API_KEY ? ['SMTP_FROM'] : ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];
  const required = [...mail, 'SUBSCRIPTION_ADMIN_EMAIL', 'PUBLIC_BASE_URL', 'LICENSE_PRIVATE_KEY', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_DB_URL'];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  const caFile = path.resolve(__dirname, '..', env.SUPABASE_DB_CA || 'certs/supabase-root-2021-ca.crt');
  return {
    port: Number(env.PORT || 8787),
    host: env.HOST || '127.0.0.1',
    publicBaseUrl: env.PUBLIC_BASE_URL,
    adminEmail: env.SUBSCRIPTION_ADMIN_EMAIL,
    paymentInstructions: env.PAYMENT_INSTRUCTIONS || '',
    licensePrivateKey: Buffer.from(env.LICENSE_PRIVATE_KEY, 'base64').toString('utf8'),
    brevoApiKey: env.BREVO_API_KEY || '',
    smtp: { host: env.SMTP_HOST, port: Number(env.SMTP_PORT), user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.SMTP_FROM },
    supabase: {
      url: env.SUPABASE_URL,
      secretKey: env.SUPABASE_SECRET_KEY,
      dbUrl: env.SUPABASE_DB_URL,
      dbCa: fs.readFileSync(caFile, 'utf8'),
      schema: env.SUPABASE_SCHEMA || 'leadfinder',
      bucket: env.SUPABASE_BUCKET || 'payment-screenshots',
      cron: env.SUPABASE_CRON !== '0',
    },
    retention: { screenshotDays: Math.max(1, Number(env.SCREENSHOT_RETENTION_DAYS || 90)) },
    usage: {
      dbLimitMB: Number(env.USAGE_DB_LIMIT_MB || 500),
      storageLimitMB: Number(env.USAGE_STORAGE_LIMIT_MB || 1024),
      alertPercents: list(env.USAGE_ALERT_PERCENTS, [80, 90, 95]),
    },
    maintenance: {
      intervalHours: Math.max(1, Number(env.MAINTENANCE_INTERVAL_HOURS || 6)),
      dryRun: env.MAINTENANCE_DRY_RUN === '1',
      maxDeletesPerRun: Math.max(1, Number(env.MAINTENANCE_MAX_DELETES || 200)),
    },
  };
}

module.exports = { loadConfig };
