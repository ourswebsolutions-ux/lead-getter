'use strict';

// Sends activation requests to the administrator over SMTP. The settings
// come from the build-time activation-secret.json; they are never logged.
// `insecure` (no TLS) is only for the local test mail server.

const nodemailer = require('nodemailer');

function createMailer(smtp, { allowInsecure = false } = {}) {
  const port = Number(smtp.port);
  const insecure = allowInsecure && smtp.insecure === true;
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port,
    secure: !insecure && port === 465,
    requireTLS: !insecure && port !== 465,
    ignoreTLS: insecure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    logger: false,
    debug: false,
  });
  return {
    send: (msg) => transport.sendMail({ from: smtp.from || smtp.user, ...msg }),
    verify: () => transport.verify(),
  };
}

// A short, safe description of a failed send (no credentials, no server
// replies that could contain them).
function mailError(err) {
  const code = err?.code || '';
  if (code === 'EAUTH') return 'the email account rejected the login';
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS'].includes(code) || /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/.test(String(err?.message))) return 'the email server could not be reached';
  if (code === 'EENVELOPE' || code === 'EMESSAGE') return 'the email server refused the message';
  return 'the email could not be sent';
}

module.exports = { createMailer, mailError };
