'use strict';

// One podcast search: the selected platforms are searched side by side (or
// one pasted link is looked up), each podcast found is merged with the same
// podcast from other platforms, and its contact emails are looked for at
// once (podcasts.js processPodcast). Each is saved to the leads as soon as it
// is done.
//
// The same podcast on several platforms is one row and one lead: same RSS
// feed, same Apple Podcasts id, or the same title with a compatible host.
// A podcast from a platform without RSS feeds (YouTube, Amazon Music) waits
// until every platform has answered, then its feed is looked for by exact
// title; if that feed is a podcast already found, the two are merged.
//
// Spotify is a browser platform: its search (or a pasted show link) is
// opened in the user's Chrome (openInBrowser) for the user to look through;
// nothing is read from it and no results are counted for it. A pasted
// podcast website is read where its robots.txt permits.
//
// Every podcast found is saved at once (email discovery pending), then again
// with what discovery found, so a stopped or failed search loses nothing.
// The search is recorded (store.startSearch) with each podcast it found, as
// new or already saved. Every event carries this run's id, so a late event
// from an earlier search never touches a newer one.
//
// seed: podcasts to check again (saved leads, "Retry"): no platform is
// searched.
//
// emit(event, payload):
//   'platform' { runId, id, state: 'searching' | 'done' | 'opened' | 'failed' | 'needs_key' | 'not_permitted', count, rejected, message }
//   'item'     { key, ...podcast, platforms, links, state: 'queued' | 'running' | 'done' | 'merged' | 'stopped', step, result, leadId, isNewLead, mergedInto }
//   'lead'     a saved lead
//   'status'   { state: 'running' | 'done' | 'stopped' | 'failed', found, done, withEmail, noEmail, failed, newLeads, message }

const { ADAPTERS, PLATFORMS, platformOfUrl, titleKey, sameHost, feedKey, feedByTitle, keywordTerms, relevant } = require('./podcast-platforms');
const { processPodcast, fetchFeed, parseFeed } = require('./podcasts');
const { textOf } = require('./website-contacts');

class PodcastSearch {
  // openInBrowser(url): opens a page in the user's Chrome (main.js); allow(url):
  // whether a website permits automated reading (robots.js).
  constructor({ query, platforms = ['apple'], creds = {}, store, keyword, categoryId = null, country = null, signal, emit = () => {}, fetchImpl, feedCache, findContacts, limit = 50, concurrency = 3, adapters = ADAPTERS, openInBrowser = null, allow = async () => true, seed = null, extraLinks = null, runId = null }) {
    Object.assign(this, { query: String(query || '').trim(), platforms, creds, store, keyword: keyword ?? query, categoryId, country, fetchImpl, feedCache, findContacts, limit, concurrency, adapters, openInBrowser, allow, seed, extraLinks, signal });
    this.runId = runId || `run${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.emit = (event, payload) => emit(event, event === 'lead' ? payload : { runId: this.runId, ...payload });
    this.entries = [];
    this.queue = [];
    this.deferred = [];
    this.searching = true;
    this.wake = null;
    // found: podcasts in this search; newLeads: saved for the first time;
    // duplicates: already saved (or the same podcast twice); rejected: results
    // that are not podcasts or could not be saved.
    this.stats = { found: 0, done: 0, withEmail: 0, noEmail: 0, failed: 0, newLeads: 0, duplicates: 0, rejected: 0, saved: 0 };
    this.seq = 0;
    this.searchId = null;
    // A keyword search keeps only podcasts about its keyword (a pasted link
    // or a retry keeps what it names).
    this.terms = seed || platformOfUrl(this.query) ? [] : keywordTerms(this.query);
  }

  status(state, message) {
    this.emit('status', { state, searchId: this.searchId, keyword: this.keyword, ...this.stats, message });
  }

  async run() {
    const link = this.seed ? null : platformOfUrl(this.query);
    if (!this.seed) {
      try {
        this.searchId = this.store.startSearch({ kind: 'podcast', keyword: this.query, platforms: link ? [link] : this.platforms });
      } catch {}
    }
    this.status('running', this.seed ? `Checking ${this.seed.length} podcast${this.seed.length === 1 ? '' : 's'} again` : link ? 'Looking up the link' : `Searching ${this.platforms.map((p) => PLATFORMS[p].label).join(', ')}`);
    const workers = Array.from({ length: this.concurrency }, () => this.worker());
    try {
      if (this.seed) this.seed.forEach((p) => this.add(p));
      else if (link) await this.lookUp(link);
      else await Promise.all(this.platforms.map((p) => this.searchPlatform(p)));
      // Podcasts from platforms without feeds: their feed by title.
      for (const e of this.deferred) {
        if (this.signal?.aborted) break;
        await this.resolveByTitle(e);
      }
    } finally {
      // Stopped before their feed was looked for: saved as they are.
      for (const e of this.deferred) if (e.state === 'queued' && !e.leadId) this.savePending(e);
      this.searching = false;
      this.poke();
    }
    await Promise.all(workers);
    for (const e of this.entries) if (e.state === 'queued') this.update(e, { state: 'stopped' });
    const s = this.stats;
    const state = this.signal?.aborted ? 'stopped' : 'done';
    const summary = `${s.found} podcast${s.found === 1 ? '' : 's'} found, ${s.withEmail} with an email`;
    if (this.searchId) {
      try {
        this.store.finishSearch(this.searchId, state, s);
      } catch {}
    }
    this.status(state, state === 'stopped' ? `Stopped: ${summary} so far` : s.found ? `Done: ${summary}` : this.seed ? 'Nothing to check' : 'No podcasts found');
    return { state, searchId: this.searchId, ...s };
  }

  async lookUp(platform) {
    if (platform === 'unknown') {
      this.emit('platform', { id: 'link', state: 'failed', message: 'Only web addresses (http or https) can be looked up.' });
      return;
    }
    if (PLATFORMS[platform].browser && !this.adapters[platform].link) {
      const url = this.adapters[platform].pageUrl(this.query);
      if (!url) {
        this.emit('platform', { id: platform, state: 'failed', message: `Only ${PLATFORMS[platform].label} podcast (show) links can be opened.` });
        return;
      }
      return this.openPage(platform, url, 'link');
    }
    this.emit('platform', { id: platform, state: 'searching', message: platform === 'website' ? 'Reading the website' : 'Looking up the link' });
    try {
      const found = await this.adapters[platform].link(this.query, this.ctx(platform));
      found.forEach((p) => this.add(this.extraLinks ? { ...p, extraLinks: this.extraLinks } : p));
      this.emit('platform', { id: platform, state: 'done', count: found.length, message: 'Link found' });
    } catch (err) {
      if (this.signal?.aborted) return;
      this.emit('platform', { id: platform, state: { needs_key: 'needs_key', not_permitted: 'not_permitted' }[err.code] || 'failed', message: err.message });
    }
  }

  // A browser platform's page, opened in Chrome for the user.
  async openPage(id, url, what) {
    const label = PLATFORMS[id].label;
    if (!this.openInBrowser) {
      this.emit('platform', { id, state: 'failed', message: `${label} opens in Chrome, which is not available here.` });
      return;
    }
    this.emit('platform', { id, state: 'searching', message: `Opening ${label} in Chrome` });
    try {
      const at = (await this.openInBrowser(url, this.signal, id)) || {};
      if (at.status >= 400) throw new Error(`${label} answered HTTP ${at.status}`);
      this.emit('platform', {
        id,
        state: 'opened',
        url,
        loadedUrl: at.url || url,
        message:
          what === 'link'
            ? `${label} page opened in Chrome. Lead Finder does not read ${label}: open the podcast’s website from there (or paste it here) to find its email.`
            : `${label} search opened in Chrome. Lead Finder does not read ${label}: open a podcast${id === 'amazon' ? '' : '’s website'} from there and it is added here with its email.`,
      });
    } catch (err) {
      if (this.signal?.aborted) return;
      this.emit('platform', { id, state: 'failed', message: `${label} could not be opened in Chrome: ${err.message}` });
    }
  }

  ctx(platform) {
    return { creds: this.creds[platform] || null, fetchImpl: this.fetchImpl, signal: this.signal, limit: this.limit, allow: this.allow };
  }

  async searchPlatform(id) {
    const def = PLATFORMS[id];
    if (def.linksOnly) {
      this.emit('platform', { id, state: 'links_only', message: `${def.label} has no public podcast search. Paste an ${def.label} podcast link instead.` });
      return;
    }
    if (def.browser) return this.openPage(id, this.adapters[id].searchUrl(this.query), 'search');
    if (def.keys.length && !this.creds[id]) {
      this.emit('platform', { id, state: 'needs_key', message: `${def.label} needs an API key. Add it in Settings.` });
      return;
    }
    this.emit('platform', { id, state: 'searching', message: 'Searching' });
    try {
      const found = await this.adapters[id].search(this.query, this.ctx(id));
      if (this.signal?.aborted) return;
      const rejected = found.rejected || 0;
      this.stats.rejected += rejected;
      // Its place in the platform's results (best match first).
      found.forEach((p, i) => this.add({ ...p, rank: i + 1 }));
      const message = found.length ? `${found.length} found` : rejected ? `No podcasts: ${rejected} result${rejected === 1 ? ' was' : 's were'} not podcasts` : `${PLATFORMS[id].label} has no podcasts for this search`;
      this.emit('platform', { id, state: 'done', count: found.length, rejected, message });
    } catch (err) {
      if (this.signal?.aborted) return;
      this.emit('platform', { id, state: err.code === 'auth' ? 'needs_key' : 'failed', message: err.message });
    }
  }

  // The podcast already found that p is, if any.
  match(p) {
    const fk = feedKey(p.feedUrl);
    const tk = titleKey(p.title);
    return this.entries.find(
      (e) =>
        e.state !== 'merged' &&
        ((fk && feedKey(e.feedUrl) === fk) || (p.appleId && e.appleId === p.appleId) || (tk && e.titleKey === tk && sameHost(e.host, p.host))),
    );
  }

  add(p) {
    if (this.signal?.aborted) return;
    if (!String(p.title || '').trim()) {
      this.stats.rejected++;
      return;
    }
    const same = this.match(p);
    if (same) {
      this.stats.duplicates++;
      return this.merge(same, p);
    }
    // Not about the keyword by its name, publisher, genre or listing: its
    // feed's own description decides (read once, before it is saved).
    const quick = relevant([p.title, p.host, p.genre, p.description].join(' '), this.terms);
    const e = {
      key: `${this.runId}:${++this.seq}`,
      verify: !quick && Boolean(p.feedUrl),
      ...p,
      titleKey: titleKey(p.title),
      platforms: p.platforms ? [...p.platforms] : [p.platform],
      links: { ...(p.links || { [p.platform]: p.url }), ...(p.extraLinks || {}) },
      platformLabel: PLATFORMS[p.platform]?.label || p.platformLabel || '',
      state: 'queued',
    };
    for (const k of Object.keys(e.links)) if (!e.platforms.includes(k)) e.platforms.push(k);
    if (!quick && !e.verify) return this.reject(e, 'not about the keyword');
    this.entries.push(e);
    this.stats.found++;
    if (e.verify) {
      // Checked by a worker (its feed), then saved or rejected.
      this.update(e, { step: 'Checking it is about the keyword' });
      this.enqueue(e);
      return;
    }
    // A podcast whose feed is still to be found by title may turn out to be
    // one already found (merged then): it is saved once that is known.
    const later = !(e.feedUrl || e.appleId || e.platform === 'website' || e.leadId);
    // Saved at once otherwise: a podcast is never lost because its emails
    // were not looked for yet (Stop, an error).
    if (!later && !this.savePending(e)) return;
    this.update(e, {});
    // A website is checked as it is: a title alone (no host to compare) could
    // match a different podcast of the same name.
    if (e.feedUrl || e.appleId || e.platform === 'website') this.enqueue(e);
    else this.deferred.push(e);
  }

  // A result that is not kept: counted, said why, never saved.
  reject(e, reason) {
    this.stats.rejected++;
    this.emit('item', { key: e.key, state: 'rejected', title: e.title, skipped: 'irrelevant', reason });
  }

  // Saves a podcast just found (email discovery pending). False when it is
  // not saved (deleted before, or invalid): it is then not checked either.
  savePending(e) {
    if (e.leadId) return true; // a saved lead checked again
    let saved = null;
    try {
      saved = this.store.savePodcastLead({
        id: e.appleId || '',
        title: e.title,
        host: e.host,
        description: e.description,
        appleUrl: e.links.apple || e.appleUrl || '',
        rssUrl: e.feedUrl || '',
        links: e.links,
        artwork: e.artwork,
        pending: true,
        searchId: this.searchId,
        platform: e.platform,
        sourceUrl: e.url,
        rank: e.rank,
        keyword: this.keyword,
        categoryId: this.categoryId,
      });
    } catch (err) {
      saved = { lead: null, skipped: 'invalid', error: err.message };
    }
    if (!saved.lead) {
      e.state = 'rejected';
      e.skipped = saved.skipped;
      this.stats.found--;
      this.stats.rejected++;
      this.emit('item', { key: e.key, state: 'rejected', title: e.title, skipped: saved.skipped, error: saved.error || null });
      return false;
    }
    e.leadId = saved.lead.id;
    e.isNewLead = saved.isNewLead;
    if (saved.isNewLead) this.stats.newLeads++;
    else this.stats.duplicates++;
    this.stats.saved++;
    this.emit('lead', saved.lead);
    return true;
  }

  // Another platform's listing of a podcast already found: its link and any
  // details still missing.
  merge(e, p) {
    if (!e.platforms.includes(p.platform)) e.platforms.push(p.platform);
    if (p.url && !e.links[p.platform]) e.links[p.platform] = p.url;
    for (const k of ['feedUrl', 'feedFrom', 'appleId', 'appleUrl', 'website', 'artwork', 'host', 'youtubeChannelId', 'store']) if (!e[k] && p[k]) e[k] = p[k];
    if (!e.description && p.description) {
      e.description = p.description;
      e.platformLabel = PLATFORMS[p.platform].label;
    }
    if (e.titleFromLink && !p.titleFromLink) Object.assign(e, { title: p.title, titleFromLink: false });
    this.update(e, {});
    // Found before its feed was known: it can start now.
    const i = this.deferred.indexOf(e);
    if (i >= 0 && (e.feedUrl || e.appleId)) {
      this.deferred.splice(i, 1);
      this.enqueue(e);
    }
    // Already saved: the lead gets the new platform link.
    if (e.state === 'done' && e.result) this.save(e);
    else if (e.leadId) this.store.savePodcastLead({ id: e.appleId || '', title: e.title, appleUrl: e.links.apple || '', rssUrl: e.feedUrl || '', links: e.links, pending: true });
  }

  async resolveByTitle(e) {
    if (e.state !== 'queued') return;
    this.update(e, { step: 'Finding its RSS feed by title' });
    let hit = null;
    try {
      hit = await feedByTitle(e, { fetchImpl: this.fetchImpl, signal: this.signal });
    } catch (err) {
      if (this.signal?.aborted) return;
    }
    if (hit) {
      // The same podcast was already found on Apple Podcasts or Podcast Index.
      const other = this.entries.find((x) => x !== e && x.state !== 'merged' && ((hit.appleId && x.appleId === hit.appleId) || feedKey(x.feedUrl) === feedKey(hit.feedUrl)));
      if (other) {
        e.state = 'merged';
        this.stats.found--;
        this.stats.duplicates++;
        this.emit('item', { key: e.key, state: 'merged', mergedInto: other.key });
        this.merge(other, { ...e, feedUrl: '', appleId: '' });
        return;
      }
      // A name read from a link address: the listing's own name and host.
      if (e.titleFromLink && hit.match) Object.assign(e, { title: hit.match.title, host: e.host || hit.match.host, artwork: e.artwork || hit.match.artwork || '', titleFromLink: false });
      Object.assign(e, { feedUrl: hit.feedUrl, feedFrom: hit.from, appleId: e.appleId || hit.appleId || '', appleUrl: e.appleUrl || hit.appleUrl || '', website: e.website || hit.website || '' });
      if (hit.match?.platform === 'apple' && hit.appleUrl) {
        e.links.apple = hit.appleUrl;
        if (!e.platforms.includes('apple')) e.platforms.push('apple');
      }
    }
    this.update(e, { step: '' });
    if (this.savePending(e)) this.enqueue(e);
  }

  enqueue(e) {
    this.queue.push(e);
    this.poke();
  }

  poke() {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  async worker() {
    for (;;) {
      if (this.signal?.aborted) return;
      const e = this.queue.shift();
      if (!e) {
        if (!this.searching) return;
        await new Promise((r) => {
          const prev = this.wake;
          this.wake = () => {
            prev?.();
            r();
          };
        });
        continue;
      }
      await this.process(e);
    }
  }

  async process(e) {
    if (e.state !== 'queued') return;
    if (e.verify) {
      e.verify = false;
      const got = this.feedCache?.get(e.feedUrl) || (await fetchFeed(e.feedUrl, { fetchImpl: this.fetchImpl, signal: this.signal }).catch(() => ({ ok: false })));
      if (this.signal?.aborted) return;
      if (got.ok) this.feedCache?.set(e.feedUrl, got);
      const f = got.ok ? parseFeed(got.xml) : null;
      // Unreadable feed: kept (its check reports the feed), not judged.
      if (f?.ok && !relevant([e.title, e.host, e.genre, textOf(f.description), f.items.slice(0, 5).map((i) => i.title).join(' ')].join(' '), this.terms)) {
        e.state = 'rejected';
        this.stats.found--;
        return this.reject(e, 'not about the keyword');
      }
      if (!this.savePending(e)) return;
    }
    this.update(e, { state: 'running', step: 'Starting' });
    let r;
    try {
      r = await processPodcast(e, {
        fetchImpl: this.fetchImpl,
        signal: this.signal,
        country: this.country,
        feedCache: this.feedCache,
        findContacts: this.findContacts,
        allow: this.allow,
        step: (step) => this.update(e, { step }),
      });
    } catch (err) {
      if (this.signal?.aborted) {
        this.update(e, { state: 'stopped', step: '' });
        return;
      }
      r = { title: e.title, host: e.host, rssUrl: '', rssStatus: 'failed', emails: [], email: '', status: 'failed', statusText: `Not checked: ${err?.message || 'unexpected error'}`, failed: [String(err?.message || err)], checked: [] };
      r.discovery = `email: ${r.statusText}`;
    }
    e.result = r;
    this.stats.done++;
    if (r.email) this.stats.withEmail++;
    else if (r.status === 'failed') this.stats.failed++;
    else this.stats.noEmail++;
    e.state = 'done';
    this.save(e);
    this.status('running', `${this.stats.done} of ${this.stats.found} checked · ${this.stats.withEmail} with an email`);
  }

  save(e) {
    let saved = null;
    try {
      saved = this.store.savePodcastLead({
        ...e.result,
        id: e.appleId || '',
        appleUrl: e.links.apple || e.appleUrl || '',
        title: e.result.title || e.title,
        host: e.result.host || e.host,
        links: e.links,
        platforms: e.platforms,
        artwork: e.artwork,
        keyword: this.keyword,
        categoryId: this.categoryId,
      });
    } catch (err) {
      e.saveError = err.message;
    }
    if (saved?.lead) {
      e.leadId = saved.lead.id;
      this.emit('lead', saved.lead);
    }
    this.update(e, { step: '', skipped: saved?.skipped || null });
  }

  update(e, patch) {
    Object.assign(e, patch);
    this.emit('item', {
      key: e.key,
      state: e.state,
      step: e.step || '',
      title: e.title,
      host: e.host,
      artwork: e.artwork || '',
      description: e.description || '',
      website: e.website || '',
      feedUrl: e.feedUrl || '',
      platforms: [...e.platforms],
      links: { ...e.links },
      result: e.result || null,
      leadId: e.leadId ?? null,
      searchId: this.searchId,
      isNewLead: Boolean(e.isNewLead),
      skipped: e.skipped || null,
      saveError: e.saveError || null,
    });
  }
}

module.exports = { PodcastSearch };
