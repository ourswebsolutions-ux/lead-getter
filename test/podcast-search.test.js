'use strict';
// Podcast search across platforms: Apple Podcasts and YouTube through their
// official interfaces, Spotify opened in Chrome for the user, Amazon Music
// links, pasted websites (robots.txt respected),
// independent platform switches, platforms that need keys, the same podcast
// on several platforms merged into one row and one lead, automatic email
// discovery and saving as each podcast is found, pasted links, Stop. The
// platforms, feeds and websites are served by a fake fetch shaped like their
// real answers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PodcastSearch } = require('../src/browser/podcast-search');
const pf = require('../src/browser/podcast-platforms');
const { LeadStore } = require('../src/database/db');
const { leadsToCsv } = require('../src/export/csv');

// Routes: exact URL, or a function(url) -> route. A route: { status, body, type } | 'down'.
function fakeFetch(routes, log = []) {
  return async (url, init = {}) => {
    log.push({ url, init });
    let r = routes[url];
    if (!r) for (const [k, v] of Object.entries(routes)) if (k.startsWith('^') && new RegExp(k).test(url)) r = typeof v === 'function' ? v(url, init) : v;
    if (r === 'down') throw new TypeError('fetch failed');
    if (!r) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    const res = new Response(body, { status: r.status || 200, headers: { 'content-type': r.type || (typeof r.body === 'string' ? 'text/html' : 'application/json') } });
    Object.defineProperty(res, 'url', { value: url });
    return res;
  };
}

const rss = ({ title, owner = '', link = '', description = '' }) => ({
  type: 'application/rss+xml',
  body: `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>${title}</title>${link ? `<link>${link}</link>` : ''}<description><![CDATA[${description}]]></description>${
    owner ? `<itunes:owner><itunes:email>${owner}</itunes:email></itunes:owner>` : ''
  }<item><title>Ep 1</title><description>Hello</description></item></channel></rss>`,
});
const appleResult = (id, title, feedUrl, host = 'Host Co') => ({
  kind: 'podcast',
  wrapperType: 'track',
  collectionId: id,
  collectionName: title,
  artistName: host,
  collectionViewUrl: `https://podcasts.apple.com/us/podcast/x/id${id}?uo=4`,
  feedUrl,
  trackCount: 10,
});
const appleSearch = (results) => ({ body: { results } });

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-pcs-'));
  const store = new LeadStore(path.join(dir, 'leads.db'));
  return { store, done: () => (store.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}

async function runSearch(opts) {
  const events = [];
  const ctl = opts.controller || new AbortController();
  const s = new PodcastSearch({ signal: ctl.signal, emit: (e, p) => events.push([e, structuredClone(p)]), ...opts });
  const stats = await s.run();
  const items = new Map();
  for (const [e, p] of events) {
    if (e !== 'item') continue;
    if (p.state === 'merged' || p.state === 'rejected') items.delete(p.key);
    else items.set(p.key, { ...(items.get(p.key) || {}), ...p });
  }
  return { stats, events, items: [...items.values()], platforms: events.filter(([e]) => e === 'platform').map(([, p]) => p) };
}

test('Pasted links are recognised by platform; any other web address is a website; titles compared loosely', () => {
  assert.equal(pf.platformOfUrl('https://podcasts.apple.com/us/podcast/x/id1'), 'apple');
  assert.equal(pf.platformOfUrl('https://open.spotify.com/show/abc'), 'spotify');
  assert.equal(pf.platformOfUrl('https://www.youtube.com/@Show'), 'youtube');
  assert.equal(pf.platformOfUrl('https://music.amazon.com/podcasts/1b2c3d4e-0000-4000-8000-000000000000/crime-junkie'), 'amazon');
  assert.equal(pf.platformOfUrl('https://example.com/'), 'website');
  assert.equal(pf.platformOfUrl('ftp://example.com/'), 'unknown');
  assert.equal(pf.platformOfUrl('true crime'), null);
  assert.equal(pf.titleKey('The Crime Junkie Podcast'), pf.titleKey('Crime Junkie'));
  assert.ok(pf.sameHost('Audiochuck', 'audiochuck') && pf.sameHost('', 'Anyone') && !pf.sameHost('NBC News', 'Audiochuck'));
  assert.deepEqual(Object.keys(pf.PLATFORMS).filter((k) => !pf.PLATFORMS[k].hidden), ['apple', 'spotify', 'youtube', 'amazon'], 'no Podcast Index');
  assert.deepEqual(pf.PLATFORMS.spotify.keys, [], 'Spotify needs no keys');
});

test('Only the selected platforms are searched; missing keys and link-only platforms are reported, not guessed', async () => {
  const log = [];
  const { store, done } = tmpStore();
  try {
    const fetchImpl = fakeFetch({ '^https://itunes\\.apple\\.com/search': appleSearch([]) }, log);
    const opened = [];
    const { platforms, stats } = await runSearch({ query: 'true crime', platforms: ['youtube', 'amazon'], creds: {}, store, fetchImpl, openInBrowser: async (url) => (opened.push(url), { url, status: 200 }) });
    assert.deepEqual(
      platforms.filter((p) => p.state !== 'searching').map((p) => [p.id, p.state]),
      [
        ['youtube', 'needs_key'],
        ['amazon', 'opened'],
      ],
    );
    // Regression: Amazon used to be links-only and never searched (zero leads).
    assert.deepEqual(opened, ['https://music.amazon.com/search/true%20crime?filter=IsLibrary%7Cfalse']);
    assert.equal(log.length, 0, 'no requests without keys');
    assert.equal(stats.found, 0);
  } finally {
    done();
  }
});

test('Spotify: its podcast search opens in Chrome for the user; no Spotify request is made, nothing is counted or saved from it', async () => {
  const { store, done } = tmpStore();
  try {
    const log = [];
    const opened = [];
    const fetchImpl = fakeFetch({ '^https://itunes\\.apple\\.com/search': appleSearch([appleResult(1, 'Solo True Crime', 'https://feeds.example/solo')]), 'https://feeds.example/solo': rss({ title: 'Solo True Crime', owner: 'me@solo.example' }) }, log);
    const { platforms, stats, items } = await runSearch({ query: 'true crime', platforms: ['apple', 'spotify'], store, fetchImpl, openInBrowser: async (url) => opened.push(url) });
    // Regression: ".../search/<term>/podcasts" shows "No Podcasts found"; the search page itself has the results.
    assert.deepEqual(opened, ['https://open.spotify.com/search/true%20crime']);
    const sp = platforms.filter((p) => p.id === 'spotify').at(-1);
    assert.equal(sp.state, 'opened');
    assert.equal(sp.count, undefined, 'no result count for Spotify');
    assert.match(sp.message, /opened in Chrome/);
    assert.ok(!log.some((l) => /spotify\.com/.test(l.url)), 'Spotify is never requested by Lead Finder');
    assert.deepEqual(items.map((i) => i.platforms), [['apple']]);
    assert.equal(stats.found, 1);

    // A pasted show link opens that page; an unsupported Spotify link is refused.
    opened.length = 0;
    const link = await runSearch({ query: 'https://open.spotify.com/show/4V3K3zyD0k789eaSWFXzhc?si=abc', platforms: ['apple'], store, fetchImpl, openInBrowser: async (url) => opened.push(url) });
    assert.deepEqual(opened, ['https://open.spotify.com/show/4V3K3zyD0k789eaSWFXzhc']);
    assert.equal(link.platforms.at(-1).state, 'opened');
    assert.equal(link.items.length, 0);
    const bad = await runSearch({ query: 'https://open.spotify.com/user/someone', platforms: ['apple'], store, fetchImpl, openInBrowser: async () => assert.fail('not opened') });
    assert.equal(bad.platforms.at(-1).state, 'failed');

    // Chrome failing (not installed, Allow not clicked) is reported as such.
    const down = await runSearch({ query: 'crime', platforms: ['spotify'], store, fetchImpl, openInBrowser: async () => { throw new Error('Chrome did not answer: click Allow'); } });
    assert.equal(down.platforms.at(-1).state, 'failed');
    assert.match(down.platforms.at(-1).message, /could not be opened in Chrome: Chrome did not answer/);
    assert.equal(down.stats.found, 0);
    const none = await runSearch({ query: 'crime', platforms: ['spotify'], store, fetchImpl });
    assert.match(none.platforms.at(-1).message, /not available/);
  } finally {
    done();
  }
});

test('Apple + YouTube: one row per podcast, emails found automatically, saved as each is done', async () => {
  const { store, done } = tmpStore();
  try {
    const feedA = 'https://feeds.example/crime-junkie';
    const feedB = 'https://feeds.example/other-show';
    const routes = {
      'https://itunes.apple.com/search?media=podcast&entity=podcast&limit=200&country=us&term=crime': appleSearch([appleResult(111, 'Crime Junkie', feedA, 'audiochuck'), appleResult(222, 'Other Crime Show', feedB, 'Someone'), appleResult(333, 'Down Crime Show', 'https://feeds.example/down')]),
      // YouTube: Crime Junkie's channel, a podcast only on YouTube, and a non-podcast playlist.
      '^https://www\\.googleapis\\.com/youtube/v3/search': { body: { items: [{ id: { playlistId: 'PLcj' } }, { id: { playlistId: 'PLpod' } }, { id: { playlistId: 'PLvideos' } }] } },
      '^https://www\\.googleapis\\.com/youtube/v3/playlists': {
        body: {
          items: [
            { id: 'PLcj', snippet: { title: 'Crime Junkie', channelTitle: 'audiochuck', channelId: 'UCcccccccccccccccccccccc' }, status: { podcastStatus: 'enabled' } },
            { id: 'PLpod', snippet: { title: 'Tube Crime Talk', channelTitle: 'Tube Co', channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', description: 'A talk show' }, status: { podcastStatus: 'enabled' } },
            { id: 'PLvideos', snippet: { title: 'Random videos', channelTitle: 'X' }, status: { podcastStatus: 'disabled' } },
          ],
        },
      },
      'https://www.youtube.com/feeds/videos.xml?channel_id=UCaaaaaaaaaaaaaaaaaaaaaa': {
        type: 'application/atom+xml',
        body: '<feed><entry><title>Ep 9</title><link rel="alternate" href="https://www.youtube.com/watch?v=1"/><media:group><media:description>Business: team@tubetalk.example</media:description></media:group></entry></feed>',
      },
      '^https://itunes\\.apple\\.com/search\\?media=podcast&entity=podcast&limit=200&country=us&term=Tube': appleSearch([]),
      [feedA]: rss({ title: 'Crime Junkie', owner: 'tips@audiochuck.example', link: 'https://crimejunkie.example/' }),
      [feedB]: rss({ title: 'Other Crime Show', link: 'https://other.example/' }),
      'https://other.example/': { body: '<html><body><a href="/contact">Contact</a></body></html>' },
      'https://other.example/contact': { body: '<html><body>Bookings: guests@other.example</body></html>' },
      'https://feeds.example/down': 'down',
    };
    const fetchImpl = fakeFetch(routes);
    const creds = { youtube: { apiKey: 'yt' } };
    const leadsSeen = [];
    const { stats, items, events } = await runSearch({ query: 'crime', platforms: ['apple', 'youtube'], creds, store, fetchImpl, keyword: 'crime' });
    for (const [e, p] of events) if (e === 'lead') leadsSeen.push(p.name);
    const byTitle = Object.fromEntries(items.map((i) => [i.title, i]));
    assert.deepEqual(Object.keys(byTitle).sort(), ['Crime Junkie', 'Down Crime Show', 'Other Crime Show', 'Tube Crime Talk'], 'Crime Junkie once; the non-podcast playlist left out');
    assert.deepEqual(byTitle['Crime Junkie'].platforms.sort(), ['apple', 'youtube']);
    assert.equal(byTitle['Crime Junkie'].result.email, 'tips@audiochuck.example');
    assert.equal(byTitle['Other Crime Show'].result.email, 'guests@other.example', 'found on its website contact page');
    assert.equal(byTitle['Tube Crime Talk'].result.email, 'team@tubetalk.example', 'from the YouTube channel feed');
    assert.equal(byTitle['Down Crime Show'].result.status, 'failed', 'an unreachable feed is never "no email"');
    assert.deepEqual({ found: stats.found, done: stats.done, withEmail: stats.withEmail, failed: stats.failed }, { found: 4, done: 4, withEmail: 3, failed: 1 });

    const leads = store.listLeads({ source: 'podcast' });
    assert.equal(leads.length, 4, 'one lead per podcast');
    const lead = leads.find((l) => l.name === 'Crime Junkie');
    assert.deepEqual(Object.keys(lead.podcastLinks).sort(), ['apple', 'youtube']);
    assert.ok(leadsSeen.length >= 4, 'each lead was sent to the window as it was saved');
    assert.match(leadsToCsv([lead]), /YouTube: https:\/\/www\.youtube\.com\/playlist\?list=PLcj/);

    const again = await runSearch({ query: 'crime', platforms: ['apple', 'youtube'], creds, store, fetchImpl });
    assert.equal(again.stats.newLeads, 0);
    assert.equal(store.listLeads({ source: 'podcast' }).length, 4);
    store.deleteLeads([lead.id]);
    await runSearch({ query: 'crime', platforms: ['youtube'], creds, store, fetchImpl });
    assert.equal(store.listLeads({ source: 'podcast' }).filter((l) => l.name === 'Crime Junkie').length, 0, 'deleted stays deleted');
  } finally {
    done();
  }
});

test('A pasted podcast website: its RSS feed link and contact pages are read, where its robots.txt permits', async () => {
  const { store, done } = tmpStore();
  try {
    const log = [];
    const { robotsChecker } = require('../src/browser/robots');
    const fetchImpl = fakeFetch(
      {
        'https://mypod.example/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /private/\n' },
        'https://mypod.example/': {
          body: '<html><head><title>My Pod | Weekly</title><meta property="og:site_name" content="My Pod"><link rel="alternate" type="application/rss+xml" href="/feed.xml"><link rel="alternate" type="application/rss+xml" href="/comments/feed/"></head><body><a href="/contact">Contact</a><a href="/private/contact-us">More</a></body></html>',
        },
        'https://mypod.example/feed.xml': rss({ title: 'My Pod', link: 'https://mypod.example/' }),
        'https://mypod.example/contact': { body: '<html><body>Write: hello@mypod.example</body></html>' },
        'https://mypod.example/private/contact-us': { body: '<html><body>secret@mypod.example</body></html>' },
        '^https://itunes\\.apple\\.com/search': appleSearch([]),
        // A site that refuses every automated reader.
        'https://closed.example/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /\n' },
        'https://closed.example/': { body: '<html><body>info@closed.example</body></html>' },
      },
      log,
    );
    const allow = robotsChecker({ fetchImpl });
    const { items, stats } = await runSearch({ query: 'https://mypod.example/', platforms: ['apple'], store, fetchImpl, allow });
    assert.equal(items.length, 1);
    const it = items[0];
    assert.equal(it.title, 'My Pod');
    assert.deepEqual(it.platforms, ['website']);
    assert.equal(it.result.rssUrl, 'https://mypod.example/feed.xml', 'the podcast feed, not the comments feed');
    assert.equal(it.result.rssStatus, 'valid');
    assert.equal(it.result.email, 'hello@mypod.example');
    assert.ok(!log.some((l) => l.url.includes('/private/')), 'a disallowed page is never fetched');
    assert.equal(stats.withEmail, 1);
    assert.equal(store.listLeads({ source: 'podcast' })[0].podcastLinks.website, 'https://mypod.example/');

    const closed = await runSearch({ query: 'https://closed.example/', platforms: ['apple'], store, fetchImpl, allow });
    assert.equal(closed.items.length, 0);
    assert.equal(closed.platforms.at(-1).state, 'not_permitted');
    assert.match(closed.platforms.at(-1).message, /does not permit automated reading/);
    assert.ok(!log.some((l) => l.url === 'https://closed.example/'), 'the refused site itself is never fetched');
  } finally {
    done();
  }
});

test('robots.txt rules: our own group, else "*"; the longest match wins; Allow can reopen a path', () => {
  const { parseRobots, allowedBy } = require('../src/browser/robots');
  const rules = parseRobots('User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /a/\nAllow: /a/open\nDisallow: /*.pdf$\n');
  assert.equal(allowedBy(rules, 'https://x.example/'), true);
  assert.equal(allowedBy(rules, 'https://x.example/a/secret'), false);
  assert.equal(allowedBy(rules, 'https://x.example/a/open/page'), true);
  assert.equal(allowedBy(rules, 'https://x.example/files/doc.pdf'), false);
  assert.equal(allowedBy(parseRobots('User-agent: LeadFinder\nDisallow: /\nUser-agent: *\nAllow: /\n'), 'https://x.example/'), false, 'a rule for us wins');
  assert.equal(allowedBy(parseRobots('User-agent: *\nDisallow:\n'), 'https://x.example/x'), true, 'an empty Disallow allows all');
});

test('A pasted Amazon Music link: matched by the name in its address on Apple Podcasts, then processed', async () => {
  const { store, done } = tmpStore();
  try {
    const feed = 'https://feeds.example/morbid';
    const fetchImpl = fakeFetch({
      '^https://itunes\\.apple\\.com/search\\?media=podcast&entity=podcast&limit=200&country=us&term=morbid': appleSearch([appleResult(333, 'Morbid', feed, 'Ash & Alaina')]),
      [feed]: rss({ title: 'Morbid', owner: 'info@morbid.example' }),
    });
    const { items, stats } = await runSearch({ query: 'https://music.amazon.com/podcasts/1b2c3d4e-0000-4000-8000-000000000000/morbid', platforms: ['apple'], store, fetchImpl });
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Morbid');
    assert.deepEqual(items[0].platforms.sort(), ['amazon', 'apple']);
    assert.equal(items[0].result.email, 'info@morbid.example');
    assert.equal(items[0].result.rssFrom, 'Apple Podcasts (same title)');
    assert.equal(stats.withEmail, 1);
    const bare = await runSearch({ query: 'https://music.amazon.com/podcasts/1b2c3d4e-0000-4000-8000-000000000000', platforms: ['apple'], store, fetchImpl });
    assert.equal(bare.items.length, 0);
    assert.match(bare.platforms.at(-1).message, /no podcast name/);
  } finally {
    done();
  }
});

test('A pasted YouTube channel link works without a key (public channel page and video feed)', async () => {
  const { store, done } = tmpStore();
  try {
    const id = 'UCbbbbbbbbbbbbbbbbbbbbbb';
    const fetchImpl = fakeFetch({
      'https://www.youtube.com/@ShowTube': { body: `<html><head><meta property="og:title" content="Show Tube"><meta property="og:description" content="Weekly show. Business inquiries: biz@showtube.example"></head><body><script>{"externalId":"${id}"}</script></body></html>` },
      [`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`]: { type: 'application/atom+xml', body: '<feed></feed>' },
      '^https://itunes\\.apple\\.com/search': appleSearch([]),
    });
    const { items } = await runSearch({ query: 'https://www.youtube.com/@ShowTube', platforms: ['apple'], store, fetchImpl });
    assert.equal(items[0].title, 'Show Tube');
    assert.equal(items[0].result.email, 'biz@showtube.example');
    assert.equal(items[0].links.youtube, `https://www.youtube.com/channel/${id}`);
  } finally {
    done();
  }
});

test('Stop ends the search; podcasts not yet checked stay saved with email discovery pending', async () => {
  const { store, done } = tmpStore();
  try {
    const ctl = new AbortController();
    const many = Array.from({ length: 8 }, (_, i) => appleResult(500 + i, `Show ${i}`, `https://feeds.example/s${i}`));
    const fetchImpl = async (url) => {
      if (url.includes('itunes.apple.com')) return new Response(JSON.stringify({ results: many }), { headers: { 'content-type': 'application/json' } });
      ctl.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    const { stats, items } = await runSearch({ query: 'shows', platforms: ['apple'], store, fetchImpl, controller: ctl, concurrency: 1 });
    assert.equal(stats.state, 'stopped');
    assert.ok(items.every((i) => i.state === 'stopped'));
    // Regression: podcasts found but not yet checked were lost on Stop. They are
    // saved at once, with email discovery pending.
    const saved = store.podcastLeads({});
    assert.equal(saved.total, 8);
    assert.deepEqual(saved.counts, { all: 8, found: 0, none: 0, pending: 8 });
  } finally {
    done();
  }
});

test('YouTube keys the platform refuses are reported as refused keys', async () => {
  const fetchImpl = fakeFetch({
    '^https://www\\.googleapis\\.com/youtube/v3/search': { status: 400, body: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', errors: [{ reason: 'badRequest' }] } } },
  });
  await assert.rejects(pf.ADAPTERS.youtube.check({ apiKey: 'bad' }, { fetchImpl }), (e) => e.code === 'auth');
});

test('A website without a feed link is checked as it is, never matched by title to another podcast; Apple private-relay addresses are platform addresses', async () => {
  const { store, done } = tmpStore();
  try {
    const log = [];
    const fetchImpl = fakeFetch(
      {
        'https://namesake.example/': { body: '<html><head><title>Big Show</title></head><body><a href="/contact">Contact</a></body></html>' },
        'https://namesake.example/contact': { body: '<html><body>Hi: team@namesake.example</body></html>' },
        '^https://itunes\\.apple\\.com/search': appleSearch([appleResult(9, 'Big Show', 'https://feeds.example/other-big-show')]),
        'https://feeds.example/other-big-show': rss({ title: 'Big Show', owner: 'x1y2@privaterelay.appleid.com' }),
      },
      log,
    );
    const { items } = await runSearch({ query: 'https://namesake.example/', platforms: ['apple'], store, fetchImpl });
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].platforms, ['website']);
    assert.equal(items[0].result.email, 'team@namesake.example');
    assert.ok(!log.some((l) => l.url.includes('itunes.apple.com') || l.url.includes('other-big-show')), 'no title lookup');
  } finally {
    done();
  }
  const pcs = require('../src/browser/podcasts');
  assert.equal(pcs.emailKind('x1y2@privaterelay.appleid.com', ''), 'platform');
});

test('A Spotify page that answers with an error is reported, not counted as opened', async () => {
  const { store, done } = tmpStore();
  try {
    const r = await runSearch({ query: 'crime', platforms: ['spotify'], store, fetchImpl: fakeFetch({}), openInBrowser: async (url) => ({ url, status: 404 }) });
    assert.equal(r.platforms.at(-1).state, 'failed');
    assert.match(r.platforms.at(-1).message, /HTTP 404/);
    const ok = await runSearch({ query: 'crime', platforms: ['spotify'], store, fetchImpl: fakeFetch({}), openInBrowser: async (url) => ({ url, status: 200 }) });
    assert.equal(ok.platforms.at(-1).loadedUrl, 'https://open.spotify.com/search/crime');
  } finally {
    done();
  }
});

test('Each search is its own: its keyword, platforms, hits (new or already saved), counts; leads without an email are saved too', async () => {
  const { store, done } = tmpStore();
  try {
    const f1 = 'https://feeds.example/one';
    const f2 = 'https://feeds.example/two';
    const f3 = 'https://feeds.example/three';
    const fetchImpl = fakeFetch({
      'https://itunes.apple.com/search?media=podcast&entity=podcast&limit=200&country=us&term=black%20women%20podcast': appleSearch([appleResult(1, 'Black Women Talk', f1), appleResult(2, 'Black Women in Video Editing', f2)]),
      'https://itunes.apple.com/search?media=podcast&entity=podcast&limit=200&country=us&term=video%20editing': appleSearch([appleResult(2, 'Black Women in Video Editing', f2), appleResult(3, 'Video Editing Weekly', f3)]),
      [f1]: rss({ title: 'Black Women Talk', owner: 'one@one.example' }),
      [f2]: rss({ title: 'Black Women in Video Editing' }),
      [f3]: rss({ title: 'Video Editing Weekly', owner: 'three@three.example' }),
    });
    const a = await runSearch({ query: 'black women podcast', platforms: ['apple'], store, fetchImpl });
    const b = await runSearch({ query: 'video editing', platforms: ['apple'], store, fetchImpl });
    assert.deepEqual(a.items.map((i) => i.title), ['Black Women Talk', 'Black Women in Video Editing']);
    assert.deepEqual(b.items.map((i) => i.title), ['Black Women in Video Editing', 'Video Editing Weekly'], 'the second search shows its own results');
    assert.deepEqual([a.stats.newLeads, a.stats.duplicates, a.stats.saved], [2, 0, 2]);
    assert.deepEqual([b.stats.newLeads, b.stats.duplicates, b.stats.saved], [1, 1, 2]);
    // Every event names its run: a late event from search a can't touch search b.
    const runA = a.events.find(([e]) => e === 'item')[1].runId;
    const runB = b.events.find(([e]) => e === 'item')[1].runId;
    assert.ok(runA && runB && runA !== runB);
    assert.ok(a.events.filter(([e]) => e !== 'lead').every(([, p]) => p.runId === runA));
    // Saved: all three, with and without email; each search lists its own.
    const all = store.podcastLeads({});
    assert.deepEqual(all.counts, { all: 3, found: 2, none: 1, pending: 0 });
    assert.equal(store.podcastLeads({ status: 'none' }).rows[0].name, 'Black Women in Video Editing');
    assert.deepEqual(store.podcastLeads({ searchId: b.stats.searchId, sort: 'name', dir: 'asc' }).rows.map((r) => r.name), ['Black Women in Video Editing', 'Video Editing Weekly']);
    const two = all.rows.find((r) => r.name === 'Black Women in Video Editing');
    assert.deepEqual(two.hits.map((h) => [h.keyword, h.platform, h.outcome]).sort(), [['black women podcast', 'apple', 'new'], ['video editing', 'apple', 'duplicate']]);
    assert.ok(two.hits.every((h) => h.sourceUrl.startsWith('https://podcasts.apple.com/') && h.foundAt));
    const searches = store.podcastSearches();
    assert.deepEqual(searches.map((x) => [x.keyword, x.state, x.found, x.platforms.join()]), [['video editing', 'done', 2, 'apple'], ['black women podcast', 'done', 2, 'apple']]);
    assert.equal(searches[0].stats.newLeads, 1);
  } finally {
    done();
  }
});

test('Rejected results are counted and explained: YouTube playlists that are not podcasts', async () => {
  const { store, done } = tmpStore();
  try {
    const fetchImpl = fakeFetch({
      '^https://www\\.googleapis\\.com/youtube/v3/search': { body: { items: [{ id: { playlistId: 'PL1' } }, { id: { playlistId: 'PL2' } }] } },
      '^https://www\\.googleapis\\.com/youtube/v3/playlists': { body: { items: [{ id: 'PL1', snippet: { title: 'Videos' }, status: { podcastStatus: 'disabled' } }, { id: 'PL2', snippet: { title: 'More videos' }, status: {} }] } },
    });
    const r = await runSearch({ query: 'cooking', platforms: ['youtube'], creds: { youtube: { apiKey: 'k' } }, store, fetchImpl });
    assert.equal(r.stats.rejected, 2);
    const yt = r.platforms.filter((p) => p.id === 'youtube').at(-1);
    assert.equal(yt.state, 'done');
    assert.match(yt.message, /2 results were not podcasts/);
    assert.equal(store.podcastLeads({}).total, 0);
  } finally {
    done();
  }
});

test('Retry: saved leads are checked again (no platform searched); a found email is kept', async () => {
  const { store, done } = tmpStore();
  try {
    const feed = 'https://feeds.example/later';
    let published = false;
    const fetchImpl = async (url) => {
      if (url === feed) return new Response(rss({ title: 'Later', owner: published ? 'now@later.example' : '' }).body, { headers: { 'content-type': 'application/rss+xml' } });
      if (url.includes('itunes.apple.com/search')) return new Response(JSON.stringify({ results: [appleResult(7, 'Later', feed)] }), { headers: { 'content-type': 'application/json' } });
      return new Response('nope', { status: 404 });
    };
    await runSearch({ query: 'later', platforms: ['apple'], store, fetchImpl });
    const lead = store.podcastLeads({}).rows[0];
    assert.equal(lead.emailStatus, 'none');
    published = true;
    const seed = [{ leadId: lead.id, appleId: '7', title: lead.name, host: lead.podcastHost, feedUrl: lead.rssUrl, links: lead.podcastLinks, platform: 'apple', platforms: ['apple'] }];
    const r = await runSearch({ query: 'retry', seed, platforms: [], store, fetchImpl });
    assert.equal(r.stats.withEmail, 1);
    assert.equal(r.stats.searchId, null, 'a retry is not a new search');
    const after = store.podcastLeads({}).rows;
    assert.equal(after.length, 1);
    assert.equal(after[0].email, 'now@later.example');
    assert.equal(after[0].emailStatus, 'found');
  } finally {
    done();
  }
});

test('Upgrade to version 11: existing podcast leads are kept and get their email status (found, none, failed)', () => {
  const { store, done } = tmpStore();
  try {
    store.savePodcastLead({ id: '1', title: 'Has email', appleUrl: 'https://podcasts.apple.com/x/id1', email: 'a@a.example', status: 'found', discovery: 'email: found (RSS feed: channel owner)' });
    store.savePodcastLead({ id: '2', title: 'No email', appleUrl: 'https://podcasts.apple.com/x/id2', status: 'not_found', discovery: 'email: No public email found (checked: RSS feed)' });
    store.savePodcastLead({ id: '3', title: 'Not checked', appleUrl: 'https://podcasts.apple.com/x/id3', status: 'failed', discovery: 'email: Not checked: the feed could not be read (HTTP 404)' });
    // As a version 10 database: no status, no search tables.
    store.db.exec("UPDATE businesses SET email_status = NULL; DROP TABLE search_hits; DROP TABLE searches; PRAGMA user_version = 10;");
    store.migrate();
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 17);
    const rows = store.podcastLeads({ sort: 'name', dir: 'asc' }).rows.map((r) => [r.name, r.emailStatus]);
    assert.deepEqual(rows, [['Has email', 'found'], ['No email', 'none'], ['Not checked', 'failed']]);
    assert.ok(store.startSearch({ keyword: 'x', platforms: [] }) > 0, 'search tables created');
  } finally {
    done();
  }
});

test('Apple: results not about the keyword are rejected (its loose matches like "Edition" for "editing"); best matches first', async () => {
  const { store, done } = tmpStore();
  try {
    const feeds = { a: 'https://feeds.example/a', b: 'https://feeds.example/b', c: 'https://feeds.example/c', d: 'https://feeds.example/d' };
    const fetchImpl = fakeFetch({
      'https://itunes.apple.com/search?media=podcast&entity=podcast&limit=200&country=us&term=video%20editing': appleSearch([
        appleResult(1, 'The Video Editing Podcast', feeds.a),
        appleResult(2, 'Cuts and Frames', feeds.b), // about it, says only its feed
        appleResult(3, 'GeoTerra: Podcast Edition', feeds.c),
        appleResult(4, 'Game Breaker - MP3 Edition', feeds.d),
      ]),
      [feeds.a]: rss({ title: 'The Video Editing Podcast', owner: 'a@a.example' }),
      [feeds.b]: rss({ title: 'Cuts and Frames', description: 'A weekly show about video editing for YouTubers.' }),
      [feeds.c]: rss({ title: 'GeoTerra: Podcast Edition', description: 'Maps and geography.' }),
      [feeds.d]: rss({ title: 'Game Breaker - MP3 Edition', description: 'Sports talk.' }),
    });
    const r = await runSearch({ query: 'video editing', platforms: ['apple'], store, fetchImpl });
    assert.deepEqual(r.items.map((i) => i.title).sort(), ['Cuts and Frames', 'The Video Editing Podcast']);
    assert.equal(r.stats.rejected, 2);
    assert.equal(r.stats.saved, 2);
    const rejected = r.events.filter(([e, p]) => e === 'item' && p.state === 'rejected').map(([, p]) => [p.title, p.reason]);
    assert.deepEqual(rejected.sort(), [['Game Breaker - MP3 Edition', 'not about the keyword'], ['GeoTerra: Podcast Edition', 'not about the keyword']]);
    assert.deepEqual(store.podcastLeads({}).rows.map((x) => x.name).sort(), ['Cuts and Frames', 'The Video Editing Podcast'], 'rejected results are never saved');
    // Best match: the platform's own order.
    assert.deepEqual(store.podcastLeads({ searchId: r.stats.searchId, sort: 'rank' }).rows.map((x) => x.name), ['The Video Editing Podcast', 'Cuts and Frames']);
  } finally {
    done();
  }
});

test('Podcasts opened in the Spotify / Amazon Music window: only their address decides what is added', () => {
  const show = 'https://open.spotify.com/show/4V3K3zyD0k789eaSWFXzhc';
  assert.deepEqual(pf.browserFindOf('https://casefilepodcast.com/', 'spotify', show), { platform: 'website', url: 'https://casefilepodcast.com/', extraLinks: { spotify: show } });
  assert.deepEqual(pf.browserFindOf('https://mypod.example/', 'spotify', 'https://open.spotify.com/search/x'), { platform: 'website', url: 'https://mypod.example/', extraLinks: null });
  const am = 'https://music.amazon.com/podcasts/14f37f6e-7952-4454-a474-d54cbb7a3d06/hidden-brain';
  assert.deepEqual(pf.browserFindOf(am, 'amazon'), { platform: 'amazon', url: am });
  assert.equal(pf.browserFindOf('https://music.amazon.com/search/x?filter=IsLibrary%7Cfalse', 'amazon'), null, 'a search page is not a podcast');
  for (const own of ['https://accounts.spotify.com/login', 'https://www.amazon.com/ap/signin', 'https://apps.apple.com/app/spotify', 'about:blank', 'chrome://newtab'])
    assert.equal(pf.browserFindOf(own, 'spotify', show), null, own);
});

test('Podcast lead management: delete and export touch only the chosen podcast leads; other lead kinds are never affected', () => {
  const { store, done } = tmpStore();
  try {
    const mk = (i, extra = {}) => store.savePodcastLead({ id: String(i), title: `Show ${i}`, appleUrl: `https://podcasts.apple.com/x/id${i}`, status: 'not_found', ...extra }).lead.id;
    const ids = Array.from({ length: 30 }, (_, i) => mk(i + 1));
    const tricky = mk(99, { title: 'Comma, "Quote" & Urdu اردو\nnew line', email: 'hi@tricky.example', status: 'found', emails: [{ email: 'hi@tricky.example', kind: 'own', from: 'RSS feed: channel owner' }] });
    const maps = store.save({ placeKey: '0xmaps:1', mapsUrl: 'https://www.google.com/maps/place/x', name: 'Maps Shop', phoneRaw: '0300 1234567', address: 'Lahore', websiteStatus: 'no_website' }).lead?.id ?? store.listLeads({ source: 'maps' })[0].id;
    // Select all matching (across pages) follows the filters.
    assert.equal(store.podcastLeadIds({}).length, 31);
    assert.deepEqual(store.podcastLeadIds({ status: 'found' }), [tricky]);
    assert.equal(store.podcastLeadIds({ search: 'Show 1' }).length, 11); // Show 1, 10-19
    // Export: exactly the ids asked for (a non-podcast id is ignored); all = every podcast lead.
    const sel = [ids[0], ids[5], tricky, maps];
    const out = store.podcastLeadsForExport({ ids: sel });
    assert.deepEqual(out.map((l) => l.id).sort((a, b) => a - b), [ids[0], ids[5], tricky].sort((a, b) => a - b));
    assert.equal(store.podcastLeadsForExport({ all: true }).length, 31);
    const csv = leadsToCsv(out).replace(/^﻿/, '');
    assert.ok(csv.includes('"Comma, ""Quote"" & Urdu اردو\nnew line"'), 'commas, quotes, Unicode and line breaks are quoted');
    assert.match(csv, /hi@tricky\.example/);
    // Delete selected: only those podcast leads (the Maps lead in the list is left alone).
    assert.equal(store.deletePodcastLeads({ ids: [ids[0], ids[1], maps] }), 2);
    assert.equal(store.podcastLeads({}).counts.all, 29);
    assert.equal(store.listLeads({ source: 'maps' }).length, 1);
    // Delete all: every podcast lead; the Maps lead stays.
    assert.equal(store.deletePodcastLeads({ all: true }), 29);
    assert.equal(store.podcastLeads({}).counts.all, 0);
    assert.deepEqual(store.listLeads({}).map((l) => l.name), ['Maps Shop']);
    assert.equal(store.deletePodcastLeads({ ids: [] }), 0, 'an empty selection deletes nothing');
  } finally {
    done();
  }
});
