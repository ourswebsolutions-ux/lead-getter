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

// Emails, phones and contact-page links on one page.
function contactsFromHtml(html, baseUrl, { country = null } = {}) {
  const links = hrefsOf(html, baseUrl);
  const text = textOf(html);
  const emails = new Set();
  for (const l of links) {
    const m = /^mailto:([^?]+)/i.exec(l.href);
    if (m) emails.add(decodeURIComponent(m[1]).trim().toLowerCase());
  }
  for (const m of text.matchAll(EMAIL)) emails.add(m[0].toLowerCase().replace(/\.$/, ''));
  const tels = links.filter((l) => /^tel:/i.test(l.href)).map((l) => l.href);
  const { phones } = findPhones(text, { country, links: tels, max: 5 });
  const host = hostOf(baseUrl);
  const contactPages = links
    .filter((l) => hostOf(l.href) === host && /contact|about|reach|support|get-in-touch|enquir|inquir/i.test(`${l.href} ${l.text}`))
    .map((l) => l.href.split('#')[0])
    .filter((h, i, a) => h && a.indexOf(h) === i);
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

// { emails: [best first], phones: [{ phone, raw, status, country }],
//   pages: [urls read], error }.
async function findContacts(website, { country = null, fetchImpl, signal, maxPages = 3, timeout } = {}) {
  const home = await fetchPage(website, { fetchImpl, signal, timeout });
  if (!home.ok) return { emails: [], phones: [], pages: [], error: home.error || `HTTP ${home.status || 'error'}` };
  const pages = [home.url];
  const first = contactsFromHtml(home.html, home.url, { country });
  const emails = [...first.emails];
  const phones = [...first.phones];
  for (const url of first.contactPages.slice(0, maxPages - 1)) {
    const p = await fetchPage(url, { fetchImpl, signal, timeout });
    if (!p.ok) continue;
    pages.push(p.url);
    const c = contactsFromHtml(p.html, p.url, { country });
    emails.push(...c.emails);
    for (const ph of c.phones) if (!phones.some((x) => x.phone === ph.phone)) phones.push(ph);
  }
  // Validated numbers first.
  phones.sort((a, b) => (a.status === 'valid' ? 0 : 1) - (b.status === 'valid' ? 0 : 1));
  return { emails: rankEmails(emails, home.url), phones, pages, error: null };
}

module.exports = { findContacts, contactsFromHtml, rankEmails, textOf, fetchPage };
