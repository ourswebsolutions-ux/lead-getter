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
const { extractName, cleanBusiness, pickName, render, validateTemplates, isOptOut, DEFAULT_TEMPLATES } = require('../src/whatsapp/templates');

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
  const outreach = () =>
    new Outreach({
      store: new OutreachStore(db.db),
      state: { get: (k) => db.getState(k), set: (k, v) => db.setState(k, v) },
      transport,
      details: (c) => ({ business: `${c.name || 'Some'} Real Estate` }),
      clock: () => clock.t,
      random: () => 0.5, // 52.5 minutes
      tickMs: 1e9,
    });
  const o = outreach();
  const cid = o.create('Campaign A').id;
  const c = o.campaign(cid);
  // A restarted app: a new scheduler on the same database, same campaign.
  const make = () => {
    const o2 = outreach();
    return Object.assign(o2.campaign(cid), { tick: () => o2.tick(), init: () => o2.init(), dispose: () => o2.dispose(), outreach: o2 });
  };
  if (!file) {
    c.addLeads(Array.from({ length: contacts }, (_, i) => ({ phone: `+92300100${String(i).padStart(4, '0')}`, leadId: null, name: i % 2 ? null : `Name${i}` })));
    assert.equal(c.configure({ test: testMode }).ok, true);
  }
  return { db, o, c, cid, clock, sent, transport, make, outreach, dir, file: file || path.join(dir, 'leads.db') };
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
  assert.equal(render(ask, { business: 'Zahid Properties' }), 'Kya aap Zahid Properties ke naam se real estate ka kaam karte hain, ya kisi aur business se related hain?');
  assert.equal(render(ask, {}), 'Kya aap real estate ka kaam karte hain, ya kisi aur business se related hain?', 'no business name: the version without it');
  assert.equal(cleanBusiness('Zahid Properties - Best Real Estate Agency in DHA'), 'Zahid Properties');
  assert.equal(cleanBusiness('Al Noor Estate | Bahria Town'), 'Al Noor Estate');
  assert.equal(cleanBusiness('Khan Associates (Pvt) Ltd'), 'Khan Associates');
  assert.equal(cleanBusiness('خان اسٹیٹ ایجنسی'), null, 'not put into Roman Urdu text');
  assert.equal(cleanBusiness('A'.repeat(41)), null);
  assert.match(validateTemplates([greet, intro, { text: 'Kya {business}?', fallback: '' }]).join(' '), /needs a version for contacts without a business name/);
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

test('one contact at a time: three messages about a minute apart, then 45-60 minutes to the next contact', async () => {
  const h = setup({ contacts: 2 });
  h.clock.t = Date.parse('2026-10-21T09:00:00Z'); // 14:00 in Pakistan
  assert.equal(h.c.start().ok, false, 'live sending needs the acknowledgement');
  assert.equal(h.c.start({ acknowledge: true }).ok, true);
  await run(h, 3 * MIN);
  const A = '+923001000000';
  const B = '+923001000001';
  const t0 = h.sent[0].at;
  // Contact A: 14:00, 14:01, 14:02.
  assert.deepEqual(h.sent.map((s) => [s.phone, (s.at - t0) / 1000]), [[A, 0], [A, 60], [A, 120]]);
  assert.deepEqual(h.sent.map((s) => s.text), [
    'Assalam-o-Alaikum Name0 bhai.',
    'Kaise hain aap? Umeed hai aap khairiyat se honge.',
    'Kya aap Name0 Real Estate ke naam se real estate ka kaam karte hain, ya kisi aur business se related hain?',
  ]);
  assert.equal(h.c.contact(A).state, 'done');
  // Contact B: 52.5 minutes (random within 45-60) after A's last message.
  const aDone = h.sent[2].at;
  assert.equal(h.c.load().nextDueAt - aDone, 52.5 * MIN);
  assert.equal(h.c.snapshot().waiting, 'interval');
  await run(h, 51 * MIN); // until 52 minutes after A's last message
  assert.equal(h.sent.length, 3, 'nothing to B before the gap');
  await run(h, 4 * MIN);
  assert.equal(h.sent.length, 6);
  assert.deepEqual(h.sent.slice(3).map((s) => s.phone), [B, B, B]);
  const bStart = (h.sent[3].at - aDone) / MIN;
  assert.ok(bStart >= 52.5 && bStart < 53, `B started ${bStart} minutes after A finished`);
  assert.deepEqual(h.sent.slice(3).map((s) => (s.at - h.sent[3].at) / 1000), [0, 60, 120]);
  await run(h, 2 * 60 * MIN);
  assert.equal(h.sent.length, 6, 'three messages each, nothing more');
  assert.equal(h.c.load().status, 'stopped');
  assert.equal(h.c.load().pauseReason, 'finished');
});

test('gaps stay within their ranges: 55-65 s within a contact, 45-60 min between contacts', () => {
  const h = setup();
  const cfg = h.c.load().config;
  for (const [r, stage, contact] of [[0, 55_000, 45 * MIN], [1, 65_000, 60 * MIN], [0.5, 60_000, 52.5 * MIN]]) {
    h.o.random = () => r;
    assert.equal(h.o.stageGap(), stage);
    assert.equal(h.o.contactGap(cfg), contact);
  }
  h.c.configure({ intervalMin: 50, intervalMax: 55 });
  h.o.random = () => 1;
  assert.equal(h.o.contactGap(h.c.load().config), 55 * MIN);
});

test('missing names use the version without a name', async () => {
  const h = setup({ contacts: 2 });
  h.c.setContact('+923001000000', { state: 'excluded' });
  h.c.start({ acknowledge: true });
  await h.o.tick();
  assert.equal(h.sent[0].phone, '+923001000001');
  assert.equal(h.sent[0].text, 'Assalam-o-Alaikum.');
  assert.deepEqual(h.c.preview(h.c.contact('+923001000001')).slice(0, 1), ['Assalam-o-Alaikum.']);
});

test('a day of sending: at most the daily cap, one contact at a time, 45+ minutes between contacts', async () => {
  const h = setup({ contacts: 14 });
  h.c.configure({ dailyCap: 10, quietStart: 23, quietEnd: 6 });
  h.c.start({ acknowledge: true });
  await run(h, 17 * 60 * MIN); // 10:00 -> 03:00 in Pakistan
  // Unique recipients per (local) day never exceed the cap.
  const byDay = new Map();
  for (const s of h.c.sends({ campaignId: h.c.id, test: false, limit: 1000 })) byDay.set(s.day, new Set([...(byDay.get(s.day) || []), s.phone]));
  for (const [day, phones] of byDay) assert.ok(phones.size <= 10, `${phones.size} recipients on ${day}`);
  assert.equal(Math.max(...[...byDay.values()].map((p) => p.size)), 10, 'the cap was reached');
  // Each contact's messages are consecutive and about a minute apart; the
  // next contact starts at least 45 minutes after the previous one's last.
  const runs = [];
  for (const s of h.sent) {
    if (runs.length && runs.at(-1).phone === s.phone) runs.at(-1).list.push(s);
    else runs.push({ phone: s.phone, list: [s] });
  }
  assert.equal(new Set(runs.map((r) => r.phone)).size, runs.length, 'no contact is returned to later');
  for (const r of runs) {
    assert.equal(r.list.length, 3);
    for (let i = 1; i < 3; i++) assert.ok(r.list[i].at - r.list[i - 1].at <= 90_000, 'about a minute apart');
  }
  for (let i = 1; i < runs.length; i++) assert.ok(runs[i].list[0].at - runs[i - 1].list[2].at >= 45 * MIN, 'gap between contacts');
  assert.equal(h.sent.length, new Set(h.sent.map((s) => `${s.phone}|${s.text}`)).size, 'no message sent twice');
  // A restarted app keeps the count.
  assert.ok(h.make().snapshot().today.recipients <= 10);
});

test('a full day of capped recipients waits; follow-ups to today’s recipients may continue', async () => {
  const h = setup({ contacts: 12 });
  h.c.configure({ dailyCap: 10 });
  const store = h.o.store;
  // Ten recipients already messaged today (stage 1), earlier.
  for (let i = 0; i < 10; i++) {
    const phone = `+92300100${String(i).padStart(4, '0')}`;
    const id = store.reserve({ campaignId: h.c.id, phone, stage: 1, test: false, day: '2026-10-21', now: START - 3 * 60 * MIN });
    store.markSent(id, `OLD${i}`, START - 3 * 60 * MIN);
    h.c.setContact(phone, { stage: 1, state: 'active', lastSentAt: START - 3 * 60 * MIN });
  }
  h.c.start({ acknowledge: true });
  await h.o.tick();
  assert.equal(h.sent.length, 1);
  assert.notEqual(h.sent[0].phone, '+923001000010', 'a new contact would exceed the cap; a follow-up goes first');
  assert.equal(h.c.snapshot().today.recipients, 10);
});

test('restarts and pauses continue the schedule without resetting it', async () => {
  const h = setup({ contacts: 2 });
  const A = '+923001000000';
  const B = '+923001000001';
  h.c.start({ acknowledge: true });
  await h.o.tick(); // A, message 1
  // Restart 30 s later (the campaign is still running in the database).
  advance(h, 30_000);
  let app = h.make();
  await app.tick();
  assert.equal(h.sent.length, 1, 'not before the minute is up');
  advance(h, 30_000);
  await app.tick();
  assert.deepEqual(h.sent.map((s) => s.phone), [A, A], 'A continues after the restart, not someone else');
  // Paused mid-sequence for 10 minutes: resuming finishes A first.
  app.pause();
  advance(h, 10 * MIN);
  assert.equal(app.resume().ok, true);
  await app.tick();
  assert.deepEqual(h.sent.map((s) => s.phone), [A, A, A]);
  const aDone = h.sent[2].at;
  // Restart, and also stop + start, between contacts: B still waits for the
  // full gap after A's last message.
  advance(h, 10 * MIN);
  app = h.make();
  await run(h, 30 * MIN, app);
  assert.equal(h.sent.length, 3);
  app.stop();
  assert.equal(app.start().ok, true);
  assert.ok(app.load().nextDueAt - aDone >= 45 * MIN, 'stop/start does not shorten the gap');
  await run(h, 30 * MIN, app);
  assert.deepEqual(h.sent.slice(3).map((s) => s.phone), [B, B, B]);
  assert.ok(h.sent[3].at - aDone >= 45 * MIN);
});

test('a crash during a send: never resent, and the next contact waits the full gap', async () => {
  const h = setup({ contacts: 2 });
  h.c.start({ acknowledge: true });
  h.transport.send = () => new Promise(() => {}); // the app dies while this is in flight
  h.o.tick();
  await new Promise((r) => setImmediate(r));
  const st = h.c.load();
  assert.equal(st.current, null);
  assert.equal(st.nextDueAt - h.clock.t, 52.5 * MIN, 'a full gap is reserved before the send');
  advance(h, 5 * MIN);
  h.transport.send = async (phone, text) => (h.sent.push({ phone, text, at: h.clock.t }), { id: 'X' });
  const app = h.make();
  app.init();
  app.dispose();
  assert.equal(app.contact('+923001000000').state, 'uncertain');
  await run(h, 60 * MIN, app);
  assert.deepEqual(h.sent.map((s) => s.phone), ['+923001000001', '+923001000001', '+923001000001'], 'the uncertain contact is skipped; B after the gap');
});

test('each stage is sent at most once, even with two schedulers or a lost update', async () => {
  const h = setup({ contacts: 1 });
  h.c.start({ acknowledge: true });
  const twin = h.make();
  await Promise.all([h.o.tick(), twin.tick(), h.o.tick()]);
  assert.equal(h.sent.length, 1);
  // The contact's progress was not saved (e.g. a crash after sending): the
  // stored reservation still prevents a second message 1.
  h.c.setContact('+923001000000', { stage: 0, state: 'queued', lastSentAt: null });
  await run(h, 2 * 60 * MIN);
  assert.equal(h.sent.filter((s) => s.text.startsWith('Assalam')).length, 1, 'message 1 never repeated');
  assert.equal(h.sent.length, new Set(h.sent.map((s) => s.text)).size);
  assert.equal(h.c.contact('+923001000000').stage, 3);
});

test('a reply pauses that contact; the next contact waits the full gap; an opt-out stops it for good', async () => {
  const h = setup({ contacts: 3 });
  const [A, B, C] = ['+923001000000', '+923001000001', '+923001000002'];
  h.c.start({ acknowledge: true });
  await h.o.tick(); // A, message 1
  const aLast = h.sent[0].at;
  h.o.onIncoming({ phone: A, text: 'Walaikum assalam, kaun?' });
  assert.equal(h.c.contact(A).state, 'replied');
  await run(h, 50 * MIN);
  assert.equal(h.sent.length, 1, 'no more messages to A, and B waits');
  while (h.sent.length < 2) await run(h, 30_000);
  assert.equal(h.sent[1].phone, B);
  assert.ok(h.sent[1].at - aLast >= 45 * MIN, 'B starts 45-60 minutes after A’s last message');
  // B opts out right after message 1: no more to B; C after the gap.
  h.o.onIncoming({ phone: B, text: 'Please do not message me again' });
  await run(h, 60 * MIN);
  assert.deepEqual(h.sent.map((s) => s.phone), [A, B, C, C, C].slice(0, h.sent.length));
  assert.equal(h.sent.filter((s) => s.phone === B).length, 1);
  assert.equal(h.c.contact(B).state, 'opted_out');
  assert.equal(h.c.include(B).ok, false, 'an opt-out cannot be resumed');
  const again = h.c.addLeads([{ phone: B, name: null }]);
  assert.equal(again.added, 0);
  assert.equal(again.skippedDetail.optedOut, 1, 'opted out: never added back');
  // The replied contact can be handed back to the campaign by the user.
  assert.equal(h.c.include(A).ok, true);
});

test('a reply that was not matched still stops the next message (safety net)', async () => {
  const h = setup({ contacts: 1 });
  let replied = false;
  const o = new Outreach({ ...h.o, store: h.o.store, state: h.o.state, transport: h.transport, details: h.o.details, clock: h.o.clock, random: h.o.random, tickMs: 1e9, hasReplied: () => replied });
  const oc = o.campaign(h.c.id);
  oc.start({ acknowledge: true });
  await o.tick();
  replied = true;
  await run(h, 2 * 60 * MIN, o);
  assert.equal(h.sent.length, 1);
  assert.equal(oc.contact('+923001000000').state, 'replied');
});

test('quiet hours in the recipient’s time zone', async () => {
  assert.equal(timeZoneOf('+923001234567'), 'Asia/Karachi');
  assert.equal(timeZoneOf('+971501234567'), 'Asia/Dubai');
  assert.equal(timeZoneOf('+15551234567'), null);
  assert.ok(inQuietHours(22, 21, 9) && inQuietHours(3, 21, 9) && !inQuietHours(12, 21, 9));
  const h = setup({ contacts: 1 });
  h.clock.t = Date.parse('2026-10-21T17:30:00Z'); // 22:30 in Pakistan
  h.c.start({ acknowledge: true });
  await h.o.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.c.snapshot().waiting, 'quiet_hours');
  h.clock.t = Date.parse('2026-10-22T04:00:00Z'); // 09:00 in Pakistan
  await h.o.tick();
  assert.equal(h.sent.length, 1);
});

test('disconnected: waits, nothing reserved; sends once after reconnecting', async () => {
  const h = setup({ contacts: 1, ready: false });
  h.c.start({ acknowledge: true });
  await run(h, 10 * MIN);
  assert.equal(h.sent.length, 0);
  assert.equal(h.c.snapshot().waiting, 'whatsapp');
  assert.equal(h.c.sends({ test: false }).length, 0);
  // Dropped between the check and the send: released, sent later once.
  h.transport.ok = true;
  h.transport.fail = Object.assign(new Error('WhatsApp is not connected.'), { code: 'not_connected' });
  await h.o.tick();
  assert.equal(h.c.sends({ test: false }).length, 0);
  h.transport.fail = null;
  await h.o.tick();
  assert.equal(h.sent.length, 1);
  await h.o.tick();
  assert.equal(h.sent.length, 1);
});

test('failures: timeouts are never retried; restrictions pause the campaign; repeated errors pause it', async () => {
  const h = setup({ contacts: 5 });
  h.c.start({ acknowledge: true });
  h.transport.fail = new Error('Sending timed out');
  await h.o.tick();
  assert.equal(h.c.contact('+923001000000').state, 'uncertain');
  assert.equal(h.c.sends({ test: false })[0].status, 'unknown');
  h.transport.fail = null;
  await run(h, 2 * 60 * MIN);
  assert.ok(!h.sent.some((s) => s.phone === '+923001000000'), 'an uncertain send is not repeated');

  const r = setup({ contacts: 2 });
  r.c.start({ acknowledge: true });
  r.transport.fail = Object.assign(new Error('rate-overlimit'), { data: { code: 463 } });
  await r.o.tick();
  assert.equal(r.c.load().status, 'paused');
  assert.equal(r.c.load().pauseReason, 'restricted');
  assert.ok(isRestriction(Object.assign(new Error('x'), { output: { statusCode: 403 } })));

  const e = setup({ contacts: 4 });
  e.c.start({ acknowledge: true });
  e.transport.fail = new Error('bad request');
  await run(e, 4 * 60 * MIN);
  assert.equal(e.c.load().status, 'paused');
  assert.equal(e.c.load().pauseReason, 'errors');
  // Three failed attempts in a row (a definite failure may be retried on
  // its own record, so attempts are counted, not records).
  assert.equal(e.c.contacts().reduce((n, c) => n + (c.attempts || 0), 0), 3);
  assert.ok(e.c.sends({ test: false }).every((s) => s.status === 'failed'));
});

test('interrupted sends are marked unknown and never resent', async () => {
  const h = setup({ contacts: 1 });
  const id = h.o.store.reserve({ campaignId: h.c.id, phone: '+923001000000', stage: 1, test: false, day: '2026-10-21', now: START - 10 * MIN });
  assert.ok(id);
  h.o.init();
  h.o.dispose();
  assert.equal(h.c.sends({ test: false })[0].status, 'unknown');
  assert.equal(h.c.contact('+923001000000').state, 'uncertain');
  h.c.start({ acknowledge: true });
  await run(h, 2 * 60 * MIN);
  assert.equal(h.sent.length, 0);
});

test('delivery receipts move forward only', async () => {
  const h = setup({ contacts: 1 });
  h.c.start({ acknowledge: true });
  await h.o.tick();
  h.o.onStatus('WA1', 'delivered');
  h.o.onStatus('WA1', 'read');
  h.o.onStatus('WA1', 'delivered');
  assert.equal(h.c.sends({ test: false })[0].status, 'read');
});

test('test mode sends nothing; switching to live forgets the simulation', async () => {
  const h = setup({ contacts: 2, test: true });
  assert.equal(h.c.start().ok, true, 'no acknowledgement needed to simulate');
  await run(h, 3 * 60 * MIN);
  assert.equal(h.sent.length, 0, 'nothing reaches WhatsApp');
  assert.ok(h.c.snapshot().sends.length >= 2);
  h.c.stop();
  h.c.exclude('+923001000001');
  assert.equal(h.c.configure({ test: false }).ok, true);
  assert.equal(h.c.snapshot().sends.length, 0);
  assert.ok(h.c.contacts().every((c) => c.stage === 0 && c.lastSentAt === null), 'no simulated progress left, excluded contacts included');
  assert.deepEqual(h.c.contacts().map((c) => c.state), ['queued', 'excluded'], 'the exclusion is kept');
});

test('settings are validated (45-60 minutes, 10-15 per day, quiet hours)', () => {
  const h = setup();
  assert.match(h.c.configure({ intervalMin: 30 }).error, /between 45 and 60 minutes/);
  assert.match(h.c.configure({ intervalMax: 90 }).error, /between 45 and 60 minutes/);
  assert.match(h.c.configure({ dailyCap: 20 }).error, /between 10 and 15/);
  assert.match(h.c.configure({ quietStart: 10, quietEnd: 8 }).error, /at least 4 sending hours/);
  assert.match(h.c.configure({ startDate: '2026-11-02', endDate: '2026-11-01' }).error, /end date is before the start date/);
  assert.match(h.c.configure({ startDate: '02/11/2026' }).error, /YYYY-MM-DD/);
  assert.equal(h.c.configure({ intervalMin: 50, intervalMax: 55, dailyCap: 15 }).ok, true);
  h.c.start({ acknowledge: true });
  assert.match(h.c.configure({ dailyCap: 12 }).error, /Pause the campaign/);
});

test('cap reached: new contacts wait until the next day, also after a restart', async () => {
  const h = setup({ contacts: 12 });
  h.c.configure({ dailyCap: 10 });
  const store = h.o.store;
  for (let i = 0; i < 10; i++) {
    const phone = `+92300100${String(i).padStart(4, '0')}`;
    for (let stage = 1; stage <= 3; stage++) {
      const id = store.reserve({ campaignId: h.c.id, phone, stage, test: false, day: '2026-10-21', now: START - 5 * 60 * MIN });
      store.markSent(id, `OLD${i}-${stage}`, START - 5 * 60 * MIN);
    }
    h.c.setContact(phone, { stage: 3, state: 'done', lastSentAt: START - 5 * 60 * MIN });
  }
  h.c.start({ acknowledge: true });
  await run(h, 6 * 60 * MIN); // until 16:00 PKT
  assert.equal(h.sent.length, 0);
  assert.equal(h.c.snapshot().waiting, 'daily_cap');
  assert.equal(h.c.snapshot().today.recipients, 10);
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
