'use strict';
// The Free Trial: starts by itself on a new computer (no payment, code or
// administrator), 5 days from that moment, 30 leads in total across every
// source, through the same mailer as the paid plans. Paid plans are unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Activation } = require('../src/main/activation');
const { LeadQuota } = require('../src/main/lead-quota');
const { LeadStore } = require('../src/database/db');

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-04T10:00:00Z');
const baseConfig = { secret: crypto.randomBytes(32).toString('base64'), adminEmail: 'admin@example.com', smtp: { host: '127.0.0.1', port: 2525, user: 'u', pass: 'p' }, trial: { days: 5, leads: 30 } };
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lf-trial-'));

// One start of the app on a computer: `home` outlives the app's data.
function app({ home = dir(), at = T0, store = new LeadStore(':memory:'), mail = { sent: [], fail: null }, config = baseConfig, machine = 'machine-a' } = {}) {
  const clock = { t: at };
  const mailer = {
    send: async (m) => {
      if (mail.fail) throw mail.fail;
      mail.sent.push(m);
    },
  };
  const act = new Activation({ store, config, mailer, mailError: () => 'failed', machineId: () => machine, clock: () => clock.t, trialFile: path.join(home, 'mark') });
  const quota = new LeadQuota({
    store,
    plan: () => {
      const st = act.status();
      if (st.state === 'active') return st.plan;
      return st.state === 'expired' && st.plan === 'free_trial' ? 'free_trial_ended' : null;
    },
    now: () => act.now(),
    config: { trialLeads: act.trialConfig?.leads },
  });
  store.setLeadGate(() => quota.gate(), () => {}, (g) => g.day === 'free_trial' && act.noteTrialUse(store.creditsOn('free_trial')));
  return { act, quota, store, clock, mail, home };
}
const lead = (i) => ({ placeKey: `k${i}`, mapsUrl: `https://www.google.com/maps/place/${i}`, name: `Shop ${i}`, keyword: 'k', phone: `+9230000${String(i).padStart(5, '0')}`, websiteStatus: 'no_website' });
const settle = () => new Promise((r) => setImmediate(r));

test('a new computer gets the Free Trial by itself: active at once, exactly 5 days, free', async () => {
  const a = app();
  assert.equal(a.act.status().state, 'none');
  assert.equal(a.act.startTrial(), true);
  const st = a.act.status();
  assert.equal(st.state, 'active');
  assert.equal(st.plan, 'free_trial');
  assert.equal(st.planName, 'Free Trial');
  assert.equal(st.trial, true);
  assert.equal(st.daysLeft, 5);
  assert.equal(Date.parse(st.expiresAt) - Date.parse(st.activatedAt), 5 * DAY);
  assert.ok(!st.plans.some((p) => p.id === 'free_trial'), 'not a plan to buy');
  // The administrator is told through the same mailer.
  await settle();
  assert.equal(a.mail.sent.length, 1);
  assert.equal(a.mail.sent[0].to, 'admin@example.com');
  assert.match(a.mail.sent[0].subject, new RegExp(`Free Trial started for ${a.act.activationId}`));
  assert.match(a.mail.sent[0].text, /Price: Free \(PKR 0\)[\s\S]*Leads allowed: 30/);
});

test('a failed email never holds the trial back; the notice is sent at a later start', async () => {
  const mail = { sent: [], fail: new Error('smtp down') };
  const a = app({ mail });
  a.act.startTrial();
  await settle();
  assert.equal(a.act.status().state, 'active');
  assert.equal(mail.sent.length, 0);
  mail.fail = null;
  const again = app({ home: a.home, store: a.store, mail });
  again.act.startTrial();
  await settle();
  assert.equal(mail.sent.length, 1, 'sent once, late');
  const third = app({ home: a.home, store: a.store, mail });
  third.act.startTrial();
  await settle();
  assert.equal(mail.sent.length, 1, 'not sent again');
});

test('30 leads in total: the 31st is refused and not saved; duplicates use nothing; a new day changes nothing', async () => {
  const a = app();
  a.act.startTrial();
  for (let i = 0; i < 20; i++) assert.ok(a.store.save(lead(i)).isNewLead);
  assert.equal(a.store.save(lead(3)).isNewLead, false, 'a duplicate');
  assert.equal(a.quota.status().used, 20);
  a.clock.t += DAY;
  assert.equal(a.quota.status().used, 20, 'the count does not reset');
  for (let i = 20; i < 30; i++) assert.ok(a.store.save(lead(i)).isNewLead);
  const st = a.quota.status();
  assert.deepEqual([st.used, st.remaining, st.reached, st.trial], [30, 0, true, true]);
  assert.deepEqual(a.store.save(lead(30)), { lead: null, isNewLead: false, limitReached: true });
  const c = a.quota.check();
  assert.equal(c.ok, false);
  assert.equal(c.error, 'You have used all 30 leads of your Free Trial. Upgrade your plan to find more leads.');
  await settle();
  assert.match(a.mail.sent.at(-1).subject, /leads used up/);
  assert.match(a.mail.sent.at(-1).text, /Leads used: 30 of 30/);
});

test('after 5 days the trial ends by itself and no lead can be saved', () => {
  const a = app();
  a.act.startTrial();
  a.clock.t += 5 * DAY - 1000;
  assert.equal(a.act.status().state, 'active');
  assert.ok(a.store.save(lead(1)).isNewLead);
  a.clock.t += 1000;
  assert.equal(a.act.status().state, 'expired');
  assert.equal(a.act.active, false);
  assert.equal(a.store.save(lead(2)).limitReached, true, 'a search still running can’t add leads');
  assert.equal(a.quota.check().error, 'Your Free Trial has ended. Upgrade your plan to find more leads.');
  assert.equal(a.act.startTrial(), false, 'no second trial');
});

test('reinstalling or clearing the app’s data brings the same trial back, not a new one', async () => {
  const a = app();
  a.act.startTrial();
  for (let i = 0; i < 12; i++) a.store.save(lead(i));
  const first = a.act.status();
  await settle();
  // A new database on the same computer, two days later.
  const b = app({ home: a.home, at: T0 + 2 * DAY, mail: a.mail });
  assert.equal(b.act.startTrial(), true);
  const st = b.act.status();
  assert.equal(st.expiresAt, first.expiresAt, 'the same end date');
  assert.equal(st.daysLeft, 3);
  assert.equal(b.quota.status().used, 12, 'the leads used are remembered');
  await settle();
  assert.equal(a.mail.sent.length, 1, 'no second "started" email');
  // After it ended: still ended.
  const c = app({ home: a.home, at: T0 + 9 * DAY });
  c.act.startTrial();
  assert.equal(c.act.status().state, 'expired');
});

test('an edited record gives no trial; another computer’s record does not count here', () => {
  const a = app();
  a.act.startTrial();
  const file = path.join(a.home, 'mark');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...rec, expiresAt: rec.expiresAt + 100 * DAY }));
  const b = app({ home: a.home });
  assert.equal(b.act.startTrial(), false);
  assert.equal(b.act.status().state, 'none');
});

test('paid plans are unchanged: no trial for them, and a paid plan replaces a running trial from today', async () => {
  // Already on a paid plan.
  const paid = app();
  await paid.act.request('monthly');
  await paid.act.verify(paid.mail.sent.at(-1).text.match(/\(OTP\): (\d{6})/)[1], 'monthly');
  assert.equal(paid.act.startTrial(), false);
  assert.equal(paid.act.status().plan, 'monthly');
  assert.equal(fs.existsSync(path.join(paid.home, 'mark')), false);
  // Upgrading during the trial: the same code flow; the trial's days are not added.
  const a = app();
  a.act.startTrial();
  for (let i = 0; i < 30; i++) a.store.save(lead(i));
  a.clock.t += 2 * DAY;
  await a.act.request('monthly');
  const r = await a.act.verify(a.mail.sent.filter((m) => /OTP/.test(m.text)).at(-1).text.match(/\(OTP\): (\d{6})/)[1], 'monthly');
  assert.equal(r.ok, true);
  assert.equal(r.expiresAt, '2026-12-06T10:00:00.000Z', 'a month from today');
  const q = a.quota.status();
  assert.deepEqual([q.trial, q.limit, q.used], [false, 100, 0], 'Monthly’s own daily allowance');
  assert.ok(a.store.save(lead(50)).isNewLead);
});

test('no Free Trial setting, or no secret: nothing starts', () => {
  assert.equal(app({ config: { ...baseConfig, trial: null } }).act.startTrial(), false);
  assert.equal(app({ config: { ...baseConfig, secret: '' } }).act.startTrial(), false);
});
