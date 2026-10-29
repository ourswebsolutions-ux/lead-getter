'use strict';

// The LinkedIn part of a search: companies that need what LinkedIn's search
// describes ("video editor"), with their public business contact details.
// It runs in one page (a window of its own) beside Google Maps and Facebook.
//
// Discovery modes (each can be switched off):
//   Jobs:       every page of job results for the search, until LinkedIn
//               shows no more; the target is the company behind each job.
//   Posts:      posts about hiring or projects for the search, scrolled for
//               more; the company (or published contact) behind each one.
//   Companies:  LinkedIn's company search, kept only when the company's own
//               description or industry matches (not just its name).
//
// Each company, once (reused for every job or post that names it):
//   1. LinkedIn: its company page (website, phone, email in its description)
//   2. Google Maps, when a phone or email is still missing (exact name and
//      city, or same website): phone, website, address
//   3. its website(s) (LinkedIn's, and Google Maps' when different), when a
//      phone or email is still missing: home, Contact, About, footer and
//      similar pages (a direct request, or in the page when the site
//      refuses one)
// and saved at once with whatever was found: both are looked for until
// every source was checked; nothing is made up. For each contact the lead says
// whether it was found (and where), is not published anywhere that was
// checked, or could not be checked (a page that failed to load).
//
// Built on SearchSession (Stop, pacing, network retries, Chrome reconnects
// as in the other searches). A login page, security check or limit stops
// the LinkedIn pages only: companies already found are still completed from
// their websites and Google Maps, and run() reports it.

const liDefault = require('./linkedin');
const contactsDefault = require('./website-contacts');
const { normalizePhone, countryFromAddress } = require('../database/phone');
const { SearchSession, StopRequested, FatalSearchError, DEFAULT_PACING } = require('./search-session');

const LI_PACING = {
  liPage: [1500, 3000], // pause after each LinkedIn page
  liMaxPages: 100, // result pages per mode, at most (a safety stop; an empty page ends sooner)
  liMaxPosts: 60, // posts read per search
  liScrolls: 4, // scrolls of one results page for more
  liMaps: true, // Google Maps fallback for missing contact details
};

const UNAVAILABLE = {
  login: 'LinkedIn asked to log in. Log in to LinkedIn in this Chrome profile to search jobs, posts and company pages.',
  checkpoint: 'LinkedIn is showing a security check. Complete it yourself in Chrome; Lead Finder does not answer it.',
  blocked: 'LinkedIn says a limit was reached for your account (or unusual activity). Lead Finder stopped reading LinkedIn; try again later.',
};

const HIRING = /\b(hiring|we('| a)re looking for|looking for|need(ed)?|require[ds]?|seeking|vacanc|job opening|open position|project|freelanc|outsourc|contract(or)?|agency|website|web ?app|software|develop(er|ment)|build(ing)? (a|an|our)|apply|dm me|send (your )?(cv|portfolio))\b/i;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;

// Company names compared without legal suffixes and punctuation.
const LEGAL = /\b(pvt|private|ltd|limited|llc|l\.l\.c|inc|incorporated|co|company|corp|corporation|plc|gmbh|llp|smc|the|pk)\b/g;
function nameKey(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(LEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The words of a search that decide relevance, as prefixes ("video
// editor" -> vide, edit), so "editing" and "editors" match too.
const STOP = new Set(['in', 'at', 'for', 'the', 'and', 'or', 'of', 'to', 'with', 'near', 'from', 'job', 'jobs', 'remote', 'hiring', 'needed', 'wanted', 'senior', 'junior', 'jr', 'sr', 'lead', 'full', 'time', 'part']);
function searchTerms(q) {
  return [...new Set(String(q || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.slice(0, Math.max(4, w.length - 2))))];
}
// How much of the search a text mentions (0..1).
function relevance(text, terms) {
  if (!terms.length) return 1;
  const t = String(text || '').toLowerCase();
  return terms.filter((w) => t.includes(w)).length / terms.length;
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

// The city part of a LinkedIn location ("Lahore, Punjab, Pakistan").
const cityOf = (loc) => nameKey(String(loc || '').split(',')[0]);

class LinkedInUnavailable extends FatalSearchError {
  constructor(kind) {
    super(UNAVAILABLE[kind] || UNAVAILABLE.blocked);
    this.kind = kind;
  }
}

class LinkedInSession extends SearchSession {
  // country: how local numbers are read when a company's location doesn't
  // say; modes: { jobs, posts, companies }; diagnose(record): optional
  // summary per company (counts and reasons).
  constructor({ country = null, linkedin = liDefault, contacts = contactsDefault, fetchImpl, modes = { jobs: true, posts: true, companies: true }, pacing = {}, diagnose = null, ...opts }) {
    super({ ...opts, pacing: { ...DEFAULT_PACING, ...LI_PACING, ...pacing } });
    this.li = linkedin;
    this.contacts = contacts;
    this.fetchImpl = fetchImpl;
    this.country = country;
    this.diagnose = diagnose;
    this.modes = { jobs: modes.jobs !== false, posts: modes.posts !== false, companies: modes.companies !== false };
    this.terms = searchTerms(this.keyword);
    this.companies = new Map(); // company page (or name) -> { name, companyUrl, location, sources, state, details }
    this.seenJobs = new Set();
    this.seenPosts = new Set();
    this.seenCompanyResults = new Set();
    this.sites = new Map(); // website -> contacts (each site read once)
    this.blocked = null; // why LinkedIn pages stopped, if they did
    this.done = new Set(); // modes finished (a reconnect continues the others)
    this.jobPages = 0;
    this.stats.linkedin = { pages: 0, jobs: 0, posts: 0, companies: 0, done: 0, notRelevant: 0, websites: 0, maps: 0, withPhone: 0, withEmail: 0, leads: 0, newLeads: 0, duplicates: 0, failures: 0 };
  }

  status(state, message, phase = 'search') {
    this.emit('status', { state, message, phase, step: this.step, keyword: this.keyword, source: 'linkedin', ...this.stats });
  }

  // { state: 'done' | 'stopped' | 'unavailable' | 'error', kind?, message }.
  async run() {
    try {
      await this.search();
      if (this.blocked && !this.stats.linkedin.leads) throw new LinkedInUnavailable(this.blocked);
      return { state: 'done', message: this.summary() };
    } catch (err) {
      if (err instanceof StopRequested) return { state: 'stopped', message: 'Search stopped' };
      if (err instanceof LinkedInUnavailable) return { state: 'unavailable', kind: err.kind, message: `${err.message} ${this.summary()}` };
      const detail = String(err?.message || err).split('\n')[0];
      return { state: 'error', message: `The LinkedIn search did not finish (${detail}). ${this.summary()}` };
    }
  }

  summary() {
    const s = this.stats.linkedin;
    const n = (v, one, many = `${one}s`) => `${v} ${v === 1 ? one : many}`;
    const parts = [];
    if (this.modes.jobs) parts.push(`${n(s.jobs, 'job')} on ${n(s.pages, 'results page')}`);
    if (this.modes.posts) parts.push(n(s.posts, 'post'));
    parts.push(`${n(s.done, 'company', 'companies')} checked`, n(s.newLeads, 'new lead'));
    if (s.duplicates) parts.push(`${s.duplicates} already saved`);
    if (s.notRelevant) parts.push(`${s.notRelevant} not relevant`);
    const contact = `${s.withPhone} with a phone, ${s.withEmail} with an email`;
    return `${parts.join(', ')} (${contact}).${this.blocked ? ` ${UNAVAILABLE[this.blocked]}` : ''}`;
  }

  progress(stage, note = '') {
    const s = this.stats.linkedin;
    this.status('running', `LinkedIn ${stage}: page ${s.pages} · ${s.jobs} jobs · ${s.posts} posts · ${s.done}/${s.companies} companies · ${s.newLeads} new leads (${s.withPhone} phone, ${s.withEmail} email)${note ? ` · ${note}` : ''}`);
  }

  // A LinkedIn page; a login page, check or limit ends the LinkedIn pages
  // (not the search). Returns the result, or null when LinkedIn is closed.
  async liPage(page, fn) {
    if (this.blocked) return null;
    const r = await this.netOp(() => fn(), page);
    if (UNAVAILABLE[r.mode]) {
      if (!this.blocked) this.status('running', `LinkedIn: ${UNAVAILABLE[r.mode]} Continuing with the companies already found.`);
      this.blocked = r.mode;
      return null;
    }
    await this.pause(this.pacing.liPage);
    return r;
  }

  async searchOnce() {
    const page = await this.op(() => this.pages.linkedin());
    for (const mode of ['jobs', 'posts', 'companies']) {
      if (!this.modes[mode] || this.done.has(mode)) continue;
      if (mode === 'jobs') await this.runJobs(page);
      else if (mode === 'posts') await this.runPosts(page);
      else await this.runCompanies(page);
      this.done.add(mode);
    }
    // Companies found before LinkedIn closed its pages are still completed.
    for (const c of this.companies.values()) if (c.state === 'queued') await this.completeCompany(page, c);
  }

  // --- Jobs: every results page --------------------------------------------------------

  // Page after page (?start=<jobs listed so far>), each page's jobs and their
  // companies completed before the next page is opened, until a page brings
  // no new jobs (or the limit of pages).
  async runJobs(page) {
    this.setStep('searching');
    this.jobOffset ||= 0;
    while (this.jobPages < this.pacing.liMaxPages && !this.blocked) {
      const start = this.jobOffset;
      this.progress('jobs', `results page ${this.jobPages + 1} for "${this.keyword}"`);
      // LinkedIn's public results pages when available (?start=<offset>),
      // else its jobs search page scrolled for more.
      const r = await this.liPage(page, () => (this.li.jobsPage ? this.li.jobsPage(page, this.keyword, start) : this.li.searchJobs(page, this.keyword)));
      if (!r) return;
      if (r.mode === 'empty') return this.progress('jobs', start ? `no more job results after ${this.jobPages} pages` : 'no jobs found');
      if (r.mode !== 'ok') return this.progress('jobs', `results page ${this.jobPages + 1} did not load (${r.detail || r.mode})`);
      const cards = new Map(r.jobs.map((j) => [j.jobId, j]));
      if (!this.li.jobsPage) {
        for (let i = 0; i < this.pacing.liScrolls; i++) {
          const before = cards.size;
          for (const j of await this.op(() => this.li.moreJobs(page))) cards.set(j.jobId, j);
          if (cards.size === before) break;
        }
      }
      this.jobOffset += r.jobs.length;
      const fresh = [...cards.values()].filter((c) => c.jobId && !this.seenJobs.has(c.jobId));
      if (!fresh.length) return this.progress('jobs', `no more job results after ${this.jobPages} pages`);
      this.jobPages++;
      this.stats.linkedin.pages = this.jobPages;
      for (const c of fresh) this.seenJobs.add(c.jobId);
      this.stats.linkedin.jobs += fresh.length;
      this.setStep('analyzing');
      for (const card of fresh) await this.processJob(page, card);
      if (!this.li.jobsPage) return;
    }
  }

  // A job: its company from the listing (the job's own page only when the
  // listing has no company link, or its title doesn't show it is about the
  // search), then that company completed and saved.
  async processJob(page, card) {
    const url = this.li.jobUrl(card.jobId);
    this.stats.processed++;
    // A job an earlier search already saved is not read again.
    if (this.store.hasLinkedInSource(url)) {
      this.stats.linkedin.duplicates++;
      return;
    }
    let job = { ...card, description: '', links: [] };
    const titleFits = relevance(card.title, this.terms) >= 0.5;
    if (!card.companyHref || !titleFits) {
      const j = await this.liPage(page, () => this.li.readJob(page, card.jobId));
      if (j?.mode === 'ok') job = { ...card, ...Object.fromEntries(Object.entries(j.job).filter(([, v]) => v)) };
      if (!titleFits && relevance(job.title, this.terms) < 0.5 && relevance(job.description, this.terms) < 0.67) {
        this.stats.linkedin.notRelevant++;
        return this.progress('jobs', `not relevant: ${job.title || 'a job'}`);
      }
    }
    const companyUrl = this.li.cleanCompanyUrl(job.companyHref || card.companyHref);
    if (!companyUrl && !job.company) return;
    await this.addCompany(page, { name: job.company || card.company, companyUrl, location: job.location || card.location }, { kind: 'job', url, title: job.title || card.title, text: job.description, links: job.links });
  }

  // --- Posts ---------------------------------------------------------------------------

  async runPosts(page) {
    this.setStep('searching');
    this.progress('posts', `searching posts for "${this.keyword}"`);
    const r = await this.liPage(page, () => this.li.searchPosts(page, this.keyword));
    if (!r || r.mode !== 'ok') return r && this.progress('posts', r.mode === 'empty' ? 'no posts found' : `posts did not load (${r.detail || r.mode})`);
    // All posts first (scrolling for more), then their companies.
    const found = new Map();
    const take = (posts) => {
      for (const p of posts) {
        const key = p.urn || p.key;
        if (key && !this.seenPosts.has(key) && !found.has(key) && found.size < this.pacing.liMaxPosts) found.set(key, p);
      }
    };
    take(r.posts);
    for (let i = 0; i < this.pacing.liScrolls && found.size < this.pacing.liMaxPosts && this.li.morePosts; i++) {
      const before = found.size;
      take(await this.op(() => this.li.morePosts(page)));
      this.progress('posts', `${found.size} posts loaded`);
      if (found.size === before) break;
    }
    this.setStep('analyzing');
    for (const [key, post] of found) {
      this.seenPosts.add(key);
      this.stats.processed++;
      this.stats.linkedin.posts++;
      await this.processPost(page, post);
    }
  }

  // A post counts when it is about the search and a need (hiring, a project),
  // and names a company or publishes business contact details.
  async processPost(page, post) {
    if (!HIRING.test(post.text) || relevance(post.text, this.terms) < 0.5) {
      this.stats.linkedin.notRelevant++;
      return;
    }
    const url = post.urn ? this.li.postUrl(post.urn) : `${this.li.postsSearchUrl(this.keyword)}#${post.key}`;
    if (this.store.hasLinkedInSource(url)) {
      this.stats.linkedin.duplicates++;
      return;
    }
    const companyUrl = this.li.cleanCompanyUrl(post.authorHref) || post.companyHrefs.map((h) => this.li.cleanCompanyUrl(h)).find(Boolean) || '';
    const isCompanyAuthor = Boolean(this.li.cleanCompanyUrl(post.authorHref));
    const published = this.contacts.contactsFromHtml(`<div>${escapeHtml(post.text)}</div>${post.links.map((h) => `<a href="${escapeHtml(h)}"></a>`).join('')}`, 'https://www.linkedin.com/', { country: this.country });
    if (!companyUrl && !published.emails.length && !published.phones.length) {
      this.stats.linkedin.notRelevant++;
      return;
    }
    // No company page: the post's own contact details, credited to its author.
    await this.addCompany(
      page,
      { name: isCompanyAuthor || !companyUrl ? post.author || 'LinkedIn post' : '', companyUrl, location: '' },
      { kind: 'post', url, title: '', text: post.text, author: post.author, emails: published.emails, phones: published.phones },
    );
  }

  // --- Companies -----------------------------------------------------------------------

  async runCompanies(page) {
    this.setStep('searching');
    for (let n = 1; n <= this.pacing.liMaxPages && !this.blocked; n++) {
      this.progress('companies', `company results page ${n} for "${this.keyword}"`);
      const r = await this.liPage(page, () => this.li.searchCompanies(page, this.keyword, n));
      if (!r || r.mode !== 'ok') {
        if (r && n === 1) this.progress('companies', r.mode === 'empty' ? 'no companies found' : `companies did not load (${r.detail || r.mode})`);
        return;
      }
      const fresh = r.companies.map((c) => ({ ...c, companyUrl: this.li.cleanCompanyUrl(c.href) })).filter((c) => c.companyUrl && !this.seenCompanyResults.has(c.companyUrl));
      if (!fresh.length) return;
      this.setStep('analyzing');
      for (const c of fresh) {
        this.seenCompanyResults.add(c.companyUrl);
        // Relevance is decided on its About page (not its name).
        await this.addCompany(page, { name: c.name, companyUrl: c.companyUrl, location: '' }, { kind: 'company', url: c.companyUrl, text: c.subtitle, needsRelevance: true });
      }
    }
  }

  // --- companies -------------------------------------------------------------------------

  // A company named by a job, post or company search: completed and saved
  // now if new; one already completed only gets this source added (no
  // pages opened again).
  async addCompany(page, { name, companyUrl, location }, source) {
    const key = companyUrl || `name:${nameKey(name)}`;
    if (!companyUrl && !nameKey(name)) return;
    let c = this.companies.get(key);
    if (!c) {
      c = { key, name, companyUrl, location, sources: [], state: 'queued' };
      this.companies.set(key, c);
      this.stats.linkedin.companies++;
    }
    c.name ||= name;
    c.location ||= location;
    c.sources.push(source);
    if (c.state === 'done') return this.saveCompany(c, source);
    if (c.state === 'queued' && !this.blocked) await this.completeCompany(page, c);
  }

  // LinkedIn company page, Google Maps, website; then saved. For each
  // contact: where it was found, or which sources were checked (not
  // published there) and which could not be checked.
  async completeCompany(page, c) {
    if (!c || c.state !== 'queued') return;
    c.state = 'working';
    const checked = []; // sources read successfully
    const failed = []; // sources that could not be read
    let website = '';
    let address = c.location || '';
    let name = c.name;
    let phone = null;
    const emails = [];
    let emailFrom = '';
    const take = (ph, from) => {
      if (!ph) return;
      if (!phone || (phone.status !== 'valid' && ph.status === 'valid')) phone = { ...ph, from };
    };
    const takeEmails = (list, from) => {
      for (const e of list) {
        if (!emails.includes(e)) emails.push(e);
        emailFrom ||= from;
      }
    };
    // Contact details the job or post itself published.
    for (const src of c.sources) {
      takeEmails(src.emails || [], src.kind);
      for (const ph of src.phones || []) take(ph, src.kind);
      if (!website) website = (src.links || []).map((h) => this.li.cleanWebsite(h)).find(Boolean) || '';
    }

    // 1. The company's LinkedIn page.
    let about = '';
    if (c.companyUrl) {
      this.progress('company', `${name || 'a company'}: LinkedIn company page`);
      const r = await this.liPage(page, () => this.li.readCompany(page, c.companyUrl));
      if (r?.mode === 'ok') {
        const info = r.company;
        if (info.name) name = info.name;
        website = this.li.cleanWebsite(info.website) || website;
        address = info.headquarters || address;
        about = `${info.industry || ''}\n${info.overview || ''}`;
        const country = countryFromAddress(address) || this.country;
        for (const raw of [...(info.tels || []).map((t) => t.replace(/^tel:/i, '')), info.phone].filter(Boolean)) {
          const n = normalizePhone(raw.replace(/phone number is.*$/i, ''), { address: country ? `x, ${countryName(country)}` : '' });
          if (n.status === 'valid' || n.status === 'unverified') take({ phone: n.phone, raw: n.raw, status: n.status, country: n.country }, 'LinkedIn');
        }
        takeEmails((info.overview || '').match(EMAIL) || [], 'LinkedIn');
        checked.push('LinkedIn');
      } else failed.push(this.blocked ? `LinkedIn page (${this.blocked})` : 'LinkedIn page did not load');
    }
    // Found only by company search: kept when its own description is about the search.
    if (c.sources.every((s) => s.needsRelevance) && relevance(`${about}\n${c.sources.map((s) => s.text).join('\n')}`, this.terms) === 0) {
      c.state = 'skipped';
      this.stats.linkedin.notRelevant++;
      return this.progress('companies', `not relevant: ${name}`);
    }
    const country = countryFromAddress(address) || this.country;

    const missing = () => !phone || phone.status !== 'valid' || !emails.length;

    // 2. Google Maps, while a phone or email is missing; only an exact match.
    let mapsSite = '';
    if (this.pacing.liMaps && name && missing()) {
      this.progress('maps', `${name}: Google Maps`);
      const m = await this.mapsLookup(page, { name, website, location: address });
      if (m === 'failed') failed.push('Google Maps did not load');
      else if (!m) checked.push('Google Maps (no exact match)');
      else {
        this.stats.linkedin.maps++;
        checked.push('Google Maps');
        take(m.phone, 'Google Maps');
        address ||= m.address;
        mapsSite = m.website || '';
      }
    }

    // 3. The company's website(s), while a phone or email is still missing:
    // home, Contact, About, footer and similar pages.
    const readSite = async (site, label) => {
      this.progress('website', `${name}: ${hostOf(site)}`);
      if (!this.sites.has(site)) {
        this.sites.set(site, await this.readSite(page, site, country));
        this.stats.linkedin.websites++;
      }
      const found = this.sites.get(site);
      if (found.error) return failed.push(`${label} (${found.error})`);
      checked.push(label);
      takeEmails(found.emails, 'website');
      for (const ph of found.phones) take(ph, 'website');
    };
    if (website && missing()) await readSite(website, 'website');
    if (mapsSite && hostOf(mapsSite) !== hostOf(website) && missing()) await readSite(mapsSite, 'website (from Google Maps)');
    website ||= mapsSite;

    const email = emails[0] || '';
    const state = (found, from) => (found ? `found (${from})` : failed.length ? `not found; could not check: ${failed.join(', ')}` : `not published (checked: ${checked.join(', ') || 'nothing to check'})`);
    c.details = {
      name,
      website,
      address,
      phone,
      email,
      contactStatus: { phone: phone ? 'found' : failed.length ? 'failed' : 'unavailable', email: email ? 'found' : failed.length ? 'failed' : 'unavailable' },
      discovery: `phone: ${state(phone, phone?.from)}; email: ${state(email, emailFrom)}; website: ${website ? hostOf(website) : 'none found'}`,
    };
    c.state = 'done';
    this.stats.linkedin.done++;
    // Saved once with its first job or post; every other source is added to the lead.
    const first = c.sources.find((x) => x.kind === 'job') || c.sources.find((x) => x.kind === 'post') || c.sources[0];
    this.saveCompany(c, first, true);
    for (const src of c.sources.filter((x) => x !== first)) this.saveCompany(c, src);
  }

  // Website contacts: a direct request; in the page when the site refuses
  // one (bot protection, 403) or can't be reached that way.
  async readSite(page, website, country) {
    const direct = await this.op(() => this.contacts.findContacts(website, { country, fetchImpl: this.fetchImpl, signal: this.signal }));
    if (!direct.error || !this.contacts.findContactsInPage) return direct;
    const inPage = await this.op(() => this.contacts.findContactsInPage(page, website, { country })).catch((err) => {
      if (err instanceof StopRequested) throw err;
      return null;
    });
    return inPage && !inPage.error ? inPage : direct;
  }

  saveCompany(c, src, primary = false) {
    const s = this.stats.linkedin;
    const d = c.details;
    const jobSrc = c.sources.find((x) => x.kind === 'job');
    const postSrc = c.sources.find((x) => x.kind === 'post');
    let saved;
    try {
      saved = this.store.saveLinkedInLead({
        companyName: d.name,
        companyUrl: c.companyUrl || null,
        website: d.website || null,
        email: d.email || null,
        phone: d.phone ? { phone: d.phone.phone, raw: d.phone.raw, status: d.phone.status, country: d.phone.country } : null,
        address: d.address || null,
        jobUrl: jobSrc?.url || null,
        jobTitle: jobSrc?.title || null,
        postUrl: postSrc?.url || null,
        sourceUrl: src?.url || c.companyUrl || null,
        sourceKind: src?.kind || 'company',
        text: src?.text || '',
        discovery: d.discovery,
        keyword: this.keyword,
        categoryId: this.categoryId,
      });
    } catch (err) {
      if (err?.code === 'invalid_lead') {
        s.failures++;
        return;
      }
      throw new FatalSearchError(`Could not save to the local database (${String(err?.message || err).split('\n')[0]}).`);
    }
    if (!saved.lead) return;
    if (primary) {
      if (d.phone) s.withPhone++;
      if (d.email) s.withEmail++;
      this.stats.leads++;
      s.leads++;
      if (saved.isNewLead) {
        this.stats.newLeads++;
        s.newLeads++;
      } else s.duplicates++;
      try {
        this.diagnose?.({ source: 'linkedin', company: Boolean(c.companyUrl), sources: c.sources.map((x) => x.kind), phone: d.contactStatus.phone, email: d.contactStatus.email, website: Boolean(d.website), notes: d.discovery.replace(/[^;]*@[^;]*/g, '') });
      } catch {}
      this.progress('company', saved.isNewLead ? `lead saved: ${d.name}` : `${d.name} is already a lead`);
    }
    this.emit('lead', saved.lead);
  }

  // Google Maps for one company: { phone, website, address } when a result
  // is clearly the same business (same website, or same name and same city),
  // null when there is none, 'failed' when Maps did not load.
  async mapsLookup(page, { name, website, location }) {
    const city = cityOf(location);
    const query = [name, String(location || '').split(',')[0]].filter(Boolean).join(' ');
    const r = await this.netOp(async () => {
      const go = () => page.goto(this.maps.searchUrl(query), { waitUntil: 'domcontentloaded', timeout: 45_000 });
      // An earlier page's navigation can still be finishing: once more.
      await go().catch((err) => (/interrupted by another navigation/i.test(String(err?.message)) ? page.waitForTimeout(1000).then(go) : Promise.reject(err)));
      return this.maps.waitForResults(page, null, 20_000);
    }, page).catch((err) => {
      if (err instanceof StopRequested || err instanceof FatalSearchError) throw err;
      return { mode: 'failed' };
    });
    const candidates = [];
    if (r.mode === 'single') candidates.push(null);
    else if (r.mode === 'list') {
      const links = await this.op(() => this.maps.collectLinks(page));
      candidates.push(...links.filter((l) => nameKey(l.name) === nameKey(name)).slice(0, 2));
    } else return r.mode === 'empty' ? null : 'failed';
    for (const link of candidates) {
      if (link && !(await this.op(() => this.maps.gotoListing(page, link.url)).catch(() => false))) continue;
      const d = await this.op(() => this.maps.extractDetails(page)).catch(() => null);
      if (!d || d.closed) continue;
      const sameSite = website && d.website && hostOf(d.website) === hostOf(website);
      const sameName = nameKey(d.name) === nameKey(name);
      const sameCity = !city || nameKey(d.address).includes(city);
      if (!sameSite && !(sameName && sameCity)) continue;
      const n = normalizePhone(d.phoneTel || d.phoneText, { address: d.address });
      return {
        phone: n.status === 'valid' || n.status === 'unverified' ? { phone: n.phone, raw: n.raw, status: n.status, country: n.country } : null,
        website: this.li.cleanWebsite(d.website),
        address: d.address,
      };
    }
    return null;
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// English name of a country code (for reading local numbers with it).
function countryName(code) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code);
  } catch {
    return '';
  }
}

module.exports = { LinkedInSession, LinkedInUnavailable, LI_PACING, nameKey, searchTerms, relevance };
