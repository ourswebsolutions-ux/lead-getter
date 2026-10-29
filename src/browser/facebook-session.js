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
  // diagnose(record): optional; receives a summary per query (counts and
  // reasons only: no post text, numbers, cookies or account details).
  constructor({ categoryName = '', country = null, facebook = fbDefault, pacing = {}, diagnose = null, ...opts }) {
    super({ ...opts, pacing: { ...DEFAULT_PACING, ...FB_PACING, ...pacing } });
    this.fb = facebook;
    this.country = country;
    this.diagnose = diagnose;
    this.queries = facebook.buildQueries(this.keyword, categoryName);
    this.doneQueries = new Set();
    this.loadedQueries = 0;
    this.seenPosts = new Set();
    // posts read; numbers detected; of those valid and to check (unverified);
    // leads saved (new, or already a lead); posts that could not be saved
    this.stats.facebook = { posts: 0, detected: 0, numbers: 0, unverified: 0, leads: 0, newLeads: 0, duplicates: 0, failures: 0 };
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
    const parts = [`${n('posts', 'post')} read`, `${n('numbers', 'valid number')}`];
    if (f.unverified) parts.push(`${n('unverified', 'number')} to check`);
    parts.push(n('newLeads', 'new lead'));
    if (f.duplicates) parts.push(`${f.duplicates} already saved`);
    if (f.failures) parts.push(`${n('failures', 'post')} not saved`);
    return `${parts.join(', ')}.${this.ending ? ` ${this.ending}` : ''}`;
  }

  progress(note = '') {
    const f = this.stats.facebook;
    this.status('running', `Facebook: ${f.posts} posts read · ${f.numbers} valid numbers${f.unverified ? ` · ${f.unverified} to check` : ''} · ${f.newLeads} new leads${note ? ` · ${note}` : ''}`);
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
    try {
      return await this.searchQueryOnce(page, query);
    } catch (err) {
      try {
        this.diagnose?.({ source: 'facebook', query, ending: `ended: ${String(err?.kind || err?.message || err).split('\n')[0].slice(0, 160)}`, stats: { ...this.stats.facebook } });
      } catch {}
      throw err;
    }
  }

  async searchQueryOnce(page, query) {
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
    const diag = { query, rounds: 0, postsOnPage: 0, withLink: 0, revealed: 0, emptyText: 0, rejected: {}, ending: '' };
    const report = (ending) => {
      this.ending = ending;
      diag.ending = ending;
      try {
        this.diagnose?.({ source: 'facebook', ...diag, stats: { ...this.stats.facebook } });
      } catch {}
    };
    for (;;) {
      const state = await this.op(() => this.fb.detectState(page));
      if (state) throw new FacebookUnavailable(state);
      await this.op(() => this.fb.expandSeeMore(page));
      diag.revealed += await this.op(() => (this.fb.revealPostLinks ? this.fb.revealPostLinks(page) : 0));
      const posts = await this.op(() => this.fb.collectPosts(page));
      diag.rounds++;
      diag.postsOnPage = Math.max(diag.postsOnPage, posts.length);
      // Posts stay on the page as it grows: each is read once (by its address,
      // or its author and text when Facebook shows no address).
      const fresh = posts.filter((p) => p.key && !this.seenPosts.has(p.key));
      for (const post of fresh) {
        this.seenPosts.add(post.key);
        if (post.url) diag.withLink++;
        if (!post.text) diag.emptyText++;
        await this.processPost(post, query, diag);
        if (++read >= this.pacing.fbMaxPosts) return report(`Stopped at ${this.pacing.fbMaxPosts} posts for "${query}".`);
      }
      const before = await this.op(() => this.fb.resultsState(page));
      // Facebook's own end marker; with posts on screen that were all read.
      if (before.end) return report(`End of the results for "${query}".`);
      this.progress('loading more posts');
      await this.op(() => (stalls ? this.fb.nudge(page) : this.fb.scrollResults(page)));
      const after = await this.op(() => this.fb.waitForMore(page, before, { timeout: this.pacing.fbLoad }));
      if (after.grew || after.end) {
        stalls = 0;
        await this.pause(this.pacing.fbScroll);
        continue;
      }
      if (++stalls > this.pacing.fbStallRetries) {
        this.progress('no more posts loaded');
        return report(`No more posts loaded for "${query}" after ${this.pacing.fbStallRetries} tries.`);
      }
      this.progress(`waiting for more posts (try ${stalls} of ${this.pacing.fbStallRetries})`);
      // Facebook may only load while its window is visible: shown once.
      if (stalls === 2) await this.op(() => page.bringToFront()).catch(() => {});
      await this.pause(this.pacing.fbStallWait);
    }
  }

  // Reads one post (no extra page is opened): the numbers in its text and
  // links, and in its visible comments (credited to the commenter). Valid
  // numbers and numbers to check are saved; nothing is filled in when there
  // is none. A post without its own address (Facebook didn't show one) is
  // still read, and linked to the search it came from.
  async processPost(post, query = this.keyword, diag = null) {
    this.stats.processed++;
    const f = this.stats.facebook;
    f.posts++;
    const who = post.author || 'a Facebook user';
    const postUrl = post.url || `${this.fb.searchUrl(query)}#lf-${post.key.replace(/^text:/, '').slice(0, 16)}`;
    // Every post's text is read, even one saved before: its numbers are then
    // counted as already saved (saving is idempotent), never skipped unread.
    const items = [{ text: post.text, links: post.links, author: post.author, pageUrl: post.pageUrl }, ...(post.comments || []).map((c) => ({ ...c, links: [] }))];
    let found = 0;
    let added = 0;
    const seen = new Set();
    for (const item of items) {
      const { phones, stats } = this.fb.readPhones(item.text, item.links, this.country);
      f.detected += stats.candidates - stats.rejected;
      if (diag) for (const [k, v] of Object.entries(stats.reasons)) diag.rejected[k] = (diag.rejected[k] || 0) + v;
      for (const ph of phones) {
        if (seen.has(ph.phone)) continue;
        seen.add(ph.phone);
        found++;
        if (ph.status === 'valid') f.numbers++;
        else f.unverified++;
        let saved;
        try {
          saved = this.saveFacebook({
            phone: ph.phone,
            status: ph.status,
            country: ph.country,
            raw: ph.raw,
            name: item.author || post.author,
            contactName: item.author || post.author,
            postUrl,
            pageUrl: item.pageUrl || post.pageUrl,
            text: post.text,
            keyword: this.keyword,
            categoryId: this.categoryId,
          });
        } catch (err) {
          if (err instanceof FatalSearchError) throw err;
          f.failures++;
          continue;
        }
        if (!saved.lead) continue;
        this.stats.leads++;
        f.leads++;
        if (saved.isNewLead) {
          added++;
          this.stats.newLeads++;
          f.newLeads++;
        } else f.duplicates++;
        this.emit('lead', saved.lead);
      }
    }
    if (!found) return this.progress(`no phone number in a post by ${who}`);
    this.progress(added ? `lead found: ${who}` : `${who}'s number is already a lead`);
  }

  saveFacebook(r) {
    try {
      return this.store.saveFacebookLead(r);
    } catch (err) {
      if (err?.code === 'invalid_lead') throw err; // this number only; the search goes on
      throw new FatalSearchError(`Could not save to the local database (${String(err?.message || err).split('\n')[0]}).`);
    }
  }
}

module.exports = { FacebookSession, FacebookUnavailable, FB_PACING };
