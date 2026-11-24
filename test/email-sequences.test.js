'use strict';
// Email sequences: the first email, then follow-ups on their days while the
// lead has not replied; replies, bounces, unsubscribes, stops and
// verification end a lead's sequence; out-of-office replies do not; pause,
// resume, restart, retries with doubling waits, several campaigns and
// accounts, sending days and hours in a time zone, the signature, threads,
// timelines and the dashboard. All on local test servers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { startSmtp } = require('./fake-smtp');
const { startMx, testEngine } = require('./fake-mx');
const { EmailAccounts } = require('../src/email/accounts');
const { EmailCampaigns } = require('../src/email/campaigns');
const { EmailVerification } = require('../src/email/verification');
const { ReplyWatcher, parseBounce, isAutoReply } = require('../src/email/replies');
const { inWindow, nextWindow, checkFollowups, withSignature } = require('../src/email/sequence');
const { Vault } = require('../src/main/vault');

const DAY = 24 * 3600_000;
const MIN = 60_000;
function memState() {
  const m = new Map();
  return { getState: (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setState: (k, v) => m.set(k, JSON.stringify(v)) };
}
const cipher = { encrypt: (t) => Buffer.from(String(t), 'utf8').reverse(), decrypt: (b) => Buffer.from(b).reverse().toString('utf8') };
const LEADS = [
  { id: 1, name: 'Zahid Properties', contactName: 'Zahid Khan', email: 'zahid@good.test', categoryId: 1 },
  { id: 2, name: 'Noor Estate', email: 'noor@good.test', categoryId: 1 },
  { id: 3, name: 'Bright Homes', email: 'sara@good.test', categoryId: 1 },
];

// The AI in these tests: a follow-up written from what it is given.
const testWriter = async (x) => ({ subject: x.subject, body: `Just following up on my email, ${(x.business?.contact_name || 'there').split(' ')[0]}.` });

async function setup(t, { start = Date.parse('2026-11-23T05:00:00Z'), writer = testWriter } = {}) {
  const smtp = await startSmtp();
  const mx = await startMx({ exists: (e) => !e.includes('nouser') });
  const state = memState();
  const db = new DatabaseSync(':memory:');
  const accounts = new EmailAccounts({ store: state, vault: new Vault({ store: state, key: 'email.secrets', cipher }), allowInsecure: true });
  const time = { now: start };
  const make = () => {
    const c = new EmailCampaigns({ db, accounts, leads: (f = {}) => LEADS.filter((l) => (f.ids ? f.ids.includes(l.id) : true)), clock: () => time.now, tickMs: 60_000, writer, random: () => 0 });
    c.verification = verification;
    return c;
  };
  const verification = new EmailVerification({ db, state: { get: state.getState, set: state.setState }, makeEngine: testEngine(mx), clock: () => time.now });
  let campaigns = make();
  t.after(async () => {
    campaigns.dispose();
    accounts.dispose();
    verification.stop();
    await smtp.close();
    await mx.close();
  });
  const acc = accounts.add({ name: 'SMTP', senderName: 'Ali from Axora', email: 'sender@example.com', host: '127.0.0.1', port: smtp.port, username: 'sender@example.com', password: 'pw', encryption: 'none' }).account;
  // Every minute for a while: the campaigns run, time goes by.
  const run = async (ms, step = MIN) => {
    for (const end = time.now + ms; time.now < end; time.now += step) await campaigns.tick();
  };
  const to = (email) => smtp.messages.filter((m) => m.to.includes(email));
  return { smtp, mx, db, state, accounts, acc, time, run, to, get campaigns() { return campaigns; }, restart: () => { campaigns.dispose(); campaigns = make(); campaigns.init(); campaigns.dispose(); return campaigns; } };
}

function sequence(campaigns, accId, extra = {}) {
  const c = campaigns.create({ name: 'Sequence' });
  const r = campaigns.update(c.id, {
    accountIds: [accId],
    subject: 'Website for {business}',
    body: 'Hello {name},\n\nWe build websites.',
    delaySeconds: 60,
    signature: 'Best,\nAli',
    followups: { on: true, steps: [{ days: 2, subject: '', body: 'Just following up on my email, {name}.' }, { days: 3, subject: '', body: 'One last note.' }, { days: 4, subject: '', body: 'Closing the loop.' }] },
    ...extra,
  });
  assert.ok(r.ok, r.error);
  return c.id;
}

test('Initial email, then follow-ups on days 3, 6 and 10 (2, 3, 4 days after the previous one), in the same thread, with the signature', { timeout: 60_000 }, async (t) => {
  const h = await setup(t);
  const id = sequence(h.campaigns, h.acc.id);
  h.campaigns.addLeads(id, { ids: [1] });
  assert.ok((await h.campaigns.start(id)).ok);
  await h.run(5 * MIN);
  const first = h.to('zahid@good.test');
  assert.equal(first.length, 1, 'the first email');
  assert.match(first[0].text, /Subject: Website for Zahid Properties/);
  assert.match(first[0].text, /We build websites\.\n\nBest,\nAli\n/, 'the signature at the end');
  const sentAt = h.campaigns.db.prepare("SELECT sent_at FROM email_recipients WHERE email = 'zahid@good.test'").get().sent_at;
  const row = h.campaigns.recipientRows(id, 10)[0];
  assert.equal(row.status, 'followup_scheduled');
  assert.equal(row.nextFollowupAt, sentAt + 2 * DAY, 'follow-up 1 scheduled for day 3');
  assert.equal(h.campaigns.summary(id).status, 'running', 'follow-ups still to come');
  assert.equal(h.campaigns.summary(id).waiting, 'followups');
  // Not before its time.
  await h.run(2 * DAY - 10 * MIN, 30 * MIN);
  assert.equal(h.to('zahid@good.test').length, 1);
  await h.run(20 * MIN);
  const fu1 = h.to('zahid@good.test')[1];
  assert.ok(fu1, 'follow-up 1 on day 3');
  assert.match(fu1.text, /Subject: Re: Website for Zahid Properties/);
  assert.match(fu1.text, /In-Reply-To: <.+>/);
  assert.match(fu1.text, /Just following up on my email, Zahid\.\n\nBest,\nAli/);
  await h.run(3 * DAY + 30 * MIN, 30 * MIN);
  assert.equal(h.to('zahid@good.test').length, 3, 'follow-up 2 on day 6');
  assert.match(h.to("zahid@good.test")[2].text, /References: <[^>]+>\s+<[^>]+>/, "it answers both earlier emails");
  await h.run(4 * DAY + 30 * MIN, 30 * MIN);
  assert.equal(h.to('zahid@good.test').length, 4, 'follow-up 3 on day 10');
  await h.run(10 * DAY, 2 * 3600_000);
  assert.equal(h.to('zahid@good.test').length, 4, 'nothing after the last step');
  assert.equal(h.campaigns.recipientRows(id, 10)[0].status, 'sequence_completed');
  assert.equal(h.campaigns.summary(id).status, 'completed');
  const tl = h.campaigns.timeline(id, 'zahid@good.test');
  assert.deepEqual(tl.filter((e) => ['email', 'followup'].includes(e.kind)).map((e) => [e.kind, e.step, e.state]), [['email', 0, 'sent'], ['followup', 1, 'sent'], ['followup', 2, 'sent'], ['followup', 3, 'sent']]);
  const d = h.campaigns.dashboard();
  assert.equal(d.sent, 1);
  assert.equal(d.followupsSent, 3);
});

test('A reply stops the follow-ups (also one matched by its thread from another address); an out-of-office reply does not; unsubscribed and stopped leads get nothing more', { timeout: 60_000 }, async (t) => {
  const h = await setup(t);
  const id = sequence(h.campaigns, h.acc.id);
  h.campaigns.addLeads(id, {});
  await h.campaigns.start(id);
  await h.run(10 * MIN);
  assert.equal(h.smtp.messages.length, 3);
  const msgId = (e) => h.campaigns.db.prepare('SELECT message_id FROM email_recipients WHERE email = ?').get(e).message_id;
  const inbox = [
    { from: 'owner@gmail.com', subject: 'Re: Website', text: 'Yes, call me.', messageId: '<r1@x>', references: [msgId('zahid@good.test')] },
    { from: 'noor@good.test', subject: 'Automatic reply: Website', text: 'I am out of the office until Monday.', messageId: '<r2@x>', auto: isAutoReply({ 'auto-submitted': 'auto-replied' }, 'Automatic reply: Website') },
  ];
  const watcher = new ReplyWatcher({ accounts: h.accounts, campaigns: h.campaigns, state: { get: h.state.getState, set: h.state.setState }, clock: () => h.time.now, openInbox: async function* () { yield* inbox; } });
  assert.equal((await watcher.check(h.acc.id)).replies, 1);
  h.campaigns.optOut('sara@good.test');
  const rows = Object.fromEntries(h.campaigns.recipientRows(id, 10).map((r) => [r.email, r]));
  assert.equal(rows['zahid@good.test'].status, 'replied');
  assert.equal(rows['noor@good.test'].status, 'followup_scheduled', 'the sequence goes on after an out-of-office reply');
  assert.ok(rows['noor@good.test'].autoReplyAt);
  assert.equal(rows['sara@good.test'].status, 'unsubscribed');
  await h.run(3 * DAY, 30 * MIN);
  assert.equal(h.to('zahid@good.test').length, 1, 'no follow-up after a reply');
  assert.equal(h.to('sara@good.test').length, 1, 'none after unsubscribing');
  assert.equal(h.to('noor@good.test').length, 2, 'follow-up 1 to the one who was away');
  // Stopped by hand: nothing more; allowed again: the sequence goes on.
  assert.ok(h.campaigns.stopLead(id, 'noor@good.test').ok);
  await h.run(4 * DAY, 30 * MIN);
  assert.equal(h.to('noor@good.test').length, 2);
  assert.equal(h.campaigns.recipientRows(id, 10).find((r) => r.email === 'noor@good.test').status, 'stopped');
  h.campaigns.stopLead(id, 'noor@good.test', false);
  await h.run(1 * DAY, 30 * MIN);
  assert.equal(h.to('noor@good.test').length, 3);
  // Not interested ends it too; interested is kept.
  h.campaigns.setInterest(id, 'noor@good.test', 'not_interested');
  await h.run(6 * DAY, 2 * 3600_000);
  assert.equal(h.to('noor@good.test').length, 3);
  assert.ok(h.campaigns.followupCounts(id).cancelled >= 3);
});

test('Bounces: a delivery failure report stops the sequence, suppresses the address and marks it invalid; a refusal while sending does too; a delay report does not', { timeout: 60_000 }, async (t) => {
  const h = await setup(t);
  const id = sequence(h.campaigns, h.acc.id);
  h.campaigns.addLeads(id, { ids: [1, 2] });
  await h.campaigns.start(id);
  await h.run(5 * MIN);
  const original = h.campaigns.db.prepare("SELECT message_id FROM email_recipients WHERE email = 'zahid@good.test'").get().message_id;
  const dsn = {
    from: 'mailer-daemon@googlemail.com',
    subject: 'Delivery Status Notification (Failure)',
    raw: `From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>\r\nMessage-ID: <dsn1@google.com>\r\nContent-Type: multipart/report; report-type=delivery-status; boundary="b"\r\n\r\n--b\r\nAddress not found\r\n--b\r\nContent-Type: message/delivery-status\r\n\r\nFinal-Recipient: rfc822; zahid@good.test\r\nAction: failed\r\nStatus: 5.1.1\r\nDiagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach does not exist.\r\n--b\r\nContent-Type: text/rfc822-headers\r\n\r\nMessage-ID: ${original}\r\nSubject: Website for Zahid Properties\r\n--b--\r\n`,
    messageId: '<dsn1@google.com>',
  };
  const b = parseBounce(dsn);
  assert.deepEqual([b.email, b.messageId, b.permanent], ['zahid@good.test', original, true]);
  assert.match(b.reason, /does not exist/);
  const delay = parseBounce({ from: 'mailer-daemon@x.com', subject: 'Delivery Status Notification (Delay)', raw: 'Final-Recipient: rfc822; noor@good.test\nStatus: 4.4.1\nWill keep trying' });
  assert.equal(delay.permanent, false);
  assert.equal(parseBounce({ from: 'noor@good.test', subject: 'Re: Website', raw: 'Thanks!' }), null);
  const watcher = new ReplyWatcher({ accounts: h.accounts, campaigns: h.campaigns, state: { get: h.state.getState, set: h.state.setState }, clock: () => h.time.now, openInbox: async function* () { yield dsn; yield { ...delay, messageId: '<d2@x>' }; } });
  const r = await watcher.check(h.acc.id);
  assert.equal(r.bounces, 1);
  assert.equal((await watcher.check(h.acc.id)).bounces, undefined, 'the same report is not counted twice');
  const rows = Object.fromEntries(h.campaigns.recipientRows(id, 10).map((x) => [x.email, x]));
  assert.equal(rows['zahid@good.test'].status, 'bounced');
  assert.match(rows['zahid@good.test'].bounceReason, /does not exist/);
  assert.equal(rows['noor@good.test'].status, 'followup_scheduled');
  assert.ok(h.campaigns.isOptedOut('zahid@good.test'), 'suppressed in every campaign');
  assert.equal(h.campaigns.verification.statusOf('zahid@good.test').status, 'invalid');
  await h.run(3 * DAY, 30 * MIN);
  assert.equal(h.to('zahid@good.test').length, 1);
  assert.equal(h.to('noor@good.test').length, 2);
  // Refused while sending (550 5.1.1): a bounce as well.
  h.smtp.reject('noor@good.test');
  await h.run(4 * DAY, 30 * MIN);
  assert.equal(h.campaigns.recipientRows(id, 10).find((x) => x.email === 'noor@good.test').status, 'bounced');
  assert.equal(h.campaigns.dashboard().bounced, 2);
});

test('Pause stops follow-ups; resume brings them back; a restart never sends one twice; temporary failures are retried after 15, then 30 minutes; permanent ones are not', { timeout: 60_000 }, async (t) => {
  const h = await setup(t);
  const id = sequence(h.campaigns, h.acc.id, { followups: { on: true, steps: [{ days: 1, subject: '', body: 'Following up.' }] } });
  h.campaigns.addLeads(id, { ids: [1] });
  await h.campaigns.start(id);
  await h.run(5 * MIN);
  h.campaigns.pause(id);
  await h.run(2 * DAY, 30 * MIN);
  assert.equal(h.to('zahid@good.test').length, 1, 'paused: nothing');
  await h.campaigns.resume(id);
  await h.run(10 * MIN);
  assert.equal(h.to('zahid@good.test').length, 2, 'resumed: the due follow-up goes');
  // A follow-up interrupted while sending (the app ended): never sent again.
  const id2 = sequence(h.campaigns, h.acc.id, { followups: { on: true, steps: [{ days: 1, subject: '', body: 'Following up.' }] } });
  h.campaigns.addLeads(id2, { ids: [2] });
  await h.campaigns.start(id2);
  await h.run(5 * MIN);
  h.time.now += DAY;
  h.campaigns.db.prepare("UPDATE email_followups SET state = 'sending' WHERE campaign_id = ?").run(id2);
  const c2 = h.restart();
  assert.equal(c2.db.prepare('SELECT state FROM email_followups WHERE campaign_id = ?').get(id2).state, 'uncertain');
  await h.run(2 * DAY, 30 * MIN);
  assert.equal(h.to('noor@good.test').length, 1, 'not sent twice after the restart');
  // Temporary failure: retried after 15 minutes, then 30.
  const id3 = sequence(h.campaigns, h.acc.id, { followups: { on: false, steps: [] } });
  h.campaigns.addLeads(id3, { ids: [3] });
  h.smtp.setMode('temp-fail');
  await h.campaigns.start(id3);
  await h.campaigns.tick();
  const r1 = h.campaigns.db.prepare('SELECT state, retry_at, attempts FROM email_recipients WHERE campaign_id = ?').get(id3);
  assert.equal(r1.state, 'failed');
  assert.equal(r1.retry_at - h.time.now, 15 * MIN);
  h.time.now += 16 * MIN;
  await h.campaigns.tick();
  const r2 = h.campaigns.db.prepare('SELECT state, retry_at FROM email_recipients WHERE campaign_id = ?').get(id3);
  assert.equal(r2.retry_at - h.time.now, 30 * MIN, 'waits longer each time');
  h.smtp.setMode('accept');
  h.time.now += 31 * MIN;
  await h.campaigns.tick();
  assert.equal(h.to('sara@good.test').length, 1, 'then delivered');
});

test('Sending days and hours in a time zone; random pauses within the limits; several campaigns run independently', { timeout: 60_000 }, async (t) => {
  // Monday 2026-11-23 03:00 UTC = 08:00 in Karachi (before 09:00).
  const h = await setup(t, { start: Date.parse('2026-11-23T03:00:00Z') });
  const schedule = { on: true, days: [1, 2, 3, 4, 5], start: 9 * 60, end: 17 * 60, tz: 'Asia/Karachi' };
  assert.equal(inWindow(schedule, Date.parse('2026-11-23T03:59:00Z')), false);
  assert.equal(inWindow(schedule, Date.parse('2026-11-23T04:00:00Z')), true, '09:00 Karachi');
  assert.equal(inWindow(schedule, Date.parse('2026-11-28T06:00:00Z')), false, 'Saturday');
  assert.equal(nextWindow(schedule, Date.parse('2026-11-27T12:30:00Z')), Date.parse('2026-11-30T04:00:00Z'), 'Friday after 17:00 -> Monday 09:00');
  const a = sequence(h.campaigns, h.acc.id, { schedule, followups: { on: false, steps: [] } });
  const b = h.campaigns.create({ name: 'Other' }).id;
  h.campaigns.update(b, { accountIds: [h.acc.id], subject: 'Hi', body: 'Hello', delaySeconds: 60 });
  h.campaigns.addLeads(a, { ids: [1, 2] });
  h.campaigns.addLeads(b, { ids: [3] });
  await h.campaigns.start(a);
  await h.campaigns.start(b);
  await h.run(30 * MIN);
  assert.equal(h.to('sara@good.test').length, 1, 'the other campaign sends at any hour');
  assert.equal(h.to('zahid@good.test').length + h.to('noor@good.test').length, 0, 'not before 09:00 Karachi');
  assert.equal(h.campaigns.summary(a).waiting, 'schedule');
  assert.equal(h.campaigns.summary(a).windowOpensAt, Date.parse('2026-11-23T04:00:00Z'));
  await h.run(40 * MIN);
  assert.equal(h.to('zahid@good.test').length + h.to('noor@good.test').length, 2, 'from 09:00 on');
  // Random pauses: between the delay and its "up to".
  const { pauseMs } = require('../src/email/sequence');
  const gaps = [0, 0.5, 0.999].map((x) => pauseMs({ delaySeconds: 600, delayMaxSeconds: 900 }, () => x));
  assert.deepEqual(gaps.map((g) => g >= 600_000 && g <= 900_000), [true, true, true]);
  assert.equal(h.campaigns.update(a, { delayMaxSeconds: 30 }).ok, false, 'never below the delay');
});

test('Settings are checked; a copy keeps the sequence; account switches and daily limits; the AI writes follow-ups from the earlier email', { timeout: 60_000 }, async (t) => {
  const writes = [];
  const h = await setup(t, { writer: async (x) => (writes.push(x), { subject: 'x', body: `AI follow-up for ${x.business.business_name}` }) });
  assert.equal(checkFollowups({ on: true, steps: [] }).ok, false);
  assert.equal(checkFollowups({ on: true, steps: [{ days: 0, body: 'x' }] }).ok, false);
  assert.equal(checkFollowups({ on: true, steps: Array(6).fill({ days: 1, body: 'x' }) }).ok, false);
  assert.equal(withSignature('Hello\n\nBest,\nAli', 'Best,\nAli'), 'Hello\n\nBest,\nAli', 'not twice');
  const id = sequence(h.campaigns, h.acc.id, { aiWrite: true, body: 'Offer a website.', followups: { on: true, steps: [{ days: 1, subject: '', body: 'Remind them kindly.' }] } });
  const copy = h.campaigns.duplicate(id);
  assert.ok(copy.ok);
  assert.deepEqual(h.campaigns.summary(copy.id).followups, h.campaigns.summary(id).followups);
  assert.equal(h.campaigns.summary(copy.id).status, 'draft');
  assert.equal(h.campaigns.counts(copy.id).total, 0, 'no recipients copied');
  h.campaigns.addLeads(id, { ids: [1] });
  await h.campaigns.start(id);
  await h.run(5 * MIN);
  await h.run(DAY + 10 * MIN, 10 * MIN);
  assert.equal(h.to('zahid@good.test').length, 2);
  const fw = writes.at(-1);
  assert.match(fw.instructions, /Offer a website\./, 'the campaign’s prompt');
  assert.match(fw.instructions, /For this follow-up: Remind them kindly\./);
  assert.match(fw.instructions, /This is follow-up 1/);
  assert.match(fw.instructions, /Earlier email[^]*AI follow-up for Zahid Properties/, 'the email it follows up on');
  assert.equal(fw.signature, 'Best,\nAli');
  // An account switched off is never used; a daily limit across campaigns.
  assert.ok(h.accounts.setLimits(h.acc.id, { enabled: false }).ok);
  const id2 = h.campaigns.create({ name: 'Off' }).id;
  h.campaigns.update(id2, { accountIds: [h.acc.id], subject: 'Hi', body: 'Hello', delaySeconds: 60 });
  h.campaigns.addLeads(id2, { ids: [2, 3] });
  await h.campaigns.start(id2);
  await h.run(10 * MIN);
  assert.equal(h.to('noor@good.test').length, 0);
  assert.equal(h.campaigns.summary(id2).waiting, 'accounts_off');
  h.accounts.setLimits(h.acc.id, { enabled: true, dailyLimit: h.campaigns.sentToday(h.acc.id) + 1 });
  await h.run(10 * MIN);
  assert.equal(h.to('noor@good.test').length + h.to('sara@good.test').length, 1, 'the account’s own daily limit');
  assert.equal(h.campaigns.summary(id2).waiting, 'daily_limit');
  assert.equal(h.accounts.setLimits(h.acc.id, { dailyLimit: 0 }).ok, false);
});
