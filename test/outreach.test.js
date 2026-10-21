'use strict';
// Real-estate outreach: templates, the persistent scheduler, daily caps,
// duplicate prevention, opt-outs, replies, reconnects and failures, against a
// real (temporary) lead database and a scripted WhatsApp transport.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LeadStore } = require('../src/database/db');
const { OutreachStore } = require('../src/database/wa-store');
const { Outreach, timeZoneOf, inQuietHours, isRestriction } = require('../src/whatsapp/outreach');
const { extractName, pickName, render, validateTemplates, isOptOut, DEFAULT_TEMPLATES } = require('../src/whatsapp/templates');

const MIN = 60_000;
// 10:00 in Pakistan (UTC+5), a Wednesday.
const START = Date.parse('2026-10-21T05:00:00Z');

function setup({ test: testMode = false, contacts = 3, ready = true, file } = {}) {
  const dir = file ? path.dirname(file) : fs.mkdtempSync(path.join(os.tmpdir(), 'lf-outreach-'));
  const db = new LeadStore(file || path.join(dir, 'leads.db'));
  const clock = { t: START };
  const sent = [];
  const transport = {
    ok: ready,
    fail: null,
    ready: () => transport.ok,
    send: async (phone, text) => {
      if (transport.fail) throw transport.fail;
      sent.push({ phone, text, at: clock.t });
      return { id: `WA${sent.length}` };
    },
  };
  const make = () =>
    new Outreach({
      store: new OutreachStore(db.db),
      state: { get: (k) => db.getState(k), set: (k, v) => db.setState(k, v) },
      transport,
      details: (c) => ({ business: `${c.name || 'Some'} Real Estate` }),
      clock: () => clock.t,
      random: () => 0.5, // 52.5 minutes
      tickMs: 1e9,
    });
  const o = make();
  if (!file) {
    o.addLeads(Array.from({ length: contacts }, (_, i) => ({ phone: `+92300100${String(i).padStart(4, '0')}`, leadId: null, name: i % 2 ? null : `Name${i}` })));
    assert.equal(o.configure({ test: testMode }).ok, true);
  }
  return { db, o, clock, sent, transport, make, dir, file: file || path.join(dir, 'leads.db') };
}

const advance = (h, ms) => (h.clock.t += ms);

// Runs the scheduler for `ms`, ticking every 30 s as the app does.
async function run(h, ms, o = h.o) {
  const end = h.clock.t + ms;
  while (h.clock.t < end) {
    await o.tick();
    h.clock.t += 30_000;
  }
}

test('names: only safe words from real names, never invented', () => {
  assert.equal(extractName('Zahid Properties'), 'Zahid');
  assert.equal(extractName('Al Noor Real Estate'), 'Noor');
  assert.equal(extractName('Haji Bashir & Sons'), 'Bashir');
  assert.equal(extractName('Real Estate Lahore'), null);
  assert.equal(extractName('DHA Phase 5 Properties'), null);
  assert.equal(extractName('Estate 5'), null);
  assert.equal(extractName('خان اسٹیٹ ایجنسی'), null, 'Urdu script is not put into Roman Urdu text');
  assert.equal(extractName('Al'), null);
  assert.equal(extractName(''), null);
  assert.deepEqual(pickName({ contactName: 'Imran Khan', businessName: 'Zahid Properties' }), { name: 'Imran', source: 'contact' });
  assert.deepEqual(pickName({ contactName: null, pushName: '~', businessName: 'Zahid Properties' }), { name: 'Zahid', source: 'business' });
  assert.deepEqual(pickName({ businessName: 'Best Properties' }), { name: null, source: null });
});

test('templates: placeholders, fallbacks, validation, Urdu and Roman Urdu', () => {
  const [greet, intro, ask] = DEFAULT_TEMPLATES;
  assert.equal(render(greet, { name: 'Zahid' }), 'Assalam-o-Alaikum Zahid bhai.');
  assert.equal(render(greet, { name: null }), 'Assalam-o-Alaikum.');
  assert.equal(render(intro, {}), 'Kaise hain aap? Umeed hai aap khairiyat se honge.');
  assert.equal(render(ask, {}), 'Kya aap real estate ka kaam karte hain, ya kisi aur business se related hain?');
  assert.equal(render({ text: 'السلام علیکم {name} بھائی', fallback: 'السلام علیکم' }, { name: null }), 'السلام علیکم');
  assert.equal(render({ text: 'Hello {business} team', fallback: '' }, {}), 'Hello team');
  assert.deepEqual(validateTemplates(DEFAULT_TEMPLATES), []);
  assert.match(validateTemplates([{ text: 'Hi {name}', fallback: '' }, intro, ask]).join(' '), /needs a version for contacts without a known name/);
  assert.match(validateTemplates([{ text: 'Hi {phone}', fallback: 'Hi' }, intro, ask]).join(' '), /unknown placeholder \{phone\}/);
  assert.match(validateTemplates([greet, { text: ' ', fallback: '' }, ask]).join(' '), /Message 2 is empty/);
});

test('opt-out detection in English, Roman Urdu and Urdu', () => {
  for (const t of ['STOP', 'please do not message me', 'not interested', 'mujhe message na karein', 'dobara msg na karna', 'band karo ye', 'میسج نہ کریں', 'unsubscribe']) assert.ok(isOptOut(t), t);
  for (const t of ['Walaikum assalam', 'Ji haan, real estate', 'Which block in DHA?', 'Theek hoon, aap sunaein', '']) assert.ok(!isOptOut(t), t);
});

test('three stages, one message per 45-60 minutes, never back to back', async () => {
  const h = setup({ contacts: 1 });
  assert.equal(h.o.start().ok, false, 'live sending needs the acknowledgement');
  assert.equal(h.o.start({ acknowledge: true }).ok, true);
  await h.o.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].text, 'Assalam-o-Alaikum Name0 bhai.');
  const due = h.o.load().nextDueAt;
  assert.equal(due - h.sent[0].at, 52.5 * MIN, 'random gap within 45-60 minutes');
  await run(h, 52 * MIN);
  assert.equal(h.sent.length, 1, 'nothing before the interval');
  await run(h, 2 * MIN);
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].text, 'Kaise hain aap? Umeed hai aap khairiyat se honge.');
  await run(h, 60 * MIN);
  assert.equal(h.sent.length, 3);
  assert.ok(h.sent[2].at - h.sent[1].at >= 45 * MIN);
  await run(h, 3 * 60 * MIN);
  assert.equal(h.sent.length, 3, 'three messages, then nothing');
  assert.equal(h.o.store.contact('+923001000000').state, 'done');
  assert.equal(h.o.load().status, 'stopped');
  assert.equal(h.o.load().pauseReason, 'finished');
});

test('missing names use the version without a name', async () => {
  const h = setup({ contacts: 2 });
  h.o.store.setContact('+923001000000', { state: 'excluded' });
  h.o.start({ acknowledge: true });
  await h.o.tick();
  assert.equal(h.sent[0].phone, '+923001000001');
  assert.equal(h.sent[0].text, 'Assalam-o-Alaikum.');
  assert.deepEqual(h.o.preview(h.o.store.contact('+923001000001')).slice(0, 1), ['Assalam-o-Alaikum.']);
});

test('daily cap counts unique recipients, survives restarts and resets the next day', async () => {
  const h = setup({ contacts: 14 });
  h.o.configure({ dailyCap: 10, quietStart: 23, quietEnd: 6 });
  h.o.start({ acknowledge: true });
  await run(h, 17 * 60 * MIN); // 10:00 -> 03:00 PKT
  const day1 = h.sent.filter((s) => s.at < Date.parse('2026-10-21T19:00:00Z'));
  const recipients = new Set(day1.map((s) => s.phone));
  assert.ok(recipients.size <= 10, `${recipients.size} recipients on day 1`);
  assert.equal(h.o.snapshot().today.recipients <= 10, true);
  // A restarted app keeps the count.
  const again = h.make();
  assert.ok(again.snapshot().today.recipients <= 10);
  assert.equal(again.snapshot().today.cap, 10);
  // Never more than one message per 45 minutes overall.
  for (let i = 1; i < h.sent.length; i++) assert.ok(h.sent[i].at - h.sent[i - 1].at >= 45 * MIN);
  assert.equal(h.sent.length, new Set(h.sent.map((s) => `${s.phone}|${s.text}`)).size, 'no message sent twice');
});

test('a full day of capped recipients waits; follow-ups to today’s recipients may continue', async () => {
  const h = setup({ contacts: 12 });
  h.o.configure({ dailyCap: 10 });
  const store = h.o.store;
  // Ten recipients already messaged today (stage 1), earlier.
  for (let i = 0; i < 10; i++) {
    const phone = `+92300100${String(i).padStart(4, '0')}`;
    const id = store.reserve({ phone, stage: 1, test: false, day: '2026-10-21', now: START - 3 * 60 * MIN });
    store.markSent(id, `OLD${i}`, START - 3 * 60 * MIN);
    store.setContact(phone, { stage: 1, state: 'active', lastSentAt: START - 3 * 60 * MIN });
  }
  h.o.start({ acknowledge: true });
  await h.o.tick();
  assert.equal(h.sent.length, 1);
  assert.notEqual(h.sent[0].phone, '+923001000010', 'a new contact would exceed the cap; a follow-up goes first');
  assert.equal(h.o.snapshot().today.recipients, 10);
});

test('the 45-minute gap holds across a restart', async () => {
  const h = setup({ contacts: 3 });
  h.o.start({ acknowledge: true });
  await h.o.tick();
  assert.equal(h.sent.length, 1);
  h.o.stop();
  advance(h, 10 * MIN);
  const restarted = h.make();
  assert.equal(restarted.start().ok, true, 'already acknowledged');
  await restarted.tick();
  assert.equal(h.sent.length, 1, 'restart does not reset the interval');
  assert.ok(restarted.load().nextDueAt >= h.sent[0].at + 45 * MIN);
  await run(h, 40 * MIN, restarted);
  assert.equal(h.sent.length, 2);
});

test('each stage is sent at most once, even with two schedulers or a lost update', async () => {
  const h = setup({ contacts: 1 });
  h.o.start({ acknowledge: true });
  const twin = h.make();
  await Promise.all([h.o.tick(), twin.tick(), h.o.tick()]);
  assert.equal(h.sent.length, 1);
  // The contact's progress was not saved (e.g. crash after sending): the
  // reservation still prevents a second stage-1 message.
  h.o.store.setContact('+923001000000', { stage: 0, state: 'queued' });
  const st = h.o.load();
  st.nextDueAt = h.clock.t;
  h.o.save(st);
  await h.o.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.o.store.contact('+923001000000').stage, 1);
});

test('a reply pauses that contact; an opt-out stops it for good', async () => {
  const h = setup({ contacts: 2 });
  h.o.start({ acknowledge: true });
  await h.o.tick(); // +923001000000 stage 1
  h.o.onIncoming({ phone: '+923001000000', text: 'Walaikum assalam, kaun?' });
  assert.equal(h.o.store.contact('+923001000000').state, 'replied');
  await run(h, 4 * 60 * MIN);
  assert.ok(h.sent.every((s, i) => i === 0 || s.phone !== '+923001000000'), 'no automated message after the reply');
  // Opt-out from the other contact, mid-sequence.
  h.o.onIncoming({ phone: '+923001000001', text: 'Please do not message me again' });
  const before = h.sent.length;
  await run(h, 4 * 60 * MIN);
  assert.equal(h.sent.length, before);
  assert.equal(h.o.store.contact('+923001000001').state, 'opted_out');
  assert.equal(h.o.include('+923001000001').ok, false, 'an opt-out cannot be resumed');
  assert.deepEqual(h.o.addLeads([{ phone: '+923001000001', name: null }]), { ok: true, added: 0, skipped: 1 });
  // The replied contact can be handed back to the campaign by the user.
  assert.equal(h.o.include('+923001000000').ok, true);
});

test('a reply that was not matched still stops the next message (safety net)', async () => {
  const h = setup({ contacts: 1 });
  let replied = false;
  const o = new Outreach({ ...h.o, store: h.o.store, state: h.o.state, transport: h.transport, details: h.o.details, clock: h.o.clock, random: h.o.random, tickMs: 1e9, hasReplied: () => replied });
  o.start({ acknowledge: true });
  await o.tick();
  replied = true;
  await run(h, 2 * 60 * MIN, o);
  assert.equal(h.sent.length, 1);
  assert.equal(o.store.contact('+923001000000').state, 'replied');
});

test('quiet hours in the recipient’s time zone', async () => {
  assert.equal(timeZoneOf('+923001234567'), 'Asia/Karachi');
  assert.equal(timeZoneOf('+971501234567'), 'Asia/Dubai');
  assert.equal(timeZoneOf('+15551234567'), null);
  assert.ok(inQuietHours(22, 21, 9) && inQuietHours(3, 21, 9) && !inQuietHours(12, 21, 9));
  const h = setup({ contacts: 1 });
  h.clock.t = Date.parse('2026-10-21T17:30:00Z'); // 22:30 in Pakistan
  h.o.start({ acknowledge: true });
  await h.o.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.o.snapshot().waiting, 'quiet_hours');
  h.clock.t = Date.parse('2026-10-22T04:00:00Z'); // 09:00 in Pakistan
  await h.o.tick();
  assert.equal(h.sent.length, 1);
});

test('disconnected: waits, nothing reserved; sends once after reconnecting', async () => {
  const h = setup({ contacts: 1, ready: false });
  h.o.start({ acknowledge: true });
  await run(h, 10 * MIN);
  assert.equal(h.sent.length, 0);
  assert.equal(h.o.snapshot().waiting, 'whatsapp');
  assert.equal(h.o.store.sends({ test: false }).length, 0);
  // Dropped between the check and the send: released, sent later once.
  h.transport.ok = true;
  h.transport.fail = Object.assign(new Error('WhatsApp is not connected.'), { code: 'not_connected' });
  await h.o.tick();
  assert.equal(h.o.store.sends({ test: false }).length, 0);
  h.transport.fail = null;
  await h.o.tick();
  assert.equal(h.sent.length, 1);
  await h.o.tick();
  assert.equal(h.sent.length, 1);
});

test('failures: timeouts are never retried; restrictions pause the campaign; repeated errors pause it', async () => {
  const h = setup({ contacts: 5 });
  h.o.start({ acknowledge: true });
  h.transport.fail = new Error('Sending timed out');
  await h.o.tick();
  assert.equal(h.o.store.contact('+923001000000').state, 'uncertain');
  assert.equal(h.o.store.sends({ test: false })[0].status, 'unknown');
  h.transport.fail = null;
  await run(h, 2 * 60 * MIN);
  assert.ok(!h.sent.some((s) => s.phone === '+923001000000'), 'an uncertain send is not repeated');

  const r = setup({ contacts: 2 });
  r.o.start({ acknowledge: true });
  r.transport.fail = Object.assign(new Error('rate-overlimit'), { data: { code: 463 } });
  await r.o.tick();
  assert.equal(r.o.load().status, 'paused');
  assert.equal(r.o.load().pauseReason, 'restricted');
  assert.ok(isRestriction(Object.assign(new Error('x'), { output: { statusCode: 403 } })));

  const e = setup({ contacts: 4 });
  e.o.start({ acknowledge: true });
  e.transport.fail = new Error('bad request');
  await run(e, 4 * 60 * MIN);
  assert.equal(e.o.load().status, 'paused');
  assert.equal(e.o.load().pauseReason, 'errors');
  assert.equal(e.o.store.sends({ test: false }).filter((s) => s.status === 'failed').length, 3);
});

test('interrupted sends are marked unknown and never resent', async () => {
  const h = setup({ contacts: 1 });
  const id = h.o.store.reserve({ phone: '+923001000000', stage: 1, test: false, day: '2026-10-21', now: START - 10 * MIN });
  assert.ok(id);
  h.o.init();
  h.o.dispose();
  assert.equal(h.o.store.sends({ test: false })[0].status, 'unknown');
  assert.equal(h.o.store.contact('+923001000000').state, 'uncertain');
  h.o.start({ acknowledge: true });
  await run(h, 2 * 60 * MIN);
  assert.equal(h.sent.length, 0);
});

test('delivery receipts move forward only', async () => {
  const h = setup({ contacts: 1 });
  h.o.start({ acknowledge: true });
  await h.o.tick();
  h.o.onStatus('WA1', 'delivered');
  h.o.onStatus('WA1', 'read');
  h.o.onStatus('WA1', 'delivered');
  assert.equal(h.o.store.sends({ test: false })[0].status, 'read');
});

test('test mode sends nothing; switching to live forgets the simulation', async () => {
  const h = setup({ contacts: 2, test: true });
  assert.equal(h.o.start().ok, true, 'no acknowledgement needed to simulate');
  await run(h, 3 * 60 * MIN);
  assert.equal(h.sent.length, 0, 'nothing reaches WhatsApp');
  assert.ok(h.o.snapshot().sends.length >= 2);
  h.o.stop();
  h.o.exclude('+923001000001');
  assert.equal(h.o.configure({ test: false }).ok, true);
  assert.equal(h.o.snapshot().sends.length, 0);
  assert.ok(h.o.store.contacts().every((c) => c.stage === 0 && c.lastSentAt === null), 'no simulated progress left, excluded contacts included');
  assert.deepEqual(h.o.store.contacts().map((c) => c.state), ['queued', 'excluded'], 'the exclusion is kept');
});

test('settings are validated (45-60 minutes, 10-15 per day, quiet hours)', () => {
  const h = setup();
  assert.match(h.o.configure({ intervalMin: 30 }).error, /between 45 and 60 minutes/);
  assert.match(h.o.configure({ intervalMax: 90 }).error, /between 45 and 60 minutes/);
  assert.match(h.o.configure({ dailyCap: 20 }).error, /between 10 and 15/);
  assert.match(h.o.configure({ quietStart: 10, quietEnd: 8 }).error, /at least 4 hours/);
  assert.equal(h.o.configure({ intervalMin: 50, intervalMax: 55, dailyCap: 15 }).ok, true);
  h.o.start({ acknowledge: true });
  assert.match(h.o.configure({ dailyCap: 12 }).error, /Pause the campaign/);
});

test('cap reached: new contacts wait until the next day, also after a restart', async () => {
  const h = setup({ contacts: 12 });
  h.o.configure({ dailyCap: 10 });
  const store = h.o.store;
  for (let i = 0; i < 10; i++) {
    const phone = `+92300100${String(i).padStart(4, '0')}`;
    for (let stage = 1; stage <= 3; stage++) {
      const id = store.reserve({ phone, stage, test: false, day: '2026-10-21', now: START - 5 * 60 * MIN });
      store.markSent(id, `OLD${i}-${stage}`, START - 5 * 60 * MIN);
    }
    store.setContact(phone, { stage: 3, state: 'done', lastSentAt: START - 5 * 60 * MIN });
  }
  h.o.start({ acknowledge: true });
  await run(h, 6 * 60 * MIN); // until 16:00 PKT
  assert.equal(h.sent.length, 0);
  assert.equal(h.o.snapshot().waiting, 'daily_cap');
  assert.equal(h.o.snapshot().today.recipients, 10);
  const restarted = h.make();
  await restarted.tick();
  assert.equal(h.sent.length, 0, 'the cap holds after a restart');
  // Next morning (09:30 PKT, outside quiet hours): a new day, new recipients.
  h.clock.t = Date.parse('2026-10-22T04:30:00Z');
  await restarted.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].phone, '+923001000010');
  assert.equal(restarted.snapshot().today.recipients, 1);
});
