'use strict';
// The daily allowance inside a real search: both workers (Google Maps and
// Facebook, side by side, mocked pages) charge each new lead with the
// licence server through the app's client before saving it.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const maps = require('../src/browser/maps');
const fb = require('../src/browser/facebook');
const { createApp } = require('../server/src/app');
const { testLicenseStore } = require('./license-harness');
const { LicenseClient } = require('../src/main/license');
const { CreditGate } = require('../src/main/credits');
const { LeadStore } = require('../src/database/db');
const { SearchSession } = require('../src/browser/search-session');
const { FacebookSession } = require('../src/browser/facebook-session');
const { runSources } = require('../src/browser/search-sources');

const FAST = { listing: [0, 0], scroll: [0, 0], longBreak: [0, 0], afterBlock: 0, blockPoll: 5, netRetries: [1, 1], reconnectDelays: [1], fbScroll: [0, 0], fbBetweenQueries: [0, 0], fbLoad: 30, fbStallWait: [0, 0] };
const tick = () => new Promise((r) => setTimeout(r, 1));
const page = (name) => ({ name, bringToFront: async () => {}, url: () => '', evaluate: async () => true });

async function licence(t) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const mails = [];
  const config = { publicBaseUrl: 'http://placeholder', adminEmail: 'admin@example.com', licensePrivateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }), timezone: 'Asia/Karachi' };
  const sb = testLicenseStore();
  const server = createApp({ config, store: sb.store, mailer: { send: async (m) => mails.push(m) }, logger: { error() {} } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => (server.close(), sb.drop()));
  const client = new LicenseClient({ store: new LeadStore(':memory:'), cipher: null, config: { serverUrl: `http://127.0.0.1:${server.address().port}`, publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }, machineId: crypto.randomUUID() });
  return { client, mails, sb };
}

function mockMaps(listings) {
  let opened = null;
  const calls = { opened: 0 };
  return {
    calls,
    placeKey: maps.placeKey,
    cleanMapsUrl: maps.cleanMapsUrl,
    detectBlock: async () => null,
    search: async () => (await tick(), { mode: 'list' }),
    collectLinks: async () => listings.map((l) => ({ url: l.url, name: l.name })),
    scrollFeed: async () => ({ end: true }),
    openListing: async (_p, link) => (await tick(), calls.opened++, (opened = listings.find((l) => l.url === link.url)), true),
    gotoListing: async () => false,
    returnToResults: async () => true,
    extractDetails: async () => ({ name: opened.name, website: '', phoneTel: opened.phone, phoneText: '', address: 'Lahore, Pakistan', infoLoaded: true, closed: false, url: opened.url }),
  };
}

function mockFacebook(posts) {
  return {
    buildQueries: () => ['garments Lahore'],
    extractPhones: fb.extractPhones,
    openSearch: async () => (await tick(), { mode: 'list' }),
    detectState: async () => null,
    expandSeeMore: async () => 0,
    collectPosts: async () => (await tick(), posts),
    resultsState: async () => ({ count: posts.length, lastKey: '', height: 1, loading: false, end: true }),
    scrollResults: async () => ({ end: true }),
    nudge: async () => ({ end: true }),
    waitForMore: async (_p, before) => ({ ...before, grew: false }),
  };
}

const listing = (n, phone) => ({ url: `https://www.google.com/maps/place/B${n}/data=!1s0x${n}:0x${n}`, name: `Shop ${n}`, phone });
const post = (n, phone) => fb.parsePost({ text: `Wholesale, call ${phone}`, author: `Author ${n}`, authorUrl: `https://www.facebook.com/a${n}`, hrefs: [`https://www.facebook.com/a${n}/posts/${n}`] });

async function search({ client, store, listings, posts }) {
  const status = await client.status();
  const gate = new CreditGate({ license: client, credits: status.credits });
  const statuses = [];
  const cat = store.ensureCategory('Garments');
  const signal = new AbortController().signal;
  const pages = { main: async () => page('maps'), check: async () => page('maps'), detail: async () => page('maps'), facebook: async () => page('facebook') };
  const mapsMock = mockMaps(listings);
  await runSources({
    withFacebook: true,
    withMaps: status.sources.includes('maps'),
    signal,
    send: (e, p) => e === 'status' && statuses.push(p),
    createMaps: (emit) => new SearchSession({ keyword: 'garments Lahore', categoryId: cat.id, store, pages, signal, credits: gate, maps: mapsMock, webCheck: async () => ({ status: 'no_website' }), pacing: FAST, emit }),
    createFacebook: (emit) => new FacebookSession({ keyword: 'garments Lahore', categoryId: cat.id, country: 'PK', store, pages, signal, credits: gate, facebook: mockFacebook(posts), pacing: FAST, emit }),
  });
  return { last: statuses.at(-1), mapsMock, gate };
}

test('Free: Google Maps stops at 5, Facebook keeps its own 5; one number found by both is one lead and one charge', async (t) => {
  const { client } = await licence(t);
  const store = new LeadStore(':memory:');
  const listings = Array.from({ length: 12 }, (_, i) => listing(i + 1, `+92300${1000000 + i}`));
  // Facebook: 7 posts, the first with a number Google Maps finds too.
  const posts = [post(0, '0300 1000000'), ...Array.from({ length: 6 }, (_, i) => post(i + 1, `0321 ${2000000 + i}`))];
  const { last, mapsMock } = await search({ client, store, listings, posts });

  const all = store.listLeads();
  const fromMaps = all.filter((l) => l.sources.includes('maps')).length;
  const fbOnly = all.filter((l) => l.source === 'facebook').length;
  const st = await client.status();
  assert.equal(st.credits.maps.used, 5, 'never more than 5 from Google Maps');
  assert.equal(st.credits.facebook.used, 5, 'never more than 5 from Facebook');
  assert.equal(fromMaps + fbOnly, all.length);
  assert.equal(all.length, 10, '5 + 5 leads saved; the shared number is one lead');
  assert.ok(mapsMock.calls.opened <= 7, `Maps stopped opening listings once its allowance was used (${mapsMock.calls.opened})`);
  assert.deepEqual([last.state, last.workers.maps.state, last.workers.facebook.state], ['done', 'completed', 'completed']);
  assert.match(last.workers.maps.message, /Today's Google Maps leads are used up \(5 of 5\)\. More at/);
  assert.match(last.message, /Facebook: .*Today's Facebook leads are used up \(5 of 5\)/);
  assert.deepEqual(st.sources, []);

  // Searching again the same day: everything found already is a duplicate,
  // and nothing new can be charged.
  const again = await search({ client, store, listings, posts });
  assert.equal(store.listLeads().length, 10);
  assert.deepEqual([(await client.status()).credits.maps.used, (await client.status()).credits.facebook.used], [5, 5]);
  assert.match(again.last.workers.facebook.message, /used up/);
});

test('paid: one shared daily total stops both sources; leads already saved cost nothing', async (t) => {
  const { client, mails, sb } = await licence(t);
  await client.requestActivation('monthly');
  await client.verifyCode(mails[0].text.match(/Activation code: (\d{4})/)[1]);
  // 96 of the 100 used earlier today (the server's own counter).
  const day = (await client.status()).credits.day;
  sb.store.q("INSERT INTO credit_usage (account, day, bucket, used) VALUES (?, ?, 'total', 96)").run(`device:${client.deviceId}`, day);
  const store = new LeadStore(':memory:');
  // Two leads saved before (no charge when found again).
  store.save({ placeKey: maps.placeKey(listing(1).url), mapsUrl: 'u', name: 'Shop 1', phoneRaw: '+923001000000', address: 'Lahore, Pakistan', websiteStatus: 'no_website' });
  store.save({ placeKey: maps.placeKey(listing(2).url), mapsUrl: 'u', name: 'Shop 2', phoneRaw: '+923001000001', address: 'Lahore, Pakistan', websiteStatus: 'no_website' });
  const listings = Array.from({ length: 8 }, (_, i) => listing(i + 1, `+92300${1000000 + i}`));
  const posts = Array.from({ length: 6 }, (_, i) => post(i + 1, `0321 ${2000000 + i}`));
  const { last } = await search({ client, store, listings, posts });
  const st = await client.status();
  assert.deepEqual(st.credits.total, { used: 100, limit: 100, remaining: 0 });
  assert.equal(store.listLeads().length, 2 + 4, 'exactly the 4 that were left, from either source');
  assert.equal(last.state, 'done');
  assert.ok(Object.values(last.workers).every((w) => w.state === 'completed'));
  assert.ok(Object.values(last.workers).some((w) => /Today's 100 leads are used up/.test(w.message)));
});
