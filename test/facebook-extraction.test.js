'use strict';
// Regression tests for "4 posts read, 0 valid numbers, 0 new leads": local
// numbers were read with the computer's language region (en-US -> US) and
// rejected, "0092" and some layouts weren't recognised, and posts whose own
// link Facebook hides until hovered were skipped before their numbers were
// read. Numbers in every common format, false positives, several numbers
// per post, duplicates across posts and sources, the counters and the end
// of the results, end to end in a throwaway headless Chrome.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { findPhones, resolvePhoneCountry } = require('../src/database/phone');
const { findChromeExecutable } = require('../src/browser/chrome');
const { LeadStore } = require('../src/database/db');
const { FacebookSession } = require('../src/browser/facebook-session');

const valid = (text, country) => findPhones(text, { country }).phones.filter((p) => p.status === 'valid').map((p) => p.phone);
const all = (text, country) => findPhones(text, { country }).phones.map((p) => `${p.status === 'valid' ? '' : '?'}${p.phone}`);

test('Pakistani numbers starting with 03, in every common layout', () => {
  for (const s of ['03001234567', '0300-1234567', '0300 1234567', '0300.1234567', '0300 123 4567', '(0300) 1234567', '۰۳۰۰۱۲۳۴۵۶۷']) {
    assert.deepEqual(valid(`Garments shop, call ${s} now`, 'PK'), ['+923001234567'], s);
  }
  assert.deepEqual(valid('Landline 042-35761234', 'PK'), ['+924235761234']);
});

test('international numbers with + and 00, spaces, brackets and hyphens', () => {
  const cases = {
    '+92 300 1234567': '+923001234567',
    '0092 300 1234567': '+923001234567',
    '+1 (212) 555-0123': '+12125550123',
    '+44 20 7946 0958': '+442079460958',
    '+971 50 123 4567': '+971501234567',
    '00971-50-1234567': '+971501234567',
  };
  for (const [s, e164] of Object.entries(cases)) {
    for (const country of ['PK', 'US', null]) assert.deepEqual(valid(`Call ${s}`, country), [e164], `${s} with ${country}`);
  }
  // Possible but not a valid number for its code (UK drama range): kept to check.
  assert.deepEqual(all('Call +44 7700 900123', 'PK'), ['?+44 7700 900123']);
});

test('the original bug: without the right country, local numbers are kept to check, never dropped', () => {
  const post = 'Garments shop Lahore. Call 0300-1234567 for wholesale rates.';
  // en-US computer, no leads yet: was "0 valid numbers" and nothing saved.
  assert.deepEqual(all(post, 'US'), ['?0300-1234567']);
  assert.deepEqual(all(post, null), ['?0300-1234567']);
  assert.deepEqual(all(post, 'PK'), ['+923001234567']);
  // The country used by default: the setting, the leads, the time zone, then the region.
  assert.equal(resolvePhoneCountry({ timeZone: 'Asia/Karachi', locale: 'US' }), 'PK');
  assert.equal(resolvePhoneCountry({ setting: 'AE', common: 'PK', timeZone: 'Asia/Karachi' }), 'AE');
  assert.equal(resolvePhoneCountry({ common: 'PK', locale: 'US' }), 'PK');
  assert.equal(resolvePhoneCountry({ timeZone: 'Etc/UTC', locale: 'GB' }), 'GB');
  assert.equal(resolvePhoneCountry({}), null);
});

test('several numbers in one post; none in a post; dates, prices, counts and ids are not numbers', () => {
  assert.deepEqual(valid('Ladies suits 03211234567 / 0333 7654321, office 042 35761234', 'PK'), ['+923211234567', '+923337654321', '+924235761234']);
  assert.deepEqual(all('Looking for a good garments shop near Liberty, any suggestions?', 'PK'), []);
  const noise = 'Sale ends 12/05/2024 (2024-05-01), price Rs 25000, PKR 1500000, 1.2k views, 350 likes, order #123456789, post id 1234567890123456789, CNIC 35202-1234567-1, call 10:30';
  const r = findPhones(noise, { country: 'PK' });
  assert.deepEqual(r.phones, []);
  assert.ok(r.stats.rejected >= 3);
  // Digits from different lines are never joined into one number.
  assert.deepEqual(all('Shop 12\n345 6789', 'PK'), []);
});

const exe = findChromeExecutable();
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'facebook-hidden-links.html'), 'utf8');

async function run(t, { country, store = new LeadStore(':memory:') }) {
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await context.addCookies([{ name: 'c_user', value: '1', domain: '.facebook.com', path: '/', secure: true }]);
  const page = await context.newPage();
  await page.route('https://www.facebook.com/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture }));
  const diag = [];
  const session = new FacebookSession({
    keyword: 'garments shop',
    country,
    store,
    pages: { facebook: async () => page },
    signal: new AbortController().signal,
    pacing: { fbScroll: [50, 50], fbLoad: 4000, fbStallRetries: 2, fbStallWait: [100, 100], netRetries: [1] },
    diagnose: (d) => diag.push(d),
    emit: () => {},
  });
  const outcome = await session.run();
  return { outcome, stats: session.stats.facebook, store, diag };
}

test('Facebook search with hidden post links: every number is saved and listed (country PK)', { skip: !exe && 'Google Chrome not installed' }, async (t) => {
  const { outcome, stats, store, diag } = await run(t, { country: 'PK' });
  assert.equal(outcome.state, 'done', outcome.message);
  const phones = store.listLeads().map((l) => l.phone).sort();
  assert.deepEqual(phones, ['+12125550123', '+442079460958', '+923001234567', '+923007654321', '+923211234567', '+923337654321', '+924235761234', '+971501234567']);
  // Same number in two posts (101, 105): one lead, the second post counted as already saved.
  assert.deepEqual(
    { posts: stats.posts, numbers: stats.numbers, unverified: stats.unverified, newLeads: stats.newLeads, duplicates: stats.duplicates, failures: stats.failures },
    { posts: 7, numbers: 9, unverified: 0, newLeads: 8, duplicates: 1, failures: 0 },
  );
  // Each lead links to its own post, revealed by hovering its date.
  const ali = store.listLeads().find((l) => l.phone === '+923001234567');
  assert.equal(ali.fbPostUrl, 'https://www.facebook.com/page101/posts/pfbid0101');
  assert.equal(ali.name, 'Ali Garments');
  assert.equal(store.leadSources(ali.id).length, 2, 'both posts are recorded as sources');
  // Ended at Facebook's own end marker, after both batches.
  assert.match(outcome.message, /^7 posts read, 9 valid numbers, 8 new leads, 1 already saved\. End of the results for "garments shop"\.$/);
  // Diagnostics: counts only.
  assert.equal(diag[0].postsOnPage, 7);
  assert.equal(diag[0].withLink, 7);
  assert.ok(diag[0].rejected.date >= 1);
  assert.doesNotMatch(JSON.stringify(diag), /0300|garments shop Lahore|c_user/i);
});

test('the same search on an en-US computer without leads (the reported bug): numbers are kept to check, not lost', { skip: !exe && 'Google Chrome not installed' }, async (t) => {
  const { outcome, stats, store } = await run(t, { country: 'US' });
  assert.equal(outcome.state, 'done', outcome.message);
  // The 5 international numbers are valid; the 4 local ones are kept to check.
  assert.deepEqual([stats.numbers, stats.unverified], [5, 4]);
  const toCheck = store.listLeads().filter((l) => l.phoneStatus === 'unverified');
  assert.ok(toCheck.some((l) => l.phone === '0300-1234567'));
  assert.ok(store.listLeads().length >= 7);
});

test('duplicates across Google Maps, Facebook and LinkedIn are one lead with every source', () => {
  const s = new LeadStore(':memory:');
  const m = s.save({ placeKey: '0x1:0x1', mapsUrl: 'https://www.google.com/maps/place/A', name: 'Ali Garments', phoneRaw: '+92 300 1234567', address: 'Lahore, Pakistan', websiteStatus: 'no_website' });
  const f = s.saveFacebookLead({ phone: '+923001234567', status: 'valid', postUrl: 'https://www.facebook.com/p/posts/1', text: 'x' });
  const l = s.saveLinkedInLead({ companyName: 'Ali Garments', companyUrl: 'https://www.linkedin.com/company/ali-garments', phone: { phone: '+923001234567', raw: '0300 1234567', status: 'valid', country: 'PK' }, sourceUrl: 'https://www.linkedin.com/jobs/view/1/', sourceKind: 'job' });
  assert.equal(f.isNewLead, false);
  assert.equal(l.isNewLead, false);
  const leads = s.listLeads();
  assert.equal(leads.length, 1);
  assert.equal(leads[0].id, m.lead.id);
  assert.deepEqual(leads[0].sources, ['maps', 'facebook', 'linkedin']);
  // A LinkedIn lead found later on Google Maps becomes that listing.
  const s2 = new LeadStore(':memory:');
  const li = s2.saveLinkedInLead({ companyName: 'Acme', companyUrl: 'https://www.linkedin.com/company/acme', phone: { phone: '+923211234567', raw: '0321 1234567', status: 'valid', country: 'PK' }, sourceUrl: 'https://www.linkedin.com/jobs/view/2/' });
  const mm = s2.save({ placeKey: '0x2:0x2', mapsUrl: 'https://www.google.com/maps/place/B', name: 'Acme', phoneRaw: '+92 321 1234567', address: 'Lahore, Pakistan', websiteStatus: 'no_website' });
  assert.equal(mm.lead.id, li.lead.id);
  assert.equal(mm.isNewLead, false);
  assert.deepEqual(s2.listLeads()[0].sources, ['maps', 'linkedin']);
});

test('the reported post: 03244548266, 0331-4059257 and 0321-4647423 with emojis, entities and dashes', () => {
  const post = '🔥🔥 Garments shop SALE 🛍️ Contact 📞03244548266, 0331-4059257 &amp; 0321‑4647423 (WhatsApp) ✅ Lahore';
  assert.deepEqual(valid(post, 'PK'), ['+923244548266', '+923314059257', '+923214647423']);
  assert.deepEqual(valid('Call 0️⃣3️⃣2️⃣4️⃣4️⃣5️⃣4️⃣8️⃣2️⃣6️⃣6️⃣', 'PK'), ['+923244548266']);
  assert.deepEqual(valid('０３３１－４０５９２５７', 'PK'), ['+923314059257']);
  assert.deepEqual(valid('&#48;3244548266 &nbsp; +92&nbsp;331&nbsp;4059257 — 0092-321-4647423', 'PK'), ['+923244548266', '+923314059257', '+923214647423']);
  // Without a country (an en-US computer, no leads): kept to check, all three.
  assert.equal(findPhones(post, { country: null }).phones.length, 3);
});

test('the search page is never a post address (it made every post look already saved)', () => {
  const fb = require('../src/browser/facebook');
  assert.equal(fb.cleanPostUrl('https://www.facebook.com/search/posts/?q=garments%20shop&__tn__=x'), '');
  assert.equal(fb.cleanPostUrl('https://www.facebook.com/hashtag/garments?__tn__=x'), '');
  const p = fb.parsePost({ text: 'Contact 03244548266', author: 'A', authorUrl: 'https://www.facebook.com/a', hrefs: ['https://www.facebook.com/search/posts/?q=garments', 'https://www.facebook.com/a/posts/pfbid02x'] });
  assert.equal(p.url, 'https://www.facebook.com/a/posts/pfbid02x');
  const q = fb.parsePost({ text: 'Contact 0331-4059257', author: 'B', authorUrl: 'https://www.facebook.com/b', hrefs: ['https://www.facebook.com/search/posts/?q=garments'] });
  assert.equal(q.url, '');
  assert.notEqual(p.key, q.key);
});

test('several posts that link to the search page: every number is saved, none skipped as "already saved"', async () => {
  const fb = require('../src/browser/facebook');
  const store = new LeadStore(':memory:');
  const hrefs = ['https://www.facebook.com/search/posts/?q=garments%20shop'];
  const posts = [
    fb.parsePost({ text: 'Contact 03244548266', author: 'Shop A', authorUrl: 'https://www.facebook.com/shopa', hrefs }),
    fb.parsePost({ text: 'Call 0331-4059257 or 0321-4647423', author: 'Shop B', authorUrl: 'https://www.facebook.com/shopb', hrefs }),
    fb.parsePost({ text: 'Same shop A again 03244548266', author: 'Shop A', authorUrl: 'https://www.facebook.com/shopa', hrefs }),
  ];
  const session = new FacebookSession({ keyword: 'garments shop', country: 'PK', store, pages: {}, signal: new AbortController().signal, emit: () => {}, facebook: fb });
  for (const p of posts) await session.processPost(p, 'garments shop');
  assert.deepEqual(store.listLeads().map((l) => l.phone).sort(), ['+923214647423', '+923244548266', '+923314059257']);
  const f = session.stats.facebook;
  assert.deepEqual([f.posts, f.numbers, f.newLeads, f.duplicates], [3, 4, 3, 1]);
});
