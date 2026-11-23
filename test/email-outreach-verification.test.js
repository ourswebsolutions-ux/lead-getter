'use strict';
// Acceptance: campaign emails go only to addresses that passed verification.
// Valid ones are sent; invalid, disposable (risky), catch-all and unreachable
// (unknown) ones never are, whatever path queues them (retries, a direct send,
// a recipient put back in the queue); a catch-all address is sent only once
// the user allows catch-all; an expired result is checked again before
// sending; without verification nothing is sent at all.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { startSmtp } = require('./fake-smtp');
const { startMx, testEngine } = require('./fake-mx');
const { EmailAccounts } = require('../src/email/accounts');
const { EmailCampaigns } = require('../src/email/campaigns');
const { EmailVerification } = require('../src/email/verification');
const { Vault } = require('../src/main/vault');

function memState() {
  const m = new Map();
  return { getState: (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setState: (k, v) => m.set(k, JSON.stringify(v)) };
}
const cipher = { encrypt: (t) => Buffer.from(String(t), 'utf8').reverse(), decrypt: (b) => Buffer.from(b).reverse().toString('utf8') };

const LEADS = [
  { id: 1, name: 'Good Co', email: 'ali@good.test', categoryId: 1 },
  { id: 2, name: 'Gone Co', email: 'nouser@good.test', categoryId: 1 },
  { id: 3, name: 'Temp Mail', email: 'x@mailinator.com', categoryId: 1 },
  { id: 4, name: 'Catch Co', email: 'any@catchall.test', categoryId: 1 },
  { id: 5, name: 'Down Co', email: 'z@unreachable.test', categoryId: 1 },
  { id: 6, name: 'Typo Co', email: 'bad@@good.test', categoryId: 1 },
  { id: 7, name: 'Two Mails', email: 'old@good.test', emails: [{ email: 'old@good.test' }, { email: 'sales@good.test' }], categoryId: 1 },
  { id: 8, name: 'No Domain', email: 'q@gone.invalid', categoryId: 1 },
];

async function setup(t, { withVerification = true } = {}) {
  const smtp = await startSmtp();
  const mx = await startMx({ exists: ['ali@good.test', 'sales@good.test'], catchAll: ['catchall.test'] });
  const state = memState();
  const db = new DatabaseSync(':memory:');
  const accounts = new EmailAccounts({ store: state, vault: new Vault({ store: state, key: 'email.secrets', cipher }), allowInsecure: true });
  const time = { now: 1_800_000_000_000 };
  const campaigns = new EmailCampaigns({ db, accounts, leads: () => LEADS, clock: () => time.now, tickMs: 60_000 });
  const verification = new EmailVerification({ db, state: { get: state.getState, set: state.setState }, makeEngine: testEngine(mx), clock: () => time.now });
  if (withVerification) {
    campaigns.verification = verification;
    verification.on('verified', (list) => campaigns.applyVerification(list.map((x) => x.email)));
    verification.on('policy', () => campaigns.applyVerification(null));
  }
  t.after(async () => {
    campaigns.dispose();
    accounts.dispose();
    verification.stop();
    await smtp.close();
    await mx.close();
  });
  const acc = accounts.add({ name: 'SMTP', senderName: 'Axora', email: 'sender@example.com', host: '127.0.0.1', port: smtp.port, username: 'sender@example.com', password: 'pw', encryption: 'none' });
  const c = campaigns.create({ name: 'Outreach' });
  campaigns.update(c.id, { accountId: acc.account.id, subject: 'Hi {business}', body: 'Hello', delaySeconds: 10 });
  const run = async (rounds = 12, step = 11_000) => {
    for (let i = 0; i < rounds; i++) {
      await campaigns.tick();
      time.now += step;
    }
  };
  const sentTo = () => smtp.messages.flatMap((m) => m.to);
  return { smtp, mx, campaigns, verification, time, c, run, sentTo, db };
}

test('Only verified emails are sent; invalid, disposable, catch-all, unreachable and malformed ones never are', { timeout: 120_000 }, async (t) => {
  const { campaigns, verification, time, c, run, sentTo, mx, db } = await setup(t);
  // Found earlier and checked in the background: this lead's first address does not exist.
  await verification.ensure(['old@good.test'], { timeout: 10_000 });
  assert.equal(verification.statusOf('old@good.test').status, 'invalid');
  const added = campaigns.addLeads(c.id, {});
  assert.ok(added.ok, added.error);
  assert.equal(added.noEmail, 1, 'the malformed address is not an address');
  assert.equal(added.added, 7);
  assert.ok((await campaigns.start(c.id)).ok);
  await run();
  // The lead with two addresses is emailed at the one that passed.
  assert.deepEqual(sentTo().sort(), ['ali@good.test', 'sales@good.test']);
  const rows = Object.fromEntries(campaigns.snapshot(c.id).recipients.map((r) => [r.email, r]));
  assert.equal(rows['nouser@good.test'].state, 'skipped');
  assert.match(rows['nouser@good.test'].error, /Not sent: email Invalid \(the mail server says the mailbox does not exist\)/);
  assert.match(rows['x@mailinator.com'].error, /Risky \(a disposable/);
  assert.match(rows['any@catchall.test'].error, /Catch-all/);
  assert.match(rows['q@gone.invalid'].error, /Invalid \(the domain has no mail server\)/);
  assert.equal(rows['ali@good.test'].verify, 'ready');
  // The unreachable server is asked again later; meanwhile it waits, unsent.
  assert.equal(rows['z@unreachable.test'].state, 'queued');
  assert.equal(rows['z@unreachable.test'].verify, 'checking');
  assert.equal(campaigns.summary(c.id).waiting, 'verifying');
  assert.equal(campaigns.summary(c.id).status, 'running');
  for (const wait of [16 * 60_000, 61 * 60_000, 6.1 * 3600_000]) {
    time.now += wait;
    verification.engine = null;
    await run(2);
  }
  assert.equal(campaigns.snapshot(c.id).recipients.find((r) => r.email === 'z@unreachable.test').state, 'skipped');
  assert.match(campaigns.snapshot(c.id).recipients.find((r) => r.email === 'z@unreachable.test').error, /Unknown/);
  await run(2);
  assert.equal(campaigns.summary(c.id).status, 'completed');
  assert.deepEqual(campaigns.summary(c.id).verify, { ready: 0, checking: 0, excluded: 5 });
  assert.equal(sentTo().length, 2);

  // Ways around it do not work: retrying, putting one back in the queue, sending it directly.
  assert.equal(campaigns.retryFailed(c.id, { includeUncertain: true }).requeued, 0);
  db.prepare("UPDATE email_recipients SET state = 'queued', error = NULL WHERE email IN ('nouser@good.test', 'any@catchall.test')").run();
  const row = db.prepare("SELECT * FROM email_recipients WHERE email = 'nouser@good.test'").get();
  await campaigns.sendOne(campaigns.row(c.id), row);
  db.prepare("UPDATE email_campaigns SET status = 'running' WHERE id = ?").run(c.id);
  await run(3);
  assert.equal(sentTo().length, 2, 'still nothing to an address that failed');
  assert.equal(db.prepare("SELECT state FROM email_recipients WHERE email = 'nouser@good.test'").get().state, 'skipped');

  // The user allows catch-all addresses: that one is queued again and sent.
  const before = mx.rcpts.length;
  verification.save({ allow: { catch_all: true } });
  await campaigns.resume(c.id).catch(() => {});
  if (campaigns.summary(c.id).status !== 'running') await campaigns.start(c.id);
  await run(3);
  assert.ok(sentTo().includes('any@catchall.test'));
  assert.ok(!sentTo().includes('nouser@good.test'));
  assert.equal(mx.rcpts.length, before, 'kept results: nothing asked again');
});

test('An expired result is checked again before sending; without verification nothing is sent', { timeout: 60_000 }, async (t) => {
  const { campaigns, verification, time, c, run, sentTo, mx } = await setup(t);
  await verification.ensure(['ali@good.test'], { timeout: 10_000 });
  time.now += 31 * 24 * 3600_000; // valid results last 30 days
  campaigns.addLeads(c.id, { ids: [1] });
  const asked = mx.rcpts.filter((e) => e === 'ali@good.test').length;
  await campaigns.start(c.id);
  await run(2);
  assert.deepEqual(sentTo(), ['ali@good.test']);
  assert.equal(mx.rcpts.filter((e) => e === 'ali@good.test').length, asked + 1, 'checked again before it was sent');

  const off = await setup(t, { withVerification: false });
  off.campaigns.addLeads(off.c.id, { ids: [1] });
  await off.campaigns.start(off.c.id);
  await off.run(3);
  assert.deepEqual(off.sentTo(), [], 'no verification, no sending');
});
