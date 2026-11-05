'use strict';
// Podcast platforms read from the page: in a real browser, on pages built like
// the real ones. Spotify audiobooks use show addresses too and must stay out.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { readResults, SITES } = require('../src/browser/podcast-read');
const { PodcastSearch } = require('../src/browser/podcast-search');
const pf = require('../src/browser/podcast-platforms');

const exe = ['/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const card = (id, title, host) => `<div data-encore-id="card"><img src="https://i.scdn.co/${id}.jpg"><a href="/show/${id}"><span>${title}</span></a><div>${host}</div></div>`;
const ID = (n) => `2TimH1rd8dZG1Pt5VHYl${n}`;

const PAGES = {
  // Podcasts tab, with audiobooks beside them.
  'https://open.spotify.com/search/marketing/podcastAndEpisodes': `<main><section data-testid="podcasts-search-entity-shelf">${card(ID('A1'), 'Marketing Against the Grain', 'HubSpot')}${card(ID('A2'), 'Online Marketing Made Easy', 'Amy Porterfield')}</section><section data-testid="audiobooks-search-entity-shelf">${card(ID('B1'), 'Marketing For Dummies', 'Jeanette McMurtry')}</section></main>`,
  // A region without podcasts: audiobooks only, on the page and the tab.
  'https://open.spotify.com/search/books/podcastAndEpisodes': '<main></main>',
  'https://open.spotify.com/search/books': `<main><section data-testid="audiobooks-search-entity-shelf" aria-label="Audiobooks">${card(ID('B2'), 'This is Marketing', 'Seth Godin')}</section><section aria-label="Top result">${card(ID('B3'), 'Marketing 7.0', 'Philip Kotler')}</section></main>`,
  // The "All" page: only its podcast section counts.
  'https://open.spotify.com/search/all/podcastAndEpisodes': '<main></main>',
  'https://open.spotify.com/search/all': `<main><section aria-label="Top result">${card(ID('B4'), 'A Book', 'An Author')}</section><section data-testid="podcasts-search-entity-shelf">${card(ID('A3'), 'All Podcast', 'Host')}</section></main>`,
  // Deezer: show names in the episode rows, repeated.
  'https://www.deezer.com/search/marketing/episode': '<ul><li><a href="/us/episode/1">Brainstorming Night</a><a href="/us/show/3558927">DJNTV – Disc Jockey News TV</a></li><li><a href="/us/show/907332">The Diary Of A CEO</a></li><li><a href="/us/show/907332">The Diary Of A CEO</a></li><li><a href="/us/album/5">Not a podcast</a></li></ul>',
  'https://player.fm/search/marketing': '<article><a href="/series/marketing-school"><img src="https://x/y.jpg"></a><a href="/series/marketing-school">Marketing School</a><a href="/series/marketing-school/episodes/1">Episode</a></article><a href="/series/no-name-show"><img src="https://x/z.jpg"></a>',
  'https://www.pandora.com/search/marketing/podcasts': '<a href="/podcast/marketing-today/PC:12345">Marketing Today</a><a href="/artist/x/AR:1">An artist</a>',
};

async function withPage(t, fn) {
  if (!exe) return t.skip('no Chrome here');
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  const context = await browser.newContext();
  await context.route('**/*', (r) => {
    const html = PAGES[r.request().url()];
    return r.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><title>Search</title><body>${html ?? '<p>nothing</p>'}` });
  });
  try {
    await fn(await context.newPage());
  } finally {
    await browser.close();
  }
}
const fast = { pause: 20, limit: 50 };

test('Spotify: podcasts with their publisher; audiobooks left out', async (t) => {
  await withPage(t, async (page) => {
    const shows = await readResults(page, 'spotify', 'marketing', fast);
    assert.deepEqual(shows.map((s) => [s.title, s.host]), [['Marketing Against the Grain', 'HubSpot'], ['Online Marketing Made Easy', 'Amy Porterfield']]);
    assert.equal(shows[0].url, `https://open.spotify.com/show/${ID('A1')}`);
    assert.match(shows[0].artwork, /A1\.jpg/);
  });
});

test('Spotify without podcasts in this region: nothing, never its audiobooks; the All page counts only its podcast section', async (t) => {
  await withPage(t, async (page) => {
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + (shift += 3000); // the page wait passes at once
    try {
      assert.deepEqual(await readResults(page, 'spotify', 'books', fast), []);
      assert.deepEqual((await readResults(page, 'spotify', 'all', fast)).map((s) => s.title), ['All Podcast']);
    } finally {
      Date.now = realNow;
    }
  });
});

test('Deezer, Player FM and Pandora: shows once each, only shows', async (t) => {
  await withPage(t, async (page) => {
    const dz = await readResults(page, 'deezer', 'marketing', fast);
    assert.deepEqual(dz.map((s) => [s.title, s.url]), [['DJNTV – Disc Jockey News TV', 'https://www.deezer.com/show/3558927'], ['The Diary Of A CEO', 'https://www.deezer.com/show/907332']]);
    const fm = await readResults(page, 'playerfm', 'marketing', fast);
    assert.deepEqual(fm.map((s) => [s.title, s.url]), [['Marketing School', 'https://player.fm/series/marketing-school'], ['no name show', 'https://player.fm/series/no-name-show']]);
    const pd = await readResults(page, 'pandora', 'marketing', fast);
    assert.deepEqual(pd.map((s) => s.title), ['Marketing Today']);
  });
});

test('The limit is kept', async (t) => {
  await withPage(t, async (page) => {
    assert.equal((await readResults(page, 'deezer', 'marketing', { ...fast, limit: 1 })).length, 1);
  });
});

// A page without a browser.
const fakePage = (states) => {
  let i = 0;
  return {
    goto: async () => {},
    bringToFront: async () => {},
    evaluate: async (fn) => {
      if (fn.name === 'pageState') return states[Math.min(i++, states.length - 1)];
      if (fn.name === 'showsOnPage') return states[Math.min(i - 1, states.length - 1)].shows || [];
      return undefined;
    },
  };
};

test("Pandora outside the US says so; a human check waits for the user and is never bypassed", async () => {
  await assert.rejects(readResults(fakePage([{ url: 'https://www.pandora.com/restricted', title: 'Pandora', text: 'unavailable' }]), 'pandora', 'x', { pause: 1 }), (e) => e.code === 'region' && /United States/.test(e.message));
  const told = [];
  const check = { url: 'https://player.fm/search/x', title: 'Just a moment...', text: 'Performing security verification' };
  const shows = await readResults(fakePage([check, check, { url: 'https://player.fm/search/x', title: 'Search', text: '', shows: [{ id: 'a', title: 'A' }] }]), 'playerfm', 'x', { pause: 1, onWait: (m) => told.push(m) });
  assert.deepEqual(shows.map((s) => s.title), ['A']);
  assert.equal(told.length, 1, 'told once');
  assert.match(told[0], /Complete it in the Chrome window/);
});

// The search around it.
const memory = () => {
  const saved = [];
  return { saved, startSearch: () => 1, finishSearch: () => {}, savePodcastLead: (l) => (saved.push(l), { lead: { id: saved.length }, isNewLead: true }), updatePodcastLead: () => {}, getSearchLeadByKey: () => null };
};

test('Shows read from a page are kept even if the title lacks the keyword, and are saved with their platform link', async () => {
  const store = memory();
  const events = [];
  const s = new PodcastSearch({
    query: 'marketing',
    platforms: ['spotify', 'deezer'],
    store,
    fetchImpl: async () => new Response(JSON.stringify({ results: [] })),
    findContacts: async () => ({ emails: [] }),
    emit: (e, p) => events.push([e, p]),
    readInBrowser: async (id) => (id === 'spotify' ? [{ id: 'abc', title: 'How I Built This', host: 'NPR', url: 'https://open.spotify.com/show/abc' }] : []),
    openInBrowser: async () => assert.fail('the page is read, not only opened'),
  }).run();
  const done = await s;
  assert.equal(done.found, 1);
  assert.equal(store.saved[0].links.spotify, 'https://open.spotify.com/show/abc');
  const states = events.filter(([e]) => e === 'platform').map(([, p]) => [p.id, p.state, p.count]);
  assert.ok(states.some(([id, st, n]) => id === 'spotify' && st === 'done' && n === 1));
  assert.ok(events.some(([e, p]) => e === 'platform' && p.id === 'deezer' && p.state === 'done' && p.message === SITES.deezer.empty));
});

test('A page that cannot be read is reported for that platform; the others carry on', async () => {
  const events = [];
  await new PodcastSearch({
    query: 'marketing',
    platforms: ['pandora'],
    store: memory(),
    emit: (e, p) => events.push([e, p]),
    readInBrowser: async () => {
      throw Object.assign(new Error('Pandora is only available in the United States.'), { code: 'region' });
    },
  }).run();
  assert.ok(events.some(([e, p]) => e === 'platform' && p.state === 'failed' && /United States/.test(p.message)));
});

test('Listen Notes: its official API with the key; feeds and details come through; a missing key is reported', async () => {
  const urls = [];
  const fetchImpl = async (url, opts) => {
    urls.push([String(url), opts.headers['X-ListenAPI-Key']]);
    const page = urls.length;
    return new Response(JSON.stringify({ next_offset: page * 10, results: page > 1 ? [] : [{ id: 'p1', title_original: '<b>Show</b>', publisher_original: 'Pub', description_original: 'About marketing', rss: 'https://feed.example/rss', website: 'https://show.example', listennotes_url: 'https://www.listennotes.com/c/p1/', image: 'https://i/x.jpg', itunes_id: 123 }] }));
  };
  const res = await pf.ADAPTERS.listennotes.search('marketing', { creds: { apiKey: 'K' }, fetchImpl, limit: 50 });
  assert.equal(res.length, 1);
  assert.deepEqual([res[0].title, res[0].host, res[0].feedUrl, res[0].website, res[0].appleId], ['Show', 'Pub', 'https://feed.example/rss', 'https://show.example', '123']);
  assert.match(urls[0][0], /listen-api\.listennotes\.com\/api\/v2\/search\?q=marketing&type=podcast&offset=0/);
  assert.equal(urls[0][1], 'K');
  await assert.rejects(pf.ADAPTERS.listennotes.check({ apiKey: 'bad' }, { fetchImpl: async () => new Response('{}', { status: 401 }) }), (e) => e.code === 'auth');
  const events = [];
  await new PodcastSearch({ query: 'x y', platforms: ['listennotes'], store: memory(), emit: (e, p) => events.push([e, p]) }).run();
  assert.ok(events.some(([e, p]) => e === 'platform' && p.id === 'listennotes' && p.state === 'needs_key'));
});
