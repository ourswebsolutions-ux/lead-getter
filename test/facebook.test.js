'use strict';
// Facebook as a second lead source: number extraction from posts, the post
// search page logic (mocked page in a throwaway headless Chrome), storage and
// de-duplication across sources, and the search flow with Facebook Lead
// Search off and on, including Facebook failures.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const fb = require('../src/browser/facebook');
const maps = require('../src/browser/maps');
const { findChromeExecutable } = require('../src/browser/chrome');
const { LeadStore, facebookKey } = require('../src/database/db');
const { SearchSession } = require('../src/browser/search-session');
const { FacebookSession } = require('../src/browser/facebook-session');
const { runSources } = require('../src/browser/search-sources');
const { OutreachStore } = require('../src/database/wa-store');

// --- numbers in post text ---------------------------------------------------------

test('valid numbers are read from post text and WhatsApp/tel links; nothing is invented', () => {
  const found = fb.extractPhones(
    'Wholesale garments. Call 0300-1234567 or ۰۳۲۱ ۷۶۵۴۳۲۱. Price 1500 rs, sale ends 2024-05-01, order #12345678.',
    ['https://l.facebook.com/l.php?u=' + encodeURIComponent('https://wa.me/923331112223'), 'tel:+923451234567'],
    'PK',
  );
  assert.deepEqual(found.map((p) => p.phone).sort(), ['+923001234567', '+923217654321', '+923331112223', '+923451234567']);
  assert.equal(found.find((p) => p.phone === '+923001234567').raw, '0300-1234567');
  assert.ok(found.every((p) => p.country === 'PK'));

  // No number, or only prices/dates/ids: no contact at all.
  assert.deepEqual(fb.extractPhones('Looking for suppliers, budget 25000, call me!', [], 'PK'), []);
  // Too short / not a real number for the country: dropped, never "fixed".
  assert.deepEqual(fb.extractPhones('Call 0300 12345', [], 'PK'), []);
  // Without a known country a local number cannot be validated, so only
  // numbers in international form are kept.
  assert.deepEqual(fb.extractPhones('Call 0300 1234567 or +44 20 7946 0958', [], null).map((p) => p.phone), ['+442079460958']);
  // At most 5 numbers from one post (a list of numbers is not one business).
  const many = Array.from({ length: 8 }, (_, i) => `0300 12345${60 + i}`).join(', ');
  assert.equal(fb.extractPhones(many, [], 'PK').length, 5);
  // Lists separated by commas are read number by number.
  assert.deepEqual(fb.extractPhones('Contact: 03001234567,03217654321; 0333-1112223', [], 'PK').map((p) => p.phone), ['+923001234567', '+923217654321', '+923331112223']);
});

test('post and page addresses lose tracking parameters; queries follow the keyword and category', () => {
  assert.equal(fb.cleanPostUrl('https://www.facebook.com/groups/1/posts/2/?__cft__[0]=x&__tn__=R'), 'https://www.facebook.com/groups/1/posts/2');
  assert.equal(fb.cleanPostUrl('https://web.facebook.com/permalink.php?story_fbid=3&id=4&__tn__=x'), 'https://www.facebook.com/permalink.php?story_fbid=3&id=4');
  assert.equal(fb.cleanPostUrl('https://www.facebook.com/AliGarments'), '', 'a page is not a post');
  assert.equal(fb.cleanPostUrl('https://evil.example/posts/1'), '');
  assert.equal(fb.cleanProfileUrl('https://www.facebook.com/profile.php?id=9&__tn__=x'), 'https://www.facebook.com/profile.php?id=9');
  assert.equal(fb.cleanProfileUrl('https://www.facebook.com/hashtag/garments'), '');
  assert.deepEqual(fb.buildQueries('garment shops in Lahore', 'Garments'), ['garment shops in Lahore', 'Garments Lahore']);
  assert.deepEqual(fb.buildQueries('Garments wholesale Lahore', 'Garments'), ['Garments wholesale Lahore']);
  assert.match(fb.searchUrl('Garments Lahore'), /^https:\/\/www\.facebook\.com\/search\/posts\/\?q=Garments%20Lahore$/);
});

// --- page logic ------------------------------------------------------------------

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'facebook-search.html'), 'utf8');
const exe = findChromeExecutable();

test('Facebook DOM: posts, See more, scrolling, login and block pages', { skip: !exe && 'Google Chrome not installed' }, async (t) => {
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  let body = fixture;
  let requests = 0;
  await page.route('https://www.facebook.com/**', (r) => (requests++, r.fulfill({ contentType: 'text/html; charset=utf-8', body })));

  // Not logged in to Facebook in this profile: Facebook is not even opened.
  assert.deepEqual(await fb.openSearch(page, 'garments Lahore'), { mode: 'login' });
  assert.equal(requests, 0);
  await context.addCookies([{ name: 'c_user', value: '1', domain: '.facebook.com', path: '/', secure: true }]);
  assert.equal(await fb.loggedIn(page), true);

  assert.deepEqual(await fb.openSearch(page, 'garments Lahore'), { mode: 'list' });
  assert.equal(await fb.expandSeeMore(page), 1);
  let posts = await fb.collectPosts(page);
  assert.equal(posts.length, 4, 'comments are not posts');
  assert.deepEqual(posts[0], {
    key: 'https://www.facebook.com/AliGarments/posts/1001',
    url: 'https://www.facebook.com/AliGarments/posts/1001',
    pageUrl: 'https://www.facebook.com/AliGarments',
    author: 'Ali Garments Wholesale',
    text: 'Wholesale garments available in Lahore. Call 0300 1234567 for rates.',
    links: [],
  });
  assert.equal(posts[1].url, 'https://www.facebook.com/groups/778899/posts/2002');
  assert.equal(posts[1].pageUrl, 'https://www.facebook.com/profile.php?id=555');
  assert.deepEqual(fb.extractPhones(posts[1].text, posts[1].links, 'PK'), [], "a commenter's number is not the poster's");
  assert.equal(posts[2].url, 'https://www.facebook.com/permalink.php?story_fbid=3003&id=444');
  assert.deepEqual(posts[2].links, ['https://wa.me/923217654321'], 'the See more text and its WhatsApp link were read');
  assert.equal(posts[3].url, '', 'a post without its own link');

  let end = false;
  for (let i = 0; i < 20 && !end; i++) {
    ({ end } = await fb.scrollResults(page));
    await page.waitForTimeout(200);
  }
  assert.ok(end, 'end of results seen');
  posts = await fb.collectPosts(page);
  assert.equal(posts.length, 5);
  assert.equal(fb.extractPhones(posts[4].text, posts[4].links, 'PK')[0].phone, '+924235761234');

  // Not logged in, security check and temporary block are recognised.
  body = '<html><body><form id="login_form"><input name="email"><input name="pass" type="password"></form></body></html>';
  assert.deepEqual(await fb.openSearch(page, 'x'), { mode: 'login' });
  body = '<html><body><h1>You’re Temporarily Blocked</h1><p>It looks like you were misusing this feature by going too fast.</p></body></html>';
  assert.deepEqual(await fb.openSearch(page, 'x'), { mode: 'blocked' });
  body = '<html><body><p>We didn\'t find any results</p></body></html>';
  assert.deepEqual(await fb.openSearch(page, 'x'), { mode: 'empty' });
  await page.route('https://www.facebook.com/checkpoint/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: '<html><body>Check</body></html>' }));
  await page.goto('https://www.facebook.com/checkpoint/123');
  assert.equal(await fb.detectState(page), 'checkpoint');
});

// --- storage and de-duplication ----------------------------------------------------

const fbLead = (extra) => ({
  phone: '+923001234567',
  country: 'PK',
  raw: '0300 1234567',
  name: 'Ali Garments Wholesale',
  contactName: 'Ali Garments Wholesale',
  postUrl: 'https://www.facebook.com/AliGarments/posts/1001',
  pageUrl: 'https://www.facebook.com/AliGarments',
  text: 'Wholesale garments available in Lahore. Call 0300 1234567 for rates.',
  keyword: 'garments Lahore',
  ...extra,
});
const mapsListing = (extra) => ({ placeKey: '0x1:0xa', mapsUrl: 'https://www.google.com/maps/place/Ali', name: 'Ali Garments', phoneRaw: '+923001234567', address: 'Hall Road, Lahore, Pakistan', websiteStatus: 'no_website', ...extra });

test('a Facebook post with a number becomes a structured lead in the same table', () => {
  const s = new LeadStore(':memory:');
  const cat = s.ensureCategory('Garments');
  const r = s.saveFacebookLead(fbLead({ categoryId: cat.id }), '2026-10-26T10:00:00.000Z');
  assert.equal(r.isNewLead, true);
  const l = s.listLeads()[0];
  assert.deepEqual(
    {
      name: l.name, contactName: l.contactName, phone: l.phone, phoneRaw: l.phoneRaw, phoneStatus: l.phoneStatus, category: l.category,
      description: l.description, fbPostUrl: l.fbPostUrl, fbPageUrl: l.fbPageUrl, source: l.source, sources: l.sources,
      campaign: l.campaign, address: l.address, websiteKind: l.websiteKind, keyword: l.keyword, discoveredAt: l.discoveredAt,
    },
    {
      name: 'Ali Garments Wholesale', contactName: 'Ali Garments Wholesale', phone: '+923001234567', phoneRaw: '0300 1234567', phoneStatus: 'valid', category: 'Garments',
      description: 'Wholesale garments available in Lahore. Call 0300 1234567 for rates.', fbPostUrl: 'https://www.facebook.com/AliGarments/posts/1001',
      fbPageUrl: 'https://www.facebook.com/AliGarments', source: 'facebook', sources: ['facebook'], campaign: 'unseen', address: '', websiteKind: 'unknown',
      keyword: 'garments Lahore', discoveredAt: '2026-10-26T10:00:00.000Z',
    },
  );
  assert.equal(l.websiteStatus, 'Website not checked (found on Facebook)');
  // Filters work across sources.
  s.save(mapsListing({ placeKey: '0x2:0xb', phoneRaw: '+923009998887', categoryId: cat.id }));
  assert.equal(s.listLeads({ source: 'facebook' }).length, 1);
  assert.equal(s.listLeads({ source: 'maps' }).length, 1);
  assert.equal(s.listLeads({ category: cat.id }).length, 2);
  assert.equal(s.listLeads({ search: 'Wholesale' }).length, 1);
  assert.equal(s.listLeads({ search: '1234567' })[0].source, 'facebook');
  assert.equal(s.listLeads({ campaign: 'unseen' }).length, 2);
  assert.throws(() => s.saveFacebookLead(fbLead({ phone: '0300 1234567' })), /validated international/);
});

test('the same number from either source never makes a second lead; campaign history stays', () => {
  const s = new LeadStore(':memory:');
  // Found on Google Maps first, and already messaged by a campaign.
  const maps1 = s.save(mapsListing(), '2026-10-20T09:00:00.000Z').lead;
  const out = new OutreachStore(s.db);
  const camp = out.createCampaign('Garments', { templates: ['a', 'b', 'c'] }, Date.now());
  s.db.prepare("INSERT INTO outreach_sends (campaign_id, campaign_name, phone, stage, test, day, status, created_at, sent_at) VALUES (?, 'Garments', ?, 0, 0, '2026-10-21', 'delivered', 1, 1)").run(camp, maps1.phone);
  assert.equal(s.listLeads()[0].campaign, 'seen');

  // ... then in two Facebook posts.
  let r = s.saveFacebookLead(fbLead(), '2026-10-26T10:00:00.000Z');
  assert.deepEqual([r.isNewLead, r.newSource], [false, true]);
  r = s.saveFacebookLead(fbLead({ postUrl: 'https://www.facebook.com/AliGarments/posts/1002', name: 'Other Name' }), '2026-10-26T11:00:00.000Z');
  assert.deepEqual([r.isNewLead, r.newSource], [false, true]);
  // The same post again adds nothing.
  assert.equal(s.saveFacebookLead(fbLead()).newSource, false);

  const leads = s.listLeads();
  assert.equal(leads.length, 1);
  const l = leads[0];
  assert.equal(l.id, maps1.id);
  assert.equal(l.name, 'Ali Garments', 'the Maps name is kept');
  assert.equal(l.address, 'Hall Road, Lahore, Pakistan');
  assert.equal(l.discoveredAt, '2026-10-20T09:00:00.000Z', 'the original date is kept');
  assert.deepEqual(l.sources, ['maps', 'facebook']);
  assert.equal(l.fbPostUrl, 'https://www.facebook.com/AliGarments/posts/1001', 'first post kept');
  assert.equal(l.campaign, 'seen', 'still Seen');
  assert.equal(l.campaignDelivery, 'delivered');
  assert.equal(s.leadSources(l.id).length, 2, 'both posts recorded');
  assert.equal(s.hasFacebookPost('https://www.facebook.com/AliGarments/posts/1002'), true);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM outreach_sends').get().n, 1, 'message history untouched');
});

test('a Facebook lead later found on Google Maps becomes that listing (same id, history and date)', () => {
  const s = new LeadStore(':memory:');
  const cat = s.ensureCategory('Garments');
  const first = s.saveFacebookLead(fbLead({ categoryId: cat.id }), '2026-10-20T09:00:00.000Z').lead;
  s.db.prepare("INSERT INTO outreach_sends (campaign_id, campaign_name, phone, stage, test, day, status, created_at, sent_at) VALUES (1, 'C', ?, 0, 0, '2026-10-21', 'sent', 1, 1)").run(first.phone);
  const r = s.save(mapsListing({ categoryId: s.ensureCategory('Other').id }), '2026-10-26T10:00:00.000Z');
  assert.equal(r.isNewLead, false);
  const all = s.listLeads();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, first.id);
  assert.deepEqual(all[0].sources, ['maps', 'facebook']);
  assert.equal(all[0].source, 'maps');
  assert.equal(all[0].name, 'Ali Garments');
  assert.equal(all[0].mapsUrl, 'https://www.google.com/maps/place/Ali');
  assert.equal(all[0].category, 'Garments', 'category kept');
  assert.equal(all[0].discoveredAt, '2026-10-20T09:00:00.000Z');
  assert.equal(all[0].campaign, 'seen');
  // Maps sees it as an already-checked listing from now on.
  assert.equal(s.get('0x1:0xa').id, first.id);
});

test('a deleted lead is not added back by Facebook, and the marker does not keep the number', () => {
  const s = new LeadStore(':memory:');
  const a = s.saveFacebookLead(fbLead()).lead;
  s.deleteLeads([a.id]);
  assert.equal(s.saveFacebookLead(fbLead({ postUrl: 'https://www.facebook.com/x/posts/9' })).skipped, 'deleted');
  const marker = s.db.prepare('SELECT * FROM businesses WHERE id = ?').get(a.id);
  assert.equal(marker.place_key, facebookKey('+923001234567'));
  assert.ok(!JSON.stringify(marker).includes('1234567'), 'no number or text left');
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM lead_sources').get().n, 0);

  // A Maps lead that was also on Facebook leaves a Facebook marker too.
  const b = s.save(mapsListing({ placeKey: '0x5:0x5', phoneRaw: '+923217654321' })).lead;
  s.saveFacebookLead(fbLead({ phone: '+923217654321', postUrl: 'https://www.facebook.com/x/posts/10' }));
  s.deleteFiltered({ category: 'all' });
  assert.equal(s.listLeads().length, 0);
  assert.equal(s.saveFacebookLead(fbLead({ phone: '+923217654321', postUrl: 'https://www.facebook.com/x/posts/11' })).skipped, 'deleted');
  assert.equal(s.get('0x5:0x5').website_status, 'deleted', 'the Maps listing stays deleted for Maps searches, as before');
  assert.ok(b.id);
});

test('upgrading a version 6 database keeps every lead and adds the Facebook fields', () => {
  const s = new LeadStore(':memory:');
  s.save(mapsListing());
  // Simulate a version 6 database: drop what version 7 added.
  s.db.exec('DROP TABLE lead_sources; PRAGMA user_version = 6;');
  for (const c of ['fb_post_url', 'fb_page_url', 'contact_name', 'description']) s.db.exec(`ALTER TABLE businesses DROP COLUMN ${c}`);
  s.migrate();
  assert.equal(s.db.prepare('PRAGMA user_version').get().user_version, 7);
  const l = s.listLeads()[0];
  assert.deepEqual([l.name, l.sources, l.fbPostUrl], ['Ali Garments', ['maps'], '']);
});

// --- the search flow -------------------------------------------------------------------

const FAST = { listing: [0, 0], scroll: [0, 0], longBreak: [0, 0], afterBlock: 0, blockPoll: 5, netRetries: [1, 1], reconnectDelays: [1], fbScroll: [0, 0], fbBetweenQueries: [0, 0] };
const fakePage = { bringToFront: async () => {}, url: () => '', evaluate: async () => true };

function mockMaps(listings) {
  let opened = null;
  return {
    calls: { search: 0 },
    placeKey: maps.placeKey,
    cleanMapsUrl: maps.cleanMapsUrl,
    detectBlock: async () => null,
    async search() {
      this.calls.search++;
      return { mode: listings.length ? 'list' : 'empty' };
    },
    collectLinks: async () => listings.map((l) => ({ url: l.url, name: l.name })),
    scrollFeed: async () => ({ end: true }),
    openListing: async (_p, link) => ((opened = listings.find((l) => l.url === link.url)), true),
    gotoListing: async () => false,
    returnToResults: async () => true,
    extractDetails: async () => ({ name: opened.name, website: '', phoneTel: opened.phone, phoneText: '', address: 'Lahore, Pakistan', infoLoaded: true, closed: false, url: opened.url }),
  };
}

// Facebook results: pages of posts revealed by scrolling; `mode` for the
// search page (list/login/checkpoint/blocked/empty), or a thrown error.
function mockFacebook({ pagesOfPosts = [], mode = 'list', fail = null } = {}) {
  let shown = 1;
  const calls = { openSearch: [], collect: 0 };
  return {
    calls,
    buildQueries: fb.buildQueries,
    extractPhones: fb.extractPhones,
    async openSearch(_page, query) {
      calls.openSearch.push(query);
      if (fail) throw fail;
      shown = 1;
      return { mode };
    },
    detectState: async () => null,
    expandSeeMore: async () => 0,
    collectPosts: async () => (calls.collect++, pagesOfPosts.slice(0, shown).flat()),
    scrollResults: async () => {
      shown++;
      return { end: shown >= pagesOfPosts.length };
    },
  };
}

const post = (n, text, extra = {}) => fb.parsePost({ text, author: `Author ${n}`, authorUrl: `https://www.facebook.com/author${n}`, hrefs: [`https://www.facebook.com/author${n}/posts/${n}?__tn__=x`], ...extra });

function search({ withFacebook, listings = [], facebook = mockFacebook(), store = new LeadStore(':memory:'), signal = new AbortController().signal, categoryName = 'Garments', country = 'PK' }) {
  const statuses = [];
  const leads = [];
  const mapsMock = mockMaps(listings);
  const cat = store.ensureCategory(categoryName);
  const pages = { main: async () => fakePage, check: async () => fakePage, detail: async () => fakePage, facebook: async () => fakePage };
  const done = runSources({
    withFacebook,
    signal,
    send: (event, payload) => (event === 'lead' ? leads.push(payload) : statuses.push(payload)),
    createMaps: (emit) => new SearchSession({ keyword: 'garment shops in Lahore', categoryId: cat.id, store, pages, signal, maps: mapsMock, webCheck: async () => ({ status: 'no_website' }), pacing: FAST, emit }),
    createFacebook: (emit, stats) =>
      new FacebookSession({ keyword: 'garment shops in Lahore', categoryId: cat.id, categoryName, country: store.commonPhoneCountry() || country, store, pages, signal, facebook, pacing: FAST, emit, stats }),
  });
  return { done, statuses, leads, store, mapsMock, facebook, cat };
}

const listing = (n, phone) => ({ url: `https://www.google.com/maps/place/B${n}/data=!1s0x${n}:0x${n}`, name: `Shop ${n}`, phone });

test('Facebook Lead Search OFF: only Google Maps runs, with the same events as before', async () => {
  const facebook = mockFacebook({ pagesOfPosts: [[post(1, 'Call 0300 1234567')]] });
  const off = search({ withFacebook: false, listings: [listing(1, '+923001111111'), listing(2, '+923002222222')], facebook });
  const stats = await off.done;
  assert.equal(facebook.calls.openSearch.length, 0, 'Facebook is never opened');
  assert.equal(stats.facebook, undefined);
  assert.equal(off.leads.length, 2);
  assert.ok(off.leads.every((l) => l.source === 'maps'));
  const last = off.statuses.at(-1);
  assert.equal(last.state, 'done');
  assert.equal(last.message, 'Search finished: no more results');
  assert.ok(!off.statuses.some((s) => s.source === 'facebook'));
});

test('Facebook Lead Search ON: Maps, then Facebook posts for the same keyword and category', async () => {
  const facebook = mockFacebook({
    pagesOfPosts: [
      [post(1, 'Wholesale garments, call 0300 1234567'), post(2, 'Need suppliers, budget 25000')],
      [post(3, 'Factory rates', { hrefs: ['https://www.facebook.com/author3/posts/3', 'https://wa.me/923217654321'] }), post(4, 'Same shop on Maps: 0300 1111111')],
    ],
  });
  const on = search({ withFacebook: true, listings: [listing(1, '+923001111111')], facebook });
  const stats = await on.done;
  assert.deepEqual(facebook.calls.openSearch, ['garment shops in Lahore', 'Garments Lahore']);
  // Leads: 1 from Maps, 2 new from Facebook, and the Maps number seen again.
  const all = on.store.listLeads();
  assert.equal(all.length, 3, 'no duplicate for the number found in both');
  const both = all.find((l) => l.phone === '+923001111111');
  assert.deepEqual(both.sources, ['maps', 'facebook']);
  const fromPost = all.find((l) => l.phone === '+923001234567');
  assert.deepEqual([fromPost.source, fromPost.category, fromPost.fbPostUrl, fromPost.name], ['facebook', 'Garments', 'https://www.facebook.com/author1/posts/1', 'Author 1']);
  assert.ok(all.find((l) => l.phone === '+923217654321'), 'WhatsApp link number saved');
  assert.ok(!all.some((l) => l.description === 'Need suppliers, budget 25000'), 'no lead without a number');
  assert.deepEqual(stats.facebook, { posts: 4, leads: 3, newLeads: 2 }, 'the second query sees the same posts and skips them');
  assert.equal(stats.newLeads, 3);

  // Progress shows the source, and the final status reports both.
  assert.ok(on.statuses.some((s) => s.state === 'running' && s.source === 'facebook' && /^Google Maps: Search finished: no more results\. Now searching Facebook$/.test(s.message)));
  assert.ok(!on.statuses.slice(0, -1).some((s) => s.state === 'done'), 'no early "done" while Facebook runs');
  const last = on.statuses.at(-1);
  assert.equal(last.state, 'done');
  assert.equal(last.facebook.state, 'done');
  assert.match(last.message, /^Google Maps: Search finished: no more results\. Facebook: 4 posts read, 3 with a valid number \(2 new leads\)\.$/);
});

test('Facebook problems are reported without failing the Google Maps search', async () => {
  for (const [mode, re] of [
    ['login', /Facebook asked to log in/],
    ['checkpoint', /security check/],
    ['blocked', /temporarily blocked/],
  ]) {
    const r = search({ withFacebook: true, listings: [listing(1, '+923001111111')], facebook: mockFacebook({ mode }) });
    await r.done;
    const last = r.statuses.at(-1);
    assert.equal(last.state, 'done', mode);
    assert.equal(last.facebook.state, 'unavailable');
    assert.equal(last.facebook.kind, mode);
    assert.match(last.message, re);
    assert.equal(r.store.listLeads().length, 1, 'the Maps lead is saved');
  }
  // Search pages that never load are reported as a problem, not as "0 posts".
  const blank = search({ withFacebook: true, listings: [listing(1, '+923001111111')], facebook: mockFacebook({ mode: 'failed' }) });
  await blank.done;
  assert.equal(blank.statuses.at(-1).state, 'done');
  assert.equal(blank.statuses.at(-1).facebook.kind, 'not_loaded');
  assert.match(blank.statuses.at(-1).message, /Facebook: Facebook search results did not load\..*\(failed\)/);
  // An unexpected Facebook failure (page crashed, timeout) is reported too.
  const crash = search({ withFacebook: true, listings: [listing(1, '+923001111111')], facebook: mockFacebook({ fail: new Error('page.goto: Timeout 45000ms exceeded') }) });
  await crash.done;
  assert.equal(crash.statuses.at(-1).state, 'done');
  assert.match(crash.statuses.at(-1).message, /Facebook: The Facebook search did not finish \(page\.goto: Timeout/);
  // A Maps problem still lets Facebook run; the final status is the Maps error.
  // (No Maps leads and no country hint: only international numbers are read.)
  const blocked = search({ withFacebook: true, listings: [], country: null, facebook: mockFacebook({ pagesOfPosts: [[post(1, 'Call 0300 1234567 or +92 321 7654321')]] }) });
  blocked.mapsMock.search = async () => ({ mode: 'failed', detail: 'test' });
  await blocked.done;
  assert.equal(blocked.statuses.at(-1).state, 'error');
  assert.match(blocked.statuses.at(-1).message, /^Google Maps: The Google Maps search for .* Facebook: 1 post read/);
  assert.deepEqual(blocked.store.listLeads().map((l) => [l.phone, l.source]), [['+923217654321', 'facebook']]);
});

test('Stop during the Facebook part ends the search as stopped', async () => {
  const ctl = new AbortController();
  const facebook = mockFacebook({ pagesOfPosts: [[post(1, 'Call 0300 1234567')], [post(2, 'Call 0300 7654321')]] });
  const orig = facebook.collectPosts;
  facebook.collectPosts = async (...a) => {
    const out = await orig(...a);
    ctl.abort();
    return out;
  };
  const r = search({ withFacebook: true, listings: [listing(1, '+923001111111')], facebook, signal: ctl.signal });
  await r.done;
  assert.equal(r.statuses.at(-1).state, 'stopped');
  assert.equal(facebook.calls.openSearch.length, 1);
});

test('a later search does not re-save posts it already read, and keeps campaign history', async () => {
  const store = new LeadStore(':memory:');
  const posts = [[post(1, 'Wholesale garments, call 0300 1234567')]];
  await search({ withFacebook: true, store, facebook: mockFacebook({ pagesOfPosts: posts }) }).done;
  const l = store.listLeads()[0];
  store.db.prepare("INSERT INTO outreach_sends (campaign_id, campaign_name, phone, stage, test, day, status, created_at, sent_at) VALUES (1, 'C', ?, 0, 0, '2026-10-21', 'read', 1, 1)").run(l.phone);
  const again = search({ withFacebook: true, store, facebook: mockFacebook({ pagesOfPosts: posts }) });
  const stats = await again.done;
  assert.equal(stats.facebook.leads, 0);
  assert.equal(again.leads.length, 0);
  assert.ok(again.statuses.some((s) => /already saved a post by Author 1/.test(s.message)));
  const after = store.listLeads();
  assert.equal(after.length, 1);
  assert.equal(after[0].discoveredAt, l.discoveredAt);
  assert.equal(after[0].campaign, 'seen');
  assert.equal(after[0].campaignDelivery, 'read');
});
