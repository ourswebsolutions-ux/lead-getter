'use strict';

// LinkedIn pages, read in a window of the user's own Chrome with whatever
// LinkedIn login that profile already has (public "guest" pages otherwise).
// Lead Finder only reads what the pages show: it never logs in, answers a
// security check or works around a limit; it reports them and that part of
// the LinkedIn search stops.
//
// LinkedIn changes its markup often, so pages are read by what is stable:
// link shapes (/jobs/view/<id>, /company/<name>, activity URNs), dt/dd
// label pairs and test ids; class names only as hints.

const NAV_TIMEOUT = 45_000;
const LI = 'https://www.linkedin.com';

const jobsSearchUrl = (q, start = 0) => `${LI}/jobs/search/?keywords=${encodeURIComponent(q)}${start ? `&start=${start}` : ''}`;
const postsSearchUrl = (q) => `${LI}/search/results/content/?keywords=${encodeURIComponent(q)}`;
const companiesSearchUrl = (q, n = 1) => `${LI}/search/results/companies/?keywords=${encodeURIComponent(q)}${n > 1 ? `&page=${n}` : ''}`;
const postUrl = (urn) => `${LI}/feed/update/${urn}/`;
// LinkedIn's public job results, page by page (what its public jobs page
// loads as it is scrolled): the same job cards, logged in or not.
const jobsResultsUrl = (q, start = 0) => `${LI}/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(q)}&start=${start}`;

function isLinkedInHost(host) {
  return /(^|\.)linkedin\.com$/i.test(host);
}

// LinkedIn wraps outside links as /redir/redirect?url=<url>.
function unwrap(href) {
  try {
    const u = new URL(href, LI);
    if (isLinkedInHost(u.hostname) && /^\/redir\/redirect/.test(u.pathname) && u.searchParams.get('url')) return u.searchParams.get('url');
    return u.toString();
  } catch {
    return '';
  }
}

// https://www.linkedin.com/company/<name>, or '' when it is not a company page.
function cleanCompanyUrl(href) {
  try {
    const u = new URL(href, LI);
    const m = u.pathname.match(/^\/company\/([^/?#]+)/);
    if (!isLinkedInHost(u.hostname) || !m || /^(setup|unavailable)$/.test(m[1])) return '';
    return `${LI}/company/${decodeURIComponent(m[1]).toLowerCase()}`;
  } catch {
    return '';
  }
}

// A job's id from /jobs/view/<slug-><id>/ or ?currentJobId=<id>.
function jobIdFrom(href) {
  try {
    const u = new URL(href, LI);
    if (!isLinkedInHost(u.hostname)) return '';
    const m = u.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d{6,})/);
    return m ? m[1] : u.searchParams.get('currentJobId') || '';
  } catch {
    return '';
  }
}

const jobUrl = (id) => `${LI}/jobs/view/${id}/`;
const aboutUrl = (companyUrl) => `${companyUrl.replace(/\/$/, '')}/about/`;

// An official website: a real outside address (not LinkedIn or a social
// network, not a job board), or ''.
const NOT_A_SITE = /(^|\.)(linkedin\.com|facebook\.com|fb\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|youtu\.be|tiktok\.com|vimeo\.com|behance\.net|dribbble\.com|pinterest\.com|threads\.net|linktr\.ee|beacons\.ai|wa\.me|whatsapp\.com|t\.me|indeed\.com|glassdoor\.com|rozee\.pk|bayt\.com|upwork\.com|fiverr\.com|google\.com|goo\.gl|bit\.ly|lnkd\.in|medium\.com|github\.com|wixsite\.com)$/i;
function cleanWebsite(href) {
  try {
    const u = new URL(unwrap(String(href || '').trim().replace(/^(?!https?:\/\/)/i, 'https://')));
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.') || NOT_A_SITE.test(u.hostname)) return '';
    return `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname === '/' ? '/' : u.pathname.replace(/\/$/, '')}`;
  } catch {
    return '';
  }
}

// --- session and page state -----------------------------------------------------

// LinkedIn keeps its li_at cookie while an account is logged in; only
// whether it exists is checked (never its value). Unknown counts as yes.
async function loggedIn(page) {
  try {
    return (await page.context().cookies(LI)).some((c) => c.name === 'li_at');
  } catch {
    return true;
  }
}

// 'login' | 'checkpoint' | 'blocked' | null.
async function detectState(page) {
  const url = page.url();
  if (/linkedin\.com\/(login|uas\/login|authwall|signup)\b/i.test(url)) return 'login';
  if (/linkedin\.com\/checkpoint\b/i.test(url)) return 'checkpoint';
  try {
    return await page.evaluate(() => {
      if (document.querySelector('iframe[src*="captcha" i], #captcha-internal, [id*="captcha" i] iframe')) return 'checkpoint';
      const text = (document.body?.innerText || '').slice(0, 6000);
      if (/commercial use limit|you('|’)ve reached the (weekly|monthly)? ?(search )?limit|too many requests|unusual activity|we('|’)ve restricted your account|your account (has been )?restricted/i.test(text)) return 'blocked';
      if (document.querySelector('form.authwall-join-form, form[data-id="sign-in-form"], .authwall-sign-in-form, input#session_key') && !document.querySelector('main a[href*="/jobs/view/"], main dl, [data-urn*="urn:li:activity"]')) return 'login';
      return null;
    });
  } catch {
    return null; // mid-navigation; checked again on the next step
  }
}

// Opens `url` and waits until `ready` (a function run in the page that
// returns truthy when the content has rendered) or a state page.
// Returns { mode: 'ok' | 'empty' | 'login' | 'checkpoint' | 'blocked' | 'failed', detail }.
async function open(page, url, ready, { timeout = 25_000 } = {}) {
  await goto(page, url);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await detectState(page);
    if (state) return { mode: state };
    const found = await page.evaluate(ready).catch(() => null);
    if (found) return { mode: found === 'empty' ? 'empty' : 'ok' };
    await page.waitForTimeout(500);
  }
  return { mode: 'failed', detail: `the page did not load (${page.url().slice(0, 120)})` };
}

// page.goto, once more when an earlier navigation was still finishing.
async function goto(page, url) {
  try {
    return await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  } catch (err) {
    if (!/interrupted by another navigation/i.test(String(err?.message))) throw err;
    await page.waitForTimeout(1000);
    return page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  }
}

// --- in-page readers (self-contained, so they can be serialised) ---------------------

function jobsReadyInPage() {
  if (document.querySelector('a[href*="/jobs/view/"], [data-occludable-job-id], [data-job-id]')) return 'ok';
  return /no matching jobs found|we couldn('|’)t find a match|no results found/i.test(document.body?.innerText || '') ? 'empty' : null;
}

// Job cards on a jobs search page: { jobId, title, company, companyHref, location }.
function collectJobsInPage() {
  const out = new Map();
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const idOf = (href) => {
    const m = String(href || '').match(/\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/) || String(href || '').match(/currentJobId=(\d{6,})/);
    return m ? m[1] : '';
  };
  const cards = new Set([
    ...document.querySelectorAll('[data-occludable-job-id], [data-job-id], li.jobs-search-results__list-item, ul.jobs-search__results-list > li, .job-search-card, .base-search-card'),
  ]);
  for (const a of document.querySelectorAll('a[href*="/jobs/view/"]')) cards.add(a.closest('li, [data-job-id], .base-card, .job-card-container') || a);
  for (const card of cards) {
    const link = card.matches('a') ? card : card.querySelector('a[href*="/jobs/view/"]');
    const urn = (card.getAttribute('data-entity-urn') || card.querySelector('[data-entity-urn]')?.getAttribute('data-entity-urn') || '').match(/jobPosting:(\d+)/);
    const jobId = card.getAttribute('data-occludable-job-id') || card.getAttribute('data-job-id') || (urn && urn[1]) || idOf(link?.getAttribute('href'));
    if (!jobId || out.has(jobId)) continue;
    const pick = (...sels) => {
      for (const s of sels) {
        const e = card.querySelector(s);
        if (e && clean(e.textContent)) return e;
      }
      return null;
    };
    const titleEl = pick('.base-search-card__title', '.job-card-list__title', '.job-card-container__link strong', '.artdeco-entity-lockup__title', 'h3', 'strong');
    const companyEl = pick('.base-search-card__subtitle', '.job-card-container__primary-description', '.artdeco-entity-lockup__subtitle', 'h4', '.job-card-container__company-name');
    const locationEl = pick('.job-search-card__location', '.job-card-container__metadata-item', '.artdeco-entity-lockup__caption li', '.artdeco-entity-lockup__caption');
    const companyLink = card.querySelector('a[href*="/company/"]');
    out.set(jobId, {
      jobId,
      title: clean(titleEl?.textContent || link?.getAttribute('aria-label') || link?.textContent).slice(0, 200),
      company: clean(companyEl?.textContent || companyLink?.textContent).slice(0, 200),
      companyHref: companyLink ? companyLink.href : '',
      location: clean(locationEl?.textContent).slice(0, 200),
    });
  }
  return [...out.values()];
}

function jobReadyInPage() {
  return document.querySelector('#job-details, .jobs-description, .show-more-less-html__markup, .description__text, .jobs-unified-top-card, .top-card-layout, a[href*="/company/"]') ? 'ok' : null;
}

// An open job: { title, company, companyHref, location, description, website }.
function readJobInPage() {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const first = (...sels) => {
    for (const s of sels) {
      const e = document.querySelector(s);
      if (e && clean(e.textContent)) return e;
    }
    return null;
  };
  const top = first('.job-details-jobs-unified-top-card__container--two-pane', '.jobs-unified-top-card', '.top-card-layout', 'main') || document.body;
  const companyLink =
    top.querySelector('.job-details-jobs-unified-top-card__company-name a, a.topcard__org-name-link, .jobs-unified-top-card__company-name a') ||
    [...top.querySelectorAll('a[href*="/company/"]')].find((a) => clean(a.textContent)) ||
    top.querySelector('a[href*="/company/"]');
  const desc = first('#job-details', '.jobs-description__content', '.jobs-description-content__text', '.show-more-less-html__markup', '.description__text');
  const loc = first('.job-details-jobs-unified-top-card__tertiary-description-container span', '.job-details-jobs-unified-top-card__primary-description-container span', '.topcard__flavor--bullet', '.jobs-unified-top-card__bullet');
  const title = first('.job-details-jobs-unified-top-card__job-title', '.top-card-layout__title', '.jobs-unified-top-card__job-title', 'h1');
  const site = [...(desc || document.createElement('div')).querySelectorAll('a[href]')].map((a) => a.href);
  return {
    title: clean(title?.textContent).slice(0, 200),
    company: clean(companyLink?.textContent || first('.job-details-jobs-unified-top-card__company-name', '.topcard__org-name-link')?.textContent).slice(0, 200),
    companyHref: companyLink ? companyLink.href : '',
    location: clean(loc?.textContent).slice(0, 200),
    description: (desc?.innerText || '').slice(0, 6000),
    links: site.slice(0, 50),
  };
}

function companyReadyInPage() {
  if (document.querySelector('main dl dt, section dl dt, [data-test-id^="about-us__"], .org-page-details__definition-term')) return 'ok';
  const text = document.body?.innerText || '';
  if (/\n\s*(Website|Industry|Company size|Headquarters)\s*\n/i.test(text)) return 'ok';
  return document.querySelector('h1') && /overview|about/i.test(text) ? 'ok' : null;
}

// A company's About page: { name, website, phone, headquarters, industry,
// size, overview, links }. Labels are read in English (LinkedIn is opened
// with the user's language; other languages fall back to link shapes).
function readCompanyInPage() {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const fields = {};
  const set = (label, dd) => {
    const k = clean(label).toLowerCase();
    if (!k || fields[k]) return;
    const a = dd.querySelector('a[href]');
    fields[k] = { text: clean(dd.textContent), href: a ? a.href : '' };
  };
  for (const dt of document.querySelectorAll('dl dt')) {
    let dd = dt.nextElementSibling;
    while (dd && dd.tagName !== 'DD' && dd.tagName !== 'DT') dd = dd.nextElementSibling;
    if (dd && dd.tagName === 'DD') set(dt.textContent, dd);
  }
  for (const box of document.querySelectorAll('[data-test-id^="about-us__"]')) {
    const id = box.getAttribute('data-test-id').replace('about-us__', '');
    const dd = box.querySelector('dd') || box;
    set({ website: 'website', phone: 'phone', headquarters: 'headquarters', industry: 'industry', size: 'company size' }[id] || id, dd);
  }
  // Layouts without dt/dd: the label on one line, its value on the next.
  if (!Object.keys(fields).length) {
    const lines = (document.querySelector('main') || document.body).innerText.split('\n').map(clean).filter(Boolean);
    const links = [...document.querySelectorAll('a[href]')];
    for (const label of ['Website', 'Phone', 'Headquarters', 'Industry', 'Company size', 'Location']) {
      const i = lines.findIndex((l) => l.toLowerCase() === label.toLowerCase());
      if (i < 0 || !lines[i + 1]) continue;
      const value = lines[i + 1];
      const a = links.find((x) => clean(x.textContent) === value);
      fields[label.toLowerCase()] = { text: value, href: a ? a.href : '' };
    }
  }
  const get = (...keys) => keys.map((k) => fields[k]).find(Boolean);
  const website = get('website');
  const phone = get('phone');
  const tel = [...document.querySelectorAll('a[href^="tel:"]')].map((a) => a.getAttribute('href'));
  const overview = document.querySelector('section p, [data-test-id="about-us__description"]');
  // Outside links written as web addresses: the website when none is
  // labelled (the caller skips social pages and job boards).
  const main = document.querySelector('main') || document.body;
  const looksLikeSite = /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i;
  const siteLinks = [...main.querySelectorAll('a[href]')]
    .filter((a) => {
      let host = '';
      try {
        host = new URL(a.href).hostname;
      } catch {}
      return (/\/redir\/redirect/.test(a.href) || !/(^|\.)linkedin\.com$/.test(host)) && looksLikeSite.test(clean(a.textContent));
    })
    .map((a) => a.href)
    .slice(0, 10);
  return {
    name: clean(document.querySelector('h1')?.textContent).slice(0, 200),
    website: website ? website.href || website.text : '',
    siteLinks,
    phone: phone ? phone.text.replace(/phone number is a link/i, '').trim() : '',
    tels: tel.slice(0, 5),
    headquarters: clean(get('headquarters', 'location')?.text).slice(0, 200),
    industry: clean(get('industry')?.text).slice(0, 120),
    size: clean(get('company size')?.text).slice(0, 120),
    overview: (overview?.innerText || '').slice(0, 2000),
  };
}

function postsReadyInPage() {
  if (document.querySelector('[data-urn*="urn:li:activity:"], [data-id*="urn:li:activity:"], [data-chameleon-result-urn*="urn:li:activity:"], [aria-label^="Open control menu for post by"]')) return 'ok';
  return /no results found|try removing filters/i.test(document.body?.innerText || '') ? 'empty' : null;
}

// Posts on a content search page: { urn, key, text, author, authorHref,
// companyHrefs, links }. Two layouts: posts with activity URNs, and the
// newer one where a post is the block around its "Open control menu for
// post by <author>" button (no URN; key is a hash of author and text).
function collectPostsInPage() {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const sel = '[data-urn*="urn:li:activity:"], [data-id*="urn:li:activity:"], [data-chameleon-result-urn*="urn:li:activity:"]';
  const posts = [...document.querySelectorAll(sel)].filter((el) => !el.parentElement?.closest(sel));
  if (!posts.length) {
    const MENU = '[aria-label^="Open control menu for post by"]';
    const out = [];
    for (const m of document.querySelectorAll(MENU)) {
      // The post: the largest ancestor that still holds only this menu.
      let box = m;
      while (box.parentElement && box.parentElement !== document.body && box.parentElement.querySelectorAll(MENU).length === 1) box = box.parentElement;
      const author = m.getAttribute('aria-label').replace(/^Open control menu for post by\s*/, '').trim();
      const actor = [...box.querySelectorAll('a[href*="/company/"], a[href*="/in/"]')][0];
      const links = [...box.querySelectorAll('a[href]')].map((a) => a.href);
      const postLink = links.find((h) => /\/feed\/update\/urn:li:activity:\d+|\/posts\/[^/?#]+-activity-\d+/.test(h)) || '';
      const text = (box.innerText || '').replace(/^Feed post\s*/i, '').slice(0, 4000);
      let h = 0;
      for (const ch of `${author}\n${text.slice(0, 400)}`) h = (Math.imul(31, h) + ch.charCodeAt(0)) | 0;
      out.push({
        urn: ((id) => (id ? `urn:li:activity:${id}` : ''))((postLink.match(/urn:li:activity:(\d+)/) || postLink.match(/activity-(\d+)/) || [])[1]),
        key: `post:${(h >>> 0).toString(36)}`,
        text,
        author: clean(author).slice(0, 200),
        authorHref: actor ? actor.href : '',
        companyHrefs: links.filter((x) => /\/company\//.test(x)).slice(0, 10),
        links: links.filter((x) => /^(mailto:|tel:)|wa\.me\//i.test(x) || !/linkedin\.com/i.test(x)).slice(0, 20),
      });
    }
    return out;
  }
  return posts.map((el) => {
    const attr = el.getAttribute('data-urn') || el.getAttribute('data-id') || el.getAttribute('data-chameleon-result-urn') || '';
    const urn = (attr.match(/urn:li:activity:\d+/) || [''])[0];
    const textEl = el.querySelector('.update-components-text, .feed-shared-inline-show-more-text, .feed-shared-update-v2__description, [data-test-id="main-feed-activity-card__commentary"]');
    const actor = el.querySelector('.update-components-actor__meta-link, .update-components-actor__container a[href], a[data-control-name="actor"]') || el.querySelector('a[href*="/company/"], a[href*="/in/"]');
    const name = el.querySelector('.update-components-actor__title span[aria-hidden="true"], .update-components-actor__name, .update-components-actor__title');
    const links = [...el.querySelectorAll('a[href]')].map((a) => a.href);
    return {
      urn,
      key: urn,
      text: (textEl || el).innerText.slice(0, 4000),
      author: clean(name?.textContent || actor?.textContent).slice(0, 200),
      authorHref: actor ? actor.href : '',
      companyHrefs: links.filter((h) => /\/company\//.test(h)).slice(0, 10),
      links: links.filter((h) => /^(mailto:|tel:)|wa\.me\//i.test(h) || !/linkedin\.com/i.test(h)).slice(0, 20),
    };
  });
}

function companiesReadyInPage() {
  if (document.querySelector('main a[href*="/company/"]')) return 'ok';
  return /no results found/i.test(document.body?.innerText || '') ? 'empty' : null;
}

// Companies on a company search page: { name, href, subtitle }.
function collectCompaniesInPage() {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const out = new Map();
  for (const a of document.querySelectorAll('main a[href*="/company/"]')) {
    const name = clean(a.textContent);
    if (!name) continue;
    const m = a.href.match(/\/company\/([^/?#]+)/);
    if (!m || out.has(m[1])) continue;
    const card = a.closest('li') || a.parentElement;
    const lines = clean(card?.innerText || '').replace(name, '').trim();
    out.set(m[1], { name: name.slice(0, 200), href: a.href, subtitle: lines.slice(0, 200) });
  }
  return [...out.values()];
}

// --- people -------------------------------------------------------------------

// LinkedIn's location ids (geoUrn) for countries, by the names people type.
// Other places are added to the search words instead, and each profile's
// location is checked.
const GEO = [
  [/^(usa|us|u\.s\.a?\.?|united states( of america)?|america)$/i, '103644278', 'United States'],
  [/^(uk|u\.k\.|united kingdom|great britain|britain|england)$/i, '101165590', 'United Kingdom'],
  [/^canada$/i, '101174742', 'Canada'],
  [/^australia$/i, '101452733', 'Australia'],
  [/^india$/i, '102713980', 'India'],
  [/^pakistan$/i, '101022442', 'Pakistan'],
  [/^(germany|deutschland)$/i, '101282230', 'Germany'],
  [/^france$/i, '105015875', 'France'],
  [/^(uae|u\.a\.e\.|united arab emirates|emirates)$/i, '104305776', 'United Arab Emirates'],
  [/^(ksa|saudi arabia|saudi)$/i, '100459316', 'Saudi Arabia'],
  [/^(netherlands|holland)$/i, '102890719', 'Netherlands'],
  [/^singapore$/i, '102454443', 'Singapore'],
  [/^ireland$/i, '104738515', 'Ireland'],
  [/^spain$/i, '105646813', 'Spain'],
  [/^italy$/i, '103350119', 'Italy'],
  [/^brazil$/i, '106057199', 'Brazil'],
];

// { geoUrn, name } for a typed location, or { geoUrn: null, name: typed }.
function geoFor(location) {
  const t = String(location || '').trim();
  if (!t) return null;
  const hit = GEO.find(([re]) => re.test(t));
  return hit ? { geoUrn: hit[1], name: hit[2] } : { geoUrn: null, name: t };
}

const peopleSearchUrl = (q, { geoUrn = null, page = 1 } = {}) =>
  `${LI}/search/results/people/?keywords=${encodeURIComponent(q)}${geoUrn ? `&geoUrn=${encodeURIComponent(JSON.stringify([geoUrn]))}` : ''}&origin=${geoUrn ? 'FACETED_SEARCH' : 'GLOBAL_SEARCH_HEADER'}${page > 1 ? `&page=${page}` : ''}`;

// https://www.linkedin.com/in/<id>, or '' when it is not a profile.
function cleanProfileUrl(href) {
  try {
    const u = new URL(href, LI);
    const m = u.pathname.match(/^\/in\/([^/?#]+)/);
    if (!isLinkedInHost(u.hostname) || !m) return '';
    return `${LI}/in/${decodeURIComponent(m[1])}`;
  } catch {
    return '';
  }
}

function peopleReadyInPage() {
  const main = document.querySelector('main') || document.body;
  if (main.querySelector('a[href*="/in/"]')) return 'ok';
  return /no results found|try removing filters|we couldn('|’)t find/i.test(main.innerText || '') ? 'empty' : null;
}

// People on a people search page: { profileUrl, name, headline, location }.
// Cards are found by their profile links; the text inside a card is read
// line by line (name, connection degree, headline, location), with
// LinkedIn's class names as hints.
function collectPeopleInPage() {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const out = new Map();
  const main = document.querySelector('main') || document.body;
  for (const a of main.querySelectorAll('a[href*="/in/"]')) {
    const m = a.href.match(/\/in\/([^/?#]+)/);
    if (!m) continue;
    const id = decodeURIComponent(m[1]);
    // The card: the largest ancestor with links to this profile only.
    let card = a;
    while (card.parentElement && card.parentElement !== main && [...card.parentElement.querySelectorAll('a[href*="/in/"]')].every((x) => x.href.includes(`/in/${m[1]}`))) card = card.parentElement;
    const existing = out.get(id);
    const nameEl = card.querySelector('.entity-result__title-text a span[aria-hidden="true"], span[dir="ltr"] > span[aria-hidden="true"], a[href*="/in/"] span[aria-hidden="true"]');
    let name = clean(nameEl?.textContent) || clean(a.textContent).replace(/^View\s+|’s profile$|'s profile$/gi, '');
    name = name.replace(/\s*•.*$/, '').replace(/View .*profile/i, '').replace(/\s+is open to work.*$/i, '').trim();
    // Some layouts write the name twice (visible text and its screen-reader copy).
    const half = name.split(' ');
    if (half.length % 2 === 0 && half.slice(0, half.length / 2).join(' ') === half.slice(half.length / 2).join(' ')) name = half.slice(0, half.length / 2).join(' ');
    const firstHalf = name.match(/^(.+?)\1$/);
    if (firstHalf && firstHalf[1].length > 3) name = firstHalf[1].trim();
    if (!name || /^linkedin member$/i.test(name)) continue;
    const lines = (card.innerText || '').split('\n').map(clean).filter(Boolean);
    const rest = lines.filter(
      (l) =>
        l !== name &&
        !l.startsWith(`${name} `) &&
        !/^(•\s*)?(1st|2nd|3rd\+?|3rd)( degree connection)?$/i.test(l) &&
        !/^(view .*profile|connect|follow|following|message|pending|current:|past:|summary:|skills:)/i.test(l) &&
        !/mutual connections?|is a mutual connection|followers$|^·/i.test(l) &&
        !/^•/.test(l),
    );
    const headline = clean(card.querySelector('.entity-result__primary-subtitle')?.textContent) || rest.find((l) => l.length > 2 && l !== name) || '';
    const location = clean(card.querySelector('.entity-result__secondary-subtitle')?.textContent) || rest.slice(rest.indexOf(headline) + 1).find((l) => /,|area|region|united|kingdom|states/i.test(l) && l.length < 80) || '';
    if (!existing || (!existing.headline && headline)) out.set(id, { profileUrl: `https://www.linkedin.com/in/${id}`, name: name.slice(0, 120), headline: headline.slice(0, 300), location: location.slice(0, 120) });
  }
  return [...out.values()];
}

// Ready once the top card is there: an h1 (earlier layout), or (current
// layout, no h1) the page title's name shown as a heading in the page.
function profileReadyInPage() {
  if (document.querySelector('main h1, h1.text-heading-xlarge, .top-card-layout__title')) return 'ok';
  const name = (document.title || '').replace(/^\(\d+\+?\)\s*/, '').split(' | ')[0].trim();
  if (!name || /^linkedin$/i.test(name)) return null;
  return [...document.querySelectorAll('main h2, main [role="heading"], main p, main strong')].some((e) => e.textContent.replace(/\s+/g, ' ').trim() === name) ? 'ok' : null;
}

// An open profile: { name, headline, location, title, company, companyHref,
// about, links }. The top card is read by its structure (the name, then the
// headline, then the location before "Contact info"); the current job from
// the Experience section, else from the headline ("SEO Lead at Acme").
function readProfileInPage() {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  // The name: the page title ("Jane Doe | LinkedIn"), else the h1.
  const titleName = clean((document.title || '').replace(/^\(\d+\+?\)\s*/, '').split(' | ')[0]);
  const h1 = document.querySelector('main h1') || document.querySelector('h1');
  const name = clean(h1?.textContent) || (/^linkedin$/i.test(titleName) ? '' : titleName);
  // The top card: the section around the name's heading (h1, or the current layout's h2).
  const heading = h1 || [...document.querySelectorAll('main h2, main [role="heading"]')].find((e) => clean(e.textContent) === name) || null;
  let top = heading;
  while (top && top.parentElement && !(top.tagName === 'SECTION' || /top-card|pv-top-card/.test(top.className || ''))) top = top.parentElement;
  if (!top || top === document.documentElement) top = [...document.querySelectorAll('main section')].find((sec) => clean(sec.innerText).startsWith(name)) || document.querySelector('main') || document.body;
  const lines = (top.innerText || '').split('\n').map(clean).filter(Boolean);
  const NOISE = /^(\(?(he|she|they)\/\w+\)?|·?\s*(1st|2nd|3rd\+?)|·|verified|premium|open to work|hiring|message|connect|follow|following|more|pending|\d[\d,+]* (followers|connections)|.* (is|are) (a )?mutual connections?|.*mutual connections?)$/i;
  const after = lines.slice(Math.max(0, lines.indexOf(name)) + 1).filter((l) => l !== name && !NOISE.test(l));
  const headline = clean(document.querySelector('.text-body-medium.break-words, .top-card-layout__headline')?.textContent) || after[0] || '';
  // "United States · Contact info" (one line), or the location on the line before "Contact info".
  const contactIdx = after.findIndex((l) => /(^|·\s*)contact info$/i.test(l));
  const contactLine = contactIdx >= 0 ? after[contactIdx] : '';
  const location =
    clean(document.querySelector('.pv-text-details__left-panel .text-body-small.inline, span.text-body-small.inline.t-black--light.break-words, .top-card__subline-item, .top-card-layout__first-subline .not-first-middot')?.textContent) ||
    clean(contactLine.replace(/\s*·?\s*contact info$/i, '')) ||
    (contactIdx > 0 ? after[contactIdx - 1].replace(/\s*·\s*$/, '') : '') ||
    '';
  // Experience: the first position (when the section is on the page).
  const expAnchor = document.querySelector('#experience');
  const expSection = expAnchor ? expAnchor.closest('section') : [...document.querySelectorAll('main section')].find((sec) => /^\s*experience\b/i.test(sec.innerText || ''));
  let title = '';
  let company = '';
  let companyHref = '';
  if (expSection) {
    const item = expSection.querySelector('li');
    if (item) {
      // Its lines, without the company logo link.
      const spans = [...item.querySelectorAll('span[aria-hidden="true"]')].filter((sp) => !sp.closest('a[data-field*="logo"], a:has(img)')).map((sp) => clean(sp.textContent)).filter(Boolean);
      const itemLines = spans.length ? spans : (item.innerText || '').split('\n').map(clean).filter(Boolean);
      title = clean(item.querySelector('.t-bold span[aria-hidden="true"]')?.textContent) || itemLines[0] || '';
      company = (clean(item.querySelector('.t-14.t-normal span[aria-hidden="true"]')?.textContent) || itemLines[1] || '').split(' · ')[0];
      const link = item.querySelector('a[href*="/company/"]');
      companyHref = link ? link.href : '';
    }
  }
  const currentBtn = document.querySelector('button[aria-label^="Current company:"]');
  if (currentBtn) company = clean(currentBtn.getAttribute('aria-label').replace(/^Current company:\s*/i, '').replace(/\.\s*Click.*$/i, '')) || company;
  // The current layout's top card lists the current company (then the school) after the location.
  if (!company && contactIdx >= 0) company = after.slice(contactIdx + 1).find((l) => l.length < 80 && !NOISE.test(l) && !/connections?|followers/i.test(l)) || '';
  if (!companyHref && top !== document.body) companyHref = [...top.querySelectorAll('a[href*="/company/"]')].map((a) => a.href)[0] || '';
  const at = headline.match(/^(.*?)\s+(?:at|@)\s+([^|·,]+)/i);
  if (!title && at) title = clean(at[1]);
  if (!company && at) company = clean(at[2]);
  if (!title) title = clean(headline.split(/[|·]/)[0]);
  const aboutSec = document.querySelector('#about')?.closest('section') || [...document.querySelectorAll('main section')].find((sec) => /^\s*about\b/i.test(sec.innerText || ''));
  return {
    name: name.slice(0, 120),
    headline: headline.slice(0, 300),
    location: location.slice(0, 120),
    title: title.slice(0, 200),
    company: company.slice(0, 200),
    companyHref,
    about: (aboutSec?.innerText || '').slice(0, 2000),
    contactHref: (document.querySelector('a[href*="/overlay/contact-info"]') || {}).href || '',
  };
}

function contactInfoReadyInPage() {
  const box = document.querySelector('[role="dialog"], .pv-contact-info, section.pv-contact-info__contact-type');
  return box && /contact info/i.test(box.innerText || '') ? 'ok' : null;
}

// The profile's Contact info: { emails, phones, websites }. Only what
// LinkedIn shows this user (the member's own sharing settings decide).
function readContactInfoInPage() {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const box = document.querySelector('[role="dialog"]') || document.querySelector('.pv-contact-info') || document.body;
  const emails = [...box.querySelectorAll('a[href^="mailto:"]')].map((a) => a.getAttribute('href').replace(/^mailto:/i, '').split('?')[0].trim());
  const phones = [];
  const websites = [];
  for (const sec of box.querySelectorAll('section, .pv-contact-info__contact-type')) {
    const head = clean(sec.querySelector('h3, header')?.textContent);
    if (/^phone/i.test(head)) for (const li of sec.querySelectorAll('li, span.t-14')) phones.push(clean(li.textContent).replace(/\((mobile|work|home)\)/i, '').trim());
    if (/^website/i.test(head)) for (const a of sec.querySelectorAll('a[href]')) websites.push(a.href);
  }
  for (const a of box.querySelectorAll('a[href^="tel:"]')) phones.push(a.getAttribute('href').replace(/^tel:/i, ''));
  return { emails: [...new Set(emails)].slice(0, 5), phones: [...new Set(phones.filter((p) => /\d{5,}/.test(p.replace(/\D/g, ''))))].slice(0, 5), websites: [...new Set(websites)].slice(0, 5) };
}

async function searchPeople(page, q, { geoUrn = null, n = 1 } = {}) {
  const r = await open(page, peopleSearchUrl(q, { geoUrn, page: n }), peopleReadyInPage);
  if (r.mode !== 'ok') return { ...r, people: [] };
  // Results render as they scroll into view.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)).catch(() => {});
  await page.waitForTimeout(1200);
  return { mode: 'ok', people: await page.evaluate(collectPeopleInPage) };
}

async function readProfile(page, profileUrl) {
  const r = await open(page, profileUrl, profileReadyInPage);
  if (r.mode !== 'ok') return r;
  // The Experience section loads lazily.
  await page.evaluate(() => window.scrollTo(0, 1600)).catch(() => {});
  await page.waitForTimeout(1000);
  return { mode: 'ok', profile: await page.evaluate(readProfileInPage) };
}

async function readContactInfo(page, profileUrl) {
  const r = await open(page, `${profileUrl.replace(/\/$/, '')}/overlay/contact-info/`, contactInfoReadyInPage, { timeout: 15_000 });
  if (r.mode !== 'ok') return r;
  return { mode: 'ok', info: await page.evaluate(readContactInfoInPage) };
}

// Scrolls a results list (the box it scrolls in, or the page) for more.
// Returns how many result links there are afterwards.
async function scrollMore(page, linkSelector) {
  return page
    .evaluate(async (sel) => {
      const links = document.querySelectorAll(sel);
      const last = links[links.length - 1];
      last?.scrollIntoView({ block: 'end' });
      let box = last?.parentElement;
      while (box && box !== document.body) {
        if (box.scrollHeight > box.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(box).overflowY)) {
          box.scrollTop = box.scrollHeight;
          break;
        }
        box = box.parentElement;
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
      // "See more jobs" / "Show more results" on guest pages.
      const more = [...document.querySelectorAll('button')].find((b) => /^(see more jobs|show more results|load more)$/i.test(b.textContent.trim()) && b.offsetParent !== null);
      more?.click();
      await new Promise((r) => setTimeout(r, 1500));
      return document.querySelectorAll(sel).length;
    }, linkSelector)
    .catch(() => 0);
}

// --- page operations ------------------------------------------------------------

async function searchJobs(page, q) {
  const r = await open(page, jobsSearchUrl(q), jobsReadyInPage);
  if (r.mode !== 'ok') return { ...r, jobs: [] };
  return { mode: 'ok', jobs: await page.evaluate(collectJobsInPage) };
}

async function moreJobs(page) {
  await scrollMore(page, 'a[href*="/jobs/view/"], [data-occludable-job-id]');
  return page.evaluate(collectJobsInPage);
}

async function readJob(page, id) {
  const r = await open(page, jobUrl(id), jobReadyInPage);
  if (r.mode !== 'ok') return r;
  // "See more" on the description, when shown.
  await page.evaluate(() => document.querySelector('button.jobs-description__footer-button, button.show-more-less-html__button--more')?.click()).catch(() => {});
  return { mode: 'ok', job: await page.evaluate(readJobInPage) };
}

async function readCompany(page, companyUrl) {
  const r = await open(page, aboutUrl(companyUrl), companyReadyInPage);
  if (r.mode !== 'ok') return r;
  const company = await page.evaluate(readCompanyInPage);
  if (!cleanWebsite(company.website)) company.website = (company.siteLinks || []).find((h) => cleanWebsite(h)) || company.website;
  return { mode: 'ok', company };
}

async function expandPosts(page) {
  await page
    .evaluate(() => {
      for (const b of document.querySelectorAll('button.feed-shared-inline-show-more-text__see-more-less-toggle, button[aria-label*="see more" i]')) b.click();
      // Newer layout: "… more" is a button inside the post text.
      for (const b of document.querySelectorAll('button, [role="button"]')) if (/^…?\s*more$/i.test((b.textContent || '').trim()) && b.offsetParent !== null) b.click();
    })
    .catch(() => {});
}

async function searchPosts(page, q) {
  const r = await open(page, postsSearchUrl(q), postsReadyInPage);
  if (r.mode !== 'ok') return { ...r, posts: [] };
  await expandPosts(page);
  return { mode: 'ok', posts: await page.evaluate(collectPostsInPage) };
}

// More posts: scroll to the end of the results, wait, expand, read again.
async function morePosts(page) {
  await scrollMore(page, '[aria-label^="Open control menu for post by"], [data-urn*="urn:li:activity:"]');
  await page.waitForTimeout(1500);
  await expandPosts(page);
  return page.evaluate(collectPostsInPage);
}

// One page of LinkedIn's public job results (start = results listed
// before it): { mode: 'ok' | 'empty' | 'blocked' | ..., jobs }. An empty page
// is the end of the results.
async function jobsPage(page, q, start) {
  const res = await goto(page, jobsResultsUrl(q, start));
  const status = res ? res.status() : 200;
  if (status === 429) return { mode: 'blocked', jobs: [] };
  if (status >= 400) return { mode: status === 404 || status === 400 ? 'empty' : 'failed', detail: `HTTP ${status}`, jobs: [] };
  const state = await detectState(page);
  if (state) return { mode: state, jobs: [] };
  await page.waitForTimeout(500);
  const jobs = await page.evaluate(collectJobsInPage);
  return { mode: jobs.length ? 'ok' : 'empty', jobs };
}

async function searchCompanies(page, q, n = 1) {
  const r = await open(page, companiesSearchUrl(q, n), companiesReadyInPage);
  if (r.mode !== 'ok') return { ...r, companies: [] };
  return { mode: 'ok', companies: await page.evaluate(collectCompaniesInPage) };
}

module.exports = {
  LI,
  jobsSearchUrl,
  jobsResultsUrl,
  postsSearchUrl,
  companiesSearchUrl,
  postUrl,
  jobUrl,
  aboutUrl,
  unwrap,
  cleanCompanyUrl,
  cleanWebsite,
  jobIdFrom,
  loggedIn,
  detectState,
  open,
  searchJobs,
  moreJobs,
  readJob,
  readCompany,
  searchPosts,
  morePosts,
  jobsPage,
  searchCompanies,
  geoFor,
  peopleSearchUrl,
  cleanProfileUrl,
  searchPeople,
  readProfile,
  readContactInfo,
  collectPeopleInPage,
  readProfileInPage,
  readContactInfoInPage,
  collectJobsInPage,
  readJobInPage,
  readCompanyInPage,
  collectPostsInPage,
  collectCompaniesInPage,
};
