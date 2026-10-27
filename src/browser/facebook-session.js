'use strict';

// The Facebook part of a search: post searches for the same keyword and
// category in a window of its own in the same Chrome session (it runs
// alongside the Google Maps search), reading the numbers posts show. Built on SearchSession, so Stop, pacing, network retries and Chrome
// reconnects behave exactly as in the Google Maps search.
//
// It never ends the whole search: run() returns an outcome instead of a
// final status, and a login page, checkpoint or block only ends the Facebook
// part (Google Maps results are already saved).

const fbDefault = require('./facebook');
const { SearchSession, StopRequested, FatalSearchError, DEFAULT_PACING } = require('./search-session');

const FB_PACING = {
  fbScroll: [1500, 3000], // pause between scrolls when new posts loaded
  fbLoad: 10_000, // wait for new results after a scroll (longer while Facebook shows it is loading)
  fbStallRetries: 4, // scrolls in a row that load nothing before a query is done
  fbStallWait: [2500, 5000], // extra pause before each retry
  fbBetweenQueries: [4000, 8000],
  fbMaxPosts: 150, // posts read per query, at most
};

const UNAVAILABLE = {
  login: 'Facebook asked to log in. Log in to Facebook in this Chrome profile, then search again.',
  checkpoint: 'Facebook is showing a security check. Complete it yourself in Chrome; Lead Finder does not answer it.',
  blocked: 'Facebook says this feature is temporarily blocked for your account. Lead Finder stopped searching Facebook; try again later.',
  not_loaded: 'Facebook search results did not load. Open facebook.com in this Chrome profile to check that it works, then search again.',
};

class FacebookUnavailable extends FatalSearchError {
  constructor(kind, detail = '') {
    super(`${UNAVAILABLE[kind] || UNAVAILABLE.blocked}${detail ? ` (${detail})` : ''}`);
    this.kind = kind;
  }
}

class FacebookSession extends SearchSession {
  // categoryName: for the extra category query; country: how local numbers
  // in posts are read.
  constructor({ categoryName = '', country = null, facebook = fbDefault, pacing = {}, ...opts }) {
    super({ ...opts, pacing: { ...DEFAULT_PACING, ...FB_PACING, ...pacing } });
    this.fb = facebook;
    this.country = country;
    this.queries = facebook.buildQueries(this.keyword, categoryName);
    this.doneQueries = new Set();
    this.loadedQueries = 0;
    this.seenPosts = new Set();
    // posts read, valid numbers found in them, leads saved (new or not)
    this.stats.facebook = { posts: 0, numbers: 0, leads: 0, newLeads: 0 };
  }

  status(state, message, phase = 'search') {
    this.emit('status', { state, message, phase, step: this.step, keyword: this.keyword, source: 'facebook', ...this.stats });
  }

  // { state: 'done' | 'stopped' | 'unavailable' | 'error', kind?, message }.
  async run() {
    try {
      await this.search();
      return { state: 'done', message: this.summary() };
    } catch (err) {
      if (err instanceof StopRequested) return { state: 'stopped', message: 'Search stopped' };
      if (err instanceof FacebookUnavailable) return { state: 'unavailable', kind: err.kind, message: `${err.message} ${this.summary()}` };
      const detail = String(err?.message || err).split('\n')[0];
      return { state: 'error', message: `The Facebook search did not finish (${detail}). ${this.summary()}` };
    }
  }

  summary() {
    const f = this.stats.facebook;
    const n = (k, one, many = `${one}s`) => `${f[k]} ${f[k] === 1 ? one : many}`;
    return `${n('posts', 'post')} read, ${n('numbers', 'valid number')}, ${n('newLeads', 'new lead')}.${this.ending ? ` ${this.ending}` : ''}`;
  }

  progress(note = '') {
    const f = this.stats.facebook;
    this.status('running', `Facebook: ${f.posts} posts read · ${f.numbers} valid numbers · ${f.newLeads} new leads${note ? ` · ${note}` : ''}`);
  }

  // Each query once; after a reconnect, finished queries are skipped and
  // posts already read are not read again.
  async searchOnce() {
    // Its own window: not brought to the front, so the Maps tabs keep theirs.
    const page = await this.op(() => this.pages.facebook());
    for (const query of this.queries) {
      if (this.doneQueries.has(query)) continue;
      if (this.doneQueries.size) await this.pause(this.pacing.fbBetweenQueries);
      await this.searchQuery(page, query);
      this.doneQueries.add(query);
    }
    // Not one search page loaded: a problem to report, not "0 posts".
    if (!this.loadedQueries) throw new FacebookUnavailable('not_loaded', this.lastFailure);
  }

  async searchQuery(page, query) {
    this.setStep('searching');
    this.status('running', `Facebook: searching posts for "${query}"`);
    const result = await this.netOp(() => this.fb.openSearch(page, query), page);
    if (UNAVAILABLE[result.mode]) throw new FacebookUnavailable(result.mode);
    if (result.mode !== 'list' && result.mode !== 'empty') {
      this.lastFailure = result.detail || result.mode;
      return this.status('running', `Facebook: the search for "${query}" did not load (${this.lastFailure})`);
    }
    this.loadedQueries++;
    if (result.mode === 'empty') return this.status('running', `Facebook: no posts found for "${query}"`);

    this.setStep('analyzing');
    // Read what is on screen, then scroll for more and wait until Facebook
    // has actually loaded new results; repeat until the limit, Facebook's
    // "End of results", or several scrolls in a row that load nothing.
    let read = 0;
    let stalls = 0;
    for (;;) {
      const state = await this.op(() => this.fb.detectState(page));
      if (state) throw new FacebookUnavailable(state);
      await this.op(() => this.fb.expandSeeMore(page));
      const posts = await this.op(() => this.fb.collectPosts(page));
      // Posts stay on the page as it grows: each is read once (by its address).
      const fresh = posts.filter((p) => p.key && !this.seenPosts.has(p.key));
      for (const post of fresh) {
        this.seenPosts.add(post.key);
        await this.processPost(post);
        if (++read >= this.pacing.fbMaxPosts) {
          this.ending = `Stopped at ${this.pacing.fbMaxPosts} posts for "${query}".`;
          return;
        }
      }
      const before = await this.op(() => this.fb.resultsState(page));
      if (before.end) {
        this.ending = `End of the results for "${query}".`;
        return;
      }
      this.progress('loading more posts');
      await this.op(() => (stalls ? this.fb.nudge(page) : this.fb.scrollResults(page)));
      const after = await this.op(() => this.fb.waitForMore(page, before, { timeout: this.pacing.fbLoad }));
      if (after.grew || after.end) {
        stalls = 0;
        await this.pause(this.pacing.fbScroll);
        continue;
      }
      if (++stalls > this.pacing.fbStallRetries) {
        this.ending = `No more posts loaded for "${query}" after ${this.pacing.fbStallRetries} tries.`;
        this.progress('no more posts loaded');
        return;
      }
      this.progress(`waiting for more posts (try ${stalls} of ${this.pacing.fbStallRetries})`);
      // Facebook may only load while its window is visible: shown once.
      if (stalls === 2) await this.op(() => page.bringToFront()).catch(() => {});
      await this.pause(this.pacing.fbStallWait);
    }
  }

  // Reads one post (no extra page is opened). Only valid numbers that the
  // post itself shows are saved; nothing is filled in when there is none.
  async processPost(post) {
    this.stats.processed++;
    this.stats.facebook.posts++;
    const who = post.author || 'a Facebook user';
    if (!post.url) {
      this.stats.skipped++;
      return this.status('running', `Facebook: skipped a post by ${who} without its own link`);
    }
    if (this.store.hasFacebookPost(post.url)) return this.status('running', `Facebook: already saved a post by ${who}`);
    const phones = this.fb.extractPhones(post.text, post.links, this.country);
    if (!phones.length) return this.status('running', `Facebook: no phone number in a post by ${who}`);
    this.stats.facebook.numbers += phones.length;
    let added = 0;
    for (const ph of phones) {
      const saved = this.saveFacebook({
        phone: ph.phone,
        country: ph.country,
        raw: ph.raw,
        name: post.author,
        contactName: post.author,
        postUrl: post.url,
        pageUrl: post.pageUrl,
        text: post.text,
        keyword: this.keyword,
        categoryId: this.categoryId,
      });
      if (!saved.lead) continue;
      this.stats.leads++;
      this.stats.facebook.leads++;
      if (saved.isNewLead) {
        added++;
        this.stats.newLeads++;
        this.stats.facebook.newLeads++;
      }
      this.emit('lead', saved.lead);
    }
    this.status('running', added ? `Facebook lead found: ${who}` : `Facebook: ${who}'s number is already a lead`);
  }

  saveFacebook(r) {
    try {
      return this.store.saveFacebookLead(r);
    } catch (err) {
      throw new FatalSearchError(`Could not save to the local database (${String(err?.message || err).split('\n')[0]}).`);
    }
  }
}

module.exports = { FacebookSession, FacebookUnavailable, FB_PACING };
