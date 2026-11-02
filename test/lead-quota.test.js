'use strict';
// The daily lead allowance: a Monthly plan finds at most 100 unique new
// leads a day across every source together (Google Maps, Facebook,
// LinkedIn, Podcasts); the 101st is refused and not saved; duplicates and
// updates use nothing; other plans get their configured allowance; the day
// turns at midnight in the configured time zone.
const test = require('node:test');
const assert = require('node:assert/strict');
const { LeadStore } = require('../src/database/db');
const { LeadQuota, dayIn } = require('../src/main/lead-quota');

function setup({ plan = 'monthly', at = Date.UTC(2026, 10, 2, 6, 0) } = {}) {
  const store = new LeadStore(':memory:');
  const clock = { now: at, plan };
  const quota = new LeadQuota({ store, plan: () => clock.plan, now: () => clock.now, config: { timeZone: 'Asia/Karachi', dailyLeads: { monthly: 100, six_months: null, lifetime: null } } });
  const refused = [];
  store.setLeadGate(() => quota.gate(), (g) => refused.push(g));
  return { store, quota, clock, refused };
}

const maps = (i) => ({ placeKey: `maps-${i}`, mapsUrl: `https://www.google.com/maps/place/${i}`, name: `Shop ${i}`, keyword: 'k', phone: `+9230000${String(i).padStart(5, '0')}`, websiteStatus: 'no_website' });
const fb = (i) => ({ postUrl: `https://www.facebook.com/groups/1/posts/${i}`, name: `FB business ${i}`, phone: `+9231100${String(i).padStart(5, '0')}`, keyword: 'k' });
const podcast = (i) => ({ id: `pod${i}`, title: `Podcast ${i}`, appleUrl: `https://podcasts.apple.com/podcast/id${i}`, keyword: 'k' });
const person = (i) => ({ profileUrl: `https://www.linkedin.com/in/person-${i}`, name: `Person ${i}`, title: 'SEO', company: 'Acme', location: 'Lahore', keyword: 'k' });

test('Monthly: exactly 100 unique leads a day across all sources; the 101st is refused and not saved', () => {
  const { store, quota, refused } = setup();
  for (let i = 0; i < 40; i++) assert.ok(store.save(maps(i)).isNewLead);
  for (let i = 0; i < 30; i++) assert.ok(store.saveFacebookLead(fb(i)).isNewLead, `facebook ${i}`);
  for (let i = 0; i < 20; i++) assert.ok(store.savePersonLead(person(i)).isNewLead, `linkedin ${i}`);
  for (let i = 0; i < 10; i++) assert.ok(store.savePodcastLead(podcast(i)).isNewLead, `podcast ${i}`);
  assert.deepEqual({ used: quota.status().used, remaining: quota.status().remaining, reached: quota.status().reached }, { used: 100, remaining: 0, reached: true });
  const total = store.listLeads({}).length;
  // The 101st, from any source: refused, nothing saved.
  for (const r of [store.save(maps(100)), store.saveFacebookLead(fb(100)), store.savePodcastLead(podcast(100)), store.savePersonLead(person(100))]) {
    assert.deepEqual(r, { lead: null, isNewLead: false, limitReached: true });
  }
  assert.equal(store.listLeads({}).length, total);
  assert.equal(store.get('maps-100'), null);
  assert.equal(refused.length, 4);
  assert.match(quota.check().error, /You have reached your daily limit of 100 leads\. Upgrade your plan to find more leads\./);
  assert.equal(quota.check().subscription, 'limit');
});

test('duplicates and updates of existing leads use nothing; businesses that are not leads use nothing', () => {
  const { store, quota } = setup();
  store.save(maps(1));
  store.save({ ...maps(1), address: 'Lahore' }); // the same business again
  store.save({ placeKey: 'web', mapsUrl: 'https://www.google.com/maps/place/web', name: 'Has a site', keyword: 'k', phone: '+923001112233', websiteStatus: 'has_website' });
  store.savePodcastLead(podcast(1));
  store.savePodcastLead({ ...podcast(1), title: 'Podcast 1 (renamed)' });
  assert.equal(quota.status().used, 2);
});

test('the allowance is the same after a restart (stored), and is only reset by a new day in the configured time zone', () => {
  const { store, quota, clock } = setup({ at: Date.UTC(2026, 10, 2, 18, 30) }); // 23:30 in Karachi
  for (let i = 0; i < 100; i++) store.save(maps(i));
  assert.equal(store.save(maps(100)).limitReached, true);
  // Another LeadQuota on the same database (a restart): still used up.
  const again = new LeadQuota({ store, plan: () => 'monthly', now: () => clock.now, config: { timeZone: 'Asia/Karachi' } });
  assert.equal(again.status().reached, true);
  clock.now += 20 * 60_000; // 23:50: same day
  assert.equal(store.save(maps(101)).limitReached, true);
  clock.now += 15 * 60_000; // 00:05 the next day in Karachi (still 19:05 UTC)
  assert.equal(quota.day(), '2026-11-03');
  assert.equal(quota.status().used, 0);
  assert.equal(store.save(maps(101)).isNewLead, true);
  assert.equal(dayIn(Date.UTC(2026, 10, 2, 19, 5), 'UTC'), '2026-11-02');
});

test('upgraded plans get the allowance configured for them (6 Months and Lifetime: unlimited)', () => {
  for (const plan of ['six_months', 'lifetime']) {
    const { store, quota } = setup({ plan });
    for (let i = 0; i < 120; i++) assert.ok(store.save(maps(i)).isNewLead);
    assert.deepEqual({ limit: quota.status().limit, used: quota.status().used, ok: quota.check().ok }, { limit: null, used: 120, ok: true });
  }
  // A Monthly user who upgrades during the day can go on at once.
  const { store, clock } = setup();
  for (let i = 0; i < 100; i++) store.save(maps(i));
  assert.equal(store.save(maps(100)).limitReached, true);
  clock.plan = 'lifetime';
  assert.equal(store.save(maps(100)).isNewLead, true);
});
