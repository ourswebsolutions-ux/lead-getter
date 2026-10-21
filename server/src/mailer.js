'use strict';

const nodemailer = require('nodemailer');

// Mail from environment variables only. Credentials are never logged.
// SMTP by default; BREVO_API_KEY switches to Brevo's HTTPS API for hosts that
// block outgoing SMTP (Render's free tier does).
function createMailer(config) {
  return config.brevoApiKey ? brevoMailer(config) : smtpMailer(config);
}

function smtpMailer(config) {
  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    requireTLS: config.smtp.port !== 465,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
    // Fail fast instead of holding an application request for minutes.
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
    logger: false,
    debug: false,
  });
  return {
    send: (msg) => transport.sendMail({ from: config.smtp.from, ...msg }),
    verify: () => transport.verify(),
  };
}

// "Name <a@b.c>" or "a@b.c"
function parseAddress(from) {
  const m = String(from).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1] || undefined, email: m[2] } : { email: String(from).trim() };
}

function brevoMailer(config, fetchImpl = globalThis.fetch) {
  const call = async (path, init = {}) => {
    const res = await fetchImpl(`https://api.brevo.com/v3${path}`, {
      ...init,
      headers: { 'api-key': config.brevoApiKey, accept: 'application/json', 'content-type': 'application/json' },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const err = new Error(`Brevo ${res.status}: ${(await res.text()).slice(0, 200)}`);
      err.code = `BREVO_${res.status}`;
      throw err;
    }
    return res.json();
  };
  return {
    send: (msg) =>
      call('/smtp/email', {
        method: 'POST',
        body: JSON.stringify({
          sender: parseAddress(config.smtp.from),
          to: [{ email: msg.to }],
          subject: msg.subject,
          textContent: msg.text,
          htmlContent: msg.html || undefined,
          attachment: msg.attachments?.length ? msg.attachments.map((a) => ({ name: a.filename, content: Buffer.from(a.content).toString('base64') })) : undefined,
        }),
      }),
    verify: () => call('/account'),
  };
}

module.exports = { createMailer, brevoMailer, parseAddress };
