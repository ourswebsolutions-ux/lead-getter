'use strict';
// LinkedIn as a lead source: address helpers, website contact discovery,
// and the whole multi-stage search (jobs -> company page -> website ->
// Google Maps -> posts -> company search) against LinkedIn-shaped pages in
// a throwaway headless Chrome, with Google Maps and company websites mocked.
// Also: login walls, cancellation, timeouts, and running beside the other
// sources.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const li = require('../src/browser/linkedin');
const contacts = require('../src/browser/website-contacts');
const { findChromeExecutable } = require('../src/browser/chrome');
const { LeadStore } = require('../src/database/db');
const { LinkedInSession, nameKey } = require('../src/browser/linkedin-session');
const { runSources } = require('../src/browser/search-sources');
const { leadsToCsv } = require('../src/export/csv');

test('LinkedIn addresses: company pages, job ids, official websites', () => {
  assert.equal(li.cleanCompanyUrl('https://www.linkedin.com/company/Acme-Soft/life/?trk=x'), 'https://www.linkedin.com/company/acme-soft');
  assert.equal(li.cleanCompanyUrl('https://www.linkedin.com/in/someone/'), '');
  assert.equal(li.cleanCompanyUrl('https://evil.example/company/x'), '');
  assert.equal(li.jobIdFrom('https://www.linkedin.com/jobs/view/full-stack-developer-at-acme-4001234567/?refId=x'), '4001234567');
  assert.equal(li.jobIdFrom('https://www.linkedin.com/jobs/search/?currentJobId=4009876543&keywords=x'), '4009876543');
  assert.equal(li.cleanWebsite('https://www.linkedin.com/redir/redirect?url=https%3A%2F%2Fwww.AcmeSoft.com%2F&urlhash=x'), 'https://www.acmesoft.com/');
  assert.equal(li.cleanWebsite('acmesoft.com'), 'https://acmesoft.com/');
  assert.equal(li.cleanWebsite('https://www.facebook.com/acme'), '', 'a social page is not a website');
  assert.equal(li.cleanWebsite('https://www.linkedin.com/company/acme'), '');
  assert.equal(nameKey('Acme Soft (Pvt.) Ltd.'), 'acme soft');
  assert.notEqual(nameKey('Beta Labs International'), nameKey('Beta Labs'));
});

const site = (pages) => async (url) => {
  const body = pages[url.replace(/\/$/, '')];
  if (body === 'hang') return new Promise(() => {});
  if (body === undefined) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
};

test('website contacts: business emails first, contact pages, numbers; nothing invented', async () => {
  const fetchImpl = site({
    'https://acme.example': `<html><body><nav><a href="/contact-us">Contact us</a><a href="https://other.example/contact">Partner</a></nav>
      <img src="logo@2x.png"><script>var x="tracking@sentry.io"</script>
      <footer>Call <a href="tel:+92 42 35761234">042 35761234</a> &middot; owner.gmail@gmail.com</footer></body></html>`,
    'https://acme.example/contact-us': '<p>Email: info&#64;acme.example</p><p>Sales: <a href="mailto:sales@acme.example?subject=Hi">write to us</a></p><p>Founded 2015-03-01</p>',
  });
  const r = await contacts.findContacts('https://acme.example/', { country: 'PK', fetchImpl });
  assert.equal(r.error, null);
  assert.deepEqual(r.emails.slice(0, 2).sort(), ['info@acme.example', 'sales@acme.example'], 'the business addresses first');
  assert.equal(r.emails[2], 'owner.gmail@gmail.com');
  assert.deepEqual(r.phones.map((p) => [p.status, p.phone]), [['valid', '+924235761234']]);
  assert.deepEqual(r.pages, ['https://acme.example/', 'https://acme.example/contact-us']);
  // A site without contact details: none.
  const empty = await contacts.findContacts('https://quiet.example/', { fetchImpl: site({ 'https://quiet.example': '<p>Welcome</p>' }) });
  assert.deepEqual([empty.emails, empty.phones], [[], []]);
  // Unreachable and slow sites are reported, not hung on.
  const down = await contacts.findContacts('https://down.example/', { fetchImpl: site({}) });
  assert.match(down.error, /HTTP 404/);
  const t0 = Date.now();
  const slow = await contacts.findContacts('https://slow.example/', { fetchImpl: site({ 'https://slow.example': 'hang' }), timeout: 200 });
  assert.match(slow.error, /timed out|could not be reached/);
  assert.ok(Date.now() - t0 < 5000);
});

// --- the search, in Chrome -----------------------------------------------------------

const exe = findChromeExecutable();
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'linkedin.html'), 'utf8');

// Google Maps results by query; only exact matches may be used.
function mockMaps() {
  const db = {
    'Gamma Traders Karachi': { mode: 'list', links: [{ name: 'Gamma Traders International', url: 'g2' }, { name: 'Gamma Traders', url: 'g1' }], details: { g1: { name: 'Gamma Traders', address: 'Plot 5, Saddar, Karachi, Pakistan', phoneText: '021 34567890', website: '' } } },
    'Beta Labs Islamabad': { mode: 'list', links: [{ name: 'Beta Labs International', url: 'b1' }], details: { b1: { name: 'Beta Labs International', address: 'Islamabad, Pakistan', phoneText: '051 1234567', website: '' } } },
    'Delta Digital Lahore': { mode: 'list', links: [{ name: 'Delta Digital', url: 'd1' }], details: { d1: { name: 'Delta Digital', address: 'Blue Area, Islamabad, Pakistan', phoneText: '051 7654321', website: '' } } },
    'Epsilon Co Faisalabad': { mode: 'single', single: { name: 'Epsilon Co.', address: 'Faisalabad, Pakistan', phoneText: '041 2345678', website: 'https://epsilon.example.org/' } },
  };
  let current = null;
  let opened = null;
  const queries = [];
  return {
    queries,
    searchUrl: (q) => `https://www.google.com/maps/search/${encodeURIComponent(q)}?hl=en`,
    async waitForResults(page) {
      const q = decodeURIComponent(new URL(page.url()).pathname.split('/maps/search/')[1] || '');
      queries.push(q);
      current = db[q] || null;
      opened = null;
      return { mode: current?.mode || 'empty' };
    },
    collectLinks: async () => current.links,
    gotoListing: async (page, url) => ((opened = url), true),
    extractDetails: async () => (opened ? current.details[opened] : current.single),
  };
}

const SITES = {
  'https://www.acmesoft.com': '<footer>Email: <a href="mailto:info@acmesoft.com">info@acmesoft.com</a> | hr.acme@gmail.com</footer>',
  'https://betalabs.io': '<a href="/contact-us">Contact</a>',
  'https://betalabs.io/contact-us': '<p>Write to hello@betalabs.io</p>',
};

async function run(t, { config = {}, pacing = {}, store = new LeadStore(':memory:'), signal = new AbortController().signal, onLead = () => {}, modes, linkedin = li } = {}) {
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await context.addCookies([{ name: 'li_at', value: '1', domain: '.linkedin.com', path: '/', secure: true }]);
  const page = await context.newPage();
  // Every tab of the context sees the same LinkedIn and Google pages.
  await context.route('https://www.linkedin.com/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture.replace('<script>', `<script>window.CONFIG = ${JSON.stringify(config)};</script><script>`) }));
  await context.route('https://www.google.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<div role="feed"></div>' }));
  await context.route(/^https:\/\/(?!www\.(linkedin|google)\.com)/, (r) => r.fulfill({ status: 404, contentType: 'text/html', body: 'not found' }));
  const maps = mockMaps();
  const statuses = [];
  const diag = [];
  const session = new LinkedInSession({
    keyword: 'Full Stack Developer',
    country: 'PK',
    store,
    pages: { linkedin: async () => page },
    linkedin,
    ...(modes ? { modes } : {}),
    signal,
    maps,
    fetchImpl: site(SITES),
    pacing: { liPage: [10, 10], liMinCompanies: 6, netRetries: [1], ...pacing },
    diagnose: (d) => diag.push(d),
    emit: (e, p) => (e === 'status' ? statuses.push(p.message) : onLead(p)),
  });
  const outcome = await session.run();
  return { outcome, stats: session.stats.linkedin, store, statuses, maps, diag, context };
}

const byName = (store) => Object.fromEntries(store.listLeads().map((l) => [l.name, l]));

test('LinkedIn search: jobs -> companies -> websites -> Google Maps -> posts -> company search', { skip: !exe && 'Google Chrome not installed' }, async (t) => {
  const { outcome, stats, store, statuses, maps, diag } = await run(t);
  assert.equal(outcome.state, 'done', outcome.message);
  const leads = byName(store);
  assert.deepEqual(Object.keys(leads).sort(), ['Acme Soft (Pvt) Ltd', 'Beta Labs', 'Delta Digital', 'Epsilon Co', 'Gamma Traders', 'Rida Recruiter']);

  // Stage 1+2: the company behind a job, from its LinkedIn page and website.
  const acme = leads['Acme Soft (Pvt) Ltd'];
  assert.deepEqual(
    { phone: acme.phone, email: acme.email, website: acme.websiteUrl, linkedin: acme.linkedinUrl, job: acme.jobUrl, title: acme.jobTitle, address: acme.address, sources: acme.sources },
    {
      phone: '+924235761234', email: 'info@acmesoft.com', website: 'https://www.acmesoft.com/', linkedin: 'https://www.linkedin.com/company/acme-soft',
      job: 'https://www.linkedin.com/jobs/view/4001/', title: 'Full Stack Developer', address: 'Lahore, Punjab', sources: ['linkedin'],
    },
  );
  assert.equal(acme.discovery, 'phone: found (LinkedIn); email: found (website); website: acmesoft.com');
  assert.equal(store.listLeads().filter((l) => l.linkedinUrl === acme.linkedinUrl).length, 1, 'two jobs, one company');

  // Website contact page: email only; Google Maps had no exact match ("Beta Labs International").
  const beta = leads['Beta Labs'];
  assert.deepEqual([beta.email, beta.phone], ['hello@betalabs.io', '']);
  // Unavailable (every source checked), not a failed lookup.
  assert.match(beta.discovery, /^phone: not published \(checked: LinkedIn, Google Maps \(no exact match\), website\); email: found \(website\)/);

  // Stage 3: no website, no phone on LinkedIn: Google Maps, the exact name in the same city.
  const gamma = leads['Gamma Traders'];
  assert.deepEqual([gamma.phone, gamma.phoneStatus, gamma.websiteUrl], ['+922134567890', 'valid', '']);
  assert.match(gamma.discovery, /^phone: found \(Google Maps\); email: not published \(checked: LinkedIn, Google Maps\); website: none found$/);

  // Stage 4: a company's hiring post (email in it); Maps result in another city is rejected.
  const delta = leads['Delta Digital'];
  assert.deepEqual([delta.email, delta.phone, delta.linkedinPostUrl], ['careers@deltadigital.pk', '', 'https://www.linkedin.com/feed/update/urn:li:activity:7001/']);
  // A person's post with business contact details published for the need.
  assert.equal(leads['Rida Recruiter'].phone, '+923217654321');
  // Stage 5: company search (too few companies); website unreachable, Maps (same site) gave the number.
  const eps = leads['Epsilon Co'];
  assert.deepEqual([eps.phone, eps.websiteUrl], ['+92412345678', 'https://epsilon.example.org/'], eps.discovery);
  // A site that could not be read: a failed lookup, said as such.
  assert.match(eps.discovery, /email: not found; could not check: website \(HTTP 404\)/);

  // Every results page (2 jobs each), until LinkedIn showed no more.
  assert.equal(stats.pages, 2);
  assert.match(outcome.message, /^4 jobs on 2 results pages, 3 posts, /);
  // Google Maps, second, whenever a phone or email is still missing after LinkedIn
  // (Acme and Rida have a phone but no email yet).
  assert.deepEqual(maps.queries.sort(), ['Acme Soft (Pvt) Ltd Lahore', 'Beta Labs Islamabad', 'Delta Digital Lahore', 'Epsilon Co Faisalabad', 'Gamma Traders Karachi', 'Rida Recruiter']);
  assert.deepEqual(
    { jobs: stats.jobs, posts: stats.posts, companies: stats.companies, newLeads: stats.newLeads, withPhone: stats.withPhone, withEmail: stats.withEmail },
    { jobs: 4, posts: 3, companies: 7, newLeads: 6, withPhone: 4, withEmail: 3 },
  );
  // Progress per stage.
  for (const stage of ['jobs', 'company', 'website', 'maps', 'posts', 'companies']) assert.ok(statuses.some((m) => m.startsWith(`LinkedIn ${stage}:`)), stage);
  assert.equal(diag.length, 6);
  assert.doesNotMatch(JSON.stringify(diag), /li_at|@|\+92/);
  // Filters and export carry the LinkedIn fields.
  assert.equal(store.listLeads({ source: 'linkedin' }).length, 6);
  assert.equal(store.listLeads({ source: 'maps' }).length, 0);
  assert.match(leadsToCsv([acme]), /info@acmesoft\.com,https:\/\/www\.acmesoft\.com\/,https:\/\/www\.linkedin\.com\/company\/acme-soft,https:\/\/www\.linkedin\.com\/jobs\/view\/4001\/,,Full Stack Developer/);

  // A second search reads nothing twice and adds no duplicates.
  const again = await run(t, { store });
  assert.equal(again.stats.newLeads, 0, store.listLeads().map((l) => `${l.name}|${l.linkedinUrl}|${l.placeKey}`).join('\n'));
  assert.equal(store.listLeads().length, 6);
});

test('LinkedIn login wall on company pages: reported, and companies are still completed from websites and Maps', { skip: !exe && 'Google Chrome not installed' }, async (t) => {
  // All jobs on one results page (no further LinkedIn page is opened after the wall).
  const { outcome, store } = await run(t, { config: { authwall: '/company/', perPage: 10 } });
  assert.equal(outcome.state, 'done', outcome.message);
  assert.match(outcome.message, /LinkedIn asked to log in/);
  const leads = byName(store);
  // Job companies are kept (names from the jobs), Gamma still matched on Maps.
  assert.equal(leads['Gamma Traders'].phone, '+922134567890');
  assert.ok(leads['Acme Soft'] || leads['Acme Soft (Pvt) Ltd']);
  assert.match((leads['Acme Soft'] || {}).discovery || '', /could not check: LinkedIn page \(login\)/);
});

test('LinkedIn not available at all: the LinkedIn part says why and saves nothing', { skip: !exe && 'Google Chrome not installed' }, async (t) => {
  const { outcome, store } = await run(t, { config: { authwall: 'all' } });
  assert.equal(outcome.state, 'unavailable');
  assert.equal(outcome.kind, 'login');
  assert.match(outcome.message, /LinkedIn asked to log in/);
  assert.equal(store.listLeads().length, 0);
});

test('Stop ends the LinkedIn search; what was saved stays', { skip: !exe && 'Google Chrome not installed' }, async (t) => {
  const ctl = new AbortController();
  const { outcome, store } = await run(t, { signal: ctl.signal, onLead: () => ctl.abort() });
  assert.equal(outcome.state, 'stopped');
  assert.equal(store.listLeads().length, 1);
});

test('LinkedIn runs beside Google Maps (and Facebook) with its own progress', async () => {
  const fakeSession = (source, leads, ms) => (emit) => ({
    stats: { processed: leads, leads, newLeads: leads, skipped: 0, [source]: { leads, newLeads: leads } },
    async run() {
      emit('status', { state: 'running', message: `${source} working`, processed: 0, leads: 0, newLeads: 0 });
      await new Promise((r) => setTimeout(r, ms));
      emit('status', { state: 'running', message: `${source} found`, processed: leads, leads, newLeads: leads });
      return source === 'maps' ? { processed: leads, leads, newLeads: leads, skipped: 0 } : { state: 'done', message: `${leads} ${source} leads.` };
    },
  });
  const statuses = [];
  const stats = await runSources({
    withFacebook: false,
    withLinkedIn: true,
    signal: new AbortController().signal,
    send: (e, p) => e === 'status' && statuses.push(p),
    createMaps: (emit) => {
      const s = fakeSession('maps', 2, 30)(emit);
      const run0 = s.run.bind(s);
      s.run = async () => {
        const r = await run0();
        emit('status', { state: 'done', message: 'Search finished' });
        return r;
      };
      return s;
    },
    createLinkedIn: fakeSession('linkedin', 3, 10),
  });
  assert.deepEqual([stats.newLeads, stats.linkedin.newLeads], [5, 3]);
  assert.ok(statuses.some((s) => s.workers?.maps.state === 'running' && s.workers?.linkedin), 'both shown at once');
  assert.ok(statuses.some((s) => s.source === 'linkedin' && /^LinkedIn: /.test(s.message)));
  const last = statuses.at(-1);
  assert.equal(last.state, 'done');
  assert.deepEqual(Object.keys(last.workers).sort(), ['linkedin', 'maps']);
  assert.match(last.message, /Google Maps: Search finished\. LinkedIn: 3 linkedin leads\./);
});

test('any combination of sources: without Google Maps only the selected ones run, each with its own progress', async () => {
  const made = [];
  const session = (source, leads) => (emit) => {
    made.push(source);
    return {
      stats: { processed: leads, leads, newLeads: leads, skipped: 0, [source]: { leads, newLeads: leads } },
      async run() {
        emit('status', { state: 'running', message: 'working', processed: leads, leads, newLeads: leads });
        return { state: 'done', message: `${leads} leads.` };
      },
    };
  };
  for (const combo of [{ withFacebook: true }, { withLinkedIn: true }, { withFacebook: true, withLinkedIn: true }]) {
    made.length = 0;
    const statuses = [];
    const stats = await runSources({
      withMaps: false,
      ...combo,
      signal: new AbortController().signal,
      send: (e, p) => e === 'status' && statuses.push(p),
      createMaps: () => assert.fail('Google Maps must not start'),
      createFacebook: session('facebook', 2),
      createLinkedIn: session('linkedin', 3),
    });
    const want = [...(combo.withFacebook ? ['facebook'] : []), ...(combo.withLinkedIn ? ['linkedin'] : [])];
    assert.deepEqual(made, want);
    const last = statuses.at(-1);
    assert.equal(last.state, 'done');
    assert.deepEqual(Object.keys(last.workers).sort(), want);
    assert.doesNotMatch(last.message, /Google Maps/);
    assert.equal(stats.newLeads, (combo.withFacebook ? 2 : 0) + (combo.withLinkedIn ? 3 : 0));
  }
});

test('"Not on WhatsApp" lists and exports only numbers WhatsApp said have no account', () => {
  const s = new LeadStore(':memory:');
  const add = (n, phone) => s.save({ placeKey: `0x${n}:0x1`, mapsUrl: `https://www.google.com/maps/place/${n}`, name: `Shop ${n}`, phoneRaw: phone, address: 'Lahore, Pakistan', websiteStatus: 'no_website' });
  add(1, '+92 300 1111111');
  add(2, '+92 300 2222222');
  add(3, '+92 300 3333333');
  s.setWhatsAppResult('+923001111111', 'available', 'baileys');
  s.setWhatsAppResult('+923002222222', 'unavailable', 'baileys');
  assert.deepEqual(s.listLeads({ whatsapp: 'unavailable' }).map((l) => l.name), ['Shop 2']);
  assert.deepEqual(s.listLeads({ whatsapp: 'available' }).map((l) => l.name), ['Shop 1']);
  assert.equal(s.listLeads({}).length, 3, 'not checked yet: in neither list');
});

test('LinkedIn modes: Posts only runs no job or company search; Jobs only no post search', { skip: !exe && 'Google Chrome not installed' }, async (t) => {
  const posts = await run(t, { modes: { jobs: false, posts: true, companies: false } });
  assert.equal(posts.outcome.state, 'done', posts.outcome.message);
  assert.deepEqual([posts.stats.jobs, posts.stats.posts], [0, 3]);
  assert.deepEqual(posts.store.listLeads().map((l) => l.name).sort(), ['Delta Digital', 'Rida Recruiter']);
  const jobs = await run(t, { modes: { jobs: true, posts: false, companies: false } });
  assert.deepEqual([jobs.stats.jobs, jobs.stats.posts], [4, 0]);
  assert.deepEqual(jobs.store.listLeads().map((l) => l.name).sort(), ['Acme Soft (Pvt) Ltd', 'Beta Labs', 'Gamma Traders']);
});

test('relevance: search words as prefixes, a name alone is not enough', () => {
  const { searchTerms, relevance } = require('../src/browser/linkedin-session');
  const terms = searchTerms('video editor in USA');
  assert.deepEqual(terms, ['vide', 'edit', 'usa']);
  assert.ok(relevance('Senior Video Editing Lead', terms) >= 0.5);
  assert.ok(relevance('Film Editor', terms) < 0.5);
  assert.equal(relevance('Bakery and cafe', terms), 0);
});

test('LinkedIn posts in the current layout (no activity ids): one post per control menu', { skip: !exe && 'Google Chrome not installed' }, async (t) => {
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  // As seen on linkedin.com: "Feed post" blocks, the author in the control menu's label.
  const post = (author, href, text) => `<div componentkey="update-card-focus${author.length}"><h2>Feed post</h2>
    <div><a href="${href}">${author}</a><button aria-label="Open control menu for post by ${author}">…</button></div>
    <div><span>${text}</span><button>… more</button></div><div><button aria-label="Repost">Repost</button></div></div>`;
  await page.setContent(`<main><div>${post('Alex Mitar', 'https://www.linkedin.com/in/alexmitar/', 'Video Editor Needed. Looking for a video editor for branded content. Email jobs@mitarfilms.com')}
    ${post('Studio Nine', 'https://www.linkedin.com/company/studio-nine/', 'We are hiring a video editor for a new campaign project.')}</div></main>`);
  const posts = await page.evaluate(li.collectPostsInPage);
  assert.equal(posts.length, 2);
  assert.deepEqual(posts.map((p) => p.author), ['Alex Mitar', 'Studio Nine']);
  assert.match(posts[0].text, /jobs@mitarfilms\.com/);
  assert.equal(posts[1].companyHrefs[0], 'https://www.linkedin.com/company/studio-nine/');
  assert.ok(posts[0].key && posts[0].key !== posts[1].key);
});

test('LinkedIn company pages without a labelled website: the outside link written as a web address', { skip: !exe && 'Google Chrome not installed' }, async (t) => {
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<main><h1>BrainX Technologies</h1>
    <section><p>Software house in Lahore. Follow us on <a href="https://www.facebook.com/brainx">facebook.com/brainx</a></p>
    <div><a href="https://www.linkedin.com/redir/redirect/?url=https%3A%2F%2Fwww.brainx.tech%2F&amp;urlhash=x">www.brainx.tech</a></div>
    <div><a href="tel:+924238913038">042 38913038</a></div></section></main>`);
  const c = await page.evaluate(li.readCompanyInPage);
  assert.equal(c.website, '', 'no labelled website');
  assert.equal(li.cleanWebsite(c.siteLinks.find((h) => li.cleanWebsite(h))), 'https://www.brainx.tech/', 'the web address link, not the social page');
  assert.deepEqual(c.tels, ['tel:+924238913038']);
});
