'use strict';

// For the GitHub workflow: turns its two JSON secrets into the settings
// cancellations.js reads, then runs it.

const set = (k, v) => {
  if (v !== undefined && v !== null && v !== '') process.env[k] = String(v);
};
const cancel = JSON.parse(process.env.CANCELLATION_CONFIG || '{}');
const app = JSON.parse(process.env.ACTIVATION_CONFIG || '{}');
delete process.env.CANCELLATION_CONFIG;
delete process.env.ACTIVATION_CONFIG;
for (const k of ['IMAP_HOST', 'IMAP_PORT', 'IMAP_USER', 'IMAP_PASS', 'CANCEL_SIGNING_KEY']) set(k, cancel[k]);
set('ADMIN_EMAIL', app.adminEmail);
set('SMTP_HOST', app.smtp?.host);
set('SMTP_PORT', app.smtp?.port);
set('SMTP_USER', app.smtp?.user);
set('SMTP_PASS', app.smtp?.pass);
set('SMTP_FROM', app.smtp?.from);
require('./cancellations');
