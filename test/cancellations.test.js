'use strict';
// Cancelling a subscription by an email to the administrator: the command
// and sender rules, the signed list, and its effect in the app.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Activation, activationIdFor } = require('../src/main/activation');
const { LeadQuota } = require('../src/main/lead-quota');
const { LeadStore } = require('../src/database/db');
const { CancellationPoller, hashId } = require('../src/main/cancellations');
const { dkimSign } = require('mailauth/lib/dkim/sign');
const { parseCommand, trustedSender, newKeys, processCommands, SUBJECT } = require('../tools/activation/cancel-lib');

const ID = 'LF-089S-2JVN-5CMD';
const ADMIN = 'admin@gmail.com';
const T0 = Date.parse('2026-11-05T10:00:00Z');
const keys = newKeys();

// Real DKIM: mail signed with a test key, checked against that key as if published.
const dkim = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_RECORD = `v=DKIM1; k=rsa; p=${dkim.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')}`;
const resolver = async (name) => {
  if (name === 's1._domainkey.gmail.com' || name === 's1._domainkey.evil.example') return [[KEY_RECORD]];
  throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
};
const raw = ({ from = ADMIN, subject = SUBJECT, body = `Activation ID: ${ID} (stop)`, id = crypto.randomUUID(), top = [] } = {}) =>
  Buffer.from([...top, `From: ${from}`, 'To: inbox@gmail.com', `Subject: ${subject}`, `Message-ID: <${id}@x>`, 'Content-Type: text/plain; charset=utf-8', '', body, ''].join('\r\n'));
const signed = async (message, { domain = 'gmail.com', at = T0, extra = {} } = {}) => {
  const { signatures } = await dkimSign(message, { signTime: new Date(at), signatureData: [{ signingDomain: domain, selector: 's1', privateKey: dkim.privateKey.export({ format: 'pem', type: 'pkcs8' }), ...extra }] });
  return Buffer.concat([Buffer.from(signatures), message]);
};
const own = async (o, at = T0) => ({ source: await signed(raw(o), { at }), date: new Date(at) });
const box = (messages, known = () => true) => ({ commands: async () => messages, known: async (id) => known(id) });
const pass = (mails, state = null, known) => processCommands({ mailbox: box(mails, known), state, adminEmail: ADMIN, resolver, privateKey: keys.privateKey, now: T0 + 1000 });

test('the command: exact format only; the subject alone never cancels', () => {
  assert.deepEqual(parseCommand({ subject: SUBJECT, text: `Activation ID: ${ID} (stop)` }), { id: ID });
  assert.deepEqual(parseCommand({ subject: ` ${SUBJECT} `, text: `Hello\n\nActivation ID: ${ID} (stop)\n\nThanks` }), { id: ID });
  for (const [subject, text] of [
    [SUBJECT, ''],
    [SUBJECT, ID],
    [SUBJECT, `Activation ID: ${ID}`],
    [SUBJECT, `Activation ID: ${ID} stop`],
    [SUBJECT, `Activation ID: lf-089s-2jvn-5cmd (stop)`],
    [SUBJECT, `Activation ID: LF-089S-2JVN (stop)`],
    [SUBJECT, `Activation ID: ${ID} (STOP)`],
    [SUBJECT, `> Activation ID: ${ID} (stop)`],
    [SUBJECT, `Activation ID: ${ID} (stop)\nActivation ID: LF-AAAA-BBBB-CCCC (stop)`],
    ['Re: Subscription Cancellation', `Activation ID: ${ID} (stop)`],
    ['Hello', `Activation ID: ${ID} (stop)`],
  ]) assert.ok(parseCommand({ subject, text }).error, `${subject} / ${text}`);
});

test('the sender: one From address, the administrator, under a valid DKIM signature', async () => {
  const check = async (source, date = T0) => (await trustedSender({ source, date, adminEmail: ADMIN, resolver })).ok;
  assert.equal(await check(await signed(raw())), true);
  assert.equal(await check(await signed(raw({ from: 'Ali <ADMIN@gmail.com>' }))), true, 'a name and capitals are fine');
  assert.equal(await check(raw()), false, 'forged From, no signature');
  assert.equal(await check(raw({ top: ['Authentication-Results: mx.google.com; dkim=pass header.i=@gmail.com; dmarc=pass header.from=gmail.com'] })), false, 'a header planted in the mailbox proves nothing');
  assert.equal(await check(await signed(raw(), { domain: 'evil.example' })), false, 'signed by another domain');
  assert.equal(await check(await signed(raw({ from: 'x@gmail.com' }))), false, 'another Gmail account');
  // Another Gmail account's genuine mail, with a second From put on top.
  const theirs = await signed(raw({ from: 'x@gmail.com' }));
  assert.equal(await check(Buffer.concat([Buffer.from(`From: ${ADMIN}\r\n`), theirs])), false, 'a second From header');
  // A genuine signature, with the command changed afterwards.
  const changed = (await signed(raw({ body: `Activation ID: LF-AAAA-BBBB-CCCC (stop)` }))).toString().replace('LF-AAAA-BBBB-CCCC', ID);
  assert.equal(await check(Buffer.from(changed)), false, 'body changed after signing');
  assert.equal(await check(await signed(raw({ body: 'Hello' }), { extra: { maxBodyLength: 0 } })), false, 'a signature that covers only part of the body');
});

test('the sender: a late run still accepts a genuine command; a failed key lookup decides nothing', async () => {
  // Signed a month ago with a week to run, as Gmail does: it arrived in time.
  const at = T0 - 30 * 86400000;
  const message = raw();
  const { signatures } = await dkimSign(message, { signTime: new Date(at), expires: new Date(at + 7 * 86400000), signatureData: [{ signingDomain: 'gmail.com', selector: 's1', privateKey: dkim.privateKey.export({ format: 'pem', type: 'pkcs8' }) }] });
  const old = Buffer.concat([Buffer.from(signatures), message]);
  assert.match(signatures, /x=\d+/);
  assert.equal((await trustedSender({ source: old, date: at, adminEmail: ADMIN, resolver })).ok, true);
  assert.equal((await trustedSender({ source: old, date: T0, adminEmail: ADMIN, resolver })).ok, false, 'expired when it arrived');
  // A lookup failure: the run stops, so the email is tried again and not marked as seen.
  const down = async () => {
    throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
  };
  await assert.rejects(processCommands({ mailbox: box([await own()]), state: null, adminEmail: ADMIN, resolver: down, privateKey: keys.privateKey, now: T0 }), (e) => e.code === 'DKIM_LOOKUP');
});

test('an email from the administrator is cancelled once, and the list is signed and holds no Activation ID', async () => {
  const mail = await own();
  const first = await pass([mail]);
  assert.deepEqual(first.events.map((e) => [e.result, e.activationId]), [['cancelled', ID]]);
  assert.deepEqual(first.state.entries.map((e) => e.id), [hashId(ID)]);
  assert.ok(!JSON.stringify(first.state).includes(ID));
  const again = await pass([mail], first.state);
  assert.equal(again.changed, false);
  assert.deepEqual(again.events, []);
});

test('forged, malformed and unknown commands cancel nothing and are logged once', async () => {
  const forged = { source: raw(), date: new Date(T0) };
  const planted = { source: raw({ top: ['Authentication-Results: mx.google.com; dkim=pass header.i=@gmail.com; dmarc=pass header.from=gmail.com'] }), date: new Date(T0) };
  const stranger = { source: await signed(raw({ from: 'x@evil.example' }), { domain: 'evil.example' }), date: new Date(T0) };
  const noBody = await own({ body: 'Please stop this one' });
  const unknown = await own({ body: 'Activation ID: LF-AAAA-BBBB-CCCC (stop)' });
  const r = await pass([forged, planted, stranger, noBody, unknown], null, (id) => id === ID);
  assert.deepEqual(r.events.map((e) => e.result), ['refused', 'refused', 'refused', 'ignored', 'ignored']);
  assert.equal(r.events[4].activationId, 'LF-AAAA-BBBB-CCCC');
  assert.deepEqual(r.state.entries, []);
  assert.deepEqual((await pass([forged, unknown], r.state)).events, []);
});

test("the job's own notices and replies are not commands", async () => {
  const r = await pass([await own({ subject: `Lead Finder: ${SUBJECT} refused` }), await own({ subject: `Re: ${SUBJECT}` })]);
  assert.equal(r.changed, false);
  assert.deepEqual(r.events, []);
});

// The app's side, with a list as published.
const config = { secret: crypto.randomBytes(32).toString('base64'), adminEmail: ADMIN, smtp: { host: 'h', port: 25, user: 'u', pass: 'p' }, trial: { days: 5, leads: 30 } };
function device(plan, { at = T0 - 1000, store = new LeadStore(':memory:') } = {}) {
  const sent = [];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-cancel-'));
  const clock = { t: at };
  const act = new Activation({ store, config, mailer: { send: async (m) => sent.push(m) }, machineId: () => 'machine-a', clock: () => clock.t, trialFile: path.join(home, 'mark') });
  if (plan === 'free_trial') act.startTrial();
  else if (plan) act.save('plan', 'activation', { plan, startedAt: at, expiresAt: plan === 'lifetime' ? null : at + 30 * 86_400_000 });
  const quota = new LeadQuota({ store, plan: () => { const s = act.status(); return s.state === 'active' ? s.plan : s.state === 'cancelled' ? 'cancelled' : null; }, now: () => act.now(), config: { trialLeads: 30 } });
  store.setLeadGate(() => quota.gate(), () => {}, () => {});
  return { act, store, quota, clock, sent };
}
async function listFor(activationId, at = T0) {
  const r = await processCommands({ mailbox: box([await own({ body: `Activation ID: ${activationId} (stop)` }, at)]), state: null, adminEmail: ADMIN, resolver, privateKey: keys.privateKey, now: at + 1000 });
  return r.state;
}
const poller = (d, doc, over = {}) =>
  new CancellationPoller({ config: { url: 'https://list.example/c.json', publicKey: keys.publicKey }, activation: d.act, state: { get: (k) => d.store.getState(k), set: (k, v) => d.store.setState(k, v) }, fetchImpl: async () => new Response(JSON.stringify(doc)), ...over });
const lead = (i) => ({ placeKey: `k${i}`, mapsUrl: `https://www.google.com/maps/place/${i}`, name: `Shop ${i}`, keyword: 'k', phoneRaw: `+92300000000${i}`, address: 'Lahore, Pakistan', websiteStatus: 'no_website', isLead: true });

for (const plan of ['monthly', 'six_months', 'lifetime', 'free_trial']) {
  test(`${plan}: cancelled at once, lead collection stops, the admin is told, and it happens once`, async () => {
    const d = device(plan);
    assert.equal(d.act.status().state, 'active');
    assert.ok(d.store.save(lead(1)).isNewLead);
    let told = 0;
    const p = poller(d, await listFor(d.act.activationId), { onCancelled: () => told++ });
    assert.equal(await p.check(), true);
    const st = d.act.status();
    assert.equal(st.state, 'cancelled');
    assert.equal(st.plan, plan);
    assert.equal(d.act.active, false);
    assert.equal(told, 1);
    assert.equal(d.quota.status().reached, true);
    assert.match(d.quota.status().message, /subscription has been cancelled/);
    const after = d.store.save(lead(2));
    assert.ok(after.limitReached, 'the database refuses further leads');
    assert.equal(d.store.listLeads().length, 1, 'saved leads stay');
    assert.equal(await p.check(), false);
    await new Promise((r) => setImmediate(r));
    const notices = d.sent.filter((m) => /cancelled/.test(m.subject));
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, new RegExp(d.act.activationId));
    assert.equal(d.store.getState('activation.cancelLog').length, 1);
  });
}

test('another computer in the list, a wrong signature, an edited list and an older list change nothing', async () => {
  const d = device('lifetime');
  assert.equal(await poller(d, await listFor('LF-AAAA-BBBB-CCCC')).check(), false);
  const good = await listFor(d.act.activationId);
  assert.equal(await poller(d, { ...good, sig: Buffer.alloc(64).toString('base64') }).check(), false);
  const other = await listFor('LF-AAAA-BBBB-CCCC');
  assert.equal(await poller(d, { ...other, entries: good.entries }).check(), false, 'entries from another list');
  const newer = await listFor('LF-AAAA-BBBB-CCCC', T0 + 60_000);
  assert.equal(await poller(d, newer).check(), false);
  assert.equal(await poller(d, good).check(), false, 'an older list is not accepted');
  assert.equal(d.act.status().state, 'active');
});

test('no network, a server error and bad data change nothing; the next check still works', async () => {
  const d = device('monthly');
  const failing = [async () => { throw new Error('offline'); }, async () => new Response('x', { status: 500 }), async () => new Response('not json')];
  for (const fetchImpl of failing) assert.equal(await poller(d, null, { fetchImpl }).check(), false);
  assert.equal(d.act.status().state, 'active');
  assert.equal(await poller(d, await listFor(d.act.activationId)).check(), true);
});

test('not set up: nothing is requested', async () => {
  const d = device('monthly');
  let asked = 0;
  const p = new CancellationPoller({ config: undefined, activation: d.act, state: {}, fetchImpl: async () => asked++ });
  assert.equal(await p.check(), false);
  p.start();
  assert.equal(asked, 0);
});

test('a restored old copy of the plan is cancelled again; a new plan bought after the cancellation stands', async () => {
  const d = device('lifetime');
  const old = d.store.getState('activation');
  const doc = await listFor(d.act.activationId);
  await poller(d, doc).check();
  d.store.setState('activation', old);
  assert.equal(d.act.status().state, 'active');
  await poller(d, doc).check();
  assert.equal(d.act.status().state, 'cancelled');
  // A cancelled Lifetime plan can be replaced, from zero.
  d.clock.t = T0 + 86_400_000;
  d.act.save('plan', 'activation', { plan: 'monthly', startedAt: d.clock.t, expiresAt: d.clock.t + 30 * 86_400_000 });
  await poller(d, doc).check();
  assert.equal(d.act.status().state, 'active');
});

test('an edited cancelled record is refused: it no longer counts as a plan', async () => {
  const d = device('monthly');
  await poller(d, await listFor(d.act.activationId)).check();
  const rec = d.store.getState('activation');
  delete rec.cancelledAt;
  d.store.setState('activation', rec);
  assert.notEqual(d.act.status().state, 'active');
});

test('the Activation ID has the format the command expects', () => {
  assert.match(activationIdFor('anything'), /^LF-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
});
