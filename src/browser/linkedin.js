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
  collectJobsInPage,
  readJobInPage,
  readCompanyInPage,
  collectPostsInPage,
  collectCompaniesInPage,
};
