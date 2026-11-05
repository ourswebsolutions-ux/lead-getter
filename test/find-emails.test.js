'use strict';
// "Find Emails from Websites" for Google Maps, and LinkedIn contact details
// that don't depend on ContactOut's presence.
const test = require('node:test');
const assert = require('node:assert/strict');
const maps = require('../src/browser/maps');
const { LeadStore } = require('../src/database/db');
const { SearchSession } = require('../src/browser/search-session');
const { findContacts, contactsFromHtml } = require('../src/browser/website-contacts');

const FAST = { listing: [0, 0], scroll: [0, 0], longBreak: [0, 0], afterBlock: 0, blockPoll: 5, netRetries: [1, 1] };
const html = (body) => new Response(`<html><body>${body}</body></html>`, { headers: { 'content-type': 'text/html' } });

function site(pages) {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    const body = pages[url];
    if (body === undefined) return new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } });
    if (body instanceof Error) throw body;
    const res = html(body);
    Object.defineProperty(res, 'url', { value: url });
    return res;
  };
  return { asked, fetchImpl };
}

test('emails anywhere on a page: footer, navigation, mailto, Cloudflare protection, structured data', () => {
  const key = 0x42;
  const hex = key.toString(16) + [...'hidden@shop.example'].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');
  const page = `<nav><a href="mailto:Sales@shop.example?subject=hi">Mail</a></nav>
    <span class="__cf_email__" data-cfemail="${hex}">[email protected]</span>
    <script type="application/ld+json">{"email":"mailto:ld@shop.example"}</script>
    <footer>Write to info@shop.example. <img src="logo@2x.png"> <a href="mailto:bad%@x">x</a></footer>`;
  const { emails } = contactsFromHtml(page, 'https://shop.example/');
  for (const e of ['sales@shop.example', 'hidden@shop.example', 'ld@shop.example', 'info@shop.example']) assert.ok(emails.includes(e), `${e} in ${emails}`);
  assert.ok(!emails.some((e) => e.includes('2x')));
});

test('an email on the home page: no other page is read', async () => {
  const s = site({ 'https://a.example/': '<a href="/contact">Contact</a> info@a.example' });
  const r = await findContacts('https://a.example/', { fetchImpl: s.fetchImpl, stopAtEmail: true, guess: true, maxPages: 6 });
  assert.deepEqual(r.emails, ['info@a.example']);
  assert.deepEqual(s.asked, ['https://a.example/']);
});

test('no email on the home page: Contact, then About, then the usual addresses; stops when one is found', async () => {
  const linked = site({ 'https://a.example/': '<a href="/about">About</a><a href="/contact">Contact</a>', 'https://a.example/contact': 'none', 'https://a.example/about': 'hello@a.example', 'https://a.example/team-about': 'x' });
  const r = await findContacts('https://a.example/', { fetchImpl: linked.fetchImpl, stopAtEmail: true, guess: true, maxPages: 6 });
  assert.deepEqual(r.emails, ['hello@a.example']);
  assert.deepEqual(linked.asked, ['https://a.example/', 'https://a.example/contact', 'https://a.example/about']);
  // A menu built by scripts: nothing linked in the page.
  const bare = site({ 'https://b.example/': 'welcome', 'https://b.example/contact-us': 'sales@b.example' });
  const g = await findContacts('https://b.example/', { fetchImpl: bare.fetchImpl, stopAtEmail: true, guess: true, maxPages: 6 });
  assert.deepEqual(g.emails, ['sales@b.example']);
  // robots.txt: a refused page isn't read.
  const r2 = site({ 'https://c.example/': 'x', 'https://c.example/contact': 'no@c.example' });
  const refused = await findContacts('https://c.example/', { fetchImpl: r2.fetchImpl, guess: true, maxPages: 6, stopAtEmail: true, allow: async (u) => !u.endsWith('/contact') });
  assert.deepEqual(refused.emails, []);
  assert.ok(!r2.asked.includes('https://c.example/contact'));
});

const listing = (n, website) => ({ url: `https://www.google.com/maps/place/Biz${n}/data=!4m2!3m1!1s0x${n}:0x${n}`, name: `Biz ${n}`, website, phone: `+92300123456${n}` });
function mapsMock(listings) {
  let opened = null;
  return {
    placeKey: maps.placeKey,
    cleanMapsUrl: maps.cleanMapsUrl,
    detectBlock: async () => null,
    search: async () => ({ mode: 'list' }),
    collectLinks: async () => listings.map((l) => ({ url: l.url, name: l.name })),
    scrollFeed: async () => ({ end: true }),
    openListing: async (_p, link) => ((opened = listings.find((l) => l.url === link.url)), true),
    extractDetails: async () => ({ name: opened.name, phoneTel: opened.phone, phoneText: '', address: 'Lahore, Pakistan', website: opened.website, infoLoaded: true, closed: false, url: opened.url }),
    gotoListing: async () => true,
    isOffline: async () => false,
    returnToResults: async () => true,
  };
}
const fakePage = () => ({ bringToFront: async () => {}, url: () => 'https://www.google.com/maps', goto: async () => { throw new Error('net::ERR_FAILED'); }, content: async () => '<html></html>', waitForTimeout: async () => {}, waitForLoadState: async () => {} });

async function run({ listings, s, findEmails, store = new LeadStore(':memory:'), filter = 'with', contacts, allow = null }) {
  const page = fakePage();
  const pages = { main: async () => page, check: async () => page, detail: async () => page, open: async () => page, adopt: () => {} };
  const events = [];
  const session = new SearchSession({ keyword: 'shops', websiteFilter: filter, store, pages, signal: new AbortController().signal, maps: mapsMock(listings), webCheck: async () => ({ status: 'no_website' }), pacing: FAST, emit: (e, p) => events.push([e, p]), findEmails, allow, fetchImpl: s.fetchImpl, ...(contacts ? { contacts } : {}) });
  await session.run();
  return { store, events, session };
}

test('Google Maps, option off: no website is visited and leads are saved as before', async () => {
  const s = site({ 'https://one.example/': 'info@one.example' });
  const { store } = await run({ listings: [listing(1, 'https://one.example/')], s, findEmails: false });
  assert.deepEqual(s.asked, []);
  const [lead] = store.listLeads();
  assert.equal(lead.email, '');
  assert.equal(lead.discovery || '', '');
});

test('Google Maps, option on: each email on the right lead, a shared site read once, a dead site reported, the phone and address kept', async () => {
  const s = site({
    'https://one.example/': '<a href="/contact">Contact</a>',
    'https://one.example/contact': 'info@one.example gmail-owner@gmail.com',
    'https://two.example/': 'sales@two.example',
    'https://dead.example/': new Error('network down'),
  });
  const listings = [listing(1, 'https://one.example/'), listing(2, 'https://two.example/'), listing(3, 'https://www.one.example/branch'), listing(4, 'https://dead.example/')];
  const { store } = await run({ listings, s, findEmails: true });
  const by = Object.fromEntries(store.listLeads().map((l) => [l.name, l]));
  assert.equal(by['Biz 1'].email, 'info@one.example');
  assert.deepEqual(by['Biz 1'].emails.map((e) => e.email), ['info@one.example', 'gmail-owner@gmail.com']);
  assert.equal(by['Biz 1'].emails[0].url, 'https://one.example/contact');
  assert.equal(by['Biz 2'].email, 'sales@two.example');
  assert.equal(by['Biz 3'].email, 'info@one.example', 'the same site: not read again');
  assert.equal(s.asked.filter((u) => u === 'https://one.example/').length, 1);
  assert.equal(by['Biz 4'].email, '');
  assert.match(by['Biz 4'].discovery, /could not read dead\.example/);
  assert.equal(by['Biz 1'].phone, '+923001234561');
  assert.match(by['Biz 1'].address, /Lahore/);
  assert.equal(store.listLeads().length, 4);
});

test('Google Maps, option on: a lead saved earlier gets its email once; a later search reads nothing again', async () => {
  const s = site({ 'https://one.example/': 'info@one.example' });
  const store = new LeadStore(':memory:');
  const listings = [listing(1, 'https://one.example/')];
  await run({ listings, s, findEmails: false, store });
  assert.equal(store.listLeads()[0].email, '');
  await run({ listings, s, findEmails: true, store });
  assert.equal(store.listLeads()[0].email, 'info@one.example');
  const before = s.asked.length;
  await run({ listings, s, findEmails: true, store });
  assert.equal(s.asked.length, before);
});

test('Google Maps, option on: a business with no website is unaffected, and robots.txt refusing a site skips Chrome too', async () => {
  const s = site({});
  const shown = [];
  const contacts = { ...require('../src/browser/website-contacts'), findContactsInPage: async () => (shown.push('chrome'), { emails: [], pages: [] }) };
  const { store } = await run({ listings: [listing(1, undefined), listing(2, 'https://private.example/')], s, findEmails: true, filter: 'all', contacts, allow: async () => false });
  assert.equal(store.listLeads().length, 2);
  assert.deepEqual(s.asked, []);
  assert.deepEqual(shown, []);
  assert.match(store.listLeads().find((l) => l.name === 'Biz 2').discovery, /robots/);
});

test('Google Maps, option on: a site that refuses a plain request is read in Chrome', async () => {
  const s = site({});
  const contacts = { ...require('../src/browser/website-contacts'), findContactsInPage: async () => ({ emails: ['js@shop.example'], phones: [], pages: ['https://shop.example/'], via: 'browser' }) };
  const { store } = await run({ listings: [listing(1, 'https://shop.example/')], s, findEmails: true, contacts });
  assert.equal(store.listLeads()[0].email, 'js@shop.example');
});
