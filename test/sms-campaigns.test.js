'use strict';
// SMS campaigns with a stand-in for Sms.send: placeholders, one at a time
// with the delay, opted-out and already-texted contacts skipped, a number
// once per campaign, retries then failed, submitted -> sent -> delivered as
// the phone reports, the hourly limit, waiting while messages are
// disconnected, pause/resume/stop, retry failures, and a restart that never
// sends a message twice.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { LeadStore } = require('../src/database/db');
const { SmsCampaigns, render, cityOf, settingsFrom } = require('../src/messaging/sms-campaigns');

const tick = () => new Promise((r) => setImmediate(r));

class FakeSms extends EventEmitter {
  constructor(store, clock = () => Date.now()) {
    super();
    this.store = store;
    this.clock = clock;
    this.s = { state: 'ready' };
    this.sent = [];
    this.fail = null; // error message for the next sends
  }
  async send(phone, text, opts) {
    if (this.s.state !== 'ready') return { ok: false, error: 'Messages are not connected.' };
    if (this.store.isOptedOut(phone)) return { ok: false, error: 'opted out', optedOut: true };
    if (this.fail) return { ok: false, error: this.fail };
    const id = this.store.addSms({ phone, direction: 'out', body: text, status: 'submitted', at: this.clock(), leadId: opts.leadId, numberId: opts.numberId });
    this.sent.push({ phone, text, id, ...opts });
    return { ok: true, id };
  }
  setState(state) {
    this.s.state = state;
    this.emit('state', { state });
  }
}

function setup() {
  const store = new LeadStore(':memory:');
  let now = 1_800_000_000_000;
  const sms = new FakeSms(store, () => now);
  const pending = [];
  const timers = { setTimeout: (fn, ms) => (pending.push({ fn, ms }), pending.length), clearTimeout: (i) => i && (pending[i - 1] = null) };
  const camps = new SmsCampaigns({ sms, store, timers, now: () => now });
  const run = async () => {
    const t = pending.filter(Boolean).at(-1);
    pending.length = 0;
    if (t) await t.fn();
    await tick();
    return t;
  };
  return { store, sms, camps, run, pending, advance: (ms) => (now += ms) };
}

const people = [
  { kind: 'import', phone: '+923001112233', name: 'Ali', business: 'SEO Hub', category: 'SEO', city: 'Lahore' },
  { kind: 'import', phone: '+923214445566', name: null, business: 'Web Works', category: 'Web', city: 'Karachi' },
  { kind: 'import', phone: '+923337778889', name: 'Bilal', business: null },
];

test('placeholders, city of an address, sending settings', () => {
  const msg = 'Assalam-o-Alaikum {name}, kya {business_name} aapka business hai? ({city}, {category}) {phone}';
  assert.equal(render(msg, people[0]), 'Assalam-o-Alaikum Ali, kya SEO Hub aapka business hai? (Lahore, SEO) +923001112233');
  assert.equal(render('Hi {name}, about {business_name}.', people[1]), 'Hi Web Works, about Web Works.');
  assert.equal(render('Hi {name} from {city}!', { name: 'Bilal' }), 'Hi Bilal from!');
  assert.equal(render('Kya {business_name} aapka business hai? ({city})', { business: 'Acme' }), 'Kya Acme aapka business hai?');
  assert.equal(cityOf('12 Main Rd, Gulberg, Lahore, Punjab 54000, Pakistan'), 'Lahore');
  assert.equal(cityOf('Austin, Texas, United States'), 'Austin');
  assert.equal(cityOf('Blue Area, Islamabad, Pakistan'), 'Islamabad');
  assert.equal(cityOf('Shahrah-e-Faisal, Karachi, Sindh, Pakistan'), 'Karachi');
  assert.equal(cityOf('123 Main St, Austin, TX 78701, USA'), 'Austin');
  assert.equal(cityOf('Lahore, Pakistan'), 'Lahore');
  assert.equal(cityOf(''), null);
  assert.equal(settingsFrom({ delaySeconds: 1 }).delaySeconds, 10); // never faster than 10 s
  assert.equal(settingsFrom({ speed: 'slow' }).delaySeconds, 60);
});

test('a campaign sends to everyone, one at a time with its delay; a number once; statuses follow the phone', async () => {
  const { store, sms, camps, run, pending } = setup();
  const { id } = camps.create({ name: 'Websites', message: 'Hi {name}, {business_name}?', delaySeconds: 20 });
  assert.deepEqual(camps.addRecipients(id, [...people, people[0]]).added, 3);
  assert.equal(camps.preview(id)[0].text, 'Hi Ali, SEO Hub?');
  assert.equal(camps.start(id).ok, true);
  await run();
  assert.equal(sms.sent.length, 1);
  assert.equal(pending.at(-1).ms, 20_000); // the delay before the next
  await run();
  await run();
  assert.deepEqual(sms.sent.map((s) => s.text), ['Hi Ali, SEO Hub?', 'Hi Web Works, Web Works?', 'Hi Bilal, Bilal?']);
  await run();
  let c = store.smsCampaign(id);
  assert.equal(c.status, 'done');
  assert.equal(c.counts.submitted, 3); // handed to the phone, not yet "sent"
  assert.equal(c.counts.sent, 0);
  // The phone reports: sent, then delivered.
  store.updateSms(sms.sent[0].id, { status: 'sent' });
  store.updateSms(sms.sent[1].id, { status: 'delivered' });
  store.updateSms(sms.sent[2].id, { status: 'failed', error: 'The phone could not send it.' });
  sms.emit('changed', {});
  c = store.smsCampaign(id);
  assert.deepEqual({ submitted: c.counts.submitted, sent: c.counts.sent, delivered: c.counts.delivered, failed: c.counts.failed }, { submitted: 0, sent: 1, delivered: 1, failed: 1 });
});

test('opted out and already texted contacts are skipped, with the reason', async () => {
  const { store, sms, camps, run } = setup();
  store.optOut('+923214445566', 'STOP');
  store.addSms({ phone: '+923337778889', direction: 'out', body: 'earlier', status: 'sent', at: 1 });
  const { id } = camps.create({ name: 'C', message: 'Hi {name}' });
  camps.addRecipients(id, people);
  camps.start(id);
  for (let i = 0; i < 5; i++) await run();
  assert.deepEqual(sms.sent.map((s) => s.phone), ['+923001112233']);
  const rows = store.smsRecipients(id).rows;
  assert.match(rows[1].reason, /Opted out/);
  assert.match(rows[2].reason, /Already texted/);
  assert.equal(store.smsCampaign(id).counts.skipped, 2);
});

test('a failing send is tried again later, then failed with its reason; "retry failures" sends again', async () => {
  const { store, sms, camps, run, advance } = setup();
  const { id } = camps.create({ name: 'C', message: 'Hi', maxRetries: 1 });
  camps.addRecipients(id, people.slice(0, 1));
  camps.start(id);
  sms.fail = 'The transfer failed.';
  await run();
  let r = store.smsRecipients(id).rows[0];
  assert.equal(r.status, 'pending');
  assert.match(r.reason, /will try again/);
  advance(60_000);
  await run(); // the queue waits for the retry time
  await run();
  r = store.smsRecipients(id).rows[0];
  assert.equal(r.status, 'failed');
  assert.equal(r.attempts, 2);
  await run();
  assert.equal(store.smsCampaign(id).status, 'done');
  sms.fail = null;
  assert.equal(camps.retryFailures(id).retried, 1);
  assert.equal(store.smsCampaign(id).status, 'paused');
  camps.start(id);
  await run();
  assert.equal(store.smsRecipients(id).rows[0].status, 'submitted');
});

test('the hourly limit, messages disconnected, pause, stop', async () => {
  const { store, sms, camps, run } = setup();
  const { id } = camps.create({ name: 'C', message: 'Hi', perHour: 1 });
  camps.addRecipients(id, people);
  camps.start(id);
  await run();
  await run();
  assert.equal(sms.sent.length, 1);
  assert.match(store.smsCampaign(id).reason, /Hourly limit/);
  store.updateSmsCampaign(id, { perHour: 100 });
  // Messages drop: it waits, and goes on when they are back.
  sms.setState('off');
  await run();
  assert.equal(sms.sent.length, 1);
  assert.match(store.smsCampaign(id).reason, /not connected/);
  sms.setState('ready');
  await run();
  assert.equal(sms.sent.length, 2);
  assert.equal(camps.pause(id).ok, true);
  await run();
  assert.equal(sms.sent.length, 2);
  assert.match(camps.start(id).error || '', /^$/);
  assert.equal(camps.stop(id).ok, true);
  await run();
  assert.equal(sms.sent.length, 2);
  assert.equal(store.smsCampaign(id).counts.pending, 1); // not sent, and it stays so
  assert.match(camps.start(id).error, /ended/);
});

test('one campaign sends at a time; a restart does not send twice', async () => {
  const { store, sms, camps, run } = setup();
  const a = camps.create({ name: 'A', message: 'Hi' }).id;
  const b = camps.create({ name: 'B', message: 'Hi' }).id;
  camps.addRecipients(a, people.slice(0, 2));
  camps.addRecipients(b, people.slice(2));
  camps.start(a);
  assert.match(camps.start(b).error, /pause it first/);
  // Lead Finder closed while handing a message to the phone.
  const r = store.smsRecipients(a).rows[0];
  store.updateSmsRecipient(r.id, { status: 'sending', attempts: 1 });
  const again = new SmsCampaigns({ sms, store, timers: { setTimeout: () => 0, clearTimeout() {} } });
  again.init();
  const after = store.smsRecipients(a).rows[0];
  assert.equal(after.status, 'failed');
  assert.match(after.reason, /not sent again/);
  await run();
  // The interrupted one is not sent again; the next one is.
  assert.deepEqual(sms.sent.map((x) => x.phone), ['+923214445566']);
});
