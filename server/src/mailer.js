'use strict';

const nodemailer = require('nodemailer');

// SMTP from environment variables only. Credentials are never logged.
function createMailer(config) {
  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    requireTLS: config.smtp.port !== 465,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
    logger: false,
    debug: false,
  });
  return {
    send: (msg) => transport.sendMail({ from: config.smtp.from, ...msg }),
    verify: () => transport.verify(),
  };
}

module.exports = { createMailer };
