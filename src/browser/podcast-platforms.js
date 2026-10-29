'use strict';

// Where podcasts are found: one adapter per platform.
//
//   Apple Podcasts  public search and lookup API; no key. Lists RSS feeds.
//   Spotify         in the browser: its podcast search (or a pasted show
//                   link) opens in Chrome for the user to look through.
//                   Lead Finder does not read Spotify's pages or use its API;
//                   the user pastes a podcast's website or link here.
//   YouTube         Data API v3; a free API key (console.cloud.google.com).
//                   Podcast playlists only. Without a key, a pasted channel
//                   link is read from the channel's public page. YouTube has
//                   no podcast RSS; its channel's official video feed is
//                   read for contact details, and a feed is matched by title.
//   Amazon Music    in the browser, like Spotify: Amazon's terms do not allow
//                   automated extraction, so its search opens in Chrome for
//                   the user. A podcast page the user opens there (or a
//                   pasted link) is matched by the name in its address.
//   Website         a pasted podcast website (not a switch): its RSS feed
//                   (from the page's feed link) and contact pages, where its
//                   robots.txt permits.
//
// search(term, ctx) -> [podcast]; link(url, ctx) -> [podcast] for a pasted
// address; a browser platform has searchUrl(term) / pageUrl(link) instead.
// A podcast: { platform, platformId, title, host, description, url, feedUrl,
// website, artwork, appleId, appleUrl, youtubeChannelId, episodes, store }.
// Errors carry a plain-language message.

const { searchApple } = require('./podcasts');
const { fetchPage, textOf } = require('./website-contacts');

const UA = 'LeadFinder/1.8 (podcast lead discovery; +https://github.com/ourswebsolutions-ux/lead-getter)';

// hidden: not a switch (found from pasted links only).
const PLATFORMS = {
  apple: { label: 'Apple Podcasts', keys: [] },
  spotify: { label: 'Spotify', keys: [], browser: true },
  youtube: { label: 'YouTube', keys: ['apiKey'] },
  amazon: { label: 'Amazon Music', keys: [], browser: true },
  website: { label: 'Website', keys: [], hidden: true },
};

const fail = (message, code) => Object.assign(new Error(message), { code });

// A JSON request with a time limit, one retry after a network or server
// error; HTTP errors become plain messages for that platform.
async function request(url, { fetchImpl = globalThis.fetch, signal, headers = {}, method = 'GET', body, label, timeout = 20_000 }) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      const limit = AbortSignal.timeout(timeout);
      res = await fetchImpl(url, { method, body, headers: { 'user-agent': UA, accept: 'application/json', ...headers }, signal: signal ? AbortSignal.any([signal, limit]) : limit });
    } catch (err) {
      if (signal?.aborted) throw err;
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      throw fail(err?.name === 'TimeoutError' ? `${label} did not answer in time.` : `${label} could not be reached.`, 'network');
    }
    if (res.status >= 500 && attempt === 0) {
      await new Promise((r) => setTimeout(r, 1200));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw classify(res, text, label);
    try {
      return JSON.parse(text);
    } catch {
      throw fail(`${label} sent an unreadable answer.`, 'http');
    }
  }
}

// What a refused request means, from the platform's own answer (its status
// and error text; never the keys). err.code: 'auth' (the keys are wrong),
// 'token' (an access token expired), 'account' (the keys are right but the
// platform account may not use the API), 'forbidden', 'limited', 'http'.
// err.status and err.reason keep the platform's answer for the message.
function classify(res, text, label) {
  let reason = '';
  let kind = '';
  try {
    const j = JSON.parse(text);
    // Spotify's token service: { error, error_description }; its Web API
    // and Google: { error: { status|code, message, errors } }.
    if (typeof j.error === 'string') [kind, reason] = [j.error, j.error_description || ''];
    else if (j.error) [kind, reason] = [j.error.errors?.[0]?.reason || '', j.error.message || ''];
    else if (j.description) reason = j.description;
  } catch {
    reason = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  reason = reason.slice(0, 300);
  const status = res.status;
  const err = (message, code) => Object.assign(fail(message, code), { status, reason });
  if (status === 429) {
    const wait = Number(res.headers?.get?.('retry-after'));
    return err(`${label} says too many requests. Try again in ${wait > 0 ? `${Math.ceil(wait / 60)} minute${wait > 60 ? 's' : ''}` : 'a few minutes'}.`, 'limited');
  }
  if (/invalid_client|unauthorized_client|API key not valid|API_KEY_INVALID|keyInvalid/i.test(`${kind} ${reason}`) || (status === 401 && !/token/i.test(reason))) {
    return err(`${label} did not accept these keys${reason ? ` (${reason})` : ''}.`, 'auth');
  }
  if (status === 401) return err(`${label}: ${reason || 'the access token was refused'}.`, 'token');
  if (status === 403 && /premium/i.test(reason)) return err(`${label}: ${reason}`, 'account');
  if (status === 403) return err(`${label} refused the request${reason ? `: ${reason}` : ` (HTTP ${status})`}.`, 'forbidden');
  return err(`${label} answered HTTP ${status}${reason ? `: ${reason}` : ''}.`, 'http');
}

// --- Apple Podcasts --------------------------------------------------------------

const apple = {
  async search(term, { fetchImpl, signal, limit = 50 }) {
    const res = await searchApple(term, { fetchImpl, signal });
    return res.results.slice(0, limit).map(fromApplePodcast);
  },
  async link(url, ctx) {
    const res = await searchApple(url, ctx);
    if (!res.results.length) throw fail('Apple Podcasts has no podcast at this link.', 'not_found');
    return res.results.map(fromApplePodcast);
  },
};
function fromApplePodcast(p) {
  return { ...p, platform: 'apple', platformId: p.appleId, url: p.appleUrl, description: '' };
}

// --- Spotify ---------------------------------------------------------------------

// Opened in the user's Chrome; nothing is read from Spotify.
const spotify = {
  // Spotify's own search page (all result types; its Podcasts filter is a
  // tab on that page: "/search/<term>/podcasts" is not a results route and
  // shows "No Podcasts found").
  searchUrl: (term) => `https://open.spotify.com/search/${encodeURIComponent(term)}`,
  // A show (or episode) link, as an open.spotify.com address, else null.
  pageUrl(url) {
    const m = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(show|episode)\/([A-Za-z0-9]{10,30})/.exec(url);
    return m ? `https://open.spotify.com/${m[1]}/${m[2]}` : null;
  },
};

// --- YouTube ---------------------------------------------------------------------

const yt = (path, params, apiKey, ctx) =>
  request(`https://www.googleapis.com/youtube/v3/${path}?${new URLSearchParams({ ...params, key: apiKey })}`, { ...ctx, label: 'YouTube' });

function fromPlaylist(p) {
  const sn = p.snippet || {};
  return {
    platform: 'youtube',
    platformId: p.id,
    title: sn.title || '',
    host: sn.channelTitle || '',
    description: sn.description || '',
    url: `https://www.youtube.com/playlist?list=${p.id}`,
    artwork: sn.thumbnails?.medium?.url || sn.thumbnails?.default?.url || '',
    youtubeChannelId: sn.channelId || '',
    episodes: Number(p.contentDetails?.itemCount) || 0,
    feedNote: 'YouTube podcasts have no RSS feed, and no podcast with the same title was found on Apple Podcasts',
  };
}
const youtube = {
  // Playlists YouTube marks as podcasts.
  async search(term, { creds, fetchImpl, signal, limit = 50 }) {
    const ctx = { fetchImpl, signal };
    const found = await yt('search', { part: 'snippet', type: 'playlist', q: `${term} podcast`, maxResults: String(Math.min(50, limit)) }, creds.apiKey, ctx);
    const ids = (found.items || []).map((i) => i.id?.playlistId).filter(Boolean);
    if (!ids.length) return [];
    const lists = await yt('playlists', { part: 'snippet,status,contentDetails', id: ids.join(','), maxResults: '50' }, creds.apiKey, ctx);
    const all = lists.items || [];
    const podcasts = all.filter((p) => p.status?.podcastStatus === 'enabled').map(fromPlaylist).slice(0, limit);
    // Playlists that are not podcasts: rejected (counted, not saved).
    podcasts.rejected = all.length - podcasts.length;
    return podcasts;
  },
  // A channel or playlist link: through the API with a key, else the
  // channel's public page (name, description, channel id).
  async link(url, { creds, fetchImpl, signal }) {
    const list = /[?&]list=([A-Za-z0-9_-]+)/.exec(url)?.[1];
    if (list && creds) {
      const data = await yt('playlists', { part: 'snippet,status,contentDetails', id: list }, creds.apiKey, { fetchImpl, signal });
      if (!data.items?.length) throw fail('YouTube has no playlist at this link.', 'not_found');
      return data.items.map(fromPlaylist);
    }
    const page = await fetchPage(url, { fetchImpl, signal, timeout: 20_000, maxBytes: 3_000_000 });
    if (!page.ok) throw fail(`The YouTube page could not be read (${page.error || `HTTP ${page.status}`}).`, 'network');
    const meta = (prop) => decodeHtml(new RegExp(`<meta property="og:${prop}" content="([^"]*)"`).exec(page.html)?.[1] || '');
    const channelId = /"externalId":"(UC[\w-]{22})"/.exec(page.html)?.[1] || /"channelId":"(UC[\w-]{22})"/.exec(page.html)?.[1] || /\/channel\/(UC[\w-]{22})/.exec(url)?.[1] || '';
    const title = meta('title');
    if (!title) throw fail('The YouTube page shows no channel or playlist name.', 'not_found');
    return [
      {
        platform: 'youtube',
        platformId: list || channelId,
        title,
        host: list ? decodeHtml(/"ownerChannelName":"([^"]+)"/.exec(page.html)?.[1] || '') : title,
        description: meta('description'),
        url: list ? `https://www.youtube.com/playlist?list=${list}` : channelId ? `https://www.youtube.com/channel/${channelId}` : url,
        artwork: meta('image'),
        youtubeChannelId: channelId,
        feedNote: 'YouTube podcasts have no RSS feed, and no podcast with the same title was found on Apple Podcasts',
      },
    ];
  },
  check: (creds, ctx) => yt('search', { part: 'snippet', type: 'playlist', q: 'podcast', maxResults: '1' }, creds.apiKey, ctx),
};

function decodeHtml(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// --- Amazon Music ----------------------------------------------------------------

const amazon = {
  // Amazon Music's search page (the filter shows catalogue results; without
  // it the page stays empty).
  searchUrl: (term) => `https://music.amazon.com/search/${encodeURIComponent(term)}?filter=IsLibrary%7Cfalse`,
  // A podcast page the user opened: its address with the podcast's name.
  pageUrl: (url) => (/music\.amazon\.[a-z.]+\/podcasts\/[0-9a-f-]{20,}/i.test(url) ? url : null),
  // music.amazon.com/podcasts/<id>/<name-of-the-podcast>
  async link(url) {
    const m = /music\.amazon\.[a-z.]+\/podcasts\/([0-9a-f-]{20,})(?:\/([^/?#]+))?/i.exec(url);
    if (!m) throw fail('Only Amazon Music podcast links can be looked up.', 'not_found');
    const slug = m[2] ? decodeURIComponent(m[2]).replace(/[-_]+/g, ' ').trim() : '';
    if (!slug) throw fail('This Amazon Music link has no podcast name in it, and Amazon Music has no public lookup. Copy the link from the podcast’s page (it ends with its name).', 'unsupported');
    return [
      {
        platform: 'amazon',
        platformId: m[1],
        title: slug,
        titleFromLink: true,
        host: '',
        description: '',
        url: `https://music.amazon.com/podcasts/${m[1]}${m[2] ? `/${m[2]}` : ''}`,
        feedNote: 'Amazon Music has no public RSS or lookup, and no podcast with this name was found on Apple Podcasts',
      },
    ];
  },
};

// --- A podcast's website -----------------------------------------------------------

// The page's RSS feed link (<link rel="alternate" type="application/rss+xml">).
function feedLinkOf(html, base) {
  for (const m of String(html).matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel\s*=\s*["']?alternate/i.test(tag) || !/type\s*=\s*["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href || /\/comments\/feed\/?$|[?&]feed=comments/i.test(href)) continue;
    try {
      return new URL(decodeHtml(href), base).toString();
    } catch {}
  }
  return '';
}
const metaOf = (html, name) => decodeHtml(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i').exec(html)?.[1] || new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, 'i').exec(html)?.[1] || '');

const website = {
  async link(url, { fetchImpl, signal, allow }) {
    if (allow && !(await allow(url))) throw fail(`${new URL(url).hostname} does not permit automated reading (its robots.txt), so Lead Finder does not read it.`, 'not_permitted');
    const page = await fetchPage(url, { fetchImpl, signal, timeout: 20_000 });
    if (!page.ok) throw fail(`The website could not be read (${page.error || `HTTP ${page.status}`}).`, 'network');
    const title = (metaOf(page.html, 'og:site_name') || metaOf(page.html, 'og:title') || decodeHtml(/<title[^>]*>([^<]*)<\/title>/i.exec(page.html)?.[1] || '')).replace(/\s+/g, ' ').trim();
    const feedUrl = feedLinkOf(page.html, page.url);
    const origin = new URL(page.url).origin;
    return [
      {
        platform: 'website',
        platformId: origin,
        title: title || new URL(page.url).hostname.replace(/^www\./, ''),
        titleFromLink: !title,
        host: '',
        description: textOf(metaOf(page.html, 'og:description') || metaOf(page.html, 'description')).replace(/\s+/g, ' ').trim(),
        url: page.url,
        website: `${origin}/`,
        feedUrl,
        feedFrom: feedUrl ? 'the website’s feed link' : '',
        feedNote: 'the website links to no RSS feed',
        platformLabel: 'Website',
      },
    ];
  },
};

const ADAPTERS = { apple, spotify, youtube, amazon, website };

// Which platform a pasted address belongs to, or null.
function platformOfUrl(input) {
  let u;
  try {
    u = new URL(String(input).trim());
  } catch {
    return null;
  }
  const h = u.hostname.toLowerCase().replace(/^www\./, '');
  if (/^(podcasts|itunes)\.apple\.com$/.test(h)) return 'apple';
  if (h === 'open.spotify.com') return 'spotify';
  if (/^(m\.|music\.)?youtube\.com$|^youtu\.be$/.test(h)) return 'youtube';
  if (/^music\.amazon\.[a-z.]+$/.test(h)) return 'amazon';
  return /^https?:$/.test(u.protocol) ? 'website' : 'unknown';
}

// --- podcasts the user opens in the Spotify / Amazon Music window ---------------------

// What a page the user opened from a browser platform's window is, from its
// address only (nothing on Spotify's or Amazon's pages is read):
// { platform: 'amazon', url } for an Amazon Music podcast page, { platform:
// 'website', url, extraLinks } for a podcast's own website (with the
// Spotify / Amazon page it was opened from), or null for anything else.
function browserFindOf(url, windowPlatform, openerUrl = '') {
  let host;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    host = u.hostname.toLowerCase();
  } catch {
    return null;
  }
  if (/^music\.amazon\./.test(host)) return amazon.pageUrl(url) ? { platform: 'amazon', url } : null;
  // Spotify, Amazon and Apple's own pages, and sign-in or app-store pages.
  if (/(^|\.)(spotify\.com|scdn\.co|spotify\.link|amazon\.[a-z.]+|amazon\.com|apple\.com|google\.com|facebook\.com|accounts\.[a-z.]+)$/.test(host)) return null;
  const from = windowPlatform === 'spotify' ? spotify.pageUrl(openerUrl) : windowPlatform === 'amazon' ? amazon.pageUrl(openerUrl) : null;
  return { platform: 'website', url, extraLinks: from ? { [windowPlatform]: from } : null };
}

// --- relevance ------------------------------------------------------------------------

// The words of a keyword that decide whether a podcast is about it (common
// words and "podcast" left out).
const KEYWORD_NOISE = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'about', 'by', 'my', 'your', 'our', 'podcast', 'podcasts', 'show', 'shows', 'episode', 'episodes']);
function keywordTerms(q) {
  return [...new Set(String(q || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !KEYWORD_NOISE.has(w)))];
}
// The stem of a word: a few English endings removed ("editing" -> "edit").
function stem(w) {
  return w.replace(/(ings|ing|ers|er|ies|es|s|ed|ly)$/, (m) => (w.length - m.length >= 3 ? (m === 'ies' ? 'y' : '') : m));
}
// Whether a text mentions a term: a word with the same stem ("editing" and
// "editor", not "edition"; "women" and "woman").
function mentions(text, term) {
  const t = stem(term);
  const alt = t.replace(/en$/, 'an'); // women / woman, men / man
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .some((w) => {
      const s = stem(w);
      return s === t || s === alt || (t.length >= 5 && s.startsWith(t) && s.length - t.length <= 2);
    });
}
// About the keyword: every term mentioned (one may be missing when there are
// three or more).
function relevant(text, terms) {
  if (!terms.length) return true;
  const hit = terms.filter((t) => mentions(text, t)).length;
  return hit >= (terms.length >= 3 ? terms.length - 1 : terms.length);
}

// --- matching across platforms ----------------------------------------------------

const TITLE_NOISE = /\b(the|a|an|podcast|podcasts|show|official|audio|with|and)\b/g;
function titleKey(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(TITLE_NOISE, ' ')
    .replace(/\s+/g, '')
    .trim();
}
// Hosts are compatible when either is unknown or they share a word.
function sameHost(a, b) {
  const words = (s) => new Set(String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !['the', 'and', 'podcast', 'podcasts', 'media', 'studios', 'network'].includes(w)));
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return true;
  return [...A].some((w) => B.has(w));
}
function feedKey(url) {
  return String(url || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

// The feed of a podcast found on a platform without feeds: the podcast with
// exactly the same title (and a compatible host) on Apple Podcasts.
// { feedUrl, appleId, appleUrl, from, match } or null.
async function feedByTitle(p, { fetchImpl, signal } = {}) {
  const key = titleKey(p.title);
  if (!key) return null;
  try {
    const hit = (await apple.search(p.title, { fetchImpl, signal, limit: 25 })).find((x) => titleKey(x.title) === key && x.feedUrl && (p.titleFromLink || sameHost(x.host, p.host)));
    if (hit) return { feedUrl: hit.feedUrl, appleId: hit.appleId, appleUrl: hit.appleUrl, from: 'Apple Podcasts (same title)', match: hit };
  } catch (err) {
    if (signal?.aborted) throw err;
  }
  return null;
}

module.exports = { PLATFORMS, ADAPTERS, platformOfUrl, titleKey, sameHost, feedKey, feedByTitle, feedLinkOf, keywordTerms, relevant, mentions, browserFindOf, UA };
