'use strict';

// Sends a test email to ADMIN_EMAIL with the settings from .env, as the
// app will. Nothing secret is printed.

const { loadEnv, appSettings } = require('./lib');
const { createMailer, mailError } = require('../../src/main/mailer');

(async () => {
  const { missing, settings } = appSettings(loadEnv());
  if (missing.length) throw new Error(`Fill in ${missing.join(', ')} in tools/activation/.env first.`);
  const mailer = createMailer(settings.smtp);
  try {
    await mailer.verify();
    await mailer.send({ to: settings.adminEmail, subject: 'Lead Finder: activation email test', text: 'This is a test. Activation requests from Lead Finder will arrive like this.' });
  } catch (err) {
    throw new Error(`SMTP failed: ${mailError(err)} (${err.code || 'error'}).`);
  }
  console.log(`SMTP works: a test email was sent to ${settings.adminEmail}.`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
