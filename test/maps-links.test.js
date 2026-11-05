'use strict';
// Google Maps: every link on a listing is looked at. A genuine website is told
// from social and contact links, which are kept with the lead. The links are
// the kinds seen on real listings ("links" section, "Book online").
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classifyWebsite, socialLinksOf, ownSiteOf } = require('../src/browser/website');
const { leadsToCsv } = require('../src/export/csv');
const { LeadStore } = require('../src/database/db');
const { SearchSession } = require('../src/browser/search-session');

const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-links-'));
  return { store: new LeadStore(path.join(dir, 'leads.db')), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

test('social and contact links are not websites; a real domain is', () => {
  for (const url of ['https://www.facebook.com/shop', 'https://wa.me/+923001888290?rwg_token=abc', 'https://whatsapp.com/channel/0029VbBi', 'https://chat.whatsapp.com/abc', 'https://wa.link/xyz', 'https://m.me/shop', 'https://www.instagram.com/shop', 'https://www.tiktok.com/@shop', 'https://linktr.ee/shop', 'https://beacons.ai/shop', 'https://t.me/shop', 'https://www.google.com/url?q=https://www.facebook.com/shop']) {
    assert.equal(classifyWebsite(url).kind, 'social', url);
  }
  for (const url of ['https://elegantdha.com/', 'http://saiban.pk/', 'https://shop.example.co.uk/contact']) assert.equal(classifyWebsite(url).kind, 'independent', url);
});

test("a listing's links: social ones kept once, without tracking; the rest ignored", () => {
  const links = ['https://wa.me/+923001888290?rwg_token=abc', 'https://wa.me/+923001888290?rwg_token=def', 'https://www.facebook.com/Shop/', 'https://support.google.com/local-listings?p=how', 'https://setmore.com/book/x', 'https://calendar.app.google/aTx5'];
  assert.deepEqual(socialLinksOf({ website: '', links }), ['wa.me/+923001888290', 'facebook.com/Shop']);
  assert.deepEqual(socialLinksOf({ website: 'https://www.instagram.com/shop', links: ['https://www.instagram.com/shop/'] }), ['instagram.com/shop']);
  assert.deepEqual(socialLinksOf({}), []);
});

test("a business's own site behind a button counts; a booking service does not", () => {
  const name = 'Faseeh Estate';
  assert.equal(ownSiteOf({ name, links: ['https://faseehestate.com/contact-us/?rwg_token=x'] }).url, 'faseehestate.com/contact-us');
  assert.equal(ownSiteOf({ name, links: ['https://setmore.com/book/x', 'https://support.google.com/local-listings', 'https://calendar.app.google/a'] }), null);
  assert.equal(ownSiteOf({ name: 'Facebook Traders', links: ['https://www.facebook.com/traders'] }), null);
});

// A search of one listing, with Maps and the web check simulated.
async function search(store, details, { filter = 'without', webCheck = { status: 'no_website' }, key = 'k1' } = {}) {
  const page = { bringToFront: async () => {}, isClosed: () => false, url: () => 'https://www.google.com/maps' };
  const checks = [];
  const s = new SearchSession({
    keyword: 'shops',
    websiteFilter: filter,
    emit: () => {},
    signal: new AbortController().signal,
    store,
    pages: { main: async () => page, check: async () => page, detail: async () => page },
    webCheck: async (_p, d) => (checks.push(d.name), webCheck),
    maps: { placeKey: () => key, cleanMapsUrl: (u) => u, openListing: async () => true, gotoListing: async () => true, extractDetails: async () => details },
  });
  s.guard = async () => {};
  await s.processListing({ url: 'https://www.google.com/maps/place/x', name: details.name }, page, {});
  return { row: store.get(key), checks };
}

const listing = (o) => ({ name: 'Rehman Traders', website: '', links: [], phoneTel: '+923001234567', phoneText: '', address: 'Lahore, Pakistan', infoLoaded: true, closed: false, url: 'https://www.google.com/maps/place/x', ...o });

test('"Without website": a business with only a WhatsApp or Facebook link is a lead that keeps the link', async () => {
  const { store, done } = tmp();
  try {
    const { row } = await search(store, listing({ links: ['https://whatsapp.com/channel/0029VbBi', 'https://www.facebook.com/rehman', 'https://support.google.com/local-listings'] }));
    assert.equal(row.website_status, 'social_only');
    assert.equal(row.qualified, 1);
    assert.equal(row.website_detail, 'whatsapp.com/channel/0029VbBi');
    assert.deepEqual(JSON.parse(row.social_links), ['whatsapp.com/channel/0029VbBi', 'facebook.com/rehman']);
  } finally {
    done();
  }
});

test('"Without website": no links at all is still "no website"; a genuine website is not a lead', async () => {
  const { store, done } = tmp();
  try {
    assert.equal((await search(store, listing({}))).row.website_status, 'no_website');
    const site = await search(store, listing({ website: 'https://rehmantraders.com/', links: ['https://www.facebook.com/rehman'] }), { key: 'k2' });
    assert.equal(site.row.website_status, 'has_website');
    assert.equal(site.row.qualified, 0);
    assert.deepEqual(JSON.parse(site.row.social_links), ['facebook.com/rehman'], 'its social links are recognised too');
    const button = await search(store, listing({ links: ['https://rehmantraders.com/contact'] }), { key: 'k3' });
    assert.equal(button.row.website_status, 'has_website', 'its own site behind "Book online"');
    assert.equal(button.checks.length, 0);
  } finally {
    done();
  }
});

test('A lead saved as "no website" by an earlier version is opened once for its links, without a new web check', async () => {
  const { store, done } = tmp();
  try {
    store.save({ placeKey: 'k1', mapsUrl: 'https://www.google.com/maps/place/x', name: 'Rehman Traders', phoneRaw: '+923001234567', address: 'Lahore, Pakistan', websiteStatus: 'no_website', keyword: 'old', isLead: true });
    assert.equal(store.get('k1').social_links, null);
    const first = await search(store, listing({ links: ['https://www.facebook.com/rehman'] }));
    assert.equal(first.row.website_status, 'social_only');
    assert.equal(first.row.keyword, 'old', 'the lead keeps its record');
    assert.deepEqual(first.checks, []);
    // Settled now: another search does not open it again, so nothing changes.
    await search(store, listing({ links: [] }));
    assert.deepEqual(JSON.parse(store.get('k1').social_links), ['facebook.com/rehman']);
  } finally {
    done();
  }
});

test('The CSV has the social links', () => {
  const csv = leadsToCsv([{ name: 'A', phone: '', listingLinks: ['wa.me/1', 'facebook.com/a'], firstSeen: '', categoryName: '' }]);
  assert.match(csv, /Social Links/);
  assert.match(csv, /wa\.me\/1 facebook\.com\/a/);
});
