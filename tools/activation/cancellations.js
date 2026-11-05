'use strict';

// One pass over the inbox of the SMTP account: cancellation emails from the
// administrator become the signed list every copy of the app reads
// (src/main/cancellations.js).
// Run by .github/workflows/cancellations.yml, or by hand:
//   node cancellations.js --state <file>
//
// The mailbox is opened only here, read-only. The signing key is never built
// into the app, and neither login is ever written to the log.

const fs = require('node:fs');
const path = require('node:path');
const { ImapFlow } = require('imapflow');
const { createMailer, mailError } = require('../../src/main/mailer');
const { loadEnv, appSettings } = require('./lib');
const { SUBJECT, processCommands } = require('./cancel-lib');

const TRIES = 3;
const LOOK_BACK = 30 * 24 * 60 * 60 * 1000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A safe description of a failure: never the settings or the login.
const safe = (err) => err?.code || err?.responseStatus || 'connection failed';

// Connected, for one pass. The mailbox is only read: nothing in it changes.
async function withMailbox(imap, fn) {
  const client = new ImapFlow({ host: imap.host, port: imap.port, secure: true, auth: { user: imap.user, pass: imap.pass }, logger: false });
  client.on('error', () => {}); // a dropped connection fails the running step, which is retried
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => {});
  }
}

async function inFolder(client, path, fn) {
  const lock = await client.getMailboxLock(path, { readOnly: true });
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

const mailboxFor = (client, now) => ({
  commands: () =>
    inFolder(client, 'INBOX', async () => {
      const uids = await client.search({ subject: SUBJECT, since: new Date(now - LOOK_BACK) }, { uid: true });
      if (!uids?.length) return [];
      const out = [];
      for await (const m of client.fetch(uids, { source: true, internalDate: true }, { uid: true })) out.push({ source: m.source, date: m.internalDate });
      return out;
    }),
  // Every activation request and Free Trial is emailed from this account, so
  // a real Activation ID is in its Sent mail.
  async known(activationId) {
    const folders = await client.list();
    const sent = folders.find((f) => f.specialUse === '\\Sent')?.path || 'INBOX';
    return inFolder(client, sent, async () => {
      const hits = await client.search({ body: activationId, not: { subject: SUBJECT } }, { uid: true });
      return Boolean(hits?.length);
    });
  },
});

function report(mailer, adminEmail, e) {
  const lines = [`Time: ${e.at}`, ...(e.activationId ? [`Activation ID: ${e.activationId}`] : []), ...(e.reason ? [`Reason: ${e.reason}`] : [])];
  // Refused senders get no answer, and the notice goes only to the administrator.
  const subject = e.result === 'cancelled' ? 'Lead Finder: Subscription Cancellation accepted' : e.result === 'ignored' ? 'Lead Finder: Subscription Cancellation ignored' : 'Lead Finder: Subscription Cancellation refused';
  const note = e.result === 'cancelled' ? ['The plan ends the next time that computer checks the list (about every 10 minutes while the app is open, and at each start). You get another email when it has.'] : [];
  return mailer.send({ to: adminEmail, subject, text: [...lines, ...note].join('\n') });
}

async function main() {
  const at = process.argv.indexOf('--state');
  const stateFile = at > 0 ? path.resolve(process.argv[at + 1]) : '';
  const env = loadEnv();
  const { settings } = appSettings(env);
  // The existing Gmail login reads that account too; IMAP_USER / IMAP_PASS
  // are only for sending through something else.
  const gmail = settings.smtp?.host === 'smtp.gmail.com';
  const imap = { host: env.IMAP_HOST || 'imap.gmail.com', port: Number(env.IMAP_PORT || 993), user: env.IMAP_USER || (gmail ? settings.smtp.user : ''), pass: env.IMAP_PASS || (gmail ? settings.smtp.pass : '') };
  if (!stateFile || !imap.user || !imap.pass || !env.CANCEL_SIGNING_KEY || !settings.adminEmail) {
    console.log('Cancellations are not set up (a Gmail SMTP login or IMAP_USER and IMAP_PASS, CANCEL_SIGNING_KEY, ADMIN_EMAIL, --state): nothing to do.');
    return;
  }
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
  const now = Date.now();
  let result = null;
  for (let attempt = 1; !result; attempt++) {
    try {
      result = await withMailbox(imap, (client) => processCommands({ mailbox: mailboxFor(client, now), state, adminEmail: settings.adminEmail, privateKey: env.CANCEL_SIGNING_KEY, now }));
    } catch (err) {
      console.error(`Inbox attempt ${attempt} failed: ${safe(err)}`);
      if (attempt >= TRIES) process.exit(1); // nothing was written: the next run starts again
      await wait(attempt * 5000);
    }
  }
  if (result.changed) fs.writeFileSync(stateFile, `${JSON.stringify(result.state, null, 1)}\n`);
  // The repository is public, so this log has no Activation IDs: the full
  // record of each event is the email to the administrator.
  const mailer = settings.smtp?.host ? createMailer(settings.smtp) : null;
  for (const e of result.events) {
    console.log(`${e.at} ${e.result}${e.reason ? `: ${e.reason}` : ''}`);
    if (mailer) await report(mailer, settings.adminEmail, e).catch((err) => console.error(`Notice not sent: ${mailError(err)}`));
  }
  console.log(`${result.events.length} new command email(s).`);
}

main().catch((err) => {
  console.error(`Stopped: ${safe(err)}`);
  process.exit(1);
});
