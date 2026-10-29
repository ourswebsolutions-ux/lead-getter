'use strict';

// Podcast Lead Finder: podcasts on Apple Podcasts and their public contact
// emails. No browser is needed; every step is a plain request.
//
//   1. Apple Podcasts: a search by name or topic (Apple's public search),
//      or one podcast by its Apple Podcasts link or id (Apple's lookup).
//   2. RSS feed: the feed Apple lists for the podcast (its lookup data, else
//      the podcast's Apple page). The feed is read and must be a podcast RSS
//      feed (a channel with a title); a feed that moved (itunes:new-feed-url)
//      is followed once.
//   3. Emails in the feed: the channel owner (itunes:owner), managing editor
//      and webmaster, the show description, every episode's description and
//      show notes; then a few episode pages the feed links to.
//   4. When the feed has no email of the podcast's own: its official website
//      (the feed's link, else a site its description links to): home,
//      Contact, About, Guest booking, Advertise and similar pages; then its
//      public link-in-bio profile pages (Linktree and the like).
//
// Nothing is guessed: an email is kept only where it was published, with
// where it was found. Addresses of the hosting platform (forwarding
// addresses such as info+id@mg-eu.acast.com) are kept but marked and never
// counted as the podcast's own email. A check that failed (timeout, HTTP
// error) is reported as failed, never as "no email".

const { contactsFromHtml, textOf, fetchPage, findContacts: findContactsDefault, NOT_AN_EMAIL } = require('./website-contacts');

const UA = 'Mozilla/5.0 (Lead Finder; podcast contact lookup)';
const FEED_LIMIT = 6_000_000; // bytes of a feed read (long feeds are cut, not refused)
const MAX_ITEMS = 1000;
const EPISODE_PAGES = 3; // episode pages read when the feed itself has no email

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}/gi;
// "name [at] domain [dot] com", "name (at) domain.com": written out to
// avoid spam bots, published all the same.
const OBFUSCATED = /\b([a-z0-9._%+-]+)\s*[[(]\s*at\s*[\])]\s*([a-z0-9-]+(?:(?:\s*[[(]\s*dot\s*[\])]\s*|\.)[a-z0-9-]+)+)\b/gi;
const FREE_MAIL = /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|proton(mail)?|pm|yandex|aol|gmx|zoho|mail)\.[a-z.]+$/i;

// Podcast hosting platforms: their addresses forward to the owner (or are
// the platform's own); their pages are the show's page on the platform.
const PLATFORM = /(^|\.)(acast\.com|anchor\.fm|spotify\.com|podcasters\.spotify\.com|buzzsprout\.com|libsyn\.com|megaphone\.fm|simplecast\.com|transistor\.fm|captivate\.fm|podbean\.com|spreaker\.com|redcircle\.com|omny\.fm|omnystudio\.com|art19\.com|audioboom\.com|soundcloud\.com|podomatic\.com|blubrry\.com|castos\.com|pinecast\.com|fireside\.fm|podiant\.co|whooshkaa\.com|iheart\.com|iheartpodcasts\.com|podcastics\.com|ausha\.co|podigee\.io|zencast\.fm|rss\.com|sounder\.fm|riverside\.fm|squadcast\.fm|apple\.com|appleid\.com|privaterelay\.appleid\.com|mzstatic\.com|feedburner\.com|feedpress\.me|pippa\.io|substack\.com|patreon\.com)$/i;
const SOCIAL = /(^|\.)(instagram\.com|facebook\.com|fb\.com|tiktok\.com|youtube\.com|youtu\.be|twitter\.com|x\.com|threads\.net|linkedin\.com|pinterest\.com|reddit\.com|discord\.gg|discord\.com|twitch\.tv|bsky\.app|snapchat\.com|t\.me|whatsapp\.com|spotify\.com|apple\.com|amazon\.com|audible\.com|music\.amazon\.com|podcasts\.google\.com|overcast\.fm|pca\.st|pocketcasts\.com|castbox\.fm|stitcher\.com|tunein\.com|deezer\.com|iheart\.com|player\.fm|goodpods\.com|podchaser\.com|bit\.ly|tinyurl\.com|eepurl\.com|w3\.org|gravatar\.com|wordpress\.org|google\.com|apps\.apple\.com|play\.google\.com|paypal\.com|paypal\.me|venmo\.com|buymeacoffee\.com|ko-fi\.com|gofundme\.com)$/i;
// Public link-in-bio pages: they list a creator's links and often an email.
const PROFILE = /(^|\.)(linktr\.ee|komi\.io|beacons\.ai|bio\.link|solo\.to|lnk\.bio|carrd\.co|campsite\.bio|linkin\.bio|taplink\.cc|hoo\.be|msha\.ke|withkoji\.com|stan\.store|allmylinks\.com|tap\.bio|later\.com|direct\.me|flowcode\.com|link\.me|podlink\.to|podfollow\.com|pod\.link)$/i;

const LEVEL = { channel: 0, web: 1, episode: 2 };
const confident = (e) => e.kind !== 'platform' && (e.kind === 'own' || e.level !== 'episode' || e.count >= 2);

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};
const domainOf = (email) => String(email).split('@')[1]?.toLowerCase() || '';
const sameSite = (a, b) => Boolean(a && b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)));

function decode(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d{1,7});/g, (_, n) => safeChar(Number(n)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, n) => safeChar(parseInt(n, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}
function safeChar(n) {
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ';
}

// --- Apple Podcasts ---------------------------------------------------------------

// An Apple Podcasts link, "id123", or a bare id: that one podcast. Anything
// else is a search.
function parseAppleInput(input) {
  const s = String(input || '').trim();
  const url = /^https?:\/\/(?:podcasts|itunes)\.apple\.com\/(?:([a-z]{2})\/)?[^\s]*?\bid(\d{5,})/i.exec(s);
  if (url) return { id: url[2], country: (url[1] || 'us').toLowerCase() };
  const id = /^(?:id)?(\d{6,})$/i.exec(s);
  if (id) return { id: id[1], country: 'us' };
  return { term: s.replace(/\s+/g, ' ').slice(0, 120) };
}

function appleUrl(raw) {
  try {
    const u = new URL(raw);
    u.search = '';
    return u.toString();
  } catch {
    return raw || '';
  }
}

// One podcast as the app shows it; store: the Apple Podcasts country it
// was found in (local phone numbers on its website are read as that
// country's).
function fromApple(r, store = 'us') {
  return {
    store,
    appleId: String(r.collectionId || r.trackId),
    id: String(r.collectionId || r.trackId),
    title: r.collectionName || r.trackName || '',
    host: r.artistName || '',
    appleUrl: appleUrl(r.collectionViewUrl || r.trackViewUrl || `https://podcasts.apple.com/podcast/id${r.collectionId || r.trackId}`),
    feedUrl: r.feedUrl || '',
    artwork: r.artworkUrl100 || r.artworkUrl60 || '',
    genre: r.primaryGenreName || '',
    episodes: Number(r.trackCount) || 0,
    latest: r.releaseDate || '',
    country: r.country || '',
  };
}

// One retry after a network error or a server error.
async function getJson(url, { fetchImpl = globalThis.fetch, signal, timeout = 20_000 } = {}) {
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await withTimeout((s) => fetchImpl(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: s }), signal, timeout);
      if (res.status < 500 || attempt) break;
    } catch (err) {
      if (signal?.aborted) throw err;
      if (attempt) throw Object.assign(new Error(err?.code === 'timeout' ? 'Apple Podcasts did not answer in time. Try again.' : 'Apple Podcasts could not be reached. Check the internet connection and try again.'), { code: 'apple_network' });
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (res.status === 403 || res.status === 429) throw Object.assign(new Error('Apple Podcasts refused the request (too many requests). Wait a minute and try again.'), { code: 'apple_limited' });
  if (!res.ok) throw Object.assign(new Error(`Apple Podcasts answered HTTP ${res.status}.`), { code: 'apple_http' });
  return JSON.parse(await res.text());
}

// A request with a time limit that holds even if the request ignores its
// abort signal; aborts with the search's own signal too.
async function withTimeout(run, signal, timeout) {
  const limit = AbortSignal.timeout(timeout);
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), timeout + 50);
  });
  try {
    return await Promise.race([run(signal ? AbortSignal.any([signal, limit]) : limit), expired]);
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err?.name === 'TimeoutError' || limit.aborted) throw Object.assign(new Error('timed out'), { code: 'timeout' });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Apple's search returns at most 200 podcasts for a search (it has no
// further pages); the app pages through them. A link or id looks up that
// podcast. Returns { query, results: [podcast], exact }.
async function searchApple(input, { fetchImpl, signal, country = 'us' } = {}) {
  const q = parseAppleInput(input);
  if (q.id) {
    const data = await getJson(`https://itunes.apple.com/lookup?id=${q.id}&entity=podcast&country=${q.country}`, { fetchImpl, signal });
    const results = (data.results || []).filter((r) => r.kind === 'podcast' || r.wrapperType === 'track' || r.collectionId).map((r) => fromApple(r, q.country));
    // Not in that store: the podcast may still be listed in the US one.
    if (!results.length && q.country !== 'us') return searchApple(`id${q.id}`, { fetchImpl, signal });
    return { query: input, exact: true, results };
  }
  if (!q.term) return { query: input, exact: false, results: [] };
  const url = `https://itunes.apple.com/search?media=podcast&entity=podcast&limit=200&country=${encodeURIComponent(country)}&term=${encodeURIComponent(q.term)}`;
  const data = await getJson(url, { fetchImpl, signal });
  const seen = new Set();
  const results = (data.results || []).map((r) => fromApple(r, country)).filter((p) => p.id && !seen.has(p.id) && seen.add(p.id));
  return { query: input, exact: false, results };
}

// The feed Apple lists for a podcast: its lookup data, else its Apple page
// (which carries the same feed address for some podcasts the lookup omits).
async function appleFeed(p, { fetchImpl, signal } = {}) {
  if (p.feedUrl) return { url: p.feedUrl, from: p.feedFrom || 'Apple Podcasts lookup' };
  if (!p.appleId) return null;
  try {
    const data = await getJson(`https://itunes.apple.com/lookup?id=${p.appleId}&entity=podcast`, { fetchImpl, signal });
    const r = (data.results || []).find((x) => x.feedUrl);
    if (r) return { url: r.feedUrl, from: 'Apple Podcasts lookup' };
  } catch (err) {
    if (signal?.aborted) throw err;
  }
  if (p.appleUrl) {
    const page = await fetchPage(p.appleUrl, { fetchImpl, signal, timeout: 20_000, maxBytes: 4_000_000 });
    if (page.ok) {
      const m = new RegExp(`"adamId":"${p.appleId}","feedUrl":"([^"]+)"`).exec(page.html) || /"feedUrl":"(https?:[^"]+)"/.exec(page.html);
      if (m) return { url: JSON.parse(`"${m[1]}"`), from: 'Apple Podcasts page' };
    }
  }
  return null;
}

// --- RSS ----------------------------------------------------------------------------

// Reads a feed: { ok, xml, url, truncated } or { ok: false, error }. Large or
// slow feeds are read as a stream and cut at maxBytes or after readFor ms:
// the channel (title, owner, description) and the latest episodes come
// first, so what arrived is used (a feed of years of episodes can take
// minutes to download in full).
async function fetchFeed(url, { fetchImpl = globalThis.fetch, signal, timeout = 30_000, readFor = 25_000, maxBytes = FEED_LIMIT } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const done = new AbortController();
    const stop = () => done.abort();
    signal?.addEventListener('abort', stop, { once: true });
    try {
      const res = await withTimeout(
        (s) => fetchImpl(url, { redirect: 'follow', headers: { 'user-agent': UA, accept: 'application/rss+xml, application/xml, text/xml, */*' }, signal: AbortSignal.any([s, done.signal]) }),
        signal,
        timeout,
      );
      if (!res.ok) {
        if (res.status >= 500 && attempt === 0) continue;
        return { ok: false, error: `HTTP ${res.status}` };
      }
      const body = await readBody(res, { maxBytes, readFor, signal });
      done.abort(); // the rest is not downloaded
      if (!body.text) return { ok: false, error: 'timed out' };
      return { ok: true, url: res.url || url, xml: body.text, truncated: body.truncated };
    } catch (err) {
      if (signal?.aborted) throw err;
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      return { ok: false, error: err?.code === 'timeout' ? 'timed out' : 'could not be reached' };
    } finally {
      signal?.removeEventListener('abort', stop);
      done.abort();
    }
  }
  return { ok: false, error: 'could not be read' };
}

async function readBody(res, { maxBytes, readFor, signal }) {
  if (!res.body?.getReader) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { text: buf.subarray(0, maxBytes).toString('utf8'), truncated: buf.length > maxBytes };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  const deadline = Date.now() + readFor;
  try {
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) {
        truncated = true;
        break;
      }
      let timer;
      const r = await Promise.race([reader.read(), new Promise((resolve) => (timer = setTimeout(() => resolve({ late: true }), left)))]).finally(() => clearTimeout(timer));
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (r.late) {
        truncated = true;
        break;
      }
      if (r.done) break;
      chunks.push(r.value);
      size += r.value.length;
      if (size >= maxBytes) {
        truncated = true;
        break;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return { text: Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'), truncated };
}

function tagText(xml, name) {
  const re = new RegExp(`<${name.replace(':', '\\:')}(?:\\s[^>]*)?>([\\s\\S]*?)</${name.replace(':', '\\:')}>`, 'i');
  const m = re.exec(xml);
  return m ? decode(m[1]).trim() : '';
}
function tagAttr(xml, name, attr) {
  const m = new RegExp(`<${name.replace(':', '\\:')}\\b[^>]*\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(xml);
  return m ? decode(m[2] ?? m[3]).trim() : '';
}

// A podcast RSS feed: { ok, title, link, author, owner: { name, email },
// managingEditor, webMaster, description, newFeedUrl, items: [{ title,
// link, guid, pubDate, html }] } or { ok: false, error }.
function parseFeed(xml) {
  const s = String(xml || '');
  if (!/<rss[\s>]/i.test(s) || !/<channel[\s>]/i.test(s)) {
    if (/<html[\s>]/i.test(s)) return { ok: false, error: 'the address shows a web page, not an RSS feed' };
    if (/<feed[\s>]/i.test(s)) return { ok: false, error: 'an Atom feed, not a podcast RSS feed' };
    return { ok: false, error: 'not an RSS feed' };
  }
  const start = s.search(/<channel[\s>]/i);
  const body = s.slice(start);
  const firstItem = body.search(/<item[\s>]/i);
  const channel = firstItem >= 0 ? body.slice(0, firstItem) : body;
  // Channel fields only (not the first episode's).
  const head = channel.replace(/<image[\s>][\s\S]*?<\/image>/gi, ' ');
  const owner = /<itunes:owner[\s>]([\s\S]*?)<\/itunes:owner>/i.exec(head)?.[1] || '';
  const title = tagText(head, 'title');
  if (!title) return { ok: false, error: 'the feed has no podcast title' };
  const items = [];
  for (const m of body.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)) {
    const x = m[1];
    items.push({
      title: tagText(x, 'title'),
      link: tagText(x, 'link'),
      guid: tagText(x, 'guid'),
      pubDate: tagText(x, 'pubDate'),
      html: [tagText(x, 'description'), tagText(x, 'content:encoded'), tagText(x, 'itunes:summary'), tagText(x, 'itunes:subtitle')].join('\n'),
    });
    if (items.length >= MAX_ITEMS) break;
  }
  return {
    ok: true,
    title,
    link: tagText(head, 'link') || tagAttr(head, 'atom:link[^>]*rel="alternate"', 'href'),
    author: tagText(head, 'itunes:author') || tagText(head, 'author'),
    owner: { name: tagText(owner, 'itunes:name'), email: tagText(owner, 'itunes:email') },
    managingEditor: tagText(head, 'managingEditor'),
    webMaster: tagText(head, 'webMaster'),
    extraEmails: [tagText(head, 'googleplay:email'), tagText(head, 'googleplay:owner')].filter(Boolean),
    description: [tagText(head, 'description'), tagText(head, 'itunes:summary'), tagText(head, 'itunes:subtitle')].join('\n'),
    newFeedUrl: tagText(head, 'itunes:new-feed-url'),
    items,
  };
}

// Emails in HTML or text: mailto: links, plain addresses and the written-out
// "name [at] domain [dot] com" form.
function emailsIn(html) {
  const out = new Set();
  const raw = String(html || '');
  for (const m of raw.matchAll(/mailto:([^"'?\s<>]+)/gi)) {
    try {
      out.add(decodeURIComponent(m[1]).trim().toLowerCase());
    } catch {}
  }
  const text = /<[a-z!/]/i.test(raw) ? textOf(raw) : decode(raw);
  for (const m of text.matchAll(EMAIL)) out.add(m[0].toLowerCase());
  for (const m of text.matchAll(OBFUSCATED)) {
    const domain = m[2].replace(/\s*[[(]\s*dot\s*[\])]\s*/gi, '.').toLowerCase();
    if (/\.[a-z]{2,24}$/.test(domain)) out.add(`${m[1].toLowerCase()}@${domain}`);
  }
  // "name@site.comwww.site.com": an address run into the next link.
  return [...new Set([...out].map((e) => e.replace(/^[.]+|[.]+$/g, '').replace(/(\.[a-z]{2,24}?)(www\.|https?).*$/, '$1')))].filter((e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/.test(e) && !NOT_AN_EMAIL.test(e) && e.length <= 120);
}

// Links (href and written-out addresses) in HTML or text.
function linksIn(html) {
  const out = new Set();
  const raw = String(html || '');
  for (const m of raw.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)) out.add(decode(m[1]).trim());
  const text = /<[a-z!/]/i.test(raw) ? textOf(raw) : decode(raw);
  for (const m of text.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>"'()⁠​]+/gi)) out.add(m[0]);
  const res = [];
  for (let l of out) {
    l = l.replace(/[.,;:!?)\]⁠​]+$/g, '');
    if (/^www\./i.test(l)) l = `https://${l}`;
    try {
      const u = new URL(l);
      if (/^https?:$/.test(u.protocol)) res.push(u.toString());
    } catch {}
  }
  return [...new Set(res)];
}

const isMedia = (url) => /\.(mp3|m4a|mp4|aac|ogg|wav|m3u8|jpe?g|png|gif|webp|svg|pdf)(\?|$)/i.test(url);

// What kind of address an email is: the podcast's own domain, a free mail
// address, the hosting platform's (forwarding) address, or another domain.
function emailKind(email, site) {
  const d = domainOf(email);
  if (PLATFORM.test(d) || /(^|\.)mg(-[a-z]+)?\.[a-z0-9-]+\.[a-z]+$/.test(d)) return 'platform';
  if (sameSite(d, hostOf(site))) return 'own';
  if (FREE_MAIL.test(email)) return 'free';
  return 'other';
}

// --- one podcast --------------------------------------------------------------------

// Everything found for one podcast:
// { id, title, host, appleUrl, rssUrl, rssFrom, rssStatus ('valid' |
//   'missing' | 'invalid' | 'failed'), rssError, episodes, latestEpisode,
//   description, website, websiteFrom, emails: [{ email, kind, from, url,
//   count }], email (the podcast's own, best first; '' if none), phone,
//   socials, profiles, checked: [...], failed: [...], status ('found' |
//   'platform_only' | 'not_found' | 'incomplete' | 'failed'), statusText,
//   discovery }.
// step(text) reports progress.
// p: a podcast from any platform: { title, host, description (the
// platform's own), url, appleId, appleUrl, feedUrl, feedFrom, feedNote (why
// there is none), website, youtubeChannelId, store, platformLabel }.
// allow(url): whether a web page may be read automatically (robots.txt);
// RSS feeds are published for programs to read and are always read.
async function processPodcast(p, { fetchImpl = globalThis.fetch, signal, country = null, step = () => {}, findContacts = findContactsDefault, feedCache, allow = async () => true } = {}) {
  const r = {
    id: p.id,
    title: p.title,
    host: p.host,
    appleUrl: p.appleUrl || '',
    rssUrl: '',
    rssFrom: '',
    rssStatus: 'missing',
    rssError: '',
    episodes: 0,
    latestEpisode: '',
    description: '',
    website: '',
    websiteFrom: '',
    emails: [],
    email: '',
    phone: null,
    socials: [],
    profiles: [],
    checked: [],
    failed: [],
  };
  const found = new Map();
  const add = (emails, from, url, siteHint) => {
    for (const e of emails) {
      const kind = emailKind(e, siteHint || r.website);
      // A hosting platform's address in the text (its own boilerplate) is
      // not the podcast's; only one in the feed's owner fields is kept.
      if (kind === 'platform' && !/owner|editor|webmaster/i.test(from)) continue;
      const level = /^RSS feed: episode/.test(from) ? 'episode' : /^RSS feed/.test(from) ? 'channel' : 'web';
      const cur = found.get(e);
      if (cur) {
        if (level === 'episode' && cur.level === 'episode') cur.count++;
        else if (LEVEL[level] < LEVEL[cur.level]) Object.assign(cur, { level, from, url: url || cur.url });
      } else found.set(e, { email: e, kind, level, from, url: url || '', count: 1 });
    }
  };
  // An email that is the podcast's own: its domain, the feed's owner fields
  // or show description, its website or profile, or repeated in episodes. One
  // mentioned in a single episode may be a guest's or a sponsor's, so the
  // search goes on.
  const own = () => [...found.values()].some(confident);

  // 1-2. The RSS feed.
  step('Finding the RSS feed');
  const feed = await appleFeed(p, { fetchImpl, signal });
  let parsed = null;
  if (!feed) {
    r.rssStatus = 'missing';
    r.rssError = p.feedNote || (p.appleId ? 'Apple Podcasts lists no RSS feed for this podcast' : 'no RSS feed was found for this podcast');
  } else {
    r.rssFrom = feed.from;
    let url = feed.url;
    for (let hop = 0; hop < 2; hop++) {
      step(hop ? 'Following the moved RSS feed' : 'Reading the RSS feed');
      const cached = feedCache?.get(url);
      const got = cached || (await fetchFeed(url, { fetchImpl, signal }));
      if (!got.ok) {
        r.rssUrl = url;
        r.rssStatus = 'failed';
        r.rssError = `the feed could not be read (${got.error})`;
        break;
      }
      feedCache?.set(url, got);
      const f = parseFeed(got.xml);
      r.rssUrl = url;
      if (!f.ok) {
        r.rssStatus = 'invalid';
        r.rssError = f.error;
        break;
      }
      r.rssStatus = 'valid';
      r.rssError = '';
      parsed = f;
      // A feed that moved: the new address, if it reads (else this one).
      if (f.newFeedUrl && /^https?:/i.test(f.newFeedUrl) && f.newFeedUrl !== url && hop === 0) {
        const moved = await fetchFeed(f.newFeedUrl, { fetchImpl, signal });
        const mf = moved.ok ? parseFeed(moved.xml) : null;
        if (mf?.ok) {
          feedCache?.set(f.newFeedUrl, moved);
          url = f.newFeedUrl;
          continue;
        }
      }
      break;
    }
  }
  if (r.rssStatus === 'valid') r.checked.push('RSS feed');
  else if (r.rssStatus !== 'missing') r.failed.push(`RSS feed (${r.rssError})`);

  const candidates = [];
  const sortLinks = (links) => {
    for (const l of links) {
      const h = hostOf(l);
      if (!h || isMedia(l)) continue;
      if (PROFILE.test(h)) {
        if (!r.profiles.some((x) => hostOf(x) === h)) r.profiles.push(l);
      } else if (SOCIAL.test(h)) {
        if (!r.socials.some((x) => sameUrl(x, l))) r.socials.push(l);
      } else if (!PLATFORM.test(h)) candidates.push(l);
    }
  };
  // The platform's own description (Spotify, YouTube, Podcast Index).
  if (p.description && p.platformLabel) {
    add(emailsIn(p.description), `${p.platformLabel} description`, p.url);
    sortLinks(linksIn(p.description));
  }
  if (parsed) {
    r.title = r.title || parsed.title;
    r.host = r.host || parsed.author || parsed.owner.name;
    r.description = textOf(parsed.description).replace(/\s+/g, ' ').trim().slice(0, 600);
    r.episodes = parsed.items.length;
    r.latestEpisode = parsed.items[0]?.title || '';
    step(`Reading ${parsed.items.length} episode${parsed.items.length === 1 ? '' : 's'}`);
    const channelLinks = linksIn(parsed.description);
    const site = /^https?:/i.test(parsed.link) ? parsed.link : '';
    add(emailsIn([parsed.owner.email, parsed.managingEditor].join(' ')), 'RSS feed: channel owner', r.rssUrl, site);
    add(emailsIn([parsed.webMaster, ...parsed.extraEmails].join(' ')), 'RSS feed: channel webmaster', r.rssUrl, site);
    add(emailsIn(parsed.description), 'RSS feed: show description', r.rssUrl, site);
    const episodeLinks = [];
    const linkCount = new Map();
    for (const it of parsed.items) {
      add(emailsIn(it.html), `RSS feed: episode “${it.title.slice(0, 60)}”`, it.link || r.rssUrl, site);
      for (const l of linksIn(it.html)) linkCount.set(l, (linkCount.get(l) || 0) + 1);
      if (it.link && /^https?:/i.test(it.link) && !isMedia(it.link)) episodeLinks.push(it.link);
    }
    // The official website: the feed's link, unless that is just the show's
    // page on Apple or a link-in-bio page (kept as a profile).
    const siteHost = hostOf(site);
    if (site && !/apple\.com$/.test(siteHost)) {
      if (PROFILE.test(siteHost)) r.profiles.push(site);
      else if (SOCIAL.test(siteHost) && !PLATFORM.test(siteHost)) r.socials.push(site);
      else {
        r.website = site;
        r.websiteFrom = PLATFORM.test(siteHost) ? 'RSS feed link (hosting platform page)' : 'RSS feed link';
      }
    }
    // Links in the show description and (repeated) in the show notes.
    sortLinks([...channelLinks, ...[...linkCount.entries()].filter(([, n]) => n >= Math.max(2, parsed.items.length * 0.3)).sort((a, b) => b[1] - a[1]).map(([l]) => l)]);

    r.episodePages = episodeLinks;
  }

  // A YouTube podcast: its channel's public video feed (titles and
  // descriptions of the latest videos), when nothing better was found.
  if (!own() && p.youtubeChannelId) {
    step('Reading the YouTube channel feed');
    const yt = await fetchFeed(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(p.youtubeChannelId)}`, { fetchImpl, signal, timeout: 20_000 });
    if (!yt.ok) r.failed.push(`YouTube channel feed (${yt.error})`);
    else {
      r.checked.push('YouTube channel feed');
      const ytCount = new Map();
      for (const m of yt.xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
        const title = tagText(m[1], 'title');
        const desc = tagText(m[1], 'media:description');
        add(emailsIn(desc), `YouTube video “${title.slice(0, 60)}”`, tagAttr(m[1], 'link', 'href'));
        for (const l of linksIn(desc)) ytCount.set(l, (ytCount.get(l) || 0) + 1);
      }
      sortLinks([...ytCount.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([l]) => l));
    }
  }

  // The official website: the feed's (above), else one the platform lists,
  // else one the descriptions link to.
  if (!r.website && p.website && /^https?:/i.test(p.website)) {
    const h = hostOf(p.website);
    if (PROFILE.test(h)) r.profiles.includes(p.website) || r.profiles.push(p.website);
    else if (!SOCIAL.test(h) || PLATFORM.test(h)) {
      r.website = p.website;
      r.websiteFrom = `${p.platformLabel || 'platform'} listing`;
    }
  }
  if (!r.website && candidates.length) {
    r.website = `https://${new URL(candidates[0]).host}/`;
    r.websiteFrom = 'linked in the descriptions';
  }
  // Own-domain emails need the website: re-rank what was found.
  for (const e of found.values()) e.kind = emailKind(e.email, r.website);

  if (parsed) {
    const episodeLinks = r.episodePages || [];
    delete r.episodePages;
    // 3b. Episode pages (the show notes' full page), when the feed's text
    // has no email of the podcast's own.
    if (!own()) {
      const pages = [...new Set(episodeLinks)].filter((l) => !sameUrl(l, r.website)).slice(0, EPISODE_PAGES);
      for (const [i, url] of pages.entries()) {
        step(`Reading episode page ${i + 1} of ${pages.length}`);
        if (!(await allow(url))) {
          r.failed.push(`episode page ${hostOf(url)} (not permitted by its robots.txt)`);
          continue;
        }
        const page = await fetchPage(url, { fetchImpl, signal, timeout: 15_000 });
        if (!page.ok) {
          r.failed.push(`episode page ${hostOf(url)} (${page.error || `HTTP ${page.status}`})`);
          continue;
        }
        r.checked.push('episode page');
        add(contactsFromHtml(page.html, page.url).emails, 'episode page', page.url);
        if (own()) break;
      }
    }
  }

  // 4. The website: home, Contact, About, Guest booking and similar pages.
  if (!own() && r.website) {
    step(`Checking the website ${hostOf(r.website)}`);
    const c = await findContacts(r.website, { country: /^[a-z]{2}$/i.test(p.store || '') ? p.store.toUpperCase() : country, fetchImpl, signal, maxPages: 6, allow });
    if (c.error) r.failed.push(`website ${hostOf(r.website)} (${c.error})`);
    else {
      r.checked.push(`website (${c.pages.length} page${c.pages.length === 1 ? '' : 's'})`);
      for (const e of c.emails) add([e], `website: ${pageName(c.emailPages?.[e] || c.pages[0])}`, c.emailPages?.[e] || c.pages[0]);
      if (c.phones?.length) r.phone = { ...c.phones[0], from: 'website' };
    }
  }

  // 5. Public link-in-bio profile pages.
  if (!own() && r.profiles.length) {
    for (const url of r.profiles.slice(0, 2)) {
      step(`Checking the profile page ${hostOf(url)}`);
      if (!(await allow(url))) {
        r.failed.push(`profile ${hostOf(url)} (not permitted by its robots.txt)`);
        continue;
      }
      const page = await fetchPage(url, { fetchImpl, signal, timeout: 15_000 });
      if (!page.ok) {
        r.failed.push(`profile ${hostOf(url)} (${page.error || `HTTP ${page.status}`})`);
        continue;
      }
      r.checked.push(`profile ${hostOf(url)}`);
      add(contactsFromHtml(page.html, page.url).emails, `profile page ${hostOf(url)}`, page.url);
      if (own()) break;
    }
  }

  // Best first: the podcast's own domain, another business domain, free
  // mail, then platform forwarding addresses; the feed before the web;
  // the most mentioned first.
  const score = (e) => (e.kind === 'platform' ? 9 : e.kind === 'own' ? 0 : e.level === 'channel' ? 1 : e.level === 'web' ? 2 : e.count >= 2 ? 3 : 4);
  r.emails = [...found.values()].sort((a, b) => score(a) - score(b) || (a.kind === 'free') - (b.kind === 'free') || b.count - a.count);
  r.email = r.emails.find((e) => e.kind !== 'platform')?.email || '';
  if (r.email) r.status = 'found';
  else if (r.emails.length) r.status = 'platform_only';
  else if (r.failed.length) r.status = r.checked.length || r.rssStatus === 'valid' ? 'incomplete' : 'failed';
  else r.status = r.rssStatus === 'missing' && !r.website ? 'failed' : 'not_found';
  r.statusText = statusText(r);
  r.discovery = discovery(r);
  return r;
}

// "example.com/contact" (a page's host and path, for where an email was found).
function pageName(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}`;
  } catch {
    return 'site';
  }
}
function sameUrl(a, b) {
  const n = (u) => String(u || '').replace(/^https?:\/\/(www\.)?/i, '').replace(/[/#?]+$/, '').toLowerCase();
  return Boolean(a && b && n(a) === n(b));
}

function statusText(r) {
  const best = r.emails.find((e) => e.email === r.email);
  if (r.status === 'found') return `Email found (${best.from})${confident(best) ? '' : ': mentioned in one episode only, may be a guest’s or sponsor’s'}`;
  if (r.status === 'platform_only') return `No email of the podcast's own; only the hosting platform's forwarding address (${r.emails[0].email})`;
  if (r.status === 'incomplete') return `No public email found; could not check: ${r.failed.join(', ')}`;
  if (r.status === 'failed') return r.rssError ? `Not checked: ${r.rssError}${r.website ? '' : ', and no website is known'}` : `Not checked: ${r.failed.join(', ') || 'nothing could be read'}`;
  return `No public email found (checked: ${r.checked.join(', ') || 'nothing to check'})`;
}

function discovery(r) {
  const rss = r.rssStatus === 'valid' ? `valid (${r.rssFrom}), ${r.episodes} episode${r.episodes === 1 ? '' : 's'}` : `${r.rssStatus}${r.rssError ? ` (${r.rssError})` : ''}`;
  return [
    `email: ${r.status === 'found' ? `found (${r.emails.find((e) => e.email === r.email).from})` : r.statusText}`,
    `rss: ${rss}`,
    `website: ${r.website ? `${hostOf(r.website)} (${r.websiteFrom})` : 'none found'}`,
    ...(r.emails.length > 1 ? [`all emails: ${r.emails.map((e) => e.email + (e.kind === 'platform' ? ' (hosting platform)' : '')).join(', ')}`] : []),
  ].join('; ');
}

// A small store of feeds already read (a preview, then processing): at
// most 40, for 15 minutes.
function feedCacheOf(max = 40, ttl = 15 * 60_000) {
  const m = new Map();
  return {
    get(url) {
      const e = m.get(url);
      if (!e || Date.now() - e.at > ttl) return null;
      return e.value;
    },
    set(url, value) {
      m.delete(url);
      m.set(url, { value, at: Date.now() });
      while (m.size > max) m.delete(m.keys().next().value);
    },
  };
}

module.exports = {
  parseAppleInput,
  searchApple,
  appleFeed,
  fetchFeed,
  parseFeed,
  emailsIn,
  linksIn,
  emailKind,
  processPodcast,
  feedCacheOf,
  fromApple,
};
