'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const maps = require('../src/browser/maps');
const { LeadStore } = require('../src/database/db');
const { SearchSession } = require('../src/browser/search-session');

const FAST = { listing: [0, 0], scroll: [0, 0], longBreak: [0, 0], afterBlock: 0, blockPoll: 5, netRetries: [1, 1] };

const place = (n) => ({
  url: `https://www.google.com/maps/place/Biz${n}/data=!4m2!3m1!1s0x${n}:0x${n}?authuser=0`,
  name: `Biz ${n}`,
});

// A mocked Maps results list: listings are revealed a page at a time as the
// feed scrolls; details come from a table of fake listings.
function mockMaps(listings, { pageSize = 2, blocks = [] } = {}) {
  let shown = pageSize;
  let opened = null;
  const calls = { open: 0, detectBlock: 0 };
  const blockQueue = blocks.slice();
  return {
    calls,
    placeKey: maps.placeKey,
    cleanMapsUrl: maps.cleanMapsUrl,
    detectBlock: async () => {
      calls.detectBlock++;
      return blockQueue.length ? blockQueue.shift() : null;
    },
    search: async () => ({ mode: listings.length ? 'list' : 'empty' }),
    collectLinks: async () => listings.slice(0, shown).map((l) => ({ url: l.url, name: l.name })),
    scrollFeed: async () => {
      shown += pageSize;
      return { end: shown >= listings.length };
    },
    openListing: async (_p, link) => {
      calls.open++;
      opened = listings.find((l) => l.url === link.url);
      return true;
    },
    gotoListing: async () => false,
    returnToResults: async () => true,
    extractDetails: async () => ({
      name: opened.name,
      website: opened.website || '',
      phoneTel: opened.phone || '',
      phoneText: '',
      address: opened.address || 'Lahore, Pakistan',
      infoLoaded: opened.infoLoaded !== false,
      closed: false,
      url: opened.url,
    }),
  };
}

const fakePage = { bringToFront: async () => {}, url: () => '', evaluate: async () => true };
const pages = { main: async () => fakePage, check: async () => fakePage, detail: async () => fakePage };

function run({ listings, webCheck, store = new LeadStore(':memory:'), signal = new AbortController().signal, ...opts }) {
  const events = [];
  const m = mockMaps(listings, opts);
  const session = new SearchSession({
    keyword: 'Real Estate Lahore',
    store,
    pages,
    signal,
    maps: m,
    webCheck: webCheck || (async () => ({ status: 'no_website' })),
    pacing: FAST,
    emit: (event, payload) => events.push({ event, payload }),
  });
  return { session, events, store, maps: m, done: session.run() };
}

test('only businesses without a website become leads, emitted as they are found', async () => {
  const listings = [
    { ...place(1), phone: '+923001111111' },
    { ...place(2), website: 'https://biz2.pk/' },
    { ...place(3), website: 'https://facebook.com/biz3' },
    { ...place(4), infoLoaded: false },
    { ...place(5) },
  ];
  const webCheck = async (_p, d) => (d.name === 'Biz 5' ? { status: 'possible_website', detail: 'biz5.com' } : { status: 'no_website' });
  const { events, store, done } = run({ listings, webCheck });
  const stats = await done;

  const leads = events.filter((e) => e.event === 'lead').map((e) => e.payload.name);
  assert.deepEqual(leads, ['Biz 1', 'Biz 3']);
  assert.equal(stats.processed, 5);
  assert.equal(stats.leads, 2);
  assert.equal(store.listLeads().length, 2);
  assert.equal(store.get('0x2:0x2').website_status, 'has_website');
  assert.equal(store.get('0x4:0x4').website_status, 'unverified');
  assert.equal(store.get('0x5:0x5').website_status, 'possible_website');
  // Lead events arrive before the search finishes.
  const firstLead = events.findIndex((e) => e.event === 'lead');
  const finished = events.findIndex((e) => e.payload.state === 'done');
  assert.ok(firstLead < finished);
  assert.equal(store.get('0x1:0x1').maps_url, 'https://www.google.com/maps/place/Biz1/data=!4m2!3m1!1s0x1:0x1');
});

test('a second search does not reopen or duplicate settled businesses', async () => {
  const store = new LeadStore(':memory:');
  const listings = [{ ...place(1), phone: '+92300' }, { ...place(2), website: 'https://b.pk' }];
  await run({ listings, store }).done;
  const again = run({ listings, store });
  await again.done;
  assert.equal(again.maps.calls.open, 0);
  assert.equal(store.listLeads().length, 1);
  assert.equal(again.events.filter((e) => e.event === 'lead').length, 0);
});

test('Stop ends the search promptly and keeps saved leads', async () => {
  const controller = new AbortController();
  const listings = Array.from({ length: 50 }, (_, i) => place(i + 1));
  let checks = 0;
  const webCheck = async () => {
    if (++checks === 3) controller.abort();
    return { status: 'no_website' };
  };
  const { events, store, done } = run({ listings, webCheck, signal: controller.signal });
  const stats = await done;
  assert.equal(events.at(-1).payload.state, 'stopped');
  assert.ok(stats.processed < 50);
  assert.ok(store.listLeads().length >= 2);
});

test('a CAPTCHA pauses automation until it is cleared', async () => {
  const listings = [place(1)];
  const { events, done } = run({ listings, blocks: [null, 'captcha', 'captcha'] });
  await done;
  const states = events.filter((e) => e.event === 'status').map((e) => e.payload.state);
  const pauseAt = states.indexOf('paused');
  assert.ok(pauseAt > 0, 'search paused');
  assert.equal(events.find((e) => e.payload.state === 'paused').payload.message.includes('CAPTCHA'), true);
  assert.equal(states.at(-1), 'done');
});

test('a closed Chrome tab stops the search with a clear error', async () => {
  const m = mockMaps([place(2)]);
  m.openListing = async () => {
    throw new Error('page.click: Target page, context or browser has been closed');
  };
  const ev = [];
  const s = new SearchSession({
    keyword: 'k',
    store: new LeadStore(':memory:'),
    pages,
    signal: new AbortController().signal,
    maps: m,
    webCheck: async () => ({ status: 'no_website' }),
    pacing: FAST,
    emit: (_e, p) => ev.push(p),
  });
  await s.run();
  assert.equal(ev.at(-1).state, 'error');
  assert.match(ev.at(-1).message, /tab was closed/);
});

test('empty search results finish without leads', async () => {
  const { events, done } = run({ listings: [] });
  await done;
  assert.equal(events.at(-1).payload.state, 'done');
  assert.match(events.at(-1).payload.message, /no results for "Real Estate Lahore"/);
});

test('a search that never runs is reported as a search error, not as "no results"', async () => {
  const m = mockMaps([place(1)]);
  m.search = async () => ({ mode: 'failed', attempts: 2, detail: 'no results appeared' });
  const ev = [];
  const s = new SearchSession({ keyword: 'Real Estate Lahore', store: new LeadStore(':memory:'), pages, signal: new AbortController().signal, maps: m, pacing: FAST, emit: (_e, p) => ev.push(p) });
  await s.run();
  assert.equal(ev.at(-1).state, 'error');
  assert.equal(ev.at(-1).phase, 'search');
  assert.match(ev.at(-1).message, /did not run: no results appeared/);
});

// Pages are objects; the mock blocks the original Maps tab until it is
// replaced, so recovery has to move the work to a new tab.
function recoveryHarness({ freshTabBlocked, canRestart }) {
  const listings = Array.from({ length: 6 }, (_, i) => place(i + 1));
  const m = mockMaps(listings, { pageSize: 3 });
  const tabsOpened = [];
  const blockedPages = new Set();
  const page0 = { name: 'tab0', bringToFront: async () => {}, url: () => '', evaluate: async () => true, goto: async () => {}, close: async () => {} };
  let main = page0;
  let searches = 0;
  m.MAPS_HOME = 'https://www.google.com/maps?hl=en';
  m.search = async () => {
    searches++;
    return { mode: 'list' };
  };
  // After 2 listings on tab0, Google starts blocking tab0.
  let opened = 0;
  const realOpen = m.openListing;
  m.openListing = async (p, link) => {
    if (++opened === 2) blockedPages.add(page0);
    return realOpen(p, link);
  };
  m.detectBlock = async (p) => (blockedPages.has(p) ? 'captcha' : null);
  const restarts = [];
  const pagesX = {
    main: async () => main,
    check: async () => main,
    detail: async () => main,
    open: async () => {
      const p = { ...page0, name: `tab${tabsOpened.length + 1}` };
      tabsOpened.push(p);
      if (freshTabBlocked) blockedPages.add(p);
      return p;
    },
    adopt: async (_role, p) => {
      main = p;
    },
  };
  const recovery = {
    canRestart: () => canRestart,
    restart: async () => {
      restarts.push(1);
      main = { ...page0, name: 'after-restart' };
      return true;
    },
  };
  return { m, listings, pagesX, recovery, restarts, tabsOpened, searches: () => searches };
}

test('CAPTCHA recovery: a fresh tab in the same session takes over, without duplicates or skipped listings', async () => {
  const h = recoveryHarness({ freshTabBlocked: false, canRestart: false });
  const store = new LeadStore(':memory:');
  const ev = [];
  const s = new SearchSession({
    keyword: 'k', store, pages: h.pagesX, recovery: h.recovery, signal: new AbortController().signal, maps: h.m,
    webCheck: async () => ({ status: 'no_website' }),
    pacing: { ...FAST, freshTabAfter: 10, restartAfter: 10_000 },
    emit: (e, p) => ev.push({ e, p }),
  });
  const stats = await s.run();
  assert.equal(ev.at(-1).p.state, 'done');
  assert.equal(h.tabsOpened.length, 1);
  assert.equal(h.searches(), 2, 'search re-run in the new tab');
  assert.equal(h.restarts.length, 0);
  assert.equal(store.listLeads().length, 6, 'every listing processed once');
  assert.equal(ev.filter((x) => x.e === 'lead').length, 6, 'no duplicate lead events');
  assert.equal(stats.processed, 6);
  assert.ok(ev.some((x) => x.p.state === 'paused' && /CAPTCHA/.test(x.p.message)));
});

test('CAPTCHA recovery: restarts Chrome once when a fresh tab is blocked too and restart is supported', async () => {
  const h = recoveryHarness({ freshTabBlocked: true, canRestart: true });
  const store = new LeadStore(':memory:');
  const ev = [];
  const s = new SearchSession({
    keyword: 'k', store, pages: h.pagesX, recovery: h.recovery, signal: new AbortController().signal, maps: h.m,
    webCheck: async () => ({ status: 'no_website' }),
    pacing: { ...FAST, freshTabAfter: 10, restartAfter: 20 },
    emit: (e, p) => ev.push({ e, p }),
  });
  await s.run();
  assert.equal(ev.at(-1).p.state, 'done');
  assert.equal(h.tabsOpened.length, 1, 'one fresh-tab attempt only');
  assert.equal(h.restarts.length, 1, 'one restart only');
  assert.equal(store.listLeads().length, 6);
});

test('CAPTCHA that persists without supported restart waits for the user and is never retried in a loop', async () => {
  const h = recoveryHarness({ freshTabBlocked: true, canRestart: false });
  const controller = new AbortController();
  const ev = [];
  const s = new SearchSession({
    keyword: 'k', store: new LeadStore(':memory:'), pages: h.pagesX, recovery: h.recovery, signal: controller.signal, maps: h.m,
    webCheck: async () => ({ status: 'no_website' }),
    pacing: { ...FAST, freshTabAfter: 10, restartAfter: 20 },
    emit: (e, p) => ev.push({ e, p }),
  });
  setTimeout(() => controller.abort(), 300);
  await s.run();
  assert.equal(ev.at(-1).p.state, 'stopped');
  assert.equal(h.tabsOpened.length, 1);
  assert.equal(h.restarts.length, 0);
});

test('a deleted lead is not added again by a later search', async () => {
  const store = new LeadStore(':memory:');
  const listings = [{ ...place(1), phone: '+92300' }, { ...place(2), phone: '+92301' }];
  await run({ listings, store }).done;
  const [first] = store.listLeads().filter((l) => l.name === 'Biz 1');
  store.deleteLeads([first.id]);
  const again = run({ listings, store });
  await again.done;
  assert.deepEqual(store.listLeads().map((l) => l.name), ['Biz 2']);
  assert.equal(again.events.filter((e) => e.event === 'lead').length, 0);
});

test('Chrome closing mid-search: reconnects, resumes, and adds no duplicates', async () => {
  const listings = Array.from({ length: 6 }, (_, i) => ({ ...place(i + 1), phone: '+923001234567' }));
  const m = mockMaps(listings, { pageSize: 3 });
  let opened = 0;
  let crashed = false;
  const realOpen = m.openListing;
  m.openListing = async (p, link) => {
    if (++opened === 3 && !crashed) {
      crashed = true;
      throw new Error('page.click: Target page, context or browser has been closed');
    }
    return realOpen(p, link);
  };
  let reconnects = 0;
  const store = new LeadStore(':memory:');
  const ev = [];
  const s = new SearchSession({
    keyword: 'k', store, pages, signal: new AbortController().signal, maps: m,
    recovery: { canRestart: () => false, reconnect: async () => { reconnects++; } },
    webCheck: async () => ({ status: 'no_website' }),
    pacing: { ...FAST, reconnectDelays: [5, 5, 5] },
    emit: (e, p) => ev.push({ e, p }),
  });
  const stats = await s.run();
  assert.equal(reconnects, 1);
  assert.equal(ev.at(-1).p.state, 'done');
  assert.ok(ev.some((x) => x.p.state === 'paused' && x.p.phase === 'connection' && /Chrome closed unexpectedly/.test(x.p.message)));
  assert.equal(store.listLeads().length, 6, 'the interrupted listing is processed after reconnecting');
  assert.equal(ev.filter((x) => x.e === 'lead').length, 6, 'no duplicates');
  assert.equal(stats.processed, 6);
});

test('Chrome recovery gives up after limited, spaced attempts', async () => {
  const m = mockMaps([place(1)]);
  m.search = async () => {
    throw new Error('Target page, context or browser has been closed');
  };
  let attempts = 0;
  const ev = [];
  const s = new SearchSession({
    keyword: 'k', store: new LeadStore(':memory:'), pages, signal: new AbortController().signal, maps: m,
    recovery: { canRestart: () => false, reconnect: async () => { attempts++; throw new Error('Chrome did not start'); } },
    pacing: { ...FAST, reconnectDelays: [5, 5, 5] },
    emit: (_e, p) => ev.push(p),
  });
  await s.run();
  assert.equal(attempts, 3);
  assert.equal(ev.at(-1).state, 'error');
  assert.equal(ev.at(-1).phase, 'connection');
  assert.match(ev.at(-1).message, /Could not reconnect to Chrome/);
});

test('reconnecting to a different Chrome profile stops instead of switching accounts', async () => {
  const m = mockMaps([place(1)]);
  m.search = async () => {
    throw new Error('Target page, context or browser has been closed');
  };
  let attempts = 0;
  const ev = [];
  const s = new SearchSession({
    keyword: 'k', store: new LeadStore(':memory:'), pages, signal: new AbortController().signal, maps: m,
    recovery: { canRestart: () => false, reconnect: async () => { attempts++; throw Object.assign(new Error('different profile'), { code: 'wrong_profile' }); } },
    pacing: { ...FAST, reconnectDelays: [5, 5, 5] },
    emit: (_e, p) => ev.push(p),
  });
  await s.run();
  assert.equal(attempts, 1);
  assert.match(ev.at(-1).message, /different profile/);
});

test('a persistent Google Search CAPTCHA gets one fresh-tab try (on the blocked page) and then waits, never cycling', async () => {
  const listings = Array.from({ length: 4 }, (_, i) => place(i + 1));
  const m = mockMaps(listings, { pageSize: 4 });
  const blockedUrl = 'https://www.google.com/search?hl=en&q=%22Biz%201%22';
  const checkPage = { name: 'check', bringToFront: async () => {}, evaluate: async () => true, url: () => `https://www.google.com/sorry/index?continue=${encodeURIComponent(blockedUrl)}` };
  const opened = [];
  m.MAPS_HOME = 'https://www.google.com/maps?hl=en';
  // The search page stays blocked; Google's home page would not be.
  m.detectBlock = async (p) => (p === checkPage || (p.visited || '').includes('/search') ? 'captcha' : null);
  let searches = 0;
  const realSearch = m.search;
  m.search = async (...a) => {
    searches++;
    return realSearch(...a);
  };
  const controller = new AbortController();
  const ev = [];
  const s = new SearchSession({
    keyword: 'k',
    store: new LeadStore(':memory:'),
    signal: controller.signal,
    maps: m,
    pages: {
      main: async () => fakePage,
      detail: async () => fakePage,
      check: async () => checkPage,
      open: async () => {
        const p = { goto: async (u) => (p.visited = u), close: async () => {} };
        opened.push(p);
        return p;
      },
      adopt: async () => {
        throw new Error('must not adopt a blocked tab');
      },
    },
    recovery: { canRestart: () => false, reconnect: async () => {} },
    webCheck: async () => ({ status: 'blocked' }),
    pacing: { ...FAST, freshTabAfter: 10, restartAfter: 20 },
    emit: (_e, p) => ev.push(p),
  });
  setTimeout(() => controller.abort(), 400);
  await s.run();
  assert.equal(opened.length, 1, 'one fresh-tab attempt for the whole search');
  assert.equal(opened[0].visited, blockedUrl, 'fresh tab retried the blocked page itself');
  assert.equal(searches, 1, 'no search restarts');
  assert.equal(ev.at(-1).state, 'stopped');
  assert.ok(ev.some((p) => /A fresh tab is blocked too/.test(p.message)));
});

// --- Website filter -----------------------------------------------------------

function filterRun(listings, websiteFilter, store = new LeadStore(':memory:')) {
  const checked = [];
  const r = run({ listings, store, webCheck: async (_p, d) => (checked.push(d.name), { status: 'no_website' }) });
  r.session.websiteFilter = websiteFilter;
  return { ...r, checked };
}
const mixed = () => [
  { ...place(1), phone: '+923001111111' }, // no website
  { ...place(2), phone: '+923002222222', website: 'https://biz2.pk/' }, // website
  { ...place(3), phone: '+923003333333', website: 'https://facebook.com/biz3' }, // social only
];

test('website filter "without": only businesses without an own website (unchanged behaviour)', async () => {
  const { done, store } = filterRun(mixed(), 'without');
  await done;
  assert.deepEqual(store.listLeads().map((l) => l.name).sort(), ['Biz 1', 'Biz 3']);
});

test('website filter "with": only businesses with a website; no web checks needed', async () => {
  const { done, store, checked } = filterRun(mixed(), 'with');
  const stats = await done;
  const leads = store.listLeads();
  assert.deepEqual(leads.map((l) => l.name), ['Biz 2']);
  assert.equal(leads[0].websiteStatus, 'Website: biz2.pk');
  assert.equal(leads[0].phone, '+923002222222');
  assert.deepEqual(checked, [], 'Google web check skipped');
  assert.equal(stats.leads, 1);
  // The website-less business was not settled; a later "without" search can still take it.
  assert.equal(store.get('0x1:0x1').website_status, 'unverified');
});

test('website filter "all": both kinds are leads', async () => {
  const { done, store } = filterRun(mixed(), 'all');
  await done;
  assert.deepEqual(store.listLeads().map((l) => [l.name, l.websiteStatus]).sort(), [
    ['Biz 1', 'No website found'],
    ['Biz 2', 'Website: biz2.pk'],
    ['Biz 3', 'No website (social page only: facebook.com/biz3)'],
  ]);
  assert.equal(store.listLeads({ website: 'with' }).length, 1);
  assert.equal(store.listLeads({ website: 'without' }).length, 2);
});

test('a business skipped by an earlier filter is reopened (with its details) when a later search wants it', async () => {
  const store = new LeadStore(':memory:');
  await filterRun(mixed(), 'without', store).done;
  assert.equal(store.get('0x2:0x2').qualified, 0);
  assert.equal(store.get('0x2:0x2').phone, null, 'details not kept for non-leads');
  const later = filterRun(mixed(), 'with', store);
  await later.done;
  assert.equal(later.maps.calls.open, 1, 'only the website business reopened');
  const lead = store.listLeads({ website: 'with' })[0];
  assert.equal(lead.name, 'Biz 2');
  assert.equal(lead.phone, '+923002222222');
  assert.equal(store.listLeads().length, 3, 'earlier leads kept, no duplicates');
});

test('deleted leads stay deleted under every filter', async () => {
  const store = new LeadStore(':memory:');
  await filterRun(mixed(), 'all', store).done;
  store.deleteLeads(store.listLeads().filter((l) => l.name === 'Biz 2').map((l) => l.id));
  const again = filterRun(mixed(), 'with', store);
  await again.done;
  assert.equal(again.maps.calls.open, 0);
  assert.deepEqual(store.listLeads().map((l) => l.name).sort(), ['Biz 1', 'Biz 3']);
});

test('"WhatsApp available only" filter keeps just WhatsApp-confirmed numbers', async () => {
  const store = new LeadStore(':memory:');
  await filterRun(mixed(), 'all', store).done;
  store.setWhatsAppResult('+923001111111', 'available', 'baileys');
  store.setWhatsAppResult('+923002222222', 'unavailable', 'baileys');
  store.setWhatsAppStatus('+923003333333', 'available', 'manual'); // not provider-confirmed
  assert.deepEqual(store.listLeads({ whatsapp: 'available' }).map((l) => l.name), ['Biz 1']);
  assert.equal(store.countLeads({ whatsapp: 'available' }), 1);
});
