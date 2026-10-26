'use strict';
// Category campaigns: an ON/OFF switch per lead category that fills its own
// queue, sends the message sequence one lead at a time, marks leads Seen,
// keeps failed leads Unseen and retries them safely, and picks up new
// leads while on. Real (temporary) lead database, scripted WhatsApp.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LeadStore } = require('../src/database/db');
const { OutreachStore } = require('../src/database/wa-store');
const { Outreach, MAX_ATTEMPTS } = require('../src/whatsapp/outreach');

const MIN = 60_000;
const START = Date.parse('2026-10-21T05:00:00Z'); // 10:00 in Pakistan

function world({ file } = {}) {
  const dir = file ? path.dirname(file) : fs.mkdtempSync(path.join(os.tmpdir(), 'lf-catcamp-'));
  const db = new LeadStore(file || path.join(dir, 'leads.db'));
  const clock = { t: START };
  const sent = [];
  const transport = {
    failNext: 0,
    hang: false,
    ready: () => true,
    send: async (phone, text) => {
      if (transport.hang) return new Promise((resolve) => (transport.release = () => resolve({ id: `WA${sent.push({ phone, text, at: clock.t })}` })));
      if (transport.failNext > 0) {
        transport.failNext--;
        throw new Error('bad request');
      }
      sent.push({ phone, text, at: clock.t });
      return { id: `WA${sent.length}` };
    },
  };
  const make = () =>
    new Outreach({
      store: new OutreachStore(db.db),
      state: { get: (k) => db.getState(k), set: (k, v) => db.setState(k, v) },
      transport,
      details: (c) => ({ business: c.leadId ? db.leadById(c.leadId)?.name : null }),
      clock: () => clock.t,
      random: () => 0.5, // 60 s between a lead's messages, 52.5 min between leads
      tickMs: 1e9,
      leads: () => db.listLeads({}),
    });
  const o = make();
  const cats = { garments: db.ensureCategory('Garments'), restaurants: db.ensureCategory('Restaurants') };
  let n = 0;
  const lead = (name, phoneRaw, cat, wa = 'available') => {
    n++;
    db.save({ placeKey: `0x${n}:0xd`, mapsUrl: `https://www.google.com/maps/place/D${n}`, name, phoneRaw, address: 'Lahore, Pakistan', websiteStatus: 'no_website', categoryId: cat?.id ?? null });
    const phone = db.listLeads({}).find((l) => l.name === name).phone;
    if (wa) db.setWhatsAppResult(phone, wa, 'baileys', wa === 'failed' ? 'timeout' : undefined);
    return phone;
  };
  const run = async (ms, inst = o) => {
    const end = clock.t + ms;
    while (clock.t < end) {
      await inst.tick();
      clock.t += 30_000;
    }
  };
  const on = (cat, name, inst = o) => inst.setCategoryEnabled(String(cat.id), name, true, { acknowledge: true });
  const live = (id, inst = o) => assert.equal(inst.campaign(id).configure({ test: false, quietStart: 23, quietEnd: 6 }).ok, true);
  const seenPhones = () => db.listLeads({ campaign: 'seen' }).map((l) => l.phone).sort();
  return { db, o, make, clock, sent, transport, cats, lead, run, on, live, seenPhones, file: file || path.join(dir, 'leads.db') };
}

test('switch ON: the category’s verified, Unseen leads are queued automatically and messaged one by one', async () => {
  const w = world();
  const A = w.lead('Ali Garments', '03001110001', w.cats.garments);
  const B = w.lead('Bilal Garments', '03001110002', w.cats.garments);
  const U = w.lead('Unverified Garments', '03001110003', w.cats.garments, null);
  const X = w.lead('Xpress Garments', '03001110004', w.cats.garments, 'unavailable');
  const R = w.lead('Rehman Restaurant', '03001110005', w.cats.restaurants);
  // Switched on (still in test mode by default): set live first.
  const id = w.o.categoryCampaign(String(w.cats.garments.id), 'Garments');
  w.live(id);
  const r = w.on(w.cats.garments, 'Garments');
  assert.equal(r.ok, true);
  assert.deepEqual(w.o.campaign(id).contacts().map((c) => c.phone).sort(), [A, B].sort(), 'no manual selection; only verified Garments leads');
  await w.run(3 * MIN);
  assert.deepEqual(w.sent.map((s) => s.phone), [A, A, A]);
  assert.deepEqual(w.sent.map((s) => s.text), [
    'Assalam-o-Alaikum Ali bhai.',
    'Kaise hain aap? Umeed hai aap khairiyat se honge.',
    'Kya aap Ali Garments ke naam se real estate ka kaam karte hain, ya kisi aur business se related hain?',
  ]);
  // Seen / Unseen in the lead table.
  assert.deepEqual(w.seenPhones(), [A]);
  const unseen = w.db.listLeads({ campaign: 'unseen' }).map((l) => l.phone);
  assert.ok(unseen.includes(B) && unseen.includes(U) && unseen.includes(X) && unseen.includes(R) && !unseen.includes(A));
  assert.equal(w.db.listLeads({ campaign: 'seen', category: w.cats.garments.id }).length, 1);
  assert.equal(w.db.listLeads({ campaign: 'unseen', category: w.cats.restaurants.id }).length, 1);
  assert.equal(w.db.listLeads({ campaign: 'seen', search: 'ali gar' }).length, 1);
  assert.equal(w.db.listLeads({ search: '1110002' })[0].name, 'Bilal Garments');
  assert.equal(w.db.listLeads({}).find((l) => l.phone === A).campaignDelivery, 'sent');
  // Next lead after the gap; then Completed (still ON).
  await w.run(60 * MIN);
  assert.deepEqual(w.sent.slice(3).map((s) => s.phone), [B, B, B]);
  assert.ok(w.sent[3].at - w.sent[2].at >= 45 * MIN);
  await w.run(2 * 60 * MIN);
  const summary = w.o.overview().campaigns.find((c) => c.id === id);
  assert.equal(summary.status, 'running');
  assert.equal(summary.display, 'completed');
  assert.equal(w.sent.length, 6, 'unverified, unavailable and other categories are never messaged');
  const stats = w.o.overview().categories[String(w.cats.garments.id)];
  assert.deepEqual(stats, { leads: 4, seen: 2, unseenVerified: 0, unseenNotVerified: 2, optedOut: 0 });
});

test('new leads in an enabled category join the queue automatically once WhatsApp confirms them', async () => {
  const w = world();
  w.lead('Ali Garments', '03001110001', w.cats.garments);
  const id = w.o.categoryCampaign(String(w.cats.garments.id), 'Garments');
  w.live(id);
  w.on(w.cats.garments, 'Garments');
  await w.run(5 * MIN);
  assert.equal(w.sent.length, 3);
  // A new Garments lead is found, not yet checked on WhatsApp: not queued.
  const N = w.lead('New Garments', '03001110009', w.cats.garments, null);
  await w.run(5 * MIN);
  assert.ok(!w.o.campaign(id).contact(N));
  // The background check confirms it: picked up without any selection.
  w.db.setWhatsAppResult(N, 'available', 'baileys');
  await w.run(60 * MIN);
  assert.equal(w.o.campaign(id).contact(N).state !== undefined, true);
  assert.deepEqual(w.sent.slice(3).map((s) => s.phone), [N, N, N]);
  assert.ok(w.seenPhones().includes(N));
});

test('leads already contacted (Seen) are skipped; switching OFF stops; OFF and ON again never duplicates', async () => {
  const w = world();
  const A = w.lead('Ali Garments', '03001110001', w.cats.garments);
  const B = w.lead('Bilal Garments', '03001110002', w.cats.garments);
  const C = w.lead('Chaudhry Garments', '03001110003', w.cats.garments);
  // A was messaged earlier by another campaign: Seen, never queued again.
  const other = w.o.create('Earlier').id;
  w.live(other);
  w.o.campaign(other).addLeads([{ phone: A, name: null }]);
  w.o.campaign(other).start({ acknowledge: true });
  await w.run(3 * MIN);
  w.o.campaign(other).stop();
  assert.deepEqual(w.seenPhones(), [A]);
  const id = w.o.categoryCampaign(String(w.cats.garments.id), 'Garments');
  w.live(id);
  w.on(w.cats.garments, 'Garments');
  assert.deepEqual(w.o.campaign(id).contacts().map((c) => c.phone).sort(), [B, C].sort(), 'A (Seen) is skipped');
  await w.run(60 * MIN); // B's three messages
  const before = w.sent.length;
  // OFF: nothing more is scheduled, however long it stays off.
  assert.equal(w.o.setCategoryEnabled(String(w.cats.garments.id), 'Garments', false).ok, true);
  assert.equal(w.o.overview().campaigns.find((c) => c.id === id).display, 'off');
  await w.run(5 * 60 * MIN);
  assert.equal(w.sent.length, before);
  // ON again: continues with C only; A and B never get a second message.
  w.on(w.cats.garments, 'Garments');
  await w.run(4 * 60 * MIN);
  const counts = w.sent.reduce((m, s) => ((m[s.phone] = (m[s.phone] || 0) + 1), m), {});
  assert.deepEqual(counts, { [A]: 3, [B]: 3, [C]: 3 });
  assert.equal(w.sent.length, new Set(w.sent.map((s) => `${s.phone}|${s.text}`)).size, 'no message twice');
});

test('switching OFF while a message is being sent: it finishes and is recorded, and the campaign stays OFF', async () => {
  const w = world();
  const A = w.lead('Ali Garments', '03001110001', w.cats.garments);
  const id = w.o.categoryCampaign(String(w.cats.garments.id), 'Garments');
  w.live(id);
  w.on(w.cats.garments, 'Garments');
  w.transport.hang = true;
  const pending = w.o.tick(); // message 1 in flight
  await new Promise((r) => setImmediate(r));
  w.o.setCategoryEnabled(String(w.cats.garments.id), 'Garments', false);
  w.transport.hang = false;
  w.transport.release();
  await pending;
  assert.equal(w.o.load(id).status, 'stopped', 'the finished send does not switch it back on');
  assert.deepEqual(w.seenPhones(), [A], 'the message that went out is recorded');
  await w.run(60 * MIN);
  assert.equal(w.sent.length, 1);
  // Back ON: the lead's sequence continues (message 2), message 1 is not repeated.
  w.on(w.cats.garments, 'Garments');
  await w.run(3 * MIN);
  assert.deepEqual(w.sent.map((s) => s.text.slice(0, 12)), ['Assalam-o-Al', 'Kaise hain a', 'Kya aap Ali ']);
});

test('restarts keep the campaign ON and its progress; nothing is sent twice', async () => {
  const w = world();
  const A = w.lead('Ali Garments', '03001110001', w.cats.garments);
  const B = w.lead('Bilal Garments', '03001110002', w.cats.garments);
  const id = w.o.categoryCampaign(String(w.cats.garments.id), 'Garments');
  w.live(id);
  w.on(w.cats.garments, 'Garments');
  await w.o.tick(); // A, message 1
  // The app restarts.
  const app = w.make();
  app.init();
  app.dispose();
  await w.run(90 * MIN, app);
  const counts = w.sent.reduce((m, s) => ((m[s.phone] = (m[s.phone] || 0) + 1), m), {});
  assert.deepEqual(counts, { [A]: 3, [B]: 3 });
  assert.equal(app.load(id).status, 'running');
});

test('failed sends keep the lead Unseen and are retried safely: after 1 h, then 6 h, at most 3 attempts', async () => {
  const w = world();
  const A = w.lead('Ali Garments', '03001110001', w.cats.garments);
  const id = w.o.categoryCampaign(String(w.cats.garments.id), 'Garments');
  w.live(id);
  w.on(w.cats.garments, 'Garments');
  w.transport.failNext = 1;
  await w.o.tick();
  let c = w.o.campaign(id).contact(A);
  assert.equal(c.state, 'failed');
  assert.equal(c.attempts, 1);
  assert.equal(c.retryAt - w.clock.t, 60 * MIN);
  assert.deepEqual(w.seenPhones(), [], 'a failed lead stays Unseen');
  assert.equal(w.o.store.wasContacted(A), false);
  await w.run(64 * MIN);
  assert.equal(w.sent.length, 3, 'retried after an hour, then the sequence went on');
  assert.ok(w.sent[0].at - c.retryAt >= 0, 'not before the retry time');
  assert.deepEqual(w.seenPhones(), [A]);
  assert.equal(w.o.campaign(id).sends({ test: false }).filter((s) => s.stage === 1).length, 1, 'the retry reused its record: one message 1');
  // Repeated failures stop after three attempts (no endless retries).
  const B = w.lead('Bilal Garments', '03001110002', w.cats.garments);
  w.o.syncQueue(id, w.clock.t, true);
  w.transport.failNext = 10;
  await w.run(10 * 60 * MIN);
  c = w.o.campaign(id).contact(B);
  assert.equal(c.attempts, MAX_ATTEMPTS);
  assert.equal(c.retryAt, null);
  assert.match(c.note, /use Retry/);
  assert.ok(!w.seenPhones().includes(B));
});

test('two categories ON: one lead at a time, 45+ minutes between leads across both', async () => {
  const w = world();
  const g = [w.lead('Ali Garments', '03001110001', w.cats.garments), w.lead('Bilal Garments', '03001110002', w.cats.garments)];
  const r = [w.lead('Rehman Restaurant', '03001110005', w.cats.restaurants), w.lead('Saad Restaurant', '03001110006', w.cats.restaurants)];
  for (const [cat, name] of [[w.cats.garments, 'Garments'], [w.cats.restaurants, 'Restaurants']]) {
    const id = w.o.categoryCampaign(String(cat.id), name);
    w.live(id);
    assert.equal(w.on(cat, name).ok, true);
  }
  await w.run(5 * 60 * MIN);
  const runs = [];
  for (const s of w.sent) {
    if (runs.length && runs.at(-1).phone === s.phone) runs.at(-1).list.push(s);
    else runs.push({ phone: s.phone, list: [s] });
  }
  assert.deepEqual(runs.map((x) => x.list.length), [3, 3, 3, 3], 'each lead’s three messages together');
  assert.deepEqual(new Set(runs.map((x) => x.phone)), new Set([...g, ...r]));
  for (let i = 1; i < runs.length; i++) assert.ok(runs[i].list[0].at - runs[i - 1].list[2].at >= 45 * MIN, 'shared gap between leads');
});

test('uncategorized leads have their own switch; statuses OFF / Running / Paused / Completed', async () => {
  const w = world();
  const N = w.lead('Nameless Shop', '03001110007', null);
  const r = w.o.setCategoryEnabled('none', 'Uncategorized', true, { acknowledge: true }); // test mode by default
  assert.equal(r.ok, true);
  const view = () => w.o.overview().campaigns.find((c) => c.id === r.id);
  assert.deepEqual(w.o.campaign(r.id).contacts().map((c) => c.phone), [N]);
  assert.equal(view().display, 'running');
  assert.equal(view().test, true);
  await w.run(5 * MIN);
  assert.equal(w.sent.length, 0, 'test run: nothing reaches WhatsApp');
  assert.equal(view().display, 'completed');
  assert.deepEqual(w.seenPhones(), [], 'simulated sends do not make a lead Seen');
  w.o.campaign(r.id).pause('restricted');
  assert.equal(view().display, 'paused');
  w.o.setCategoryEnabled('none', 'Uncategorized', false);
  assert.equal(view().display, 'off');
  assert.equal(w.o.categoryCampaign('none', 'Uncategorized'), r.id, 'one campaign per category');
});
