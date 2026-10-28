'use strict';

// The LinkedIn part of a search: companies that need what the keyword
// describes ("Full Stack Developer"), with their public business contact
// details. It runs in a window of its own beside Google Maps and Facebook.
//
//   1. Jobs:       LinkedIn job listings for the keyword; the target is the
//                  company that posted each one (not job seekers).
//   2. Company:    each company's LinkedIn About page: website, phone,
//                  headquarters.
//      Website:    the company's own site (and its contact page) for a
//                  business email and phone number.
//      Maps:       still no phone or email: Google Maps for the company name
//                  and location, accepted only when it is clearly the same
//                  business (same website, or same name and city).
//   3. Posts:      LinkedIn posts about hiring, projects or outsourcing for
//                  the keyword; the company behind each one.
//   4. Companies:  too few companies from jobs: LinkedIn's company search.
//
// Built on SearchSession (Stop, pacing, network retries, Chrome reconnects
// as in the other searches). A login page, security check or limit only
// stops the LinkedIn pages: companies already found are still completed
// from their websites and Google Maps, and run() reports it.

const liDefault = require('./linkedin');
const contactsDefault = require('./website-contacts');
const { normalizePhone, countryFromAddress } = require('../database/phone');
const { SearchSession, StopRequested, FatalSearchError, DEFAULT_PACING } = require('./search-session');

const LI_PACING = {
  liPage: [2500, 5000], // pause between LinkedIn pages
  liMaxJobs: 20, // job listings read per search
  liMaxCompanies: 25, // companies completed per search
  liMaxPosts: 20, // posts read per search
  liMinCompanies: 5, // fewer than this from jobs and posts: company search too
  liScrolls: 3, // scrolls of the jobs list for more listings
  liMaps: true, // Google Maps fallback for missing contact details
};

const UNAVAILABLE = {
  login: 'LinkedIn asked to log in. Log in to LinkedIn in this Chrome profile to search jobs, posts and company pages.',
  checkpoint: 'LinkedIn is showing a security check. Complete it yourself in Chrome; Lead Finder does not answer it.',
  blocked: 'LinkedIn says a limit was reached for your account (or unusual activity). Lead Finder stopped reading LinkedIn; try again later.',
};

const HIRING = /\b(hiring|we('| a)re looking for|looking for|need(ed)?|require[ds]?|seeking|vacanc|job opening|open position|project|freelanc|outsourc|contract(or)?|agency|website|web ?app|software|develop(er|ment)|build(ing)? (a|an|our))\b/i;

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
  // say; diagnose(record): optional summary per stage (counts and reasons).
  constructor({ country = null, linkedin = liDefault, contacts = contactsDefault, fetchImpl, pacing = {}, diagnose = null, ...opts }) {
    super({ ...opts, pacing: { ...DEFAULT_PACING, ...LI_PACING, ...pacing } });
    this.li = linkedin;
    this.contacts = contacts;
    this.fetchImpl = fetchImpl;
    this.country = country;
    this.diagnose = diagnose;
    this.companies = new Map(); // company page (or name) -> { name, companyUrl, location, sources: [] }
    this.doneCompanies = new Set();
    this.readJobs = new Set();
    this.readPosts = new Set();
    this.sites = new Map(); // website -> contacts (each site fetched once)
    this.blocked = null; // why LinkedIn pages stopped, if they did
    this.stages = new Set();
    this.stats.linkedin = { jobs: 0, posts: 0, companies: 0, websites: 0, maps: 0, withPhone: 0, withEmail: 0, leads: 0, newLeads: 0, duplicates: 0, failures: 0 };
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
    const parts = [n(s.jobs, 'job'), n(s.posts, 'post'), `${n(s.companies, 'company', 'companies')} checked`, n(s.newLeads, 'new lead')];
    if (s.duplicates) parts.push(`${s.duplicates} already saved`);
    const contact = `${s.withPhone} with a phone, ${s.withEmail} with an email`;
    return `${parts.join(', ')} (${contact}).${this.blocked ? ` ${UNAVAILABLE[this.blocked]}` : ''}`;
  }

  progress(stage, note = '') {
    const s = this.stats.linkedin;
    this.status('running', `LinkedIn ${stage}: ${s.jobs} jobs · ${s.posts} posts · ${s.companies} companies · ${s.newLeads} new leads${note ? ` · ${note}` : ''}`);
  }

  // A LinkedIn page; a login page, check or limit ends the LinkedIn pages
  // (not the search). Returns the result, or null when LinkedIn is closed.
  async liPage(page, fn) {
    if (this.blocked) return null;
    const r = await this.netOp(() => fn(), page);
    if (UNAVAILABLE[r.mode]) {
      this.blocked = r.mode;
      this.status('running', `LinkedIn: ${UNAVAILABLE[r.mode]} Continuing with the companies already found.`);
      return null;
    }
    await this.pause(this.pacing.liPage);
    return r;
  }

  async searchOnce() {
    const page = await this.op(() => this.pages.linkedin());
    if (!this.stages.has('jobs')) await this.stageJobs(page);
    this.stages.add('jobs');
    await this.completeCompanies(page);
    if (!this.stages.has('posts')) await this.stagePosts(page);
    this.stages.add('posts');
    await this.completeCompanies(page);
    if (!this.stages.has('companies') && this.companies.size < this.pacing.liMinCompanies) await this.stageCompanySearch(page);
    this.stages.add('companies');
    await this.completeCompanies(page);
  }

  addCompany({ name, companyUrl, location }, source) {
    const key = companyUrl || `name:${nameKey(name)}`;
    if (!companyUrl && !nameKey(name)) return;
    const c = this.companies.get(key) || { name, companyUrl, location, sources: [] };
    c.name ||= name;
    c.location ||= location;
    c.sources.push(source);
    this.companies.set(key, c);
  }

  // 1. Jobs for the keyword, then each job's own page for its company.
  async stageJobs(page) {
    this.setStep('searching');
    this.progress('jobs', `searching jobs for "${this.keyword}"`);
    const r = await this.liPage(page, () => this.li.searchJobs(page, this.keyword));
    if (!r) return;
    if (r.mode === 'empty') return this.progress('jobs', 'no jobs found');
    if (r.mode !== 'ok') return this.progress('jobs', `jobs did not load (${r.detail || r.mode})`);
    const cards = new Map(r.jobs.map((j) => [j.jobId, j]));
    for (let i = 0; i < this.pacing.liScrolls && cards.size < this.pacing.liMaxJobs; i++) {
      const more = await this.op(() => this.li.moreJobs(page));
      const before = cards.size;
      for (const j of more) cards.set(j.jobId, j);
      if (cards.size === before) break;
    }
    this.setStep('analyzing');
    for (const card of [...cards.values()].slice(0, this.pacing.liMaxJobs)) {
      if (this.readJobs.has(card.jobId)) continue;
      this.readJobs.add(card.jobId);
      const url = this.li.jobUrl(card.jobId);
      this.stats.processed++;
      this.stats.linkedin.jobs++;
      // A job an earlier search already turned into a lead is not read again.
      if (this.store.hasLinkedInSource(url)) {
        this.stats.linkedin.duplicates++;
        continue;
      }
      let job = { ...card, description: '', links: [] };
      // The job's own page has the company link and the description.
      const j = await this.liPage(page, () => this.li.readJob(page, card.jobId));
      if (j?.mode === 'ok') job = { ...card, ...Object.fromEntries(Object.entries(j.job).filter(([, v]) => v)) };
      const companyUrl = this.li.cleanCompanyUrl(job.companyHref || card.companyHref);
      if (!companyUrl && !job.company) continue;
      this.addCompany({ name: job.company || card.company, companyUrl, location: job.location || card.location }, { kind: 'job', url, title: job.title || card.title, text: job.description, links: job.links });
      this.progress('jobs', `${job.company || 'a company'}: ${job.title || card.title}`);
    }
  }

  // 3. Posts about hiring or projects; the company behind each one.
  async stagePosts(page) {
    this.setStep('searching');
    this.progress('posts', `searching posts for "${this.keyword}"`);
    const r = await this.liPage(page, () => this.li.searchPosts(page, this.keyword));
    if (!r || r.mode !== 'ok') return r && this.progress('posts', r.mode === 'empty' ? 'no posts found' : `posts did not load (${r.detail || r.mode})`);
    this.setStep('analyzing');
    for (const post of r.posts.slice(0, this.pacing.liMaxPosts)) {
      if (!post.urn || this.readPosts.has(post.urn)) continue;
      this.readPosts.add(post.urn);
      this.stats.processed++;
      this.stats.linkedin.posts++;
      if (!HIRING.test(post.text)) continue;
      const url = this.li.postUrl(post.urn);
      if (this.store.hasLinkedInSource(url)) {
        this.stats.linkedin.duplicates++;
        continue;
      }
      const companyUrl = this.li.cleanCompanyUrl(post.authorHref) || post.companyHrefs.map((h) => this.li.cleanCompanyUrl(h)).find(Boolean) || '';
      const isCompanyAuthor = Boolean(this.li.cleanCompanyUrl(post.authorHref));
      // A person's post counts when it names a company or publishes business
      // contact details for the need it describes.
      const published = this.contacts.contactsFromHtml(`<div>${escapeHtml(post.text)}</div>${post.links.map((h) => `<a href="${escapeHtml(h)}"></a>`).join('')}`, 'https://www.linkedin.com/', { country: this.country });
      if (!companyUrl && !published.emails.length && !published.phones.length) continue;
      // No company page: the post's own contact details, credited to its author.
      this.addCompany(
        { name: isCompanyAuthor || !companyUrl ? post.author || 'LinkedIn post' : '', companyUrl, location: '' },
        { kind: 'post', url, title: '', text: post.text, author: post.author, emails: published.emails, phones: published.phones },
      );
      this.progress('posts', `${post.author || 'a post'}`);
    }
  }

  // 4. Fallback: LinkedIn's company search.
  async stageCompanySearch(page) {
    this.setStep('searching');
    this.progress('companies', `searching companies for "${this.keyword}"`);
    const r = await this.liPage(page, () => this.li.searchCompanies(page, this.keyword));
    if (!r || r.mode !== 'ok') return r && this.progress('companies', r.mode === 'empty' ? 'no companies found' : `companies did not load (${r.detail || r.mode})`);
    for (const c of r.companies.slice(0, this.pacing.liMaxCompanies)) {
      const companyUrl = this.li.cleanCompanyUrl(c.href);
      if (companyUrl) this.addCompany({ name: c.name, companyUrl, location: '' }, { kind: 'company', url: companyUrl, text: c.subtitle });
    }
  }

  // 2. Each company found: its About page, its website, then Google Maps;
  // saved as a lead with whatever public contact details were found.
  async completeCompanies(page) {
    for (const [key, c] of this.companies) {
      if (this.doneCompanies.has(key)) continue;
      if (this.doneCompanies.size >= this.pacing.liMaxCompanies) {
        this.status('running', `LinkedIn: stopped at ${this.pacing.liMaxCompanies} companies`);
        return;
      }
      this.doneCompanies.add(key);
      await this.completeCompany(page, c);
    }
  }

  async completeCompany(page, c) {
    const s = this.stats.linkedin;
    s.companies++;
    const notes = [];
    let website = '';
    let address = c.location || '';
    let name = c.name;
    let phone = null;
    const emails = [];
    const take = (ph, from) => {
      if (!ph) return;
      const better = !phone || (phone.status !== 'valid' && ph.status === 'valid');
      if (better) phone = { ...ph, from };
    };
    // Contact details the job or post itself published.
    for (const src of c.sources) {
      for (const e of src.emails || []) emails.push(e);
      for (const ph of src.phones || []) take(ph, 'post');
      if (!website) website = (src.links || []).map((h) => this.li.cleanWebsite(h)).find(Boolean) || '';
    }

    // The company's LinkedIn About page.
    if (c.companyUrl) {
      this.progress('company', `reading ${name || 'a company'} on LinkedIn`);
      const r = await this.liPage(page, () => this.li.readCompany(page, c.companyUrl));
      if (r?.mode === 'ok') {
        const info = r.company;
        if (info.name) name = info.name;
        website = this.li.cleanWebsite(info.website) || website;
        address = info.headquarters || address;
        const country = countryFromAddress(address) || this.country;
        for (const raw of [...(info.tels || []).map((t) => t.replace(/^tel:/i, '')), info.phone].filter(Boolean)) {
          const n = normalizePhone(raw, { address: country ? `x, ${countryName(country)}` : '' });
          if (n.status === 'valid' || n.status === 'unverified') take({ phone: n.phone, raw: n.raw, status: n.status, country: n.country }, 'linkedin');
        }
        notes.push('LinkedIn company page read');
      } else notes.push(this.blocked ? `LinkedIn company page not read (${this.blocked})` : 'LinkedIn company page did not load');
    }
    const country = countryFromAddress(address) || this.country;

    // The company's own website (each site once).
    if (website) {
      this.progress('website', `checking ${hostOf(website)}`);
      let found = this.sites.get(website);
      if (!found) {
        found = await this.op(() => this.contacts.findContacts(website, { country, fetchImpl: this.fetchImpl, signal: this.signal }));
        this.sites.set(website, found);
        s.websites++;
      }
      if (found.error) notes.push(`website not reached (${found.error})`);
      else {
        emails.push(...found.emails);
        for (const ph of found.phones) take(ph, 'website');
        notes.push(`website read (${found.pages.length} page${found.pages.length === 1 ? '' : 's'})`);
      }
    }

    // Google Maps, only for a missing phone, and only an exact match.
    if (this.pacing.liMaps && (!phone || phone.status !== 'valid') && name) {
      this.progress('maps', `looking up ${name} on Google Maps`);
      const m = await this.mapsLookup(page, { name, website, location: address });
      if (m) {
        s.maps++;
        take(m.phone, 'maps');
        website ||= m.website;
        address ||= m.address;
        notes.push('matched on Google Maps');
      } else notes.push('no exact Google Maps match');
    }

    const email = [...new Set(emails)][0] || '';
    // A lead needs something useful: a contact, a website, or the job/post itself.
    const src = c.sources.find((x) => x.kind === 'job') || c.sources.find((x) => x.kind === 'post') || c.sources[0];
    const jobSrc = c.sources.find((x) => x.kind === 'job');
    const postSrc = c.sources.find((x) => x.kind === 'post');
    const discovery = [phone ? `phone (${phone.from})` : 'no phone', email ? 'email' : 'no email', website ? 'website' : 'no website'].join(', ') + (notes.length ? `; ${notes.join('; ')}` : '');
    let saved;
    try {
      saved = this.store.saveLinkedInLead({
        companyName: name,
        companyUrl: c.companyUrl || null,
        website: website || null,
        email: email || null,
        phone: phone ? { phone: phone.phone, raw: phone.raw, status: phone.status, country: phone.country } : null,
        address: address || null,
        jobUrl: jobSrc?.url || null,
        jobTitle: jobSrc?.title || null,
        postUrl: postSrc?.url || null,
        sourceUrl: src?.url || c.companyUrl || null,
        sourceKind: src?.kind || 'company',
        text: src?.text || '',
        discovery,
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
    if (phone) s.withPhone++;
    if (email) s.withEmail++;
    this.stats.leads++;
    s.leads++;
    if (saved.isNewLead) {
      this.stats.newLeads++;
      s.newLeads++;
    } else s.duplicates++;
    this.emit('lead', saved.lead);
    try {
      this.diagnose?.({ source: 'linkedin', company: Boolean(c.companyUrl), sources: c.sources.map((x) => x.kind), phone: phone?.from || null, email: Boolean(email), website: Boolean(website), notes });
    } catch {}
    this.status('running', saved.isNewLead ? `LinkedIn lead found: ${name}` : `LinkedIn: ${name} is already a lead`);
  }

  // Google Maps for one company: { phone, website, address } when a result
  // is clearly the same business (same website, or same name and same city),
  // else null.
  async mapsLookup(page, { name, website, location }) {
    const city = cityOf(location);
    const query = [name, String(location || '').split(',')[0]].filter(Boolean).join(' ');
    const r = await this.netOp(async () => {
      await page.goto(this.maps.searchUrl(query), { waitUntil: 'domcontentloaded', timeout: 45_000 });
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
    } else return null;
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

module.exports = { LinkedInSession, LinkedInUnavailable, LI_PACING, nameKey };
