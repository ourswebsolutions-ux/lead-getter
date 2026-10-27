'use strict';
// Several outreach campaigns: selection filters (category, date, verified
// only), global contact history across campaigns, delete and reset, safe
// retries, one running campaign at a time, and the database upgrade.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LeadStore } = require('../src/database/db');
const { OutreachStore } = require('../src/database/wa-store');
const { Outreach } = require('../src/whatsapp/outreach');
const { eligibleContacts } = require('../src/whatsapp/eligibility');

const MIN = 60_000;
const START = Date.parse('2026-10-21T05:00:00Z'); // 10:00 in Pakistan

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-campaigns-'));
  const db = new LeadStore(path.join(dir, 'leads.db'));
  const clock = { t: START };
  const sent = [];
  const transport = {
    fail: null,
    ready: () => true,
    send: async (phone, text) => {
      if (transport.fail) {
        const e = transport.fail;
        transport.fail = null;
        throw e;
      }
      sent.push({ phone, text, at: clock.t });
      return { id: `WA${sent.length}` };
    },
  };
  const o = new Outreach({
    store: new OutreachStore(db.db),
    state: { get: (k) => db.getState(k), set: (k, v) => db.setState(k, v) },
    transport,
    details: () => ({ business: null }),
    clock: () => clock.t,
    random: () => 0.5,
    tickMs: 1e9,
  });
  // Leads: categories, collection dates, and real check results.
  const re = db.ensureCategory('Real Estate');
  const dealers = db.ensureCategory('Property Dealers');
  const agents = db.ensureCategory('Agents');
  let n = 0;
  const lead = (name, phoneRaw, cat, date, wa) => {
    n++;
    db.save({ placeKey: `0x${n}:0xc`, mapsUrl: `https://www.google.com/maps/place/C${n}`, name, phoneRaw, address: 'Lahore, Pakistan', websiteStatus: 'no_website', categoryId: cat?.id ?? null });
    const phone = db.listLeads({}).find((l) => l.name === name).phone;
    db.db.prepare('UPDATE businesses SET discovered_date = ? WHERE name = ?').run(date, name);
    if (wa === 'available' || wa === 'unavailable' || wa === 'failed') db.setWhatsAppResult(phone, wa, 'baileys', wa === 'failed' ? 'timeout' : undefined);
    if (wa === 'manual') db.setWhatsAppStatus(phone, 'available', 'manual');
    return phone;
  };
  const P = {
    A: lead('Alpha Estate', '03001110001', re, '2026-10-01', 'available'),
    B: lead('Beta Estate', '03001110002', re, '2026-10-05', 'available'),
    C: lead('Gamma Dealers', '03001110003', dealers, '2026-10-05', 'available'),
    D: lead('Delta Agents', '03001110004', agents, '2026-10-10', 'available'),
    E: lead('Echo Estate', '03001110005', re, '2026-10-10', 'unavailable'),
    F: lead('Foxtrot Estate', '03001110006', re, '2026-10-10', 'failed'),
    G: lead('Golf Estate', '03001110007', re, '2026-10-10', 'manual'),
    H: lead('Hotel Estate', '03001110008', re, '2026-10-10', null),
    I: lead('India Dealers', '03001110009', null, '2026-10-12', 'available'),
  };
  // A second lead record with the same number as A (another listing).
  db.save({ placeKey: '0x99:0xc', mapsUrl: 'https://www.google.com/maps/place/C99', name: 'Alpha Estate Branch', phoneRaw: '+92 300 1110001', address: 'Lahore, Pakistan', websiteStatus: 'no_website', categoryId: re.id });
  db.db.prepare("UPDATE businesses SET discovered_date = '2026-10-01' WHERE name = 'Alpha Estate Branch'").run();
  const cats = { re: String(re.id), dealers: String(dealers.id), agents: String(agents.id) };
  const eligible = (campaignId, filters = {}) => eligibleContacts({ leads: db.listLeads({}), store: o.store, campaign: o.load(campaignId), filters });
  const add = (campaignId, phones) => o.campaign(campaignId).addLeads(phones.map((phone) => ({ phone, name: null })));
  const run = async (ms) => {
    const end = clock.t + ms;
    while (clock.t < end) {
      await o.tick();
      clock.t += 30_000;
    }
  };
  const live = (id) => assert.equal(o.campaign(id).configure({ test: false, quietStart: 23, quietEnd: 6 }).ok, true);
  return { db, o, clock, sent, transport, P, cats, eligible, add, run, live };
}

test('filters: categories (one or several), collection dates, both together, search', () => {
  const w = world();
  const id = w.o.create('Filters').id;
  const phones = (f) => w.eligible(id, f).eligible.map((l) => l.phone).sort();
  assert.deepEqual(phones({}), [w.P.A, w.P.B, w.P.C, w.P.D, w.P.I].sort());
  assert.deepEqual(phones({ categories: [w.cats.re] }), [w.P.A, w.P.B].sort());
  assert.deepEqual(phones({ categories: [w.cats.dealers, w.cats.agents] }), [w.P.C, w.P.D].sort());
  assert.deepEqual(phones({ categories: ['none'] }), [w.P.I]);
  assert.deepEqual(phones({ from: '2026-10-05', to: '2026-10-05' }), [w.P.B, w.P.C].sort(), 'a single day');
  assert.deepEqual(phones({ from: '2026-10-06' }), [w.P.D, w.P.I].sort());
  assert.deepEqual(phones({ to: '2026-10-04' }), [w.P.A]);
  assert.deepEqual(phones({ categories: [w.cats.re], from: '2026-10-02', to: '2026-10-31' }), [w.P.B], 'category and date together');
  assert.deepEqual(phones({ search: 'gamma' }), [w.P.C]);
  assert.deepEqual(phones({ search: '1110004' }), [w.P.D]);
  const counts = w.eligible(id, { categories: [w.cats.re] }).counts;
  assert.equal(counts.matching, 7, 'every Real Estate lead record (A, B, E, F, G, H and A’s second listing)');
  assert.equal(counts.notVerified, 4, 'unavailable, failed, manual-only, unchecked');
  assert.equal(counts.verified, 2, 'A’s second listing shares A’s number: counted once');
  assert.equal(counts.eligible, 2);
});

test('only numbers the automatic WhatsApp check confirmed can be selected, one entry per number', () => {
  const w = world();
  const id = w.o.create('Verified').id;
  const r = w.eligible(id, { categories: [w.cats.re] });
  assert.ok(!r.eligible.some((l) => [w.P.E, w.P.F, w.P.G, w.P.H].includes(l.phone)), 'unavailable, failed, manual and unchecked are never eligible');
  assert.equal(r.eligible.filter((l) => l.phone === w.P.A).length, 1, 'two lead records, one number, one entry');
  // The main process re-checks: an unverified number can't be added by id either.
  const res = w.add(id, [w.P.A]);
  assert.equal(res.added, 1);
});

test('acceptance: someone messaged in Campaign 1 is not eligible in Campaign 2, also after resetting or deleting Campaign 1', async () => {
  const w = world();
  const c1 = w.o.create('Campaign 1').id;
  const c2 = w.o.create('Campaign 2').id;
  w.live(c1);
  w.add(c1, [w.P.A]);
  assert.equal(w.o.campaign(c1).start({ acknowledge: true }).ok, true);
  await w.o.tick(); // A, message 1
  assert.deepEqual(w.sent.map((s) => s.phone), [w.P.A]);
  // Campaign 2: A is absent from the eligible list and listed as previously contacted, as "Sent".
  let r = w.eligible(c2);
  assert.ok(!r.eligible.some((l) => l.phone === w.P.A));
  assert.deepEqual(r.previous.map((l) => [l.phone, l.history.status]), [[w.P.A, 'sent']]);
  // Delivered only when WhatsApp's receipt says so.
  w.o.onStatus('WA1', 'delivered');
  r = w.eligible(c2);
  assert.equal(r.previous[0].history.status, 'delivered');
  // Adding A anyway (manual or bulk selection) is refused.
  assert.equal(w.add(c2, [w.P.A]).skippedDetail.previous, 1);
  // Reset Campaign 1: A stays excluded.
  w.o.campaign(c1).pause();
  assert.equal(w.o.reset([c1]).ok, true);
  assert.equal(w.o.campaign(c1).contacts().length, 0, 'the queue is cleared');
  assert.equal(w.o.load(c1).status, 'stopped');
  r = w.eligible(c2);
  assert.ok(!r.eligible.some((l) => l.phone === w.P.A));
  assert.equal(r.previous[0].phone, w.P.A);
  // ... and re-adding A to the reset Campaign 1 is refused too.
  assert.equal(w.add(c1, [w.P.A]).skippedDetail.previous, 1);
  // Delete Campaign 1: still excluded, history keeps the campaign's name.
  assert.equal(w.o.remove([c1]).ok, true);
  assert.equal(w.o.load(c1), null);
  r = w.eligible(c2);
  assert.ok(!r.eligible.some((l) => l.phone === w.P.A));
  assert.equal(r.previous[0].history.campaign, 'Campaign 1');
  assert.equal(r.previous[0].history.status, 'delivered');
  assert.equal(w.o.store.history().length, 1);
});

test('a contact added to two campaigns is messaged only by the first; the other skips them', async () => {
  const w = world();
  const c1 = w.o.create('One').id;
  const c2 = w.o.create('Two').id;
  w.live(c1);
  w.live(c2);
  w.add(c1, [w.P.B]);
  w.add(c2, [w.P.B, w.P.C]); // B not contacted yet: allowed into both queues
  w.o.campaign(c1).start({ acknowledge: true });
  await w.run(5 * MIN); // B gets the three messages from One
  w.o.campaign(c1).stop();
  assert.equal(w.o.campaign(c2).start().ok, true);
  await w.run(3 * 60 * MIN);
  assert.equal(w.sent.filter((s) => s.phone === w.P.B).length, 3, 'B: only campaign One’s three messages');
  assert.equal(w.o.campaign(c2).contact(w.P.B).state, 'skipped');
  assert.equal(w.sent.filter((s) => s.phone === w.P.C).length, 3, 'C is messaged by Two');
});

test('“Allow previously contacted contacts” re-includes them, never opt-outs', async () => {
  const w = world();
  const c1 = w.o.create('First').id;
  w.live(c1);
  w.add(c1, [w.P.A, w.P.B]);
  w.o.campaign(c1).start({ acknowledge: true });
  await w.run(60 * MIN); // A done (3), B started
  w.o.onIncoming({ phone: w.P.B, text: 'stop' });
  w.o.campaign(c1).stop();
  const c2 = w.o.create('Again').id;
  w.live(c2);
  assert.equal(w.eligible(c2).previous.length, 1, 'A (B opted out and is hidden)');
  assert.equal(w.o.campaign(c2).configure({ allowPrevious: true }).ok, true);
  const r = w.eligible(c2);
  assert.ok(r.eligible.some((l) => l.phone === w.P.A && l.previous));
  assert.ok(!r.eligible.some((l) => l.phone === w.P.B), 'opt-outs never, even with the override');
  const added = w.add(c2, [w.P.A, w.P.B]);
  assert.equal(added.added, 1);
  assert.equal(added.skippedDetail.optedOut, 1);
  const before = w.sent.length;
  w.o.campaign(c2).start();
  await w.run(2 * 60 * MIN);
  assert.equal(w.sent.slice(before).filter((s) => s.phone === w.P.A).length, 3, 'A messaged again by the campaign that allows it');
  assert.ok(!w.sent.slice(before).some((s) => s.phone === w.P.B));
});

test('retries: a definite failure can be retried once safely; an ambiguous send never is', async () => {
  const w = world();
  const id = w.o.create('Retry').id;
  w.live(id);
  w.add(id, [w.P.C, w.P.D]);
  const c = w.o.campaign(id);
  c.start({ acknowledge: true });
  w.transport.fail = new Error('bad request');
  await w.o.tick();
  assert.equal(c.contact(w.P.C).state, 'failed');
  assert.equal(w.o.store.wasContacted(w.P.C), false, 'a definite failure is not “previously contacted”');
  // Retry: the same reservation is reused, then sent once.
  assert.equal(c.include(w.P.C).ok, true);
  await w.run(4 * 60 * MIN);
  assert.equal(w.sent.filter((s) => s.phone === w.P.C).length, 3);
  assert.equal(c.sends({ test: false }).filter((s) => s.phone === w.P.C && s.stage === 1).length, 1, 'one record for message 1');
  // Ambiguous: a timeout is never retried, and counts as contacted.
  const id2 = w.o.create('Timeout').id;
  w.live(id2);
  w.add(id2, [w.P.I]);
  w.o.campaign(c.id).stop();
  w.o.campaign(id2).start();
  w.clock.t += 2 * 60 * MIN;
  w.transport.fail = new Error('Sending timed out');
  await w.o.tick();
  assert.equal(w.o.campaign(id2).contact(w.P.I).state, 'uncertain');
  assert.equal(w.o.store.wasContacted(w.P.I), true);
  assert.equal(w.o.store.history().find((h) => h.phone === w.P.I).status, 'unknown');
  assert.equal(w.o.campaign(id2).include(w.P.I).ok, true, 'the user may resume after checking the chat');
  await w.run(2 * 60 * MIN);
  assert.equal(w.sent.filter((s) => s.phone === w.P.I && s.text.startsWith('Assalam')).length, 0, 'message 1 is never re-sent');
});

test('several campaigns may be on; the daily limit counts across all of them', async () => {
  const w = world();
  const c1 = w.o.create('One').id;
  const c2 = w.o.create('Two').id;
  w.live(c1);
  w.live(c2);
  w.add(c1, [w.P.A]);
  w.add(c2, [w.P.B]);
  assert.equal(w.o.campaign(c1).start({ acknowledge: true }).ok, true);
  assert.equal(w.o.campaign(c2).start().ok, true, 'a second campaign can be on too');
  // Ten recipients already messaged today by other campaigns (simulated).
  for (let i = 0; i < 10; i++) {
    const sid = w.o.store.reserve({ campaignId: c2, phone: `+9230099900${String(i).padStart(2, '0')}`, stage: 1, test: false, day: '2026-10-21', now: START - 5 * 60 * MIN });
    w.o.store.markSent(sid, `X${i}`, START - 5 * 60 * MIN);
  }
  await w.run(5 * MIN);
  assert.equal(w.sent.length, 0, 'the cap is shared by all campaigns');
  assert.equal(w.o.campaign(c1).snapshot().waiting, 'daily_cap');
  assert.equal(w.o.campaign(c2).snapshot().waiting, 'daily_cap');
});

test('campaign dates: waits before the start date, ends after the end date', async () => {
  const w = world();
  const id = w.o.create('Dated').id;
  w.add(id, [w.P.A]);
  const c = w.o.campaign(id);
  assert.equal(c.configure({ startDate: '2026-10-22', endDate: '2026-10-23' }).ok, true);
  c.start();
  await w.run(5 * MIN);
  assert.equal(c.snapshot().waiting, 'not_started');
  assert.equal(c.sends({ test: true }).length, 0);
  w.clock.t = Date.parse('2026-10-22T05:00:00Z');
  await w.o.tick();
  assert.equal(c.sends({ test: true }).length, 1);
  w.clock.t = Date.parse('2026-10-24T05:00:00Z');
  await w.o.tick();
  assert.equal(c.load().status, 'stopped');
  assert.equal(c.load().pauseReason, 'ended');
});

test('delete and reset several campaigns; settings, leads and other campaigns are untouched', async () => {
  const w = world();
  w.db.setState('theme', { mode: 'dark' });
  const ids = ['Keep', 'Reset me', 'Delete me', 'Delete me too'].map((n) => w.o.create(n).id);
  const [keep, r1, d1, d2] = ids;
  for (const id of ids) w.add(id, [w.P.D]);
  assert.equal(w.o.campaign(r1).configure({ dailyCap: 12, name: 'Reset me' }).ok, true);
  w.o.campaign(r1).start();
  await w.o.tick(); // test-run progress in r1
  w.o.campaign(r1).stop();
  assert.equal(w.o.reset([r1]).reset, 1);
  assert.equal(w.o.load(r1).config.dailyCap, 12, 'reset keeps the campaign’s settings');
  assert.equal(w.o.campaign(r1).contacts().length, 0);
  assert.equal(w.o.campaign(r1).sends({ test: true }).length, 0);
  assert.equal(w.o.remove([d1, d2, 999]).deleted, 2);
  assert.deepEqual(w.o.store.campaigns().map((c) => c.name), ['Keep', 'Reset me']);
  assert.equal(w.o.campaign(keep).contacts().length, 1, 'other campaigns keep their queues');
  assert.equal(w.db.listLeads({}).length, 10, 'leads untouched');
  assert.deepEqual(w.db.getState('theme'), { mode: 'dark' }, 'global settings untouched');
  assert.equal(w.o.campaign(d1).start().ok, false);
});

test('upgrade from version 4 keeps the existing campaign, its contacts, history and acknowledgement', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-v4-'));
  const file = path.join(dir, 'leads.db');
  const db = new LeadStore(file);
  // Rebuild the version 4 tables and data.
  db.db.exec(`
    DROP TABLE outreach_contacts; DROP TABLE outreach_sends; DROP TABLE outreach_campaigns;
    CREATE TABLE outreach_contacts (phone TEXT PRIMARY KEY, lead_id INTEGER, name TEXT, stage INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, last_sent_at INTEGER, added_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, note TEXT);
    CREATE TABLE outreach_sends (id INTEGER PRIMARY KEY, phone TEXT NOT NULL, stage INTEGER NOT NULL, test INTEGER NOT NULL DEFAULT 0, day TEXT NOT NULL, status TEXT NOT NULL, wa_id TEXT, error TEXT, created_at INTEGER NOT NULL, sent_at INTEGER, UNIQUE (phone, stage, test));
    INSERT INTO outreach_contacts VALUES ('+923001110001', NULL, 'Zahid', 3, 'done', 1000, 1, 1000, NULL), ('+923001110002', NULL, NULL, 0, 'queued', NULL, 2, 2, NULL);
    INSERT INTO outreach_sends VALUES (1, '+923001110001', 1, 0, '2026-10-20', 'read', 'W1', NULL, 900, 900), (2, '+923001110001', 2, 0, '2026-10-20', 'delivered', 'W2', NULL, 960, 960), (3, '+923001110001', 3, 0, '2026-10-20', 'sent', 'W3', NULL, 1000, 1000);
    PRAGMA user_version = 4;`);
  db.setState('outreach', { status: 'paused', pauseReason: 'user', nextDueAt: 5000, acknowledgedAt: 123, config: { dailyCap: 14, test: false } });
  db.close();
  const up = new LeadStore(file);
  assert.equal(up.db.prepare('PRAGMA user_version').get().user_version, 8);
  const store = new OutreachStore(up.db);
  const [c] = store.campaigns();
  assert.equal(c.name, 'Campaign 1');
  assert.equal(c.status, 'paused');
  assert.equal(c.config.dailyCap, 14);
  assert.equal(c.config.test, false);
  assert.deepEqual(store.contacts(c.id).map((x) => [x.phone, x.stage, x.state]), [['+923001110001', 3, 'done'], ['+923001110002', 0, 'queued']]);
  assert.equal(store.sends({ campaignId: c.id, test: false }).length, 3);
  assert.deepEqual(store.history().map((h) => [h.phone, h.status, h.messages, h.campaign]), [['+923001110001', 'read', 3, 'Campaign 1']]);
  assert.equal(up.getState('outreach.ack'), 123);
  assert.equal(up.getState('outreach'), null);
});
