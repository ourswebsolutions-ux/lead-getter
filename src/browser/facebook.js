'use strict';

// Facebook post search, performed in a tab of the user's own Chrome with the
// Facebook login already in that profile. Lead Finder only reads what the
// search results show: it never logs in, solves a check or works around a
// block; it reports them and stops the Facebook part of the search.

const crypto = require('node:crypto');
const { parsePhoneNumberFromString, findPhoneNumbersInText } = require('libphonenumber-js/max');

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

const POST_PATH = /\/posts\/|\/permalink\/|\/permalink\.php|\/story\.php|\/photo\.php|\/photos\/|\/videos\/|\/reel\/|\/groups\/[^/]+\/(posts|permalink)\//;
// Query parameters that identify a post; everything else is tracking.
const KEEP_PARAMS = ['story_fbid', 'id', 'fbid', 'v', 'set'];

// A post's address without tracking parameters, or '' if it is not a post.
function cleanPostUrl(href) {
  try {
    const u = new URL(unwrap(href));
    if (u.protocol !== 'https:' || !isFacebookHost(u.hostname) || !POST_PATH.test(u.pathname)) return '';
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

// Arabic-Indic and Persian digits as 0-9, so "۰۳۰۰" is read like "0300".
function asciiDigits(text) {
  return String(text || '').replace(/[٠-٩۰-۹]/g, (d) => String((d.charCodeAt(0) & 0xf) % 10));
}

// Valid numbers in a post: tel: and WhatsApp (wa.me) links, and numbers in
// the text. Local numbers ("0300 1234567") are read with `country` (the
// country of the user's other leads); without it only numbers written in
// international form are kept. Numbers that are not valid for their country
// are dropped, never guessed. Returns [{ phone (E.164), country, raw }].
function extractPhones(text, links = [], country = null) {
  const out = new Map();
  const add = (parsed, raw) => {
    if (parsed?.isValid() && !out.has(parsed.number)) out.set(parsed.number, { phone: parsed.number, country: parsed.country || null, raw: String(raw).trim() });
  };
  for (const href of links) {
    const target = unwrap(href) || href;
    const tel = /^tel:(.+)$/i.exec(target);
    if (tel) {
      const raw = decodeURIComponent(tel[1]);
      add(parsePhoneNumberFromString(asciiDigits(raw), country || undefined), raw);
      continue;
    }
    try {
      const u = new URL(target);
      const wa = /^(www\.)?wa\.me$/i.test(u.hostname) ? u.pathname.slice(1) : /(^|\.)whatsapp\.com$/i.test(u.hostname) ? u.searchParams.get('phone') : null;
      // WhatsApp links always carry the number in international form.
      const digits = String(wa || '').replace(/\D/g, '');
      if (digits.length >= 8) add(parsePhoneNumberFromString(`+${digits}`), `+${digits}`);
    } catch {}
  }
  // Numbers listed with commas ("0300 1234567, 0321 7654321") are read
  // one by one; the matcher otherwise stops at the first.
  const plain = asciiDigits(text).replace(/[,;|،]/g, '\n');
  for (const m of findPhoneNumbersInText(plain, country ? { defaultCountry: country } : undefined)) {
    add(m.number, plain.slice(m.startsAt, m.endsAt));
  }
  return [...out.values()].slice(0, MAX_PHONES_PER_POST);
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
  return posts.map((el) => {
    const message = el.querySelector('[data-ad-preview="message"], [data-ad-comet-preview="message"]');
    const author = el.querySelector('h2 a[href], h3 a[href], h4 a[href], strong a[href]');
    return {
      text: (message || el).innerText.slice(0, 4000),
      author: author ? author.innerText.trim().slice(0, 200) : '',
      authorUrl: author ? author.href : '',
      hrefs: [...el.querySelectorAll('a[href]')].map((a) => a.href).slice(0, 100),
    };
  });
}

// Posts on screen: { key, url, pageUrl, author, text, links }. `url` is the
// post's own address (or '' when it shows none).
async function collectPosts(page) {
  return (await page.evaluate(collectInPage)).map(parsePost);
}

function parsePost(raw) {
  const hrefs = raw.hrefs || [];
  const url = hrefs.map(cleanPostUrl).find(Boolean) || '';
  const pageUrl = cleanProfileUrl(raw.authorUrl);
  const links = hrefs.map((h) => unwrap(h) || h).filter((h) => /^tel:|wa\.me\/|whatsapp\.com\/send/i.test(h));
  const text = String(raw.text || '').trim();
  const key = url || (text ? `text:${crypto.createHash('sha1').update(`${pageUrl}\n${text}`).digest('hex')}` : '');
  return { key, url, pageUrl, author: String(raw.author || '').trim(), text, links };
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

// Scrolls the results one screen. Returns { end } when Facebook says there
// are no more results.
async function scrollResults(page) {
  return page.evaluate(() => {
    const before = window.scrollY;
    window.scrollBy({ top: Math.max(400, window.innerHeight * 0.9) });
    const text = (document.body?.innerText || '').slice(-3000);
    return { end: /end of results|no more results|we didn(’|')t find any more/i.test(text), moved: window.scrollY !== before };
  });
}

module.exports = {
  FB_HOME,
  searchUrl,
  buildQueries,
  cleanPostUrl,
  cleanProfileUrl,
  extractPhones,
  detectState,
  loggedIn,
  openSearch,
  collectInPage,
  collectPosts,
  parsePost,
  expandSeeMore,
  scrollResults,
};
