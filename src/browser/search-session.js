'use strict';

// One keyword search: drives the visible Maps tab, qualifies each listing,
// saves it, and reports progress. Browser operations, storage and pacing are
// injected so the loop can be tested against mocked pages.

const mapsDefault = require('./maps');
const { checkWebPresence } = require('./web-check');
const { classifyWebsite } = require('./website');

const DEFAULT_PACING = {
  listing: [2500, 5000], // pause between opened listings
  scroll: [1200, 2500], // pause after scrolling the results feed
  breakEvery: 25, // longer break after this many opened listings
  longBreak: [15_000, 30_000],
  afterBlock: 30_000, // cool-down after a CAPTCHA / rate-limit page clears
  blockPoll: 3000,
  freshTabAfter: 45_000, // still blocked this long: try one fresh tab
  restartAfter: 120_000, // still blocked this long: one approved Chrome restart, if supported
  netRetries: [5000, 15_000, 30_000],
  reconnectDelays: [5000, 15_000, 30_000], // waits before each reconnect attempt after Chrome closes
};

const BLOCK_MESSAGES = {
  captcha: 'Google is showing a CAPTCHA. Lead Finder has paused and will not try to solve it. Complete it yourself in Chrome to continue, or click Stop.',
  rate_limit: 'Google reports unusual traffic (rate limit). Lead Finder has paused. Wait or complete the check in Chrome to continue, or click Stop.',
  consent: 'Google is showing a consent page in Chrome. Please make your choice there; Lead Finder will continue afterwards.',
};

class StopRequested extends Error {
  constructor() {
    super('Search stopped');
    this.name = 'StopRequested';
  }
}

class FatalSearchError extends Error {}

// Today's allowance for this source is used up (or the subscription is
// suspended): the source stops, its saved leads stay.
class LimitReached extends Error {}

// Chrome (or Lead Finder's tab) went away. Recoverable: the session
// reconnects and continues, a limited number of times.
class BrowserClosed extends FatalSearchError {
  constructor() {
    super('Chrome or the Lead Finder tab was closed. Your saved leads are kept.');
    this.phase = 'connection';
  }
}

// The tab for `role` was replaced while recovering from a block; the work
// on it is redone with the new tab (already-seen listings are skipped).
class PageReplaced extends Error {
  constructor(role) {
    super(`tab replaced: ${role}`);
    this.role = role;
  }
}

function isClosedError(err) {
  return /Target page, context or browser has been closed|Target closed|Browser has been closed|has been disconnected/i.test(
    String(err?.message || err),
  );
}

function isNetworkError(err) {
  return /net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|CONNECTION_\w+|ADDRESS_UNREACHABLE|TIMED_OUT|PROXY_\w+)/.test(
    String(err?.message || err),
  );
}

class SearchSession {
  // credits: the daily allowance (main/credits.js CreditGate); null = none.
  constructor({ keyword, categoryId = null, websiteFilter = 'without', store, pages, emit, signal, recovery = null, credits = null, maps = mapsDefault, webCheck = checkWebPresence, pacing = {}, random = Math.random }) {
    this.keyword = keyword;
    this.categoryId = categoryId;
    this.websiteFilter = WEBSITE_FILTERS.has(websiteFilter) ? websiteFilter : 'without';
    this.store = store;
    this.pages = pages; // { main(), check(), detail(), open(), adopt(role, page) }
    this.recovery = recovery; // { canRestart(), restart() } or null
    this.credits = credits;
    this.emit = emit; // (event, payload)
    this.signal = signal;
    this.maps = maps;
    this.webCheck = webCheck;
    this.pacing = { ...DEFAULT_PACING, ...pacing };
    this.random = random;
    this.slow = 1;
    this.opened = 0;
    this.seenUrls = new Set();
    this.seenKeys = new Set();
    this.stats = { processed: 0, leads: 0, newLeads: 0, skipped: 0 };
    this.recoveryUsed = new Set(); // block-recovery steps already used in this search
  }

  status(state, message, phase = 'search') {
    this.emit('status', { state, message, phase, step: this.step, keyword: this.keyword, ...this.stats });
  }

  // What the agent is doing, for the UI: 'searching' | 'analyzing' | 'qualifying'.
  setStep(step) {
    this.step = step;
  }

  // --- abort-aware primitives ----------------------------------------------

  checkStop() {
    if (this.signal.aborted) throw new StopRequested();
  }

  delay(ms) {
    this.checkStop();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(new StopRequested());
      };
      this.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  pause([min, max]) {
    return this.delay(Math.round((min + this.random() * (max - min)) * this.slow));
  }

  // Runs a browser operation; Stop resolves immediately while the in-flight
  // Playwright call finishes on its own (each has its own timeout).
  async op(fn) {
    this.checkStop();
    let onAbort;
    const stopped = new Promise((_, reject) => {
      onAbort = () => reject(new StopRequested());
      this.signal.addEventListener('abort', onAbort, { once: true });
    });
    const work = Promise.resolve().then(fn);
    work.catch(() => {});
    try {
      return await Promise.race([work, stopped]);
    } catch (err) {
      if (err instanceof StopRequested) throw err;
      if (isClosedError(err)) {
        throw new BrowserClosed();
      }
      throw err;
    } finally {
      this.signal.removeEventListener('abort', onAbort);
    }
  }

  // op() with limited retries when the network is down.
  async netOp(fn, page) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.op(fn);
      } catch (err) {
        if (err instanceof StopRequested || err instanceof FatalSearchError || err instanceof PageReplaced) throw err;
        const offline = isNetworkError(err) || (await this.isOffline(page));
        if (!offline) throw err;
        if (attempt >= this.pacing.netRetries.length) {
          throw new FatalSearchError('Network connection lost. The search was stopped; your saved leads are kept.');
        }
        const wait = this.pacing.netRetries[attempt];
        this.status('running', `Network problem. Retrying in ${Math.round(wait / 1000)}s`);
        await this.delay(wait);
      }
    }
  }

  async isOffline(page) {
    if (!page) return false;
    try {
      return !(await page.evaluate(() => navigator.onLine));
    } catch {
      return false;
    }
  }

  // Pauses while Google shows a CAPTCHA, rate-limit or consent page. Lead
  // Finder never solves or bypasses it. Recovery, each tried at most once per
  // block and never in a loop: (1) a fresh tab in the same Chrome session,
  // (2) an approved graceful restart of the same profile where Chrome
  // supports it, then (3) wait for the user to solve it in Chrome.
  async guard(page, role = 'main') {
    let kind = await this.op(() => this.maps.detectBlock(page));
    if (!kind) return;
    const started = Date.now();
    let shown = null;
    // Each recovery step is tried at most once per search, not once per
    // block, so a persistent block never turns into a cycle of new tabs or
    // restarts. Consent pages need the user's choice, so they only wait.
    const consent = kind === 'consent';
    // The page Google blocked: its CAPTCHA page carries it as ?continue=.
    const blockedUrl = blockedTarget(page.url());
    while (kind) {
      if (kind !== shown) this.status('paused', BLOCK_MESSAGES[kind] || BLOCK_MESSAGES.captcha);
      shown = kind;
      await this.delay(this.pacing.blockPoll);
      const waited = Date.now() - started;

      if (!consent && !this.recoveryUsed.has('tab') && waited >= this.pacing.freshTabAfter && this.pages.open) {
        this.recoveryUsed.add('tab');
        this.status('paused', 'Still blocked. Trying a fresh tab in the same Chrome session');
        const fresh = await this.op(() => this.pages.open()).catch(rethrowControl);
        if (fresh) {
          const ok = await this.op(async () => {
            // Retry the very page that was blocked, not a page that never is.
            await fresh.goto(blockedUrl || this.maps.MAPS_HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            return !(await this.maps.detectBlock(fresh));
          }).catch(rethrowControl);
          if (ok) {
            await this.op(() => this.pages.adopt(role, fresh));
            await this.cooldown();
            throw new PageReplaced(role);
          }
          await fresh.close().catch(() => {});
        }
        this.status('paused', `${BLOCK_MESSAGES[kind] || BLOCK_MESSAGES.captcha} A fresh tab is blocked too.`);
        shown = kind;
      }

      if (!consent && this.recoveryUsed.has('tab') && !this.recoveryUsed.has('restart') && waited >= this.pacing.restartAfter && this.recovery?.canRestart()) {
        this.recoveryUsed.add('restart');
        this.status('paused', 'Still blocked. Restarting Chrome with your profile (your tabs are restored)');
        const restarted = await this.op(() => this.recovery.restart()).catch((err) => {
          rethrowControl(err);
          this.status('paused', `Chrome was not restarted (${String(err?.message || err).split('\n')[0]}).`);
          return false;
        });
        if (restarted) {
          await this.cooldown();
          throw new PageReplaced('all');
        }
        shown = null;
      }

      kind = await this.op(() => this.maps.detectBlock(page));
    }
    await this.cooldown();
  }

  async cooldown() {
    this.slow = 2; // go slower for the rest of this search
    this.status('running', 'Resuming after pause');
    await this.delay(this.pacing.afterBlock);
  }

  // --- search loop -----------------------------------------------------------

  async run() {
    try {
      await this.search();
      this.status('done', this.noResults ? `Google Maps found no results for "${this.keyword}"` : 'Search finished: no more results');
    } catch (err) {
      if (err instanceof StopRequested) {
        this.status('stopped', 'Search stopped');
      } else if (err instanceof LimitReached) {
        this.status('done', err.message);
      } else if (err instanceof FatalSearchError) {
        this.status('error', err.message, err.phase);
      } else {
        this.status('error', `Search failed: ${String(err?.message || err).split('\n')[0]}`);
      }
    }
    return this.stats;
  }

  // Runs the search; if a block recovery replaced the tab (or restarted
  // Chrome), the search is run again in the new tab and continues where it
  // left off, because seen listings are skipped.
  // If Chrome closes, it is reopened and reconnected (limited attempts,
  // spaced out), and the search continues with the same keyword and category,
  // skipping every business already processed.
  async search() {
    let replaced = 0;
    let reconnects = 0;
    for (;;) {
      try {
        return await this.searchOnce();
      } catch (err) {
        if (err instanceof PageReplaced && replaced++ < 3) {
          this.status('running', 'Continuing the search in the new tab');
          continue;
        }
        if (err instanceof BrowserClosed && this.recovery?.reconnect && reconnects < this.pacing.reconnectDelays.length) {
          await this.reconnect(reconnects++);
          continue;
        }
        throw err;
      }
    }
  }

  async reconnect(attempt) {
    const total = this.pacing.reconnectDelays.length;
    for (let i = attempt; i < total; i++) {
      const wait = this.pacing.reconnectDelays[i];
      this.status('paused', `Chrome closed unexpectedly. Reopening it in ${Math.round(wait / 1000)}s (attempt ${i + 1} of ${total}); click Stop to cancel`, 'connection');
      await this.delay(wait);
      try {
        await this.op(() => this.recovery.reconnect());
        this.status('running', `Reconnected. Resuming "${this.keyword}" after ${this.stats.processed} processed listings`);
        return;
      } catch (err) {
        if (err instanceof StopRequested) throw err;
        if (err?.code === 'wrong_profile' || err?.code === 'restart_declined' || i === total - 1) {
          const e = new FatalSearchError(`Could not reconnect to Chrome: ${String(err?.message || err).split('\n')[0]}. Your saved leads are kept.`);
          e.phase = 'connection';
          throw e;
        }
      }
    }
  }

  async runMapsSearch(page) {
    this.setStep('searching');
    const onStep = (m) => this.status('running', m);
    let result = await this.netOp(() => this.maps.search(page, this.keyword, { onStep }), page);
    if (result.mode === 'blocked') {
      await this.guard(page);
      result = await this.netOp(() => this.maps.search(page, this.keyword, { onStep }), page);
    }
    if (result.mode === 'blocked') throw new FatalSearchError('Google Maps is still blocking automated access. Try again later.');
    if (result.mode === 'failed') {
      throw new FatalSearchError(
        `The Google Maps search for "${this.keyword}" did not run: ${result.detail}. Chrome is connected; the search was tried twice. Check the Maps tab in Chrome and start again.`,
      );
    }
    return result;
  }

  async searchOnce() {
    const page = await this.op(() => this.pages.main());
    await this.op(() => page.bringToFront());

    const result = await this.runMapsSearch(page);
    if (result.mode === 'empty') {
      this.noResults = true;
      return;
    }
    if (result.mode === 'single') {
      const url = page.url();
      await this.processListing({ url, name: '' }, page, { alreadyOpen: true });
      return;
    }

    const count = (await this.op(() => this.maps.collectLinks(page))).length;
    this.setStep('analyzing');
    this.status('running', `Results loaded (${count} listings visible). Processing listings`);
    let idle = 0;
    let endSeen = false;
    let lastCount = 0;
    let researched = 0;
    for (;;) {
      await this.guard(page);
      const links = await this.op(() => this.maps.collectLinks(page));
      const fresh = links.filter((l) => !this.seenUrls.has(l.url));
      for (const link of fresh) {
        this.seenUrls.add(link.url);
        await this.processListing(link, page);
        // Opening a listing can replace the result list with its details.
        if (!(await this.op(() => this.maps.returnToResults(page)))) {
          if (++researched > 3) throw new FatalSearchError('Google Maps did not return to the result list. The search was stopped; your saved leads are kept.');
          this.status('running', 'Returning to the result list');
          await this.runMapsSearch(page); // resumes; already-seen listings are skipped
          lastCount = 0;
          break;
        }
      }
      // Progress = new listings to process, or the list grew while scrolling.
      if (fresh.length || links.length > lastCount) idle = 0;
      else if (endSeen || ++idle >= 6) return;
      lastCount = links.length;
      this.status('running', `Loading more listings (${links.length} loaded so far)`);
      const scroll = await this.op(() => this.maps.scrollFeed(page));
      if (scroll.end) endSeen = true;
      await this.pause(this.pacing.scroll);
    }
  }

  // A listing previously checked with a conclusive result is not reopened,
  // unless it is a lead with a missing phone or address.
  isSettled(row) {
    if (row?.website_status === 'deleted') return true; // deleted leads stay deleted
    if (!row || row.website_status === 'unverified') return false;
    // Skipped before only because of the website filter of that search:
    // reopen it if this search's filter includes it (its contact details were
    // not kept then).
    if (!row.qualified) return !isLeadFor(this.websiteFilter, row.website_status);
    // A number that was extracted but rejected as invalid is not retried.
    return !(row.qualified && ((!row.phone && !row.phone_raw) || !row.address));
  }

  // Processes one listing. If block recovery replaced the detail or check
  // tab, the listing is retried once; if it replaced the Maps tab, the
  // listing is un-marked so the resumed search processes it again.
  async processListing(link, page, opts = {}) {
    const key = this.maps.placeKey(link.url);
    if (this.seenKeys.has(key)) return;
    this.seenKeys.add(key);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.processListingOnce(link, key, page, opts);
      } catch (err) {
        if (err instanceof PageReplaced && (err.role === 'detail' || err.role === 'check') && attempt === 0) continue;
        if (err instanceof PageReplaced || err instanceof BrowserClosed) {
          this.seenKeys.delete(key);
          this.seenUrls.delete(link.url);
        }
        throw err;
      }
    }
  }

  async processListingOnce(link, key, page, { alreadyOpen = false } = {}) {

    const existing = this.store.get(key);
    if (this.isSettled(existing)) {
      this.stats.processed++;
      if (existing.qualified && isLeadFor(this.websiteFilter, existing.website_status)) this.stats.leads++;
      this.status('running', `Already checked: ${existing.name}`);
      return;
    }

    if (this.credits?.exhausted('maps')) throw new LimitReached(this.credits.message('maps'));
    await this.guard(page);
    if (this.opened > 0 && this.opened % this.pacing.breakEvery === 0) {
      this.status('running', 'Taking a short break to keep the pace gentle');
      await this.pause(this.pacing.longBreak);
    }
    this.opened++;
    this.status('running', `Opening listing${link.name ? `: ${link.name}` : ''}`);

    let detailsPage = page;
    let opened = alreadyOpen || (await this.netOp(() => this.maps.openListing(page, link), page).catch(rethrowControl));
    if (!opened) {
      // The card was not clickable (re-rendered or hidden): open it directly.
      detailsPage = await this.op(() => this.pages.detail());
      await this.op(() => detailsPage.bringToFront());
      opened = await this.netOp(() => this.maps.gotoListing(detailsPage, link.url), detailsPage).catch(rethrowControl);
      await this.guard(detailsPage, 'detail');
    }
    const details = opened ? await this.op(() => this.maps.extractDetails(detailsPage)).catch(rethrowControl) : null;
    if (detailsPage !== page) await this.op(() => page.bringToFront());

    if (!details || !details.name) {
      this.stats.processed++;
      this.stats.skipped++;
      this.status('running', 'Skipped a listing whose details did not load');
      return;
    }

    const verdict = await this.qualify(details, page);
    this.setStep('analyzing');
    const result = {
      placeKey: key,
      mapsUrl: this.maps.cleanMapsUrl(link.url || details.url),
      name: details.name,
      // Normalised to an international number when saved (see database/phone.js).
      phoneRaw: details.phoneTel || details.phoneText,
      address: details.address,
      websiteStatus: verdict.status,
      websiteDetail: verdict.detail || null,
      isLead: isLeadFor(this.websiteFilter, verdict.status),
      keyword: this.keyword,
      categoryId: this.categoryId,
    };
    // A new qualified lead uses one of today's leads first.
    await this.charge('maps', this.credits ? this.store.creditKeyForMaps(result) : null);
    const saved = this.save(result);

    this.stats.processed++;
    if (saved.lead) {
      this.stats.leads++;
      if (saved.isNewLead) this.stats.newLeads++;
      this.emit('lead', saved.lead);
      this.status('running', `Lead found: ${saved.lead.name}`);
    } else {
      this.status('running', `Not a lead: ${details.name} (${describeVerdict(verdict.status)})`);
    }
    await this.pause(this.pacing.listing);
  }

  // Charges a new lead to today's allowance before it is saved. Network
  // problems are retried like page loads; a refusal stops this source.
  async charge(source, key) {
    if (!this.credits || !key) return;
    for (let attempt = 0; ; attempt++) {
      let r;
      try {
        r = await this.op(() => this.credits.reserve(source, key));
      } catch (err) {
        if (err instanceof StopRequested || err instanceof FatalSearchError) throw err;
        if (attempt < this.pacing.netRetries.length) {
          const wait = this.pacing.netRetries[attempt];
          this.status('running', `Could not reach the subscription server. Retrying in ${Math.round(wait / 1000)}s`);
          await this.delay(wait);
          continue;
        }
        throw new FatalSearchError(`The lead could not be recorded with the subscription server (${String(err?.message || err).split('\n')[0]}). The search was stopped; your saved leads are kept.`);
      }
      if (r?.granted) return;
      throw new LimitReached(this.credits.message(source, r?.reason));
    }
  }

  // Applies the qualification rules. Only 'no_website' and 'social_only'
  // become leads; anything inconclusive is 'unverified' and kept out.
  async qualify(details, mainPage) {
    if (details.closed) return { status: 'closed' };
    let social = null;
    if (details.website) {
      const c = classifyWebsite(details.website);
      if (c.kind === 'independent') return { status: 'has_website', detail: c.url };
      if (c.kind === 'social') social = c.url;
    }
    if (!details.infoLoaded) return { status: 'unverified', detail: 'listing details did not load' };
    // "With website" searches only want businesses with a website on Maps;
    // the web check that confirms "no website" is not needed for the rest.
    if (this.websiteFilter === 'with') return { status: 'unverified', detail: 'no website on Maps (not checked further)' };

    this.setStep('qualifying');
    this.status('running', `Checking website status: ${details.name}`);
    let check;
    try {
      const checkPage = await this.op(() => this.pages.check());
      await this.op(() => checkPage.bringToFront());
      check = await this.netOp(() => this.webCheck(checkPage, details), checkPage);
      if (check.status === 'blocked') {
        await this.guard(checkPage, 'check');
        check = await this.netOp(() => this.webCheck(checkPage, details), checkPage);
      }
    } catch (err) {
      rethrowControl(err);
      check = { status: 'unverified', detail: 'website check failed' };
    } finally {
      await this.op(() => mainPage.bringToFront()).catch(rethrowControl);
    }
    if (check.status === 'blocked') return { status: 'unverified', detail: 'website check blocked' };
    if (check.status === 'no_website') return social ? { status: 'social_only', detail: social } : { status: 'no_website' };
    return check;
  }

  save(result) {
    try {
      return this.store.save(result);
    } catch (err) {
      throw new FatalSearchError(`Could not save to the local database (${String(err?.message || err).split('\n')[0]}). The search was stopped.`);
    }
  }
}

// Which businesses a search keeps as leads, by its website filter.
const WEBSITE_FILTERS = new Set(['without', 'with', 'all']);
const LEAD_STATUSES = {
  without: new Set(['no_website', 'social_only']),
  with: new Set(['has_website']),
  all: new Set(['no_website', 'social_only', 'has_website', 'possible_website']),
};
function isLeadFor(filter, status) {
  return (LEAD_STATUSES[filter] || LEAD_STATUSES.without).has(status);
}

// For Google's CAPTCHA page (/sorry/index?continue=<url>), the URL that was
// blocked; otherwise the page's own URL.
function blockedTarget(url) {
  try {
    const u = new URL(url);
    const next = /\/sorry\//.test(u.pathname) ? u.searchParams.get('continue') : null;
    const target = new URL(next || url);
    return /^https:$/.test(target.protocol) && /(^|\.)google\.[a-z.]+$/.test(target.hostname) ? target.toString() : null;
  } catch {
    return null;
  }
}

// Control-flow errors propagate; anything else becomes a "not loaded" result.
function rethrowControl(err) {
  if (err instanceof StopRequested || err instanceof FatalSearchError || err instanceof PageReplaced) throw err;
  return false;
}

function describeVerdict(status) {
  return (
    {
      has_website: 'has a website',
      possible_website: 'a matching website was found on the web',
      unverified: 'could not verify',
      closed: 'permanently closed',
    }[status] || status
  );
}

module.exports = { isLeadFor, WEBSITE_FILTERS, SearchSession, StopRequested, FatalSearchError, LimitReached, BrowserClosed, PageReplaced, DEFAULT_PACING };
