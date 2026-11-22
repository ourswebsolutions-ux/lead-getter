'use strict';
// Email campaigns with a real SMTP conversation (the local test server):
// accounts (passwords kept in the vault, never returned), personalisation,
// delays, duplicates, opt-outs, pause / resume / stop, failures and restarts.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { startSmtp } = require('./fake-smtp');
const { EmailAccounts } = require('../src/email/accounts');
const { EmailCampaigns, compose, render, emailOf } = require('../src/email/campaigns');
const { Vault } = require('../src/main/vault');

function memState() {
  const m = new Map();
  return { getState: (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setState: (k, v) => m.set(k, JSON.stringify(v)), raw: m };
}
const cipher = { encrypt: (t) => Buffer.from(String(t), 'utf8').reverse(), decrypt: (b) => Buffer.from(b).reverse().toString('utf8') };

const LEADS = [
  { id: 1, name: 'Zahid Properties', contactName: 'Zahid Khan', email: 'zahid@realty.pk', categoryId: 1, kind: 'business' },
  { id: 2, name: 'Noor Estate', email: '', emails: [{ email: 'info@noor.pk' }], categoryId: 1, kind: 'business' },
  { id: 3, name: 'No Email Co', email: '', categoryId: 1, kind: 'business' },
  { id: 4, name: 'Sara Ahmed', companyName: 'Bright Homes', email: 'sara@bright.pk', categoryId: 2, kind: 'person', source: 'linkedin', profileUrl: 'https://www.linkedin.com/in/sara' },
  { id: 5, name: 'Dup Office', email: 'ZAHID@realty.pk', categoryId: 1, kind: 'business' },
];

async function setup(t, { clock } = {}) {
  const smtp = await startSmtp();
  t.after(() => smtp.close());
  const state = memState();
  const db = new DatabaseSync(':memory:');
  const vault = new Vault({ store: state, key: 'email.secrets', cipher });
  const accounts = new EmailAccounts({ store: state, vault, allowInsecure: true });
  const time = { now: 1_800_000_000_000 };
  const campaigns = new EmailCampaigns({
    db,
    accounts,
    leads: (f = {}) => LEADS.filter((l) => (f.category ? String(l.categoryId) === String(f.category) : true) && (f.ids ? f.ids.includes(l.id) : true)),
    clock: clock || (() => time.now),
    tickMs: 60_000,
  });
  t.after(() => {
    campaigns.dispose();
    accounts.dispose();
  });
  const acc = accounts.add({ name: 'Company SMTP', senderName: 'Ali from Axora', email: 'sender@example.com', host: '127.0.0.1', port: smtp.port, username: 'sender@example.com', password: 's3cret-pass', encryption: 'none' });
  assert.ok(acc.ok, acc.error);
  return { smtp, state, db, vault, accounts, campaigns, account: acc.account, time };
}

test('SMTP accounts: password kept encrypted and never returned; connection test; edit and delete', async (t) => {
  const { smtp, state, accounts, account } = await setup(t);
  assert.equal(account.hasPassword, true);
  assert.ok(!JSON.stringify(accounts.list()).includes('s3cret-pass'), 'no password in the list');
  assert.ok(![...state.raw.values()].some((v) => v.includes('s3cret-pass')), 'never stored in plain text');
  const ok = await accounts.test(account.id);
  assert.equal(ok.ok, true, ok.error);
  assert.equal(accounts.list()[0].status, 'ok');
  smtp.setMode('auth-fail');
  const bad = await accounts.test(account.id);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /rejected the login/);
  assert.equal(accounts.list()[0].status, 'failed');
  smtp.setMode('accept');
  assert.equal(accounts.update(account.id, { ...account, name: 'Renamed', password: '' }).ok, true, 'a blank password keeps the saved one');
  assert.equal(accounts.list()[0].hasPassword, true);
  assert.equal(accounts.add({ name: 'renamed', email: 'x@y.com', host: 'smtp.y.com', port: 465, encryption: 'ssl', password: 'p' }).ok, false, 'names are unique');
  assert.equal(accounts.add({ name: 'Bad', email: 'not-an-email', host: 'smtp.y.com', port: 465, encryption: 'ssl', password: 'p' }).ok, false);
  assert.equal(accounts.remove(account.id).ok, true);
  assert.equal(accounts.list().length, 0);
});

test('Personalisation: {name}, {business}, {email}; missing values removed cleanly; HTML and plain text with an unsubscribe line', () => {
  assert.equal(render('Hello {name}, about {business}.', { name: null, business: 'Noor Estate' }), 'Hello, about Noor Estate.');
  assert.equal(render('Hi {name} ({email})', { name: 'Zahid', email: 'z@x.pk' }), 'Hi Zahid (z@x.pk)');
  const m = compose({ subject: 'For {business}', body: 'Hello {name},\n\nVisit https://axora.pk now.' }, { name: 'Zahid', business: 'Zahid Properties', email: 'z@x.pk' });
  assert.equal(m.subject, 'For Zahid Properties');
  assert.match(m.text, /^Hello Zahid,/);
  assert.match(m.text, /unsubscribe/);
  assert.match(m.html, /<a href="https:\/\/axora\.pk">/);
  const h = compose({ subject: 's', body: '<p>Hi <b>{name}</b></p><script>alert(1)</script><a href="javascript:x" onclick="y">x</a>' }, { name: 'Sara' });
  assert.ok(!/script|onclick|javascript:/i.test(h.html));
  assert.match(h.text, /Hi Sara/);
  assert.equal(emailOf({ email: '', emails: [{ email: 'logo@2x.png' }, { email: 'Info@Noor.pk' }] }), 'info@noor.pk');
});

test('Campaign: only leads with a valid email, no duplicates, delay between emails, personalised, completed', async (t) => {
  const { smtp, campaigns, account, time } = await setup(t);
  const c = campaigns.create({ name: 'Real estate' });
  assert.ok(c.ok);
  assert.equal((await campaigns.start(c.id)).ok, false, 'nothing to send yet');
  assert.ok(campaigns.update(c.id, { accountId: account.id, subject: 'Websites for {business}', body: 'Hello {name},\nWe build websites.', delaySeconds: 30 }).ok);
  const p = campaigns.preview(c.id, { category: 1 });
  assert.equal(p.ready, 2);
  assert.equal(p.noEmail, 1);
  assert.equal(p.already, 1, 'the same address twice counts once');
  const added = campaigns.addLeads(c.id, { category: 1 });
  assert.equal(added.added, 2);
  assert.equal(campaigns.addLeads(c.id, { category: 1 }).added, 0, 'adding again adds nobody');
  const s = await campaigns.start(c.id);
  assert.ok(s.ok, s.error);
  await campaigns.tick();
  assert.equal(smtp.messages.length, 1);
  await campaigns.tick();
  assert.equal(smtp.messages.length, 1, 'the delay is respected');
  time.now += 31_000;
  await campaigns.tick();
  assert.equal(smtp.messages.length, 2);
  const zahid = smtp.messages.find((m) => m.to.includes('zahid@realty.pk'));
  assert.match(zahid.text, /Subject: Websites for Zahid Properties/);
  assert.match(zahid.text, /Hello Zahid,/);
  assert.match(zahid.text, /List-Unsubscribe: <mailto:sender@example\.com\?subject=unsubscribe>/);
  assert.match(zahid.text, /From: Ali from Axora <sender@example\.com>/);
  const noor = smtp.messages.find((m) => m.to.includes('info@noor.pk'));
  assert.match(noor.text, /Hello,/, 'no name: the greeting without it');
  time.now += 31_000;
  await campaigns.tick();
  const done = campaigns.summary(c.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.counts.sent, 2);
  assert.equal(done.counts.remaining, 0);
  // Another campaign: the same people are not emailed again.
  const c2 = campaigns.create({ name: 'Again' });
  campaigns.update(c2.id, { accountId: account.id, subject: 's', body: 'b' });
  assert.equal(campaigns.addLeads(c2.id, { category: 1 }).previous, 2);
  const snap = campaigns.snapshot(c.id);
  assert.ok(snap.log.some((l) => /Completed: 2 sent/.test(l.text)));
});

test('Pause, resume, stop; opt-outs never emailed; login failure pauses without losing anyone; restart marks interrupted sends uncertain', async (t) => {
  const { smtp, campaigns, account, time, db } = await setup(t);
  const c = campaigns.create({ name: 'Mixed' });
  campaigns.update(c.id, { accountId: account.id, subject: 'Hi', body: 'Hello {name}', delaySeconds: 10 });
  campaigns.addLeads(c.id, {});
  assert.equal(campaigns.counts(c.id).queued, 3);
  assert.ok(campaigns.optOut('sara@bright.pk').ok);
  assert.equal(campaigns.counts(c.id).skipped, 1);
  await campaigns.start(c.id);
  assert.ok(campaigns.pause(c.id).ok);
  await campaigns.tick();
  assert.equal(smtp.messages.length, 0, 'paused: nothing sent');
  smtp.setMode('auth-fail');
  assert.ok((await campaigns.resume(c.id)).ok);
  await campaigns.tick();
  assert.equal(smtp.messages.length, 0);
  let s = campaigns.summary(c.id);
  assert.equal(s.status, 'paused');
  assert.equal(s.pauseReason, 'login');
  assert.equal(s.counts.queued, 2, 'nobody lost');
  smtp.setMode('accept');
  await campaigns.resume(c.id);
  await campaigns.tick();
  assert.equal(smtp.messages.length, 1);
  assert.ok(!smtp.messages.some((m) => m.to.includes('sara@bright.pk')), 'opted out: never emailed');
  assert.ok(campaigns.stop(c.id).ok);
  time.now += 60_000;
  await campaigns.tick();
  assert.equal(smtp.messages.length, 1, 'stopped: nothing more');
  // A send interrupted by a crash.
  db.prepare("UPDATE email_recipients SET state = 'sending' WHERE state = 'queued'").run();
  campaigns.init();
  campaigns.dispose();
  assert.equal(campaigns.counts(c.id).uncertain, 1);
  assert.equal(campaigns.retryFailed(c.id).requeued, 0, 'uncertain ones are not retried unless asked');
  assert.equal(campaigns.retryFailed(c.id, { includeUncertain: true }).requeued, 1);
});

const { ReplyWatcher, isUnsubscribe } = require('../src/email/replies');

test('Unsubscribe replies: recognised in English and Roman Urdu, in the subject or the reply itself (not in quoted text)', () => {
  for (const [subject, text] of [
    ['unsubscribe', ''],
    ['Re: Websites for Zahid Properties', 'Please remove me from your list.'],
    ['Re: Hi', 'Not interested, thanks.'],
    ['Re: Hi', 'STOP'],
    ['Re: Hi', 'aage se mat bhejo'],
  ]) assert.ok(isUnsubscribe(subject, text), `${subject} / ${text}`);
  for (const [subject, text] of [
    ['Re: Websites for Zahid Properties', 'Sounds good, what is the price?'],
    ['Re: Hi', 'Yes please call me.\n\nOn Mon, Ali wrote:\n> If you would rather not receive these emails, reply with unsubscribe'],
  ]) assert.ok(!isUnsubscribe(subject, text), `${subject} / ${text}`);
});

test('Replies from the inbox: only people the account emailed; a reply is recorded once; an unsubscribe opts out; a failed login is reported', async (t) => {
  const { smtp, state, campaigns, accounts, account, time } = await setup(t);
  const c = campaigns.create({ name: 'R' });
  campaigns.update(c.id, { accountId: account.id, subject: 'Hi', body: 'Hello', delaySeconds: 10 });
  campaigns.addLeads(c.id, { category: 1 });
  await campaigns.start(c.id);
  await campaigns.tick();
  time.now += 11_000;
  await campaigns.tick();
  assert.equal(smtp.messages.length, 2);
  let inbox = [
    { from: 'Zahid@Realty.pk', subject: 'Re: Hi', text: 'What is the price?' },
    { from: 'info@noor.pk', subject: 'unsubscribe', text: '' },
    { from: 'stranger@spam.com', subject: 'unsubscribe', text: '' },
  ];
  let logins = 0;
  const watcher = new ReplyWatcher({ accounts, campaigns, state: { get: state.getState, set: state.setState }, clock: () => time.now, openInbox: async function* (login) {
    logins++;
    assert.equal(login.pass, 's3cret-pass', 'the account’s own login');
    yield* inbox;
  } });
  const r = await watcher.check(account.id);
  assert.deepEqual(r, { replies: 2, unsubscribed: 1 });
  assert.ok(campaigns.isOptedOut('info@noor.pk'));
  assert.ok(!campaigns.isOptedOut('stranger@spam.com'), 'not someone this account emailed');
  assert.equal(campaigns.summary(c.id).replies, 2);
  assert.equal((await watcher.check(account.id)).replies, 0, 'the same replies are not counted twice');
  assert.equal(accounts.list()[0].imapStatus, 'ok');
  inbox = null;
  const failing = new ReplyWatcher({ accounts, campaigns, state: { get: state.getState, set: state.setState }, openInbox: async function* () {
    throw Object.assign(new Error('Invalid credentials'), { authenticationFailed: true });
  } });
  assert.match((await failing.check(account.id)).error, /rejected the login/);
  assert.equal(accounts.list()[0].imapStatus, 'failed');
  accounts.update(account.id, { ...accounts.list()[0], imapOn: false, password: '' });
  assert.equal((await watcher.check(account.id)).skipped, true, 'reading replies can be turned off');
  assert.equal(logins, 2);
});

const { startImap } = require('./fake-imap');
const { imapInbox, watchInbox, ownText } = require('../src/email/replies');

test('Replies found by the email they answer (another address of the business, a reply to a test email); Gmail’s wrapped "On … wrote:"', async (t) => {
  const { state, db, campaigns, accounts, account, time } = await setup(t);
  const c = campaigns.create({ name: 'R' });
  campaigns.update(c.id, { accountId: account.id, subject: 'Hi', body: 'Hello', delaySeconds: 10 });
  campaigns.addLeads(c.id, { category: 1 });
  await campaigns.start(c.id);
  await campaigns.tick();
  const sent = db.prepare("SELECT email, message_id FROM email_recipients WHERE state = 'sent'").get();
  assert.match(sent.message_id, /^<.+@.+>$/);
  assert.ok((await campaigns.sendTest(c.id, 'me@axora.pk')).ok);
  const testId = db.prepare('SELECT message_id FROM email_test_sends').get().message_id;
  assert.ok(campaigns.hasTestSends(account.id));
  const replies = [];
  const others = [];
  const watcher = new ReplyWatcher({ accounts, campaigns, state: { get: state.getState, set: state.setState }, clock: () => time.now, onReply: (r) => replies.push(r), onOther: (r) => others.push(r), openInbox: async function* () {
    yield { from: 'owner@gmail.com', subject: 'Re: Hi', text: 'Call me please.\n\nOn Sat, Nov 22, 2026 at 5:43 PM Axora <\nsender@example.com> wrote:\n> Hello', messageId: '<r1@gmail>', references: ['<older@x>', sent.message_id] };
    yield { from: 'me@axora.pk', subject: 'Re: [Test] Hi', text: 'No', messageId: '<r2@x>', inReplyTo: testId };
    yield { from: 'stranger@x.com', subject: 'hello', text: 'hi', messageId: '<r3@x>' };
  } });
  const r = await watcher.check(account.id);
  assert.equal(r.replies, 1);
  assert.deepEqual(replies.map((x) => [x.from, x.recipient, x.text, x.match.test, x.unsubscribe]), [['owner@gmail.com', sent.email, 'Call me please.', false, false], ['me@axora.pk', 'me@axora.pk', 'No', true, false]]);
  assert.equal(replies[1].match.campaignName, 'R');
  assert.match(replies[1].match.subject, /^\[Test\] Hi/);
  assert.equal(campaigns.summary(c.id).replies, 1, 'recorded on the person emailed');
  assert.ok(!campaigns.isOptedOut('me@axora.pk'), 'a reply to a test never unsubscribes');
  assert.deepEqual(others.map((x) => x.from), ['stranger@x.com']);
  assert.equal(ownText('Thanks\n\nOn Mon, Nov 3, 2026 at 10:00 AM Axora Web Solutions <\ninfo@axoraweb.com> wrote:\n\n> Hello'), 'Thanks');
  assert.equal(ownText('Ok\n________________________________\nFrom: Axora'), 'Ok');
  campaigns.dispose();
});

test('Live inbox watching (IMAP IDLE): a reply that arrives is read within seconds, without waiting for the regular check', { timeout: 30_000 }, async (t) => {
  const { state, campaigns, accounts, account, time } = await setup(t);
  const c = campaigns.create({ name: 'Live' });
  campaigns.update(c.id, { accountId: account.id, subject: 'Hi', body: 'Hello', delaySeconds: 10 });
  campaigns.addLeads(c.id, { category: 1 });
  await campaigns.start(c.id);
  await campaigns.tick();
  campaigns.dispose();
  const to = campaigns.db.prepare("SELECT email FROM email_recipients WHERE state = 'sent'").get().email;
  const messages = [];
  const imap = await startImap({ messages, user: null });
  accounts.update(account.id, { ...accounts.list()[0], imapOn: true, imapHost: '127.0.0.1', imapPort: imap.port, password: '' });
  const replies = [];
  const watcher = new ReplyWatcher({ accounts, campaigns, state: { get: state.getState, set: state.setState }, clock: () => time.now, first: 3_600_000, onReply: (r) => replies.push(r), openInbox: (login, since) => imapInbox(login, since, { allowInsecure: true }), openWatch: (login, on) => watchInbox(login, on, { allowInsecure: true }) });
  t.after(async () => {
    watcher.stop();
    await imap.close();
  });
  watcher.start();
  const until = async (fn, ms, what) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (fn()) return;
    throw new Error(`timed out waiting for ${what}`);
  };
  await until(() => imap.idling() > 0, 10_000, 'the inbox to be watched');
  messages.push({ from: to, subject: 'Re: Hi', text: 'Haan, details bhejo.' });
  const at = Date.now();
  imap.notify();
  await until(() => replies.length > 0, 10_000, 'the reply');
  assert.ok(Date.now() - at < 8_000, 'read within seconds');
  assert.equal(replies[0].text, 'Haan, details bhejo.');
  assert.equal(campaigns.summary(c.id).replies, 1);
});

test('The inbox over IMAP (imapflow): logs in, examines INBOX read-only, reads senders, subjects and text; a wrong password fails', async (t) => {
  const imap = await startImap({ messages: [{ from: 'info@noor.pk', subject: 'Re: Hi', text: 'Please unsubscribe me.' }, { from: 'zahid@realty.pk', subject: 'Re: Hi', text: 'Price?' }] });
  t.after(() => imap.close());
  const login = { account: { imapHost: '127.0.0.1', imapPort: imap.port, username: 'sender@example.com' }, pass: 'pw' };
  const got = [];
  for await (const m of imapInbox(login, Date.now() - 86_400_000, { allowInsecure: true })) got.push(m);
  assert.deepEqual(got.map((m) => [m.from, m.subject, m.text.trim()]), [['info@noor.pk', 'Re: Hi', 'Please unsubscribe me.'], ['zahid@realty.pk', 'Re: Hi', 'Price?']]);
  assert.ok(imap.log.some((l) => /EXAMINE/i.test(l)), 'read-only: nothing in the mailbox is changed');
  assert.ok(!imap.log.some((l) => /STORE|EXPUNGE|COPY|MOVE/i.test(l)));
  await assert.rejects(async () => {
    for await (const m of imapInbox({ ...login, pass: 'wrong' }, Date.now(), { allowInsecure: true })) void m;
  });
});

test('Several sending accounts: emails go out from each in turn, each with its own delay; one failing does not stop the others; accounts added while running', async (t) => {
  const { smtp, campaigns, accounts, account, time } = await setup(t);
  const smtp2 = await startSmtp();
  t.after(() => smtp2.close());
  campaigns.random = () => 0.999; // a fixed order here (it is random otherwise)
  const second = accounts.add({ name: 'Second', senderName: 'Axora 2', email: 'second@example.com', host: '127.0.0.1', port: smtp2.port, password: 'pw2', encryption: 'none' }).account;
  const c = campaigns.create({ name: 'Rotation' });
  assert.ok(campaigns.update(c.id, { accountIds: [account.id], subject: 'Hi {name}', body: 'Hello', delaySeconds: 60 }).ok);
  campaigns.addLeads(c.id, {});
  assert.equal(campaigns.counts(c.id).queued, 3);
  await campaigns.start(c.id);
  await campaigns.tick();
  assert.equal(smtp.messages.length, 1);
  // Added while running (other changes are refused while it runs).
  assert.equal(campaigns.update(c.id, { subject: 'x' }).ok, false);
  assert.ok(campaigns.update(c.id, { accountIds: [account.id, second.id] }).ok);
  assert.deepEqual(campaigns.summary(c.id).accountIds, [account.id, second.id]);
  await campaigns.tick();
  assert.equal(smtp2.messages.length, 1, 'the new account sends at once; the first one waits for its delay');
  assert.match(smtp2.messages[0].text, /From: Axora 2 <second@example\.com>/);
  // The first account's login now fails: the second goes on alone.
  smtp.setMode('auth-fail');
  time.now += 61_000;
  await campaigns.tick();
  const s = campaigns.summary(c.id);
  assert.equal(s.status, 'running', 'one failing account does not stop the campaign');
  assert.ok(s.senders.find((x) => x.id === account.id).down);
  assert.equal(smtp2.messages.length + smtp.messages.length, 2, 'the failed send went back in the queue');
  await campaigns.tick();
  assert.equal(smtp2.messages.length, 2, 'the working account sent it');
  await campaigns.tick();
  assert.equal(campaigns.summary(c.id).status, 'completed');
  assert.equal(campaigns.summary(c.id).counts.sent, 3);
  // Replies are matched to the account that sent each email.
  const toSecond = campaigns.sentAddresses(second.id);
  const toFirst = campaigns.sentAddresses(account.id);
  assert.equal(toSecond.size + toFirst.size, 3);
  assert.ok([...toSecond].every((e) => !toFirst.has(e)));
});

const { extractAccounts, providerFor } = require('../src/email/credentials');
const { createEmail } = require('../src/email/service');

test('Accounts from text: email + app password in a sentence or one per line; ordinary sentences are left alone; the text comes back without passwords', async () => {
  const one = extractAccounts('mera gmail ali.khan@gmail.com hai, app password: wxyz abcd efgh ijkl');
  assert.deepEqual(one.accounts, [{ email: 'ali.khan@gmail.com', password: 'wxyzabcdefghijkl', name: null }]);
  assert.ok(!/wxyz/.test(one.redacted));
  const many = extractAccounts('ali@gmail.com, abcd efgh ijkl mnop, Ali Sales\nteam@company.pk:S3cret!pw\nsara@outlook.com Pa55word');
  assert.deepEqual(many.accounts.map((a) => [a.email, a.password, a.name]), [['ali@gmail.com', 'abcdefghijklmnop', 'Ali Sales'], ['team@company.pk', 'S3cret!pw', null], ['sara@outlook.com', 'Pa55word', null]]);
  for (const t of ['zahid@realty.pk unsubscribe', 'ali@gmail.com ko email bhejo', 'send this mail to ali@gmail.com asap please now']) assert.equal(extractAccounts(t).accounts.length, 0, t);
  assert.equal((await providerFor('x@gmail.com')).host, 'smtp.gmail.com');
  assert.equal((await providerFor('x@hotmail.com')).host, 'smtp.office365.com');
  assert.equal((await providerFor('x@axora.pk', { resolveMx: async () => [{ exchange: 'aspmx.l.google.com' }] })).name, 'Gmail', 'Google Workspace by its mail servers');
  assert.equal(await providerFor('x@unknown.example', { resolveMx: async () => [{ exchange: 'mx.unknown.example' }] }), null);
});

test('Adding accounts from text: created with the provider settings, passwords only in the vault, existing ones updated, unknown providers reported', async (t) => {
  const state = memState();
  const db = new DatabaseSync(':memory:');
  const store = { ...state, db, listLeads: () => [], leadById: () => null };
  const vault = new Vault({ store: state, key: 'secrets', cipher });
  const email = createEmail({ store, vault, files: null, canSend: async () => true });
  t.after(() => {
    email.campaigns.dispose();
    email.accounts.dispose();
  });
  const resolveMx = async () => [{ exchange: 'mx.nowhere.example' }];
  const r = await email.addFromText('ali@gmail.com, abcd efgh ijkl mnop, Ali Sales\nbob@nowhere.example, S3cret!pw', { test: false, resolveMx });
  assert.equal(r.found, 2);
  assert.deepEqual(r.results.map((x) => [x.email, x.ok]), [['ali@gmail.com', true], ['bob@nowhere.example', false]]);
  assert.match(r.results[1].error, /provider is not known/);
  const acc = email.accounts.list()[0];
  assert.equal(acc.host, 'smtp.gmail.com');
  assert.equal(acc.port, 465);
  assert.equal(acc.senderName, 'Ali Sales');
  assert.equal(acc.imapHost, 'imap.gmail.com');
  assert.equal(vault.get(`smtp:${acc.id}`), 'abcdefghijklmnop');
  assert.ok(![...state.raw.values()].some((v) => v.includes('abcdefghijklmnop') || v.includes('S3cret')), 'no password stored in plain text');
  assert.ok(!r.redacted.includes('abcd efgh'));
  const again = await email.addFromText('ali@gmail.com qwer tyui opas dfgh', { test: false });
  assert.equal(again.results[0].created, false, 'the same address: its password is updated');
  assert.equal(email.accounts.list().length, 1);
  assert.equal(vault.get(`smtp:${acc.id}`), 'qwertyuiopasdfgh');
});

test('Accounts from text: the password on its own line, before the address, or copied with non-breaking spaces', () => {
  for (const t of [
    'axoraweb.services@gmail.com\nabcd efgh ijkl mnop',
    'email: axoraweb.services@gmail.com\napp password: abcd efgh ijkl mnop',
    'axoraweb.services@gmail.com abcd efgh ijkl mnop',
    'abcd efgh ijkl mnop ye app password hai axoraweb.services@gmail.com ka',
    'axoraweb.services@gmail.com\napp password\nabcd efgh ijkl mnop',
  ]) {
    const r = extractAccounts(t);
    assert.deepEqual(r.accounts.map((a) => [a.email, a.password]), [['axoraweb.services@gmail.com', 'abcdefghijklmnop']], t);
    assert.ok(!/abcd/.test(r.redacted), t);
  }
  for (const t of ['ali@gmail.com pe kaam karo abhi sath', 'ali@gmail.com ko email bhejo aur kaam karo abhi jaldi']) assert.equal(extractAccounts(t).accounts.length, 0, t);
});

test('Category campaigns: every category with emails is listed; ON sends to its leads and picks up new ones by itself; it never completes', async (t) => {
  const { smtp, campaigns, account, time } = await setup(t);
  const cats = [{ id: 1, name: 'Real Estate' }, { id: 2, name: 'People' }, { id: 3, name: 'Empty' }];
  const stats = campaigns.categoryStats(cats);
  assert.deepEqual(stats.map((x) => [x.name, x.withEmail, x.notEmailed]), [['Real Estate', 3, 3], ['People', 1, 1]], 'a category without emails is not listed');
  const cc = campaigns.categoryCampaign('1', 'Real Estate');
  assert.equal(campaigns.categoryCampaign('1', 'Real Estate').id, cc.id, 'one campaign per category');
  assert.equal((await campaigns.setCategoryEnabled('1', 'Real Estate', true)).ok, false, 'not ready: no account, subject or email');
  campaigns.update(cc.id, { accountIds: [account.id], subject: 'Hi {business}', body: 'Hello {name}', delaySeconds: 10 });
  assert.ok((await campaigns.setCategoryEnabled('1', 'Real Estate', true)).ok);
  assert.equal(campaigns.counts(cc.id).total, 2, 'its leads with an email, added by themselves');
  await campaigns.tick();
  time.now += 11_000;
  await campaigns.tick();
  time.now += 11_000;
  await campaigns.tick();
  assert.equal(smtp.messages.length, 2);
  assert.equal(campaigns.summary(cc.id).status, 'running', 'stays on, waiting for new leads');
  assert.equal(campaigns.summary(cc.id).waiting, 'new_leads');
  LEADS.push({ id: 9, name: 'New Realty', email: 'new@realty.pk', categoryId: 1, kind: 'business' });
  t.after(() => LEADS.pop());
  time.now += 61_000;
  await campaigns.tick();
  assert.equal(smtp.messages.length, 3, 'a new lead of the category was emailed');
  assert.ok((await campaigns.setCategoryEnabled('1', 'Real Estate', false)).ok);
  assert.equal(campaigns.summary(cc.id).status, 'stopped');
});

test('Write with AI: each email written from the prompt and the business details, kept on the recipient; a failing AI sends nothing and pauses', async (t) => {
  const { smtp, campaigns, account, time } = await setup(t);
  const asked = [];
  campaigns.writer = async (x) => {
    asked.push(x);
    if (campaigns.aiDown) throw Object.assign(new Error('Groq rejected the API key'), { code: 'invalid_key' });
    return { subject: `Idea for ${x.business.business_name}`, body: `Hi there,\n\nI saw ${x.business.business_name} has no site yet. ${x.instructions}\n\nAli` };
  };
  const c = campaigns.create({ name: 'AI' });
  campaigns.update(c.id, { accountIds: [account.id], subject: '', body: 'We build websites. Offer a free homepage design.', aiWrite: true, delaySeconds: 10 });
  campaigns.addLeads(c.id, { category: 1 });
  const preview = await campaigns.render(c.id);
  assert.ok(preview.ok && preview.ai);
  assert.match(preview.text, /Offer a free homepage design/);
  assert.ok((await campaigns.start(c.id)).ok, 'no subject needed: the AI writes it');
  await campaigns.tick();
  assert.equal(smtp.messages.length, 1);
  assert.match(smtp.messages[0].text, /Subject: Idea for (Zahid Properties|Noor Estate)/);
  assert.match(smtp.messages[0].text, /unsubscribe/, 'the unsubscribe line is still added');
  const first = asked.at(-1);
  assert.equal(first.instructions, 'We build websites. Offer a free homepage design.');
  assert.equal(first.sender.email, 'sender@example.com');
  assert.ok(first.business.business_name && first.business.email);
  const sent = campaigns.snapshot(c.id).recipients.find((r) => r.state === 'sent');
  assert.match(sent.aiBody, /^Hi there/, 'what was sent is kept');
  campaigns.aiDown = true;
  time.now += 11_000;
  await campaigns.tick();
  assert.equal(smtp.messages.length, 1, 'nothing sent without the AI’s text');
  const s = campaigns.summary(c.id);
  assert.equal(s.status, 'paused');
  assert.equal(s.pauseReason, 'ai');
  assert.equal(s.counts.queued, 1, 'the recipient is still waiting');
});

test('Category campaigns: a category with no emails left disappears, and its unused campaign is deleted', async (t) => {
  const { campaigns } = await setup(t);
  const cc = campaigns.categoryCampaign('3', 'Empty');
  assert.ok(campaigns.row(cc.id));
  const list = campaigns.categoryStats([{ id: 1, name: 'Real Estate' }, { id: 3, name: 'Empty' }]);
  assert.ok(!list.some((x) => x.name === 'Empty'));
  assert.equal(campaigns.row(cc.id), null, 'never sent anything: deleted');
});
