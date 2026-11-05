'use strict';

// Public business contact details from a company's own website: its home
// page and up to two of its contact/about pages, fetched directly (no
// browser). mailto:/tel: links and emails/numbers in the visible text.
// Nothing is guessed or invented; only what the site publishes.

const { findPhones } = require('../database/phone');

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;
const NOT_AN_EMAIL = /\.(png|jpe?g|gif|svg|webp|ico|css|js)$|@(example\.(com|org)|domain\.com|email\.com|sentry\.io|[a-z0-9.-]*sentry[a-z0-9.-]*|wixpress\.com|godaddy\.com|2x\.)|^(noreply|no-reply|donotreply|do-not-reply)@/i;
const FREE_MAIL = /@(gmail|yahoo|hotmail|outlook|live|icloud|proton(mail)?|yandex|aol)\./i;

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

// Visible text of an HTML page (scripts, styles and tags removed; block
// elements become line breaks so separate items are never joined).
function textOf(html) {
  return decodeEntities(
    String(html)
      .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d|\/td|\/section|\/footer|\/header|\/address)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*/g, '\n');
}

function hrefsOf(html, base) {
  const out = [];
  for (const m of String(html).matchAll(/<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi)) {
    const raw = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '').trim();
    try {
      out.push({ href: /^(mailto|tel):/i.test(raw) ? raw : new URL(raw, base).toString(), text: textOf(m[5]).trim().slice(0, 80) });
    } catch {}
  }
  return out;
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

const decodeMailto = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // a stray % in the address
  }
};

// Cloudflare's email protection: the address is shown to visitors, by a
// script, from a hex string in the page.
function cloudflareEmails(html) {
  const out = [];
  for (const m of String(html).matchAll(/data-cfemail="([0-9a-f]{4,})"|\/cdn-cgi\/l\/email-protection#([0-9a-f]{4,})/gi)) {
    const hex = m[1] || m[2];
    if (hex.length % 2) continue;
    const key = parseInt(hex.slice(0, 2), 16);
    let email = '';
    for (let i = 2; i < hex.length; i += 2) email += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    out.push(email);
  }
  return out;
}

// The business's own data for search engines ("email": "..." in JSON-LD).
function structuredEmails(html) {
  return [...String(html).matchAll(/"email"\s*:\s*"(?:mailto:)?([^"\s]+@[^"\s]+)"/gi)].map((m) => m[1]);
}

// Emails, phones and contact-page links on one page (all of it: header,
// navigation, body and footer).
function contactsFromHtml(html, baseUrl, { country = null } = {}) {
  const links = hrefsOf(html, baseUrl);
  const text = textOf(html);
  const emails = new Set();
  for (const l of links) {
    const m = /^mailto:([^?]+)/i.exec(l.href);
    if (m) emails.add(decodeMailto(m[1]).trim().toLowerCase());
  }
  for (const m of text.matchAll(EMAIL)) emails.add(m[0].toLowerCase().replace(/\.$/, ''));
  for (const e of [...cloudflareEmails(html), ...structuredEmails(html)]) if (new RegExp(`^${EMAIL.source}$`, 'i').test(e)) emails.add(e.toLowerCase());
  const tels = links.filter((l) => /^tel:/i.test(l.href)).map((l) => l.href);
  const { phones } = findPhones(text, { country, links: tels, max: 5 });
  const host = hostOf(baseUrl);
  const contactPages = links
    .filter((l) => hostOf(l.href) === host && /contact|about|reach|support|get-in-touch|enquir|inquir|guest|booking|be-on|advertis|sponsor|press|media-kit|work-with|partner/i.test(`${l.href} ${l.text}`))
    .map((l) => l.href.split('#')[0])
    .filter((h, i, a) => h && a.indexOf(h) === i)
    // Contact pages first, then About, then the rest (they are read in this order).
    .map((h, i) => [/contact|reach|get-in-touch|enquir|inquir/i.test(h) ? 0 : /about/i.test(h) ? 1 : 2, i, h])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map((x) => x[2]);
  return { emails: [...emails].filter((e) => !NOT_AN_EMAIL.test(e)), phones, contactPages };
}

// Business emails first: the site's own domain, then free mail
// addresses, then others.
function rankEmails(emails, site) {
  const host = hostOf(site);
  const score = (e) => {
    const d = e.split('@')[1] || '';
    if (host && (d === host || d.endsWith(`.${host}`) || host.endsWith(`.${d}`))) return /^(info|contact|hello|sales|office|admin|support|hr|careers|jobs|business)@/.test(e) ? 0 : 1;
    return FREE_MAIL.test(e) ? 2 : 3;
  };
  return [...new Set(emails)].sort((a, b) => score(a) - score(b));
}

// fetchImpl(url, init) -> Response. One retry after a short wait.
async function fetchPage(url, { fetchImpl = globalThis.fetch, timeout = 12_000, maxBytes = 1_500_000, signal } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let timer;
    try {
      const limit = AbortSignal.timeout(timeout);
      // The time limit holds even if a request ignores its abort signal.
      const expired = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), timeout + 50);
      });
      const res = await Promise.race([
        fetchImpl(url, {
          redirect: 'follow',
          headers: { 'user-agent': 'Mozilla/5.0 (Lead Finder; business contact lookup)', accept: 'text/html,application/xhtml+xml' },
          signal: signal ? AbortSignal.any([signal, limit]) : limit,
        }),
        expired,
      ]);
      if (!res.ok || !/html|xml|text\/plain/i.test(res.headers.get('content-type') || 'text/html')) return { ok: false, status: res.status };
      const buf = Buffer.from(await Promise.race([res.arrayBuffer(), expired]));
      return { ok: true, url: res.url || url, html: buf.subarray(0, maxBytes).toString('utf8') };
    } catch (err) {
      if (signal?.aborted) throw err;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
      else return { ok: false, error: err?.name === 'TimeoutError' ? 'timed out' : 'could not be reached' };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false };
}

// Where contact details usually are, for sites whose links are not in the
// page (menus built by scripts). Tried only when an email is still missing.
const USUAL_PAGES = ['/contact', '/contact-us', '/about', '/about-us'];

// The pages to read after the home page: the ones it links to, then the usual ones.
function nextPages(found, base, guess) {
  const list = [...found];
  if (guess) for (const p of USUAL_PAGES) list.push(new URL(p, base).toString());
  const seen = new Set([base.replace(/\/$/, '')]);
  return list.filter((u) => {
    const k = u.replace(/\/$/, '');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// { emails: [best first], phones: [{ phone, raw, status, country }],
//   pages: [urls read], error }.
// allow(url) -> Promise<boolean>: pages it refuses are not read (robots.txt).
// stopAtEmail: no more pages once an email is found (the home page's own
// links, then, with guess, the usual addresses of a contact or about page).
async function findContacts(website, { country = null, fetchImpl, signal, maxPages = 3, timeout, allow, stopAtEmail = false, guess = false } = {}) {
  if (allow && !(await allow(website))) return { emails: [], phones: [], pages: [], error: 'its robots.txt does not permit automated reading' };
  const home = await fetchPage(website, { fetchImpl, signal, timeout });
  if (!home.ok) return { emails: [], phones: [], pages: [], error: home.error || `HTTP ${home.status || 'error'}` };
  const pages = [home.url];
  const first = contactsFromHtml(home.html, home.url, { country });
  const emails = [...first.emails];
  const phones = [...first.phones];
  // The page each email was first seen on.
  const emailPages = Object.fromEntries(first.emails.map((e) => [e, home.url]));
  for (const url of nextPages(first.contactPages, home.url, guess)) {
    if (pages.length >= maxPages || (stopAtEmail && emails.length)) break;
    if (allow && !(await allow(url))) continue;
    const p = await fetchPage(url, { fetchImpl, signal, timeout });
    if (!p.ok) continue;
    pages.push(p.url);
    const c = contactsFromHtml(p.html, p.url, { country });
    emails.push(...c.emails);
    for (const e of c.emails) emailPages[e] ||= p.url;
    for (const ph of c.phones) if (!phones.some((x) => x.phone === ph.phone)) phones.push(ph);
  }
  // Validated numbers first.
  phones.sort((a, b) => (a.status === 'valid' ? 0 : 1) - (b.status === 'valid' ? 0 : 1));
  return { emails: rankEmails(emails, home.url), phones, pages, emailPages, error: null };
}

// The same, read in a browser tab: for sites that refuse a plain request
// (bot protection, HTTP 403) or need scripts to show their contact details.
async function findContactsInPage(page, website, { country = null, maxPages = 3, timeout = 25_000, allow, stopAtEmail = false, guess = false } = {}) {
  const read = async (url) => {
    try {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      if (res && res.status() >= 400) return null;
      await page.waitForTimeout(1500);
      return { url: page.url(), html: await page.content() };
    } catch {
      // A failed load is still turning into Chrome's error page: let it
      // settle so the page's next navigation isn't interrupted by it.
      await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
      return null;
    }
  };
  if (allow && !(await allow(website))) return { emails: [], phones: [], pages: [], error: 'its robots.txt does not permit automated reading' };
  const home = await read(website);
  if (!home) return { emails: [], phones: [], pages: [], error: 'could not be opened' };
  const pages = [home.url];
  const first = contactsFromHtml(home.html, home.url, { country });
  const emails = [...first.emails];
  const phones = [...first.phones];
  for (const url of nextPages(first.contactPages, home.url, guess)) {
    if (pages.length >= maxPages || (stopAtEmail && emails.length)) break;
    if (allow && !(await allow(url))) continue;
    const p = await read(url);
    if (!p) continue;
    pages.push(p.url);
    const c = contactsFromHtml(p.html, p.url, { country });
    emails.push(...c.emails);
    for (const ph of c.phones) if (!phones.some((x) => x.phone === ph.phone)) phones.push(ph);
  }
  phones.sort((a, b) => (a.status === 'valid' ? 0 : 1) - (b.status === 'valid' ? 0 : 1));
  return { emails: rankEmails(emails, home.url), phones, pages, error: null, via: 'browser' };
}

module.exports = { findContacts, findContactsInPage, contactsFromHtml, rankEmails, textOf, fetchPage, NOT_AN_EMAIL };
