'use strict';

// Contact discovery for a person found on LinkedIn (ContactOut-style
// enrichment, with free and self-hosted means only). LinkedIn gives the
// identity (name, title, company, location, profile); this finds that
// person's professional email and phone from:
//
//   0. a contact provider the user has (the ContactOut extension), when on
//   1. what LinkedIn itself shows the user (the profile's Contact info)
//   2. local contact datasets (CSV files the user imported) and the leads
//      already saved for the same company
//   3. the company's public website: team, about, contact and similar pages
//      (only where robots.txt allows); an email or number counts as the
//      person's only when it is written next to their name, or the address
//      itself is made of their name
//   4. the company's email format: addresses built from the name at the
//      company's own domain, kept only when the domain's mail server
//      confirms the mailbox (never for free-mail domains, never when the
//      server accepts every address)
//
// Every email ends verified (the mail server confirmed it), unverified
// (published, but the server could not confirm it) or invalid (the server
// says it does not exist). Phones are direct (the person's) or company,
// each checked against its country's numbering plan. Nothing is invented:
// an address built from a name is never kept unless confirmed.

const contactsDefault = require('./website-contacts');
const { normalizePhone, findPhones, countryFromAddress } = require('../database/phone');

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;
const ROLE = /^(info|contact|contacts|hello|hi|sales|office|admin|support|team|enquiries|enquiry|inquiries|inquiry|marketing|hr|careers|jobs|recruit|recruitment|press|media|pr|billing|accounts|accounting|finance|help|mail|webmaster|postmaster|service|services|customerservice|bookings|booking|reservations|partners|partnerships|privacy|legal|security|abuse|noreply|no-reply|news|newsletter|feedback|general|reception|studio|business|team)$/i;
const FREE_MAIL = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|aol|proton|protonmail|pm|yandex|gmx|zoho|mail|hey|fastmail|tutanota|qq|163|126|rediffmail)\.[a-z.]+$/i;
const TEAM_PAGE = /team|people|staff|leadership|management|about|contact|who-we-are|our-story|founder|meet|directory|partners|attorneys|lawyers|our-firm|experts|consultants|company/i;
const PEOPLE_PAGE = /team|people|staff|leadership|management|directory|attorneys|lawyers|experts|consultants|founder|meet/i;
const GUESS_PATHS = ['/about', '/about-us', '/team', '/our-team', '/contact', '/contact-us', '/leadership', '/people'];
const TITLES = /^(mr|mrs|ms|miss|dr|prof|sir|eng|engr|er|ca|cpa|adv|hon)\.?$/i;
const CREDENTIALS = /,.*$|\b(mba|phd|ph\.d|cpa|pmp|cfa|acca|msc|bsc|jr|sr|iii|iv)\b\.?/gi;

const fold = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');

// { first, last, full, tokens } from a LinkedIn name ("Dr. Jane A. Doe, MBA
// 🚀" -> jane / doe), or null when there is no usable first and last name.
function parseName(full) {
  const cleaned = fold(full)
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^\p{L}\s'.,-]/gu, ' ')
    .replace(CREDENTIALS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = cleaned.split(' ').map((w) => w.replace(/^[.'-]+|[.,'-]+$/g, '')).filter((w) => w && !TITLES.test(w));
  const letters = words.filter((w) => /\p{L}{2,}/u.test(w));
  if (letters.length < 2) return null;
  const ascii = (w) => w.toLowerCase().replace(/[^a-z]/g, '');
  const first = ascii(letters[0]);
  const last = ascii(letters[letters.length - 1]);
  return {
    first,
    last,
    // Names that are not written in Latin letters give no email candidates.
    latin: first.length >= 2 && last.length >= 2,
    display: letters.join(' '),
    words: letters.map((w) => w.toLowerCase()),
  };
}

// The organisation part of a host ("mail.acme.co.uk" -> "acme.co.uk").
function baseDomain(host) {
  const parts = String(host || '').toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const sld = parts[parts.length - 2];
  const tld = parts[parts.length - 1];
  const keep = tld.length === 2 && /^(co|com|org|net|ac|gov|edu|ltd|plc|or|ne|gob|nic)$/.test(sld) ? 3 : 2;
  return parts.slice(-keep).join('.');
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

const domainOf = (email) => String(email).split('@')[1]?.toLowerCase() || '';
const localOf = (email) => String(email).split('@')[0]?.toLowerCase() || '';
const sameDomain = (a, b) => Boolean(a && b) && baseDomain(a) === baseDomain(b);

// How an email's own address relates to a name: 'name' (made of it),
// 'role' (info@, sales@ ...), or 'other'.
function emailKind(email, name) {
  const local = localOf(email);
  if (ROLE.test(local.replace(/[0-9]+$/, ''))) return 'role';
  if (!name?.latin) return 'other';
  const { first, last } = name;
  const flat = local.replace(/[^a-z]/g, '');
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (flat === `${first}${last}` || flat === `${last}${first}`) return 'name';
  if (parts.includes(first) && parts.includes(last)) return 'name';
  if (flat === `${first[0]}${last}` || flat === `${first}${last[0]}` || flat === `${last}${first[0]}`) return 'name';
  if (parts.length === 2 && ((parts[0] === first[0] && parts[1] === last) || (parts[0] === first && parts[1] === last[0]))) return 'name';
  // The first name alone counts only at the person's company (checked by the caller).
  if (flat === first && first.length >= 3) return 'first';
  return 'other';
}

const PATTERNS = {
  'first.last': (n) => `${n.first}.${n.last}`,
  first: (n) => n.first,
  firstlast: (n) => `${n.first}${n.last}`,
  flast: (n) => `${n.first[0]}${n.last}`,
  'f.last': (n) => `${n.first[0]}.${n.last}`,
  first_last: (n) => `${n.first}_${n.last}`,
  firstl: (n) => `${n.first}${n.last[0]}`,
  last: (n) => n.last,
  'last.first': (n) => `${n.last}.${n.first}`,
  'first-last': (n) => `${n.first}-${n.last}`,
  lastf: (n) => `${n.last}${n.first[0]}`,
};

// The formats a domain's known (non-role) addresses suggest, most likely first.
function patternOrder(knownEmails) {
  const score = Object.fromEntries(Object.keys(PATTERNS).map((k, i) => [k, -i / 100]));
  for (const e of knownEmails) {
    const l = localOf(e);
    if (ROLE.test(l)) continue;
    if (/^[a-z]\.[a-z]{2,}$/.test(l)) score['f.last'] += 3;
    else if (/^[a-z]{2,}\.[a-z]{2,}$/.test(l)) score['first.last'] += 3;
    else if (/^[a-z]{2,}_[a-z]{2,}$/.test(l)) score.first_last += 3;
    else if (/^[a-z]{2,}-[a-z]{2,}$/.test(l)) score['first-last'] += 3;
    else if (/^[a-z]{3,14}$/.test(l)) {
      score.first += 1;
      score.flast += 1;
      score.firstlast += 1;
    }
  }
  return Object.keys(PATTERNS).sort((a, b) => score[b] - score[a]);
}

function candidates(name, domain, knownEmails, max = 8) {
  if (!name?.latin || !domain) return [];
  return patternOrder(knownEmails)
    .map((p) => ({ email: `${PATTERNS[p](name)}@${domain}`, pattern: p }))
    .filter((c, i, a) => a.findIndex((x) => x.email === c.email) === i)
    .slice(0, max);
}

// Where the person's name is written in a text: indexes of each mention
// ("Jane Doe", "Jane A. Doe", "Doe, Jane").
function nameMentions(text, name) {
  if (!name) return [];
  const t = fold(text).toLowerCase();
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const first = esc(name.words[0]);
  const last = esc(name.words[name.words.length - 1]);
  const re = new RegExp(`\\b(${first}\\s+(?:[a-z]\\.?\\s+|[a-z]+\\s+)?${last}|${last},\\s*${first})\\b`, 'g');
  return [...t.matchAll(re)].map((m) => m.index);
}

// --- company website ---------------------------------------------------------------

// Reads a company's site once (home, then its team/about/contact pages and
// a few usual addresses): { pages: [{ url, text, links }], error }.
async function readSite(website, { fetchImpl, signal, allow, maxPages = 6, contacts = contactsDefault, timeout } = {}) {
  if (allow && !(await allow(website))) return { pages: [], error: 'its robots.txt does not permit automated reading' };
  const home = await contacts.fetchPage(website, { fetchImpl, signal, timeout });
  if (!home.ok) return { pages: [], error: home.error || `HTTP ${home.status || 'error'}` };
  const page = (url, html) => ({ url, text: contacts.textOf(html), links: linksOf(html, url) });
  const pages = [page(home.url, home.html)];
  const host = hostOf(home.url);
  const queue = pages[0].links
    .filter((l) => hostOf(l.href) === host && TEAM_PAGE.test(`${new URL(l.href).pathname} ${l.text}`))
    .map((l) => l.href.split('#')[0]);
  for (const p of GUESS_PATHS) queue.push(new URL(p, home.url).toString());
  const seen = new Set([home.url.replace(/\/$/, '')]);
  for (const url of queue) {
    if (pages.length >= maxPages) break;
    const key = url.replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    if (allow && !(await allow(url))) continue;
    const r = await contacts.fetchPage(url, { fetchImpl, signal, timeout });
    if (r.ok && hostOf(r.url) === host) pages.push(page(r.url, r.html));
  }
  return { pages, error: null };
}

function linksOf(html, base) {
  const out = [];
  for (const m of String(html).matchAll(/<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi)) {
    const raw = (m[2] ?? m[3] ?? m[4] ?? '').replace(/&amp;/g, '&').trim();
    try {
      out.push({ href: /^(mailto|tel):/i.test(raw) ? raw : new URL(raw, base).toString(), text: contactsDefault.textOf(m[5]).replace(/\s+/g, ' ').trim().slice(0, 120) });
    } catch {}
  }
  return out;
}

// What a site says about one person: emails/phones written next to their
// name, mailto links labelled with it, and every address at the domain
// (company addresses, and evidence of the domain's email format).
function personOnSite(site, name, { country }) {
  const near = { emails: new Map(), phones: [] };
  const domainEmails = new Set();
  for (const p of site.pages) {
    for (const m of p.text.matchAll(EMAIL)) domainEmails.add(m[0].toLowerCase().replace(/\.$/, ''));
    for (const l of p.links) {
      const mm = /^mailto:([^?]+)/i.exec(l.href);
      if (!mm) continue;
      const email = decodeURIComponent(mm[1]).trim().toLowerCase();
      domainEmails.add(email);
      if (name && nameMentions(l.text, name).length) near.emails.set(email, p.url);
    }
    for (const at of nameMentions(p.text, name)) {
      // Contact details written right after the name (a team card:
      // name, title, email, phone), not a neighbour's further on.
      const win = p.text.slice(at, at + 260);
      for (const m of win.matchAll(EMAIL)) {
        const email = m[0].toLowerCase().replace(/\.$/, '');
        if (emailKind(email, name) === 'name' || emailKind(email, name) === 'first') near.emails.set(email, p.url);
      }
      const ph = findPhones(win.slice(0, 200), { country, max: 2 }).phones;
      for (const x of ph) if (!near.phones.some((y) => y.phone === x.phone)) near.phones.push({ ...x, url: p.url });
    }
  }
  const all = [...domainEmails].filter((e) => !contactsDefault.NOT_AN_EMAIL.test(e));
  return { near, emails: all };
}

// --- the engine --------------------------------------------------------------------

// person: { name, title, company, location, profileUrl, website, companyPhone
//   ({ phone, raw, status, country, from }), profileEmails, profilePhones }
// opts: { store (findContactRecords), verifier (EmailVerifier, or null to
//   skip verification), fetchImpl, signal, allow (robots), country,
//   siteCache (Map: website -> site), maxCandidates, progress(text) }
async function discoverContacts(person, opts = {}) {
  const { store = null, verifier = null, fetchImpl, signal, allow, siteCache = new Map(), maxCandidates = 8, progress = () => {}, contacts = contactsDefault } = opts;
  const name = parseName(person.name);
  const country = countryFromAddress(person.location) || opts.country || null;
  const website = person.website || '';
  const domain = website ? baseDomain(hostOf(website)) : '';
  const checked = [];
  const failed = [];
  const emails = new Map(); // email -> { email, kind: 'person' | 'company', sources: [], status, reason }
  const phones = new Map(); // key -> { phone, raw, status, country, kind: 'direct' | 'company', source }
  const evidence = new Set(); // addresses at the company's domain (its email format)

  const addEmail = (raw, kind, source) => {
    const email = String(raw || '').trim().toLowerCase().replace(/^mailto:/, '');
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email) || contacts.NOT_AN_EMAIL.test(email)) return;
    const e = emails.get(email) || { email, kind, sources: [], status: 'unverified', reason: 'not checked with the mail server' };
    if (kind === 'person') e.kind = 'person';
    if (!e.sources.includes(source)) e.sources.push(source);
    emails.set(email, e);
  };
  const addPhone = (raw, kind, source, address = person.location) => {
    const n = raw && typeof raw === 'object' ? raw : normalizePhone(String(raw || ''), { address: address || (country ? `x, ${countryName(country)}` : '') });
    if (!n?.phone || n.status === 'invalid') return;
    const key = n.status === 'valid' ? n.phone : `?${String(n.raw || n.phone).replace(/\D/g, '')}`;
    const old = phones.get(key);
    if (old && (old.kind === 'direct' || kind === 'company')) return;
    phones.set(key, { phone: n.phone, raw: n.raw || n.phone, status: n.status, country: n.country || null, kind, source });
  };
  // An address's relation to this person: the person's own (made of their
  // name at their company, or published as theirs), the company's (role
  // addresses at the company domain), or neither (ignored).
  const classify = (email) => {
    const k = emailKind(email, name);
    const atCompany = domain && sameDomain(domainOf(email), domain);
    if (atCompany && (k === 'name' || k === 'first')) return 'person';
    if (atCompany && k === 'role') return 'company';
    return null;
  };

  // 0. Contact details a provider the user uses (the ContactOut extension)
  // displayed for this person: [{ source, emails: [{ email, label }],
  // phones: [{ phone, raw, status, country, label }] }].
  for (const p of person.provided || []) {
    checked.push(p.source);
    for (const e of p.emails || []) addEmail(e.email, 'person', e.label ? `${p.source} (${e.label})` : p.source);
    for (const ph of p.phones || []) addPhone(ph, 'direct', ph.label ? `${p.source} (${ph.label})` : p.source);
  }

  // 1. LinkedIn's Contact info (what the profile shares with this user).
  if (person.profileEmails?.length || person.profilePhones?.length) checked.push('LinkedIn contact info');
  for (const e of person.profileEmails || []) addEmail(e, 'person', 'LinkedIn contact info');
  for (const p of person.profilePhones || []) addPhone(p, 'direct', 'LinkedIn contact info');

  // 2. Local datasets and saved leads.
  if (store?.findContactRecords) {
    const recs = store.findContactRecords({ name: person.name, first: name?.first, last: name?.last, domain, company: person.company, profileUrl: person.profileUrl });
    checked.push(`local datasets (${recs.length} match${recs.length === 1 ? '' : 'es'})`);
    for (const r of recs) {
      const label = r.dataset ? `dataset "${r.dataset}"` : 'saved leads';
      if (r.match === 'person') {
        if (r.email) addEmail(r.email, 'person', label);
        if (r.phone) addPhone(r.phone, 'direct', label, r.address || person.location);
      } else {
        if (r.email) {
          evidence.add(r.email.toLowerCase());
          const k = classify(r.email);
          if (k) addEmail(r.email, k, label);
        }
        if (r.phone && r.match === 'company') addPhone(r.phone, 'company', label, r.address || person.location);
      }
    }
  }

  // 3. The company website.
  if (website) {
    progress(`${hostOf(website)}: team, about and contact pages`);
    if (!siteCache.has(website)) siteCache.set(website, await readSite(website, { fetchImpl, signal, allow, contacts }));
    const site = siteCache.get(website);
    if (site.error) failed.push(`${hostOf(website)} (${site.error})`);
    else {
      checked.push(`${hostOf(website)} (${site.pages.length} page${site.pages.length === 1 ? '' : 's'})`);
      const found = personOnSite(site, name, { country });
      for (const [email] of found.near.emails) addEmail(email, 'person', 'company website (next to the name)');
      for (const ph of found.near.phones) addPhone(ph, 'direct', 'company website (next to the name)');
      for (const e of found.emails) {
        if (sameDomain(domainOf(e), domain)) evidence.add(e);
        const k = classify(e);
        if (k) addEmail(e, k, 'company website');
      }
      // The company's own numbers: its home and contact pages (a team
      // page's numbers are its people's, not the company's).
      for (const p of site.pages.filter((x) => !PEOPLE_PAGE.test(new URL(x.url).pathname)).slice(0, 3)) {
        for (const ph of findPhones(p.text, { country, max: 3 }).phones) addPhone(ph, 'company', 'company website');
      }
    }
  }
  if (person.companyPhone?.phone) addPhone(person.companyPhone, 'company', person.companyPhone.from || 'company page');

  // 4. Verification with the mail servers, then the company's format.
  const personal = [...emails.values()].filter((e) => e.kind === 'person');
  let tried = 0;
  let rejected = 0;
  let formatNote = '';
  if (verifier) {
    const byDomain = new Map();
    for (const e of personal) byDomain.set(domainOf(e.email), [...(byDomain.get(domainOf(e.email)) || []), e.email]);
    for (const [d, list] of byDomain) {
      progress(`checking ${list.length === 1 ? list[0] : `${list.length} addresses`} with the mail server`);
      const res = await verifier.checkDomain(d, list);
      for (const em of list) applyCheck(emails.get(em), res.get(em));
    }
    if (personal.length || (name?.latin && domain && maxCandidates > 0)) checked.push('mail server');
    const confirmed = personal.some((e) => e.status === 'verified');
    const free = FREE_MAIL.test(domain);
    if (!confirmed && domain && !free && name?.latin && maxCandidates > 0) {
      const cands = candidates(name, domain, [...evidence], maxCandidates).filter((c) => !emails.has(c.email));
      for (let i = 0; i < cands.length; i += 4) {
        const batch = cands.slice(i, i + 4);
        progress(`trying ${domain}'s email formats with its mail server`);
        const res = await verifier.checkDomain(domain, batch.map((c) => c.email));
        tried += batch.length;
        const statuses = batch.map((c) => res.get(c.email)?.status);
        if (statuses.every((s) => s === 'catch_all')) {
          formatNote = `${domain} accepts every address, so its email format could not be confirmed`;
          break;
        }
        if (statuses.every((s) => s === 'unknown')) {
          formatNote = `${domain}'s mail server gave no clear answer (${res.get(batch[0].email)?.reason || 'unknown'})`;
          break;
        }
        rejected += statuses.filter((s) => s === 'invalid').length;
        const hit = batch.find((c) => res.get(c.email)?.status === 'verified');
        if (hit) {
          addEmail(hit.email, 'person', `email format "${hit.pattern}" at ${domain}`);
          applyCheck(emails.get(hit.email), res.get(hit.email));
          break;
        }
      }
      if (!formatNote && tried && ![...emails.values()].some((e) => e.kind === 'person' && e.status === 'verified')) formatNote = `${tried} likely address${tried === 1 ? '' : 'es'} at ${domain} rejected by its mail server`;
    } else if (free && domain) formatNote = 'the company uses a free mail domain; no address is built from the name';
  }

  // Results, best first.
  const order = { verified: 0, unverified: 1, invalid: 2 };
  const list = [...emails.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'person' ? -1 : 1) || order[a.status] - order[b.status]);
  const best = list.find((e) => e.kind === 'person' && e.status !== 'invalid') || null;
  const phoneList = [...phones.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'direct' ? -1 : 1) || (a.status === 'valid' ? 0 : 1) - (b.status === 'valid' ? 0 : 1));
  const direct = phoneList.find((p) => p.kind === 'direct') || null;
  const emailStatus = best ? best.status : list.some((e) => e.kind === 'person' && e.status === 'invalid') ? 'invalid' : 'none';

  const why = (e) => `${e.email} ${e.status} (${e.sources.join(', ')}${e.status === 'verified' ? '' : `; ${e.reason}`})`;
  const discovery = [
    `email: ${best ? why(best) : list.some((e) => e.kind === 'person') ? `only invalid addresses found (${list.filter((e) => e.kind === 'person').map((e) => e.email).join(', ')})` : 'none found for this person'}${formatNote ? `; ${formatNote}` : ''}`,
    `phone: ${direct ? `${direct.phone} direct (${direct.source})` : phoneList.length ? `company only: ${phoneList[0].phone} (${phoneList[0].source})` : 'none found'}`,
    `checked: ${checked.join(', ') || 'nothing'}`,
    ...(failed.length ? [`could not check: ${failed.join(', ')}`] : []),
  ].join('; ');

  return {
    emails: list.map(({ email, kind, sources, status, reason }) => ({ email, kind, status, source: sources.join(', '), reason })),
    phones: phoneList,
    email: best?.email || '',
    emailStatus,
    phone: direct,
    companyPhone: phoneList.find((p) => p.kind === 'company') || null,
    domain,
    tried,
    rejected,
    checked,
    failed,
    discovery,
  };
}

function applyCheck(entry, result) {
  if (!entry || !result) return;
  entry.status = result.status === 'verified' ? 'verified' : result.status === 'invalid' ? 'invalid' : 'unverified';
  entry.reason = result.reason;
}

function countryName(code) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code);
  } catch {
    return '';
  }
}

module.exports = { discoverContacts, parseName, emailKind, candidates, patternOrder, baseDomain, nameMentions, readSite, personOnSite, FREE_MAIL, ROLE };
