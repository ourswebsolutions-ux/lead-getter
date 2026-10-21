'use strict';

// Google Maps page operations, performed in a visible tab of the user's
// Chrome. Every lookup uses several selectors because Maps markup changes
// often: stable attributes (role, aria-label, data-item-id) come first,
// Maps' generated class names only as a fallback.

const MAPS_HOME = 'https://www.google.com/maps?hl=en';
const NAV_TIMEOUT = 45_000;

const SEARCH_INPUTS = [
  'input#searchboxinput',
  'input[name="q"]',
  'input[role="combobox"]',
  'input[aria-label*="Search" i]',
];

// --- placeKey ---------------------------------------------------------------

// Stable identifier for a listing, taken from its Maps URL: the feature id
// (!1s0x...:0x...) when present, otherwise the path without query/data.
function placeKey(url) {
  const s = String(url || '');
  const fid = s.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
  if (fid) return fid[1].toLowerCase();
  const cid = s.match(/[?&]cid=(\d+)/);
  if (cid) return `cid:${cid[1]}`;
  try {
    const u = new URL(s);
    return `${u.hostname}${decodeURIComponent(u.pathname).replace(/\/data=.*$/, '').replace(/\/$/, '')}`;
  } catch {
    return s;
  }
}

// Listing URL without tracking/session query parameters.
function cleanMapsUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

// --- block detection --------------------------------------------------------

// Returns 'captcha' | 'rate_limit' | 'consent' | null. Lead Finder never
// interacts with these pages; it pauses until the user deals with them.
async function detectBlock(page) {
  const url = page.url();
  if (/\/sorry\//.test(url)) return 'captcha';
  if (/^https:\/\/consent\.google\./.test(url)) return 'consent';
  try {
    return await page.evaluate(() => {
      if (document.querySelector('iframe[src*="recaptcha"], #captcha-form, form[action*="/sorry/"]')) return 'captcha';
      const text = (document.body?.innerText || '').slice(0, 5000);
      if (/unusual traffic from your computer/i.test(text)) return 'rate_limit';
      if (/too many requests|rate limit exceeded/i.test(text)) return 'rate_limit';
      return null;
    });
  } catch {
    return null; // page mid-navigation; checked again on the next step
  }
}

// --- search -----------------------------------------------------------------

async function firstVisible(page, selectors, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) return loc;
    }
    await page.waitForTimeout(300);
  }
  return null;
}

const SEARCH_BUTTONS = [
  'button#searchbox-searchbutton',
  'button[aria-label="Search"]:visible',
  'button[jsaction*="omnibox.search"]:visible',
];

// True once Maps has navigated to a search or place page.
async function searchSubmitted(page, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (/\/maps\/(search|place)\//.test(page.url())) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

function sameQuery(a, b) {
  const n = (x) => String(x || '').normalize('NFKC').replace(/\+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return n(a) === n(b);
}

function searchUrl(keyword) {
  return `https://www.google.com/maps/search/${encodeURIComponent(keyword)}?hl=en`;
}

// Runs the search in the visible tab: types the keyword exactly as given
// into Maps' search box and submits it, then confirms that Maps accepted
// that query and showed results. If typing/submitting does not take effect,
// it retries once through the equivalent search URL.
// Returns { mode: 'list' | 'single' | 'empty' | 'blocked' | 'failed', attempts, detail }.
async function search(page, keyword, { onStep = () => {} } = {}) {
  let detail = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt === 1) {
      onStep('Opening Google Maps');
      await page.goto(MAPS_HOME, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      if (await detectBlock(page)) return { mode: 'blocked', attempts: attempt };
      const input = await firstVisible(page, SEARCH_INPUTS, 20_000);
      if (!input) {
        detail = 'the Google Maps search box did not appear';
        continue;
      }
      onStep(`Entering keyword "${keyword}"`);
      await input.click();
      await input.fill('');
      await input.pressSequentially(keyword, { delay: 70 });
      if (!sameQuery(await input.inputValue().catch(() => ''), keyword)) await input.fill(keyword);
      // Let Maps' suggestion list settle; an Enter pressed while it is still
      // loading can be swallowed.
      await page.waitForTimeout(1200);
      onStep('Submitting search');
      await input.press('Enter');
      if (!(await searchSubmitted(page, 6000))) {
        onStep('Enter did not submit; pressing the Search button');
        const button = page.locator(SEARCH_BUTTONS.join(', ')).first();
        if (await button.isVisible().catch(() => false)) await button.click({ timeout: 5000 }).catch(() => {});
      }
    } else {
      onStep(`Search did not start (${detail}); retrying with the Google Maps search address`);
      await page.goto(searchUrl(keyword), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    }
    onStep('Waiting for results');
    const r = await waitForResults(page, keyword);
    if (r.mode !== 'timeout' && r.mode !== 'wrong_query') return { ...r, attempts: attempt };
    detail = r.mode === 'wrong_query' ? `Maps searched for "${r.query}" instead` : `no results appeared (page: ${page.url().slice(0, 120)})`;
  }
  return { mode: 'failed', attempts: 2, detail };
}

// Waits until Maps has run *this* search: results feed, single place, or
// an explicit "can't find" message. 'timeout' means nothing happened.
async function waitForResults(page, keyword, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await detectBlock(page)) return { mode: 'blocked' };
    const state = await page
      .evaluate(() => {
        const box = document.querySelector('input#searchboxinput, input[name="q"]');
        const m = location.pathname.match(/\/maps\/search\/([^/@]+)/);
        const query = m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : box?.value || '';
        const feed = document.querySelector('div[role="feed"]');
        if (feed && feed.querySelector('a[href*="/maps/place/"]')) return { mode: 'list', query };
        if (/\/maps\/place\//.test(location.href) && document.querySelector('div[role="main"] h1')) return { mode: 'single', query: box?.value || query };
        const text = document.body?.innerText || '';
        if (m && /Google Maps can't find|No results found|didn't match any/i.test(text)) return { mode: 'empty', query };
        return null;
      })
      .catch(() => null);
    if (state) {
      if (keyword && state.query && !sameQuery(state.query, keyword) && state.mode !== 'single') {
        return { mode: 'wrong_query', query: state.query };
      }
      return { mode: state.mode };
    }
    await page.waitForTimeout(500);
  }
  return { mode: 'timeout' };
}

// --- results list -----------------------------------------------------------

// Listing links currently rendered in the results feed, in display order.
async function collectLinks(page) {
  return page.evaluate(() => {
    const feed = document.querySelector('div[role="feed"]') || document;
    const out = [];
    const seen = new Set();
    for (const a of feed.querySelectorAll('a[href*="/maps/place/"]')) {
      if (seen.has(a.href)) continue;
      seen.add(a.href);
      const card = a.closest('div[role="article"]') || a.parentElement;
      const name =
        a.getAttribute('aria-label') ||
        card?.getAttribute('aria-label') ||
        card?.querySelector('.fontHeadlineSmall, [role="heading"]')?.textContent ||
        '';
      out.push({ url: a.href, name: name.trim() });
    }
    return out;
  });
}

// Scrolls the results feed one step, using Load more / See more style
// buttons when Maps shows them. Returns { end } when Maps says the list is
// exhausted.
async function scrollFeed(page) {
  return page.evaluate(() => {
    const feed = document.querySelector('div[role="feed"]');
    const scope = feed?.parentElement || document;
    const more = [...scope.querySelectorAll('button, a[role="button"], div[role="button"]')].find((b) =>
      /^(see more|load more|more results|more places|show more results)$/i.test(
        (b.getAttribute('aria-label') || b.textContent || '').trim(),
      ),
    );
    if (more && more.offsetParent !== null) more.click();
    // The feed or its nearest scrollable ancestor holds the scrollbar.
    let scroller = feed;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) {
      scroller = scroller.parentElement;
    }
    scroller = scroller || document.scrollingElement;
    const before = scroller.scrollTop;
    scroller.scrollBy({ top: Math.max(400, scroller.clientHeight * 0.85) });
    const text = (feed || document.body).innerText || '';
    const end = /You've reached the end of the list|reached the end of the list/i.test(text);
    return { end, moved: scroller.scrollTop !== before || Boolean(more) };
  });
}

// --- listing details --------------------------------------------------------

function normalizeName(s) {
  return String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Clicks a result in the feed and waits for its details panel. Returns
// false when the card is no longer present or the panel does not appear.
async function openListing(page, link) {
  const anchor = page.locator(`div[role="feed"] a[href="${cssEscape(link.url)}"]`).first();
  if (!(await anchor.count())) return false;
  await anchor.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await anchor.click({ timeout: 10_000 });
  return waitForDetails(page, link.name);
}

// After a listing has been read, gets back to the results feed. Maps either
// shows details beside the list or replaces the list with them, depending on
// the window width. Maps' own Back button keeps the list's scroll position;
// browser history back is the fallback. Returns true when the feed is back.
async function returnToResults(page) {
  const feedVisible = () =>
    page
      .evaluate(() => {
        const f = document.querySelector('div[role="feed"]');
        return Boolean(f && f.offsetParent !== null && f.querySelector('a[href*="/maps/place/"]'));
      })
      .catch(() => false);
  const waitFeed = async (ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await feedVisible()) return true;
      await page.waitForTimeout(300);
    }
    return false;
  };
  if (await feedVisible()) return true;
  const back = page.locator('button[jsaction*="omnibox.back"]:visible, button[aria-label="Back"]:visible').first();
  if (await back.count().catch(() => 0)) {
    await back.click({ timeout: 5000 }).catch(() => {});
    if (await waitFeed(6000)) return true;
  }
  await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
  return waitFeed(8000);
}

async function gotoListing(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  return waitForDetails(page, null);
}

async function waitForDetails(page, expectedName, timeout = 15_000) {
  const want = normalizeName(expectedName);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const heading = await page
      .evaluate(() => {
        const hs = [...document.querySelectorAll('div[role="main"] h1, h1.DUwDvf')];
        const h = hs.find((e) => e.offsetParent !== null && e.textContent.trim());
        return h ? h.textContent : null;
      })
      .catch(() => null);
    if (heading && (!want || normalizeName(heading) === want)) {
      // Give the info rows (address, phone, website) time to render.
      await page
        .waitForSelector('div[role="main"] [data-item-id]', { timeout: 6000 })
        .catch(() => {});
      await page.waitForTimeout(700);
      return true;
    }
    await page.waitForTimeout(300);
  }
  return false;
}

// Reads the publicly displayed fields from the open details panel.
async function extractDetails(page) {
  return page.evaluate(extractInPage);
}

// Runs inside the page. Kept self-contained so it can be serialised.
function extractInPage() {
  const visible = (e) => e && e.offsetParent !== null;
  const h1 = [...document.querySelectorAll('div[role="main"] h1, h1.DUwDvf')].find(
    (e) => visible(e) && e.textContent.trim(),
  );
  if (!h1) return null;
  const root = h1.closest('div[role="main"]') || document;
  const label = (e) => (e.getAttribute('aria-label') || '').trim();
  const byLabel = (re, tags = 'a, button') => [...root.querySelectorAll(tags)].find((e) => re.test(label(e)));
  const clean = (s) => String(s || '').replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim();

  const websiteEl =
    root.querySelector('a[data-item-id="authority"]') ||
    byLabel(/^website\s*:/i, 'a') ||
    [...root.querySelectorAll('a[data-tooltip]')].find((a) => /open website/i.test(a.getAttribute('data-tooltip')));

  const phoneEl = root.querySelector('[data-item-id^="phone:tel:"]') || byLabel(/^phone\s*:/i);
  let phoneTel = '';
  let phoneText = '';
  if (phoneEl) {
    const id = phoneEl.getAttribute('data-item-id') || '';
    phoneTel = id.startsWith('phone:tel:') ? id.slice('phone:tel:'.length) : '';
    phoneText = clean(label(phoneEl).replace(/^phone\s*:\s*/i, '') || phoneEl.textContent);
  }

  const addressEl = root.querySelector('[data-item-id="address"]') || byLabel(/^address\s*:/i);
  const address = addressEl ? clean(label(addressEl).replace(/^address\s*:\s*/i, '') || addressEl.textContent) : '';

  const text = root.innerText || '';
  return {
    name: clean(h1.textContent),
    website: websiteEl ? websiteEl.href || websiteEl.getAttribute('href') || '' : '',
    phoneTel,
    phoneText,
    address,
    infoLoaded: Boolean(root.querySelector('[data-item-id]')),
    closed: /permanently closed/i.test(text),
    url: location.href,
  };
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

module.exports = {
  MAPS_HOME,
  placeKey,
  cleanMapsUrl,
  detectBlock,
  search,
  searchUrl,
  sameQuery,
  waitForResults,
  collectLinks,
  scrollFeed,
  openListing,
  gotoListing,
  returnToResults,
  extractDetails,
  extractInPage,
};
