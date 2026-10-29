'use strict';

// Facebook post search, performed in a tab of the user's own Chrome with the
// Facebook login already in that profile. Lead Finder only reads what the
// search results show: it never logs in, solves a check or works around a
// block; it reports them and stops the Facebook part of the search.

const crypto = require('node:crypto');
const { findPhones } = require('../database/phone');

const FB_HOME = 'https://www.facebook.com/';
const NAV_TIMEOUT = 45_000;
const MAX_PHONES_PER_POST = 5;

function searchUrl(query) {
  return `https://www.facebook.com/search/posts/?q=${encodeURIComponent(query)}`;
}

// The searches run for one keyword: the keyword itself and, when the
// category is not already part of it, the category with the keyword's place
// ("Garments" + "garment shops in Lahore" -> "Garments Lahore").
function buildQueries(keyword, category) {
  const out = [String(keyword || '').trim()];
  const cat = String(category || '').trim();
  if (cat && !out[0].toLowerCase().includes(cat.toLowerCase())) {
    const place = out[0].match(/\b(?:in|near|at)\s+(.+)$/i)?.[1];
    out.push(place ? `${cat} ${place}` : cat);
  }
  return [...new Map(out.filter((q) => q.length >= 2).map((q) => [q.toLowerCase(), q])).values()];
}

// --- URLs ----------------------------------------------------------------------

function isFacebookHost(host) {
  return /(^|\.)facebook\.com$/i.test(host) || /^fb\.com$/i.test(host);
}

// Facebook wraps outside links as l.facebook.com/l.php?u=<url>.
function unwrap(href) {
  try {
    const u = new URL(href);
    if (/^l[m]?\.facebook\.com$/i.test(u.hostname) && u.searchParams.get('u')) return u.searchParams.get('u');
    return u.toString();
  } catch {
    return '';
  }
}

const POST_PATH = /\/posts\/|\/permalink\/|\/permalink\.php|\/story\.php|\/photo\.php|^\/photo\/?$|\/photos\/|\/videos\/|\/reel\/|\/groups\/[^/]+\/(posts|permalink)\//;
// Query parameters that identify a post; everything else is tracking.
const KEEP_PARAMS = ['story_fbid', 'id', 'fbid', 'v', 'set'];

// Facebook's own pages whose paths can look like a post's (the search page is
// /search/posts/): never a post.
const NOT_A_POST = /^\/(search|hashtag|watch\/search|events|marketplace|login|help|policies|privacy|settings|notifications|messages|bookmarks|friends|gaming|ads|business|pages\/create)(\/|$)/i;

// A post's address without tracking parameters, or '' if it is not a post.
function cleanPostUrl(href) {
  try {
    const u = new URL(unwrap(href));
    if (u.protocol !== 'https:' || !isFacebookHost(u.hostname) || NOT_A_POST.test(u.pathname)) return '';
    // A group post as Facebook links it from search: /groups/<id>/?multi_permalinks=<post>.
    const group = u.pathname.match(/^\/groups\/([^/]+)\/?$/);
    const multi = (u.searchParams.get('multi_permalinks') || '').split(',')[0];
    if (group && /^\d+$/.test(multi)) return `https://www.facebook.com/groups/${group[1]}/posts/${multi}`;
    // A photo of a group post (set=gm.<post>&idorvanity=<group>).
    const gm = (u.searchParams.get('set') || '').match(/^gm\.(\d+)$/);
    if (/^\/photo\/?$/.test(u.pathname) && gm && u.searchParams.get('idorvanity')) return `https://www.facebook.com/groups/${u.searchParams.get('idorvanity')}/posts/${gm[1]}`;
    if (!POST_PATH.test(u.pathname)) return '';
    const q = new URLSearchParams();
    for (const k of KEEP_PARAMS) if (u.searchParams.get(k)) q.set(k, u.searchParams.get(k));
    const qs = q.toString();
    return `https://www.facebook.com${u.pathname.replace(/\/$/, '')}${qs ? `?${qs}` : ''}`;
  } catch {
    return '';
  }
}

// The author's page or profile address, or ''.
function cleanProfileUrl(href) {
  try {
    const u = new URL(unwrap(href));
    if (u.protocol !== 'https:' || !isFacebookHost(u.hostname)) return '';
    if (/^\/(search|hashtag|watch|events|marketplace|login)\b/.test(u.pathname)) return '';
    if (/^\/profile\.php$/.test(u.pathname)) return u.searchParams.get('id') ? `https://www.facebook.com/profile.php?id=${u.searchParams.get('id')}` : '';
    return `https://www.facebook.com${u.pathname.replace(/\/$/, '')}`;
  } catch {
    return '';
  }
}

// --- phone numbers -----------------------------------------------------------

// Numbers in a post: tel: and WhatsApp (wa.me) links, and numbers in the
// text (any country; see findPhones). Local numbers ("0300 1234567") are
// read with `country`; without it, with a country the post's own
// international numbers show; otherwise they are kept as unverified (the
// text as written), never guessed. Returns { phones: [{ phone, country,
// raw, status }], stats }.
function readPhones(text, links = [], country = null) {
  return findPhones(text, { country, links: links.map((h) => unwrap(h) || h), max: MAX_PHONES_PER_POST });
}

// The validated numbers only (E.164), as before: [{ phone, country, raw }].
function extractPhones(text, links = [], country = null) {
  return readPhones(text, links, country).phones.filter((p) => p.status === 'valid').map(({ phone, country: c, raw }) => ({ phone, country: c, raw }));
}

// --- page state ----------------------------------------------------------------

// 'login' | 'checkpoint' | 'blocked' | null. Lead Finder never acts on these
// pages; the Facebook search stops and says what the user needs to do.
async function detectState(page) {
  const url = page.url();
  if (/facebook\.com\/(login|login\.php)\b/i.test(url)) return 'login';
  if (/facebook\.com\/checkpoint\b/i.test(url)) return 'checkpoint';
  try {
    return await page.evaluate(() => {
      if (document.querySelector('iframe[src*="captcha" i], #captcha, [id*="captcha" i] iframe')) return 'checkpoint';
      const text = (document.body?.innerText || '').slice(0, 6000);
      if (/you(’|')re temporarily blocked|you can(’|')t use this feature (right now|at the moment)|we limit how often you can|your account (has been )?(locked|suspended|disabled)/i.test(text)) return 'blocked';
      const pass = document.querySelector('input[name="pass"], input[type="password"]');
      if (pass && pass.offsetParent !== null) return 'login';
      if (/you must log in to continue|log in to continue/i.test(text) && !document.querySelector('[role="feed"], [role="article"]')) return 'login';
      return null;
    });
  } catch {
    return null; // mid-navigation; checked again on the next step
  }
}

// --- search results ------------------------------------------------------------

// Facebook keeps its c_user cookie while an account is logged in; only
// whether it exists is checked (never its value). Unknown counts as yes, and
// the page itself decides.
async function loggedIn(page) {
  try {
    return (await page.context().cookies('https://www.facebook.com')).some((c) => c.name === 'c_user');
  } catch {
    return true;
  }
}

// Opens the post search for `query`. Returns { mode: 'list' | 'empty' |
// 'login' | 'checkpoint' | 'blocked' | 'failed', detail }. Without a
// Facebook login in this Chrome profile, Facebook is not opened at all.
async function openSearch(page, query, { timeout = 25_000 } = {}) {
  if (!(await loggedIn(page))) return { mode: 'login' };
  await page.goto(searchUrl(query), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await detectState(page);
    if (state) return { mode: state };
    const found = await page
      .evaluate(() => {
        if (document.querySelector('[role="article"], div[aria-posinset]')) return 'list';
        const text = document.body?.innerText || '';
        if (/we didn(’|')t find any results|no results found|make sure all words are spelled correctly/i.test(text)) return 'empty';
        return null;
      })
      .catch(() => null);
    if (found) return { mode: found };
    await page.waitForTimeout(500);
  }
  return { mode: 'failed', detail: `no posts appeared (page: ${page.url().slice(0, 120)})` };
}

// Runs inside the page; self-contained so it can be serialised. Top-level
// posts only (comments are nested articles): their text, author and links.
function collectInPage() {
  const sel = '[role="article"], div[aria-posinset]';
  const posts = [...document.querySelectorAll(sel)].filter((el) => !el.parentElement?.closest(sel));
  // The post's own text: its message block when Facebook marks one, else
  // the post without its comments (comments are read separately).
  const ownText = (el) => {
    const message = el.querySelector('[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-ad-rendering-role="story_message"]');
    if (message) return message.innerText;
    const copy = el.cloneNode(true);
    for (const c of copy.querySelectorAll(sel)) c.remove();
    document.body.appendChild(copy);
    copy.style.cssText = 'position:absolute;left:-99999px;top:0;width:600px';
    const t = copy.innerText;
    copy.remove();
    return t;
  };
  return posts.map((el) => {
    const author = el.querySelector('h2 a[href], h3 a[href], h4 a[href], strong a[href]');
    const comments = [...el.querySelectorAll(sel)].slice(0, 15).map((c) => {
      const who = c.querySelector('a[href] span, a[href]');
      const link = c.querySelector('a[href]');
      return { text: (c.innerText || '').slice(0, 1500), author: who ? who.textContent.trim().slice(0, 200) : '', authorUrl: link ? link.href : '' };
    });
    return {
      text: ownText(el).slice(0, 4000),
      author: author ? author.innerText.trim().slice(0, 200) : '',
      authorUrl: author ? author.href : '',
      hrefs: [...el.querySelectorAll('a[href]')].map((a) => a.href).slice(0, 100),
      comments,
    };
  });
}

// Posts on screen: { key, url, pageUrl, author, text, links }. `url` is the
// post's own address (or '' when it shows none).
async function collectPosts(page) {
  return (await page.evaluate(collectInPage)).map(parsePost);
}

// The post's own address: its post/permalink link first, a photo of it last.
function postUrlOf(hrefs) {
  const found = hrefs.map(cleanPostUrl).filter(Boolean);
  return found.find((u) => !/\/photo(\.php|\/|$)|\/photos\//.test(new URL(u).pathname)) || found[0] || '';
}

function parsePost(raw) {
  const hrefs = raw.hrefs || [];
  const url = postUrlOf(hrefs);
  const pageUrl = cleanProfileUrl(raw.authorUrl);
  const links = hrefs.map((h) => unwrap(h) || h).filter((h) => /^tel:|wa\.me\/|whatsapp\.com\/send/i.test(h));
  const text = String(raw.text || '').trim();
  const key = url || (text ? `text:${crypto.createHash('sha1').update(`${pageUrl}\n${text}`).digest('hex')}` : '');
  const comments = (raw.comments || [])
    .map((c) => ({ text: String(c.text || '').trim(), author: String(c.author || '').trim(), pageUrl: cleanProfileUrl(c.authorUrl) }))
    .filter((c) => c.text);
  return { key, url, pageUrl, author: String(raw.author || '').trim(), text, links, comments };
}

// Facebook leaves a post's own link (its date) as "?__cft__..." (or "#")
// until the pointer is over it; read as is, that is the search page. For
// posts without a post link, those links are hovered so Facebook fills in the
// post's address, the way it does for a person reading. Returns how many
// were hovered.
async function revealPostLinks(page, { max = 12 } = {}) {
  const n = await page
    .evaluate((limit) => {
      const sel = '[role="article"], div[aria-posinset]';
      const posts = [...document.querySelectorAll(sel)].filter((el) => !el.parentElement?.closest(sel));
      const isPost = (h) => /\/posts\/|\/permalink|story_fbid|multi_permalinks|\/videos\/|\/reel\//.test(h || '') && !/^\/?search\//.test(h || '');
      let i = 0;
      for (const post of posts) {
        if (i >= limit) break;
        if ([...post.querySelectorAll('a[href]')].some((a) => isPost(a.getAttribute('href')))) continue;
        const own = [...post.querySelectorAll('a')].filter((a) => !a.closest(sel + ' ' + sel) || a.closest(sel) === post);
        const cand = own.find((a) => {
          const h = a.getAttribute('href');
          return (!h || h.startsWith('#') || h.startsWith('?')) && a.offsetParent !== null;
        });
        if (cand) cand.setAttribute('data-lf-reveal', String(i++));
      }
      return i;
    }, max)
    .catch(() => 0);
  for (let i = 0; i < n; i++) {
    const a = page.locator(`[data-lf-reveal="${i}"]`).first();
    await a.hover({ timeout: 2500 }).catch(() => a.hover({ timeout: 1000, force: true }).catch(() => {}));
    await a.focus({ timeout: 500 }).catch(() => {});
  }
  if (n) await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelectorAll('[data-lf-reveal]').forEach((a) => a.removeAttribute('data-lf-reveal'))).catch(() => {});
  return n;
}

// Opens Facebook's "See more" on long posts so their full text (and number)
// is read. Returns how many were opened.
async function expandSeeMore(page) {
  const n = await page
    .evaluate(() => {
      const sel = '[role="article"], div[aria-posinset]';
      let clicked = 0;
      for (const post of document.querySelectorAll(sel)) {
        for (const b of post.querySelectorAll('[role="button"]')) {
          if (clicked >= 10) break;
          if (/^see more$/i.test((b.innerText || '').trim()) && b.offsetParent !== null) {
            b.click();
            clicked++;
          }
        }
      }
      return clicked;
    })
    .catch(() => 0);
  if (n) await page.waitForTimeout(600);
  return n;
}

// Runs inside the page; self-contained so it can be serialised. What the
// results look like now: how many posts, the last one (to notice new posts
// even if Facebook drops old ones from the page), the page height, whether
// Facebook shows a loading indicator, and whether it shows its own
// "End of results" marker (a visible element, not just text somewhere).
function resultsStateInPage() {
  const sel = '[role="article"], div[aria-posinset]';
  const posts = [...document.querySelectorAll(sel)].filter((el) => !el.parentElement?.closest(sel));
  const last = posts.at(-1);
  const lastKey = last ? (last.querySelector('a[href*="/posts/"], a[href*="permalink"], a[href*="story_fbid"]')?.getAttribute('href') || '') + (last.innerText || '').slice(0, 80) : '';
  const shown = (el) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed';
  const loading = [...document.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some(shown);
  let end = false;
  for (const el of document.querySelectorAll('span, div, h2, h3')) {
    if (el.childElementCount === 0 && /^(end of results|no more results|you('|’)ve reached the end of the results)\.?$/i.test((el.textContent || '').trim()) && shown(el)) {
      end = true;
      break;
    }
  }
  const scroller = document.scrollingElement || document.documentElement;
  return { count: posts.length, lastKey, height: scroller.scrollHeight, loading, end };
}

async function resultsState(page) {
  return page.evaluate(resultsStateInPage);
}

// Asks Facebook for the next results: the last post into view, then the
// page (or the box the results scroll in) to its bottom, where Facebook's
// infinite scroll loads more. Returns the state after scrolling.
async function scrollResults(page) {
  await page.evaluate(() => {
    const sel = '[role="article"], div[aria-posinset]';
    const posts = [...document.querySelectorAll(sel)].filter((el) => !el.parentElement?.closest(sel));
    const last = posts.at(-1);
    last?.scrollIntoView({ block: 'end' });
    let box = last?.parentElement;
    while (box && box !== document.body && box !== document.documentElement) {
      if (box.scrollHeight > box.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(box).overflowY)) {
        box.scrollTop = box.scrollHeight;
        break;
      }
      box = box.parentElement;
    }
    window.scrollTo(0, (document.scrollingElement || document.documentElement).scrollHeight);
  });
  return resultsState(page);
}

// Waits until the results change after a scroll: more posts, a different
// last post, or the page grew. While Facebook shows its loading indicator
// the wait is extended (up to twice). Returns { ...state, grew }.
async function waitForMore(page, before, { timeout = 10_000, poll = 400 } = {}) {
  let deadline = Date.now() + timeout;
  let extended = false;
  for (;;) {
    const st = await resultsState(page).catch(() => null);
    if (st) {
      const grew = st.count > before.count || (st.lastKey && st.lastKey !== before.lastKey) || st.height > before.height + 40;
      if (grew || st.end) return { ...st, grew: Boolean(grew) };
      if (Date.now() >= deadline) {
        if (st.loading && !extended) {
          extended = true;
          deadline = Date.now() + timeout;
        } else return { ...st, grew: false };
      }
    } else if (Date.now() >= deadline) return { ...before, grew: false };
    await page.waitForTimeout(poll);
  }
}

// When nothing loads: a screen up and back down again, which makes
// Facebook's infinite scroll notice the bottom once more.
async function nudge(page) {
  await page.evaluate(() => window.scrollBy(0, -Math.max(400, window.innerHeight)));
  await page.waitForTimeout(500);
  return scrollResults(page);
}

module.exports = {
  FB_HOME,
  searchUrl,
  buildQueries,
  cleanPostUrl,
  cleanProfileUrl,
  extractPhones,
  readPhones,
  revealPostLinks,
  detectState,
  loggedIn,
  openSearch,
  collectInPage,
  collectPosts,
  parsePost,
  expandSeeMore,
  resultsStateInPage,
  resultsState,
  scrollResults,
  waitForMore,
  nudge,
};
