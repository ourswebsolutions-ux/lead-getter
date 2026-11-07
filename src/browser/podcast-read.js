'use strict';

// Podcasts shown by a platform's own search page, read from the user's Chrome
// after the search opens there (like the Google Maps and LinkedIn pages):
// only the show links and names on the page, at a person's pace. No private
// API is called, and a page that asks for a human check waits for the user,
// who completes it in that window. Nothing here gets around a check or a
// region limit: those are reported as they are.

const { textOf } = require('./website-contacts');

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
    // A long list may drop the rows scrolled past: everything seen is kept.
    const seen = new Map(shows.map((s) => [s.id, s]));
    for (const s of await page.evaluate(showsOnPage, args)) if (!seen.has(s.id)) seen.set(s.id, s);
    if (seen.size <= shows.length) break;
    shows = [...seen.values()];
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

// --- a Spotify show or episode: its descriptions --------------------------------

// What a page says about itself, for search engines and link previews, in its
// JSON-LD and <meta> tags: the full description, whatever the page's layout.
// An episode's reads "Listen to this episode from <show> on Spotify. <text>".
function metadataOf(html) {
  const out = { name: '', description: '', publisher: '', show: '' };
  const clean = (s) => textOf(String(s || '').replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\n/g, '\n')).trim();
  const meta = (name) => {
    const tag = String(html).match(new RegExp(`<meta\\b[^>]*(?:name|property)="${name}"[^>]*>`, 'i'))?.[0] || '';
    return clean(/\bcontent="([^"]*)"/i.exec(tag)?.[1]);
  };
  for (const m of String(html).matchAll(/<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    if (!/\/(show|episode)\//.test(`${data?.url || ''}${data?.['@id'] || ''}`)) continue;
    out.name = out.name || clean(data.name);
    out.description = out.description || clean(data.description);
    out.publisher = out.publisher || clean(data.publisher || data.author?.name);
  }
  out.name = out.name || meta('og:title');
  out.description = out.description || meta('description');
  const lead = /^Listen to (?:this episode from )?(.+?) on Spotify\.\s*/i.exec(out.description);
  if (lead) {
    out.description = out.description.slice(lead[0].length);
    out.show = lead[1];
  }
  return out;
}

// Runs in the page: what is rendered, for what the metadata does not give.
function detailsOnPage(episodePath) {
  const main = document.querySelector('main, [role="main"], [data-testid="main-view-container"]') || document.body;
  const re = new RegExp(episodePath);
  const heads = [...main.querySelectorAll('h1, h2, h3')].filter((h) => /^(about|description|episode description)$/i.test(h.innerText.trim()));
  // Visible text, plus the addresses behind mailto: links.
  const withMail = (el) => [(el?.innerText || '').trim(), ...[...(el?.querySelectorAll('a[href^="mailto:" i]') || [])].map((a) => a.getAttribute('href'))].join('\n').trim();
  const sections = heads.map((h) => {
    let box = h.parentElement;
    for (let i = 0; i < 4 && box !== main && box.innerText.length < h.innerText.length + 20; i++) box = box.parentElement;
    return withMail(box);
  });
  const episodes = new Map();
  for (const a of main.querySelectorAll('a[href]')) {
    const m = re.exec(a.pathname);
    if (!m || episodes.has(m[1])) continue;
    const row = a.closest('[role="listitem"], [role="row"], [data-testid*="episode" i], li') || a.parentElement;
    episodes.set(m[1], { id: m[1], title: (a.innerText || a.getAttribute('aria-label') || '').trim().split('\n')[0], url: a.origin + a.pathname, text: withMail(row).slice(0, 4000) });
  }
  const show = [...main.querySelectorAll('a[href]')].find((a) => /^\/(?:intl-[a-z-]+\/)?show\/[A-Za-z0-9]{10,30}/.test(a.pathname));
  return {
    head: `${document.head?.outerHTML || ''}${[...document.querySelectorAll('body script[type="application/ld+json"]')].map((s) => s.outerHTML).join('')}`,
    heading: main.querySelector('h1')?.innerText.trim() || '',
    sections,
    body: withMail(main).slice(0, 20_000),
    episodes: [...episodes.values()],
    show: show ? { url: show.origin + show.pathname, name: show.innerText.trim().split('\n')[0] } : null,
    artwork: document.querySelector('meta[property="og:image"]')?.content || '',
  };
}

// Runs in the page: opens the descriptions cut short behind a "more" button.
// Only these buttons are pressed: nothing is played, followed or signed in to.
function expandDescriptions() {
  const main = document.querySelector('main, [role="main"]') || document.body;
  let pressed = 0;
  for (const b of main.querySelectorAll('button, [role="button"]')) {
    const text = (b.innerText || b.getAttribute('aria-label') || '').trim();
    if (/^(\.\.\.|…)?\s*(show|see|read)\s+more$/i.test(text) && !b.closest('a')) {
      b.click();
      pressed++;
    }
  }
  return pressed;
}

// Runs in the page: asks for more episodes, by its button or by scrolling to
// the last one (the page loads more as it scrolls).
function loadMoreEpisodes(episodePath) {
  const main = document.querySelector('main, [role="main"]') || document.body;
  const re = new RegExp(episodePath);
  for (const b of main.querySelectorAll('button, [role="button"]')) {
    if (/^(load|show|see)\s+more(\s+episodes)?$|^more episodes$/i.test((b.innerText || b.getAttribute('aria-label') || '').trim()) && !b.closest('a')) b.click();
  }
  const links = [...main.querySelectorAll('a[href]')].filter((a) => re.test(a.pathname));
  links[links.length - 1]?.scrollIntoView({ block: 'end' });
}

const EPISODE_PATH = '^/(?:intl-[a-z-]+/)?episode/([A-Za-z0-9]{10,30})';
const REGION = /not currently available in your region/i;
const MISSING = /^page not available/i;
const ROWS_WAIT = 5_000;
const MORE_ROUNDS = 8; // times the show page is asked for more episodes
const MAX_ROWS = 60; // episodes listed from one show page
const BUSY_WAIT = 30_000; // after Spotify answers "too many requests"

// One show or episode page. The page's own metadata (as served, then as it
// stands once rendered) comes first; the visible description is added to it,
// and the whole page is read only when neither exists. Throws with a reason
// when the page cannot be read: that is never the same as "no email".
async function readSpotifyPage(page, url, { signal, onWait, pause = 800, busyWait = BUSY_WAIT } = {}) {
  const type = /\/episode\//.test(url) ? 'episode' : 'show';
  let res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  if (res?.status() === 429) {
    onWait?.('Spotify asks to slow down: waiting before the next page.');
    await sleep(busyWait, signal);
    if (signal?.aborted) throw fail('stopped', 'stopped');
    res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (res?.status() === 429) throw fail('Spotify is limiting requests: try this podcast again later', 'busy');
  }
  const served = (await res?.text().catch(() => '')) || '';
  const started = Date.now();
  let waiting = false;
  let got = null;
  while (!signal?.aborted) {
    const state = await page.evaluate(pageState);
    if (REGION.test(`${state.title} ${state.text}`)) throw fail('Spotify does not offer this in your region: turn on your VPN and try again', 'region');
    const check = HUMAN_CHECK.test(`${state.title} ${state.text}`);
    if (check && !waiting) {
      waiting = true;
      onWait?.('Spotify is asking you to confirm you are human. Complete it in the Chrome window and the search continues.');
    }
    if (!check) {
      got = await page.evaluate(detailsOnPage, EPISODE_PATH);
      if (MISSING.test(`${got.heading}\n${state.title}`)) throw fail('Spotify says this page is not available', 'missing');
      const ready = got.heading && (type === 'episode' || got.episodes.length || Date.now() - started > ROWS_WAIT);
      if (ready) break;
    }
    if (Date.now() - started > (check ? CHECK_WAIT : LOAD_WAIT)) {
      if (check) throw fail('Spotify’s check was not completed in the Chrome window', 'blocked');
      break;
    }
    await sleep(pause, signal);
  }
  if (!got) throw fail('the page was not read', 'stopped');
  if (await page.evaluate(expandDescriptions).catch(() => 0)) {
    await sleep(pause, signal);
    got = await page.evaluate(detailsOnPage, EPISODE_PATH).catch(() => got);
  }
  // Every episode the page will list, kept as it goes (long lists drop rows).
  const rows = new Map((got.episodes || []).map((r) => [r.id, r]));
  for (let i = 0; type === 'show' && i < MORE_ROUNDS && rows.size && rows.size < MAX_ROWS && !signal?.aborted; i++) {
    await page.evaluate(loadMoreEpisodes, EPISODE_PATH).catch(() => {});
    await sleep(pause * 2, signal);
    const before = rows.size;
    for (const r of (await page.evaluate(detailsOnPage, EPISODE_PATH).catch(() => got)).episodes) if (!rows.has(r.id)) rows.set(r.id, r);
    if (rows.size === before) break;
  }
  const first = metadataOf(served);
  const now = metadataOf(got.head);
  const description = first.description || now.description;
  const text = [...new Set([first.description, now.description, ...got.sections].filter(Boolean))].join('\n');
  const final = page.url().replace(/[?#].*$/, '');
  return {
    type,
    id: /\/(?:show|episode)\/([A-Za-z0-9]+)/.exec(url)?.[1] || '',
    url: url.replace(/[?#].*$/, ''),
    title: first.name || now.name || got.heading,
    host: first.publisher || now.publisher || '',
    show: got.show?.name || first.show || now.show || '',
    showUrl: got.show?.url || (type === 'show' ? final : ''),
    artwork: got.artwork,
    description: description || got.sections.join('\n'),
    text: text || got.body,
    fromMetadata: Boolean(first.description || now.description),
    episodes: type === 'show' ? [...rows.values()].slice(0, MAX_ROWS) : [],
  };
}

module.exports = { SITES, readResults, showsOnPage, metadataOf, readSpotifyPage };
