'use strict';

// Podcasts shown by a platform's own search page, read from the user's Chrome
// after the search opens there (like the Google Maps and LinkedIn pages):
// only the show links and names on the page, at a person's pace. No private
// API is called, and a page that asks for a human check waits for the user,
// who completes it in that window. Nothing here gets around a check or a
// region limit: those are reported as they are.

const fail = (message, code) => Object.assign(new Error(message), { code });
const enc = encodeURIComponent;

// urls: the search pages to try, in order, until one shows podcasts.
// path: a show's address (group 1 is its id). within / skip: the page areas to
// keep or leave out. Spotify's show addresses are also used by audiobooks, so
// its audiobook shelves are left out, and its "All" page is only trusted
// inside a podcast section.
const SITES = {
  spotify: {
    label: 'Spotify',
    pages: (t) => [
      { url: `https://open.spotify.com/search/${enc(t)}/podcastAndEpisodes`, skip: '[data-testid^="audiobooks"]' },
      { url: `https://open.spotify.com/search/${enc(t)}`, within: 'section[data-testid*="podcast" i], section[aria-label*="podcast" i]' },
    ],
    path: '^/(?:intl-[a-z-]+/)?show/([A-Za-z0-9]{10,30})',
    showUrl: (id) => `https://open.spotify.com/show/${id}`,
    card: '[data-encore-id="card"]',
    hostLine: true,
    empty: 'Spotify showed no podcasts for this search. In some countries it lists audiobooks but no podcasts: try again with your VPN on.',
  },
  // Deezer's search has no podcast tab: its Episodes tab names each show.
  deezer: {
    label: 'Deezer',
    pages: (t) => [{ url: `https://www.deezer.com/search/${enc(t)}/episode` }],
    path: '^/(?:[a-z]{2}/)?show/(\\d+)',
    showUrl: (id) => `https://www.deezer.com/show/${id}`,
    empty: 'Deezer has no podcast episodes for this search.',
  },
  playerfm: {
    label: 'Player FM',
    pages: (t) => [{ url: `https://player.fm/search/${enc(t)}` }],
    path: '^/(?:[a-z]{2}/)?series/([A-Za-z0-9-]+)/?$',
    showUrl: (id) => `https://player.fm/series/${id}`,
    empty: 'Player FM has no podcasts for this search.',
  },
  pandora: {
    label: 'Pandora',
    pages: (t) => [{ url: `https://www.pandora.com/search/${enc(t)}/podcasts` }],
    path: '^/podcast/(?:[^/]+/)?(PC:\\d+)',
    regionPage: /\/restricted/,
    region: 'Pandora is only available in the United States. Connect your VPN to the US and search again.',
    empty: 'Pandora has no podcasts for this search.',
  },
};

// Runs in the page: the shows on it, once each, in display order.
function showsOnPage({ path, within, skip, card: cardSelector, hostLine }) {
  const re = new RegExp(path);
  const shows = new Map();
  const roots = within ? [...document.querySelectorAll(within)] : [document];
  const lines = (el) => (el?.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const slugName = (s) => s.replace(/-/g, ' ').trim();
  for (const root of roots) {
    for (const a of root.querySelectorAll('a[href]')) {
      const m = re.exec(a.pathname);
      if (!m || (skip && a.closest(skip))) continue;
      const card = a.closest(cardSelector || 'article, li, [role="listitem"], [role="row"]');
      const text = lines(a)[0] || a.getAttribute('aria-label') || a.getAttribute('title') || (cardSelector ? lines(card)[0] : '') || '';
      const old = shows.get(m[1]);
      if (old?.title && !old.fromAddress) continue;
      const seen = hostLine ? lines(card) : [];
      const title = text || (old ? old.title : slugName(/^\w+:/.test(m[1]) ? '' : m[1]));
      shows.set(m[1], {
        id: m[1],
        title,
        fromAddress: !text,
        host: hostLine ? seen.find((l, i) => i > 0 && l !== title && !/^(podcast|show|episode)$/i.test(l)) || '' : '',
        artwork: (card || a).querySelector('img')?.src || '',
        url: a.origin + a.pathname,
      });
    }
  }
  return [...shows.values()].filter((s) => s.title);
}

// Runs in the page: what kind of page it is.
function pageState() {
  return { url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 500) };
}

// Brings the last show on the page into view, for pages that load more as they scroll.
function revealMore(path) {
  const re = new RegExp(path);
  const links = [...document.querySelectorAll('a[href]')].filter((a) => re.test(a.pathname));
  links[links.length - 1]?.scrollIntoView({ block: 'end' });
}

const HUMAN_CHECK = /just a moment|security verification|verify you are human|are you a robot|unusual traffic/i;
const LOAD_WAIT = 10_000;
const CHECK_WAIT = 120_000;
const SCROLLS = 6;

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });
}

// One search page: waits for its shows (or for the user's human check), then
// scrolls until there are enough or no more appear.
async function readPage(page, site, spec, { limit, signal, onWait, pause }) {
  const args = { path: site.path, within: spec.within, skip: spec.skip, card: site.card, hostLine: site.hostLine };
  await page.goto(spec.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.bringToFront().catch(() => {});
  const started = Date.now();
  let waiting = false;
  let shows = [];
  while (!signal?.aborted) {
    const state = await page.evaluate(pageState);
    if (site.regionPage?.test(state.url)) throw fail(site.region, 'region');
    const check = HUMAN_CHECK.test(`${state.title} ${state.text}`);
    if (check && !waiting) {
      waiting = true;
      onWait?.(`${site.label} is asking you to confirm you are human. Complete it in the Chrome window and the search continues.`);
    }
    shows = check ? [] : await page.evaluate(showsOnPage, args);
    if (shows.length) break;
    if (Date.now() - started > (check ? CHECK_WAIT : LOAD_WAIT)) {
      if (check) throw fail(`${site.label}’s check was not completed in the Chrome window.`, 'blocked');
      return [];
    }
    await sleep(pause, signal);
  }
  for (let i = 0; i < SCROLLS && shows.length < limit && !signal?.aborted; i++) {
    await page.evaluate(revealMore, site.path).catch(() => {});
    await sleep(pause * 2, signal);
    const more = await page.evaluate(showsOnPage, args);
    if (more.length <= shows.length) break;
    shows = more;
  }
  return shows;
}

// The podcasts a platform's search shows: [{ id, title, host, artwork, url }].
async function readResults(page, platform, term, { limit = 50, signal, onWait, pause = 800 } = {}) {
  const site = SITES[platform];
  for (const spec of site.pages(term)) {
    const shows = await readPage(page, site, spec, { limit, signal, onWait, pause });
    if (shows.length || signal?.aborted) return shows.slice(0, limit).map((s) => ({ id: s.id, title: s.title, host: s.host, artwork: s.artwork, url: site.showUrl?.(s.id) || s.url }));
  }
  return [];
}

module.exports = { SITES, readResults, showsOnPage };
