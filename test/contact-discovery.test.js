'use strict';
// LinkedIn People search with ContactOut-style contact discovery:
//  - the email verifier against a local mail server (existing and missing
//    mailboxes, servers that accept every address, policy refusals, no mail
//    server, port 25 blocked, a self-hosted Reacher);
//  - the discovery engine: LinkedIn contact info, local datasets, the
//    company website (only what is next to the person's name), the company's
//    email format confirmed by its mail server, and nothing invented;
//  - person leads in the database (one per profile, never merged with a
//    business; deleted stays deleted), CSV datasets and export;
//  - the whole People search in a headless Chrome against LinkedIn-shaped
//    pages: results page after page, each profile opened, duplicates and
//    unrelated people skipped, the location filter, a login wall.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { EmailVerifier, validSyntax } = require('../src/browser/email-verify');
const cd = require('../src/browser/contact-discovery');
const li = require('../src/browser/linkedin');
const { LinkedInSession } = require('../src/browser/linkedin-session');
const { findChromeExecutable } = require('../src/browser/chrome');
const { LeadStore } = require('../src/database/db');
const { leadsToCsv } = require('../src/export/csv');
const { contactRowsFromCsv } = require('../src/export/csv-import');

// --- a local mail server ------------------------------------------------------------

// mailboxes: existing addresses; catchAll: domains that accept everything;
// policy: domains that refuse this computer ("listed on a blocklist").
function mailServer({ mailboxes = [], catchAll = [], policy = [] } = {}) {
  const boxes = new Set(mailboxes.map((e) => e.toLowerCase()));
  const log = [];
  const server = net.createServer((sock) => {
    sock.write('220 mx.test ESMTP\r\n');
    let buf = '';
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        log.push(line);
        const up = line.toUpperCase();
        if (up.startsWith('EHLO')) sock.write('250-mx.test\r\n250 SIZE 1000\r\n');
        else if (up.startsWith('MAIL FROM')) sock.write('250 OK\r\n');
        else if (up.startsWith('RCPT TO')) {
          const addr = line.slice(line.indexOf('<') + 1, line.indexOf('>')).toLowerCase();
          const domain = addr.split('@')[1];
          if (policy.includes(domain)) sock.write('554 5.7.1 Service unavailable; client host blocked using zen.spamhaus.org\r\n');
          else if (catchAll.includes(domain) || boxes.has(addr)) sock.write('250 2.1.5 OK\r\n');
          else sock.write('550 5.1.1 The email account that you tried to reach does not exist\r\n');
        } else if (up.startsWith('DATA')) sock.write('503 no DATA in tests\r\n');
        else if (up.startsWith('QUIT')) sock.end('221 bye\r\n');
        else sock.write('250 OK\r\n');
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, log, close: () => server.close() })));
}

// DNS: every known domain has an MX record (all pointing at the local server).
const fakeDns = (domains, { noMail = [] } = {}) => ({
  resolveMx: async (d) => {
    if (noMail.includes(d)) throw Object.assign(new Error('nodata'), { code: 'ENODATA' });
    if (!domains.includes(d)) throw Object.assign(new Error('notfound'), { code: 'ENOTFOUND' });
    return [{ exchange: `mx.${d}`, priority: 10 }];
  },
  resolve4: async () => {
    throw Object.assign(new Error('notfound'), { code: 'ENOTFOUND' });
  },
});

async function verifierFor(t, opts, domains, dnsOpts) {
  const srv = await mailServer(opts);
  t.after(() => srv.close());
  return { v: new EmailVerifier({ dns: fakeDns(domains, dnsOpts), port: srv.port, hostFor: () => '127.0.0.1', helo: 'test.example', timeout: 3000 }), srv };
}

test('email verifier: existing, missing, catch-all, policy refusal, no mail server; never sends a message', async (t) => {
  const { v, srv } = await verifierFor(t, { mailboxes: ['jane.doe@acme.example'], catchAll: ['catch.example'], policy: ['strict.example'] }, ['acme.example', 'catch.example', 'strict.example'], { noMail: ['nomail.example'] });
  const r = await v.checkDomain('acme.example', ['jane.doe@acme.example', 'nobody@acme.example']);
  assert.equal(r.get('jane.doe@acme.example').status, 'verified');
  assert.equal(r.get('nobody@acme.example').status, 'invalid');
  assert.equal((await v.verify('anyone@catch.example')).status, 'catch_all', 'a server that accepts everything confirms nothing');
  assert.equal((await v.verify('x@strict.example')).status, 'unknown', 'a policy refusal is not "does not exist"');
  assert.equal((await v.verify('x@nomail.example')).status, 'invalid');
  assert.equal((await v.verify('not an email')).status, 'invalid');
  // A random address is tried first (to recognise catch-all servers); no DATA, a null sender.
  assert.ok(srv.log.some((l) => /^RCPT TO:<lf-[0-9a-f]+-nouser@acme\.example>$/.test(l)));
  assert.ok(srv.log.includes('MAIL FROM:<>'));
  assert.ok(!srv.log.some((l) => /^DATA/i.test(l)));
  // Results are remembered: no second conversation.
  const before = srv.log.length;
  assert.equal((await v.verify('jane.doe@acme.example')).status, 'verified');
  assert.equal(srv.log.length, before);
  assert.ok(validSyntax('a.b+c@d-e.co.uk') && !validSyntax('a..b@c.com') && !validSyntax('@c.com'));
});

test('email verifier: port 25 blocked -> unknown, and after a few servers it stops waiting; a self-hosted Reacher is used instead when set', async () => {
  const refused = (opts) => {
    const s = new net.Socket();
    setImmediate(() => s.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })));
    return s;
  };
  const v = new EmailVerifier({ dns: fakeDns(['a.example', 'b.example', 'c.example', 'd.example']), connect: refused, timeout: 500 });
  for (const d of ['a', 'b', 'c']) assert.equal((await v.verify(`x@${d}.example`)).status, 'unknown');
  assert.equal(v.blocked, true);
  assert.match((await v.verify('x@d.example')).reason, /port 25/);
  const asked = [];
  const reacher = new EmailVerifier({
    reacherUrl: 'http://localhost:8080/',
    fetchImpl: async (url, init) => {
      asked.push([url, JSON.parse(init.body).to_email]);
      const to = JSON.parse(init.body).to_email;
      return new Response(JSON.stringify({ is_reachable: to.startsWith('ok') ? 'safe' : to.startsWith('bad') ? 'invalid' : 'risky', smtp: { is_catch_all: to.startsWith('all') } }), { headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal((await reacher.verify('ok@x.example')).status, 'verified');
  assert.equal((await reacher.verify('bad@x.example')).status, 'invalid');
  assert.equal((await reacher.verify('all@x.example')).status, 'catch_all');
  assert.deepEqual(asked[0], ['http://localhost:8080/v0/check_email', 'ok@x.example']);
});

test('names, email shapes and formats', () => {
  assert.deepEqual([cd.parseName('Dr. Jane A. Doe, MBA 🚀').first, cd.parseName('Dr. Jane A. Doe, MBA 🚀').last], ['jane', 'doe']);
  assert.equal(cd.parseName('José Núñez').last, 'nunez');
  assert.equal(cd.parseName('Madonna'), null, 'one name gives no candidates');
  const n = cd.parseName('Jane Doe');
  assert.deepEqual(['jane.doe@a.io', 'jdoe@a.io', 'jane@a.io', 'info@a.io', 'bob@a.io'].map((e) => cd.emailKind(e, n)), ['name', 'name', 'first', 'role', 'other']);
  // A domain whose addresses look like first.last tries that first; f.last likewise.
  assert.equal(cd.candidates(n, 'a.io', ['bob.stone@a.io'])[0].email, 'jane.doe@a.io');
  assert.equal(cd.candidates(n, 'a.io', ['b.stone@a.io', 'c.wu@a.io'])[0].email, 'j.doe@a.io');
  assert.equal(cd.baseDomain('mail.acme.co.uk'), 'acme.co.uk');
  assert.ok(cd.FREE_MAIL.test('gmail.com'));
});

// --- the discovery engine ------------------------------------------------------------

const site = (pages) => async (url) => {
  const body = pages[url.replace(/\/$/, '')];
  if (body === undefined) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
};

const SITES = {
  'https://acmegrowth.example': '<nav><a href="/our-team">Our team</a><a href="/contact">Contact</a></nav><p>We grow brands.</p>',
  'https://acmegrowth.example/our-team': `<h1>Our team</h1>
    <div class="card"><h3>Bob Stone</h3><p>Founder</p><p>bob.stone@acmegrowth.example</p><p>+1 512 555 0111</p></div>
    <div class="card"><h3>Jane Doe</h3><p>SEO Lead</p><p><a href="mailto:jane.doe@acmegrowth.example">jane.doe@acmegrowth.example</a></p><p>Direct: +1 512 555 0142</p></div>`,
  'https://acmegrowth.example/contact': '<p>Write to hello@acmegrowth.example or call (512) 555-0100</p>',
  'https://betarank.example': '<footer>info@betarank.example · +1 415 555 0100</footer>',
  'https://catchcorp.example': '<p>Catch Corp</p>',
};

test('discovery: an email published next to the name, confirmed; the direct number next to it; a colleague\'s is not taken', async (t) => {
  const { v } = await verifierFor(t, { mailboxes: ['jane.doe@acmegrowth.example', 'bob.stone@acmegrowth.example'] }, ['acmegrowth.example']);
  const r = await cd.discoverContacts({ name: 'Jane Doe', company: 'Acme Growth', location: 'Austin, Texas, United States', website: 'https://acmegrowth.example/' }, { verifier: v, fetchImpl: site(SITES) });
  assert.equal(r.email, 'jane.doe@acmegrowth.example');
  assert.equal(r.emailStatus, 'verified');
  assert.ok(!r.emails.some((e) => e.email === 'bob.stone@acmegrowth.example'), "a colleague's address is never the person's");
  assert.deepEqual(r.emails.find((e) => e.email === 'hello@acmegrowth.example')?.kind, 'company');
  assert.equal(r.phone.phone, '+15125550142');
  assert.equal(r.phone.kind, 'direct');
  assert.ok(r.phones.some((p) => p.kind === 'company' && p.phone === '+15125550100'));
  assert.ok(!r.phones.some((p) => p.phone === '+15125550111'), "Bob's number is not Jane's");
  assert.match(r.discovery, /checked: .*acmegrowth\.example \(\d+ pages\)/);
});

test('discovery: nothing published -> the company\'s email format, kept only when its mail server confirms the mailbox', async (t) => {
  const { v } = await verifierFor(t, { mailboxes: ['omar@betarank.example'] }, ['betarank.example']);
  const r = await cd.discoverContacts({ name: 'Omar Khan', company: 'Beta Rank', location: 'San Francisco Bay Area', website: 'https://betarank.example' }, { verifier: v, fetchImpl: site(SITES), country: 'US' });
  assert.equal(r.email, 'omar@betarank.example');
  assert.equal(r.emailStatus, 'verified');
  assert.match(r.emails[0].source, /email format "first" at betarank\.example/);
  assert.ok(r.rejected >= 1, 'the formats before it were rejected by the server');
  assert.equal(r.phone, null, 'no direct number: only the company one');
  assert.equal(r.companyPhone.phone, '+14155550100');
});

test('discovery invents nothing: a catch-all domain, a free-mail company, no verification, no website', async (t) => {
  const { v } = await verifierFor(t, { catchAll: ['catchcorp.example'] }, ['catchcorp.example']);
  const a = await cd.discoverContacts({ name: 'Lena Fischer', company: 'Catch Corp', location: 'Berlin, Germany', website: 'https://catchcorp.example' }, { verifier: v, fetchImpl: site(SITES) });
  assert.deepEqual([a.email, a.emailStatus], ['', 'none']);
  assert.match(a.discovery, /accepts every address/);
  const b = await cd.discoverContacts({ name: 'Ana Lima', company: 'Ana Studio', location: 'Lisbon, Portugal', website: 'https://gmail.com' }, { verifier: v, fetchImpl: site({}) });
  assert.equal(b.email, '');
  assert.match(b.discovery, /free mail domain/);
  // Without verification, a published email stays unverified and no address is built.
  const c = await cd.discoverContacts({ name: 'Jane Doe', company: 'Acme Growth', website: 'https://acmegrowth.example/' }, { verifier: null, fetchImpl: site(SITES) });
  assert.deepEqual([c.email, c.emailStatus], ['jane.doe@acmegrowth.example', 'unverified']);
  const d = await cd.discoverContacts({ name: 'Joe Bloggs', company: 'Nowhere' }, { verifier: null });
  assert.deepEqual([d.email, d.phones.length, d.emails.length], ['', 0, 0]);
});

test('discovery: LinkedIn contact info and local datasets; an invalid published address is reported, never used', async (t) => {
  const { v } = await verifierFor(t, { mailboxes: ['lena.fischer@gmail.example'] }, ['gmail.example', 'acmegrowth.example']);
  const store = new LeadStore(':memory:');
  store.importContactRecords('conference', [
    { name: 'Lena Fischer', email: 'lena@old-employer.example', phone: '+49 30 7654321', company: 'Old Employer' },
    { name: 'Sam Roe', email: 'sam.roe@acmegrowth.example', company: 'Acme Growth', website: 'acmegrowth.example' },
  ]);
  const r = await cd.discoverContacts({ name: 'Lena Fischer', company: 'Catch Corp', location: 'Berlin, Germany', profileEmails: ['lena.fischer@gmail.example'], profilePhones: ['+49 30 1234567'] }, { verifier: v, store });
  assert.equal(r.email, 'lena.fischer@gmail.example');
  assert.equal(r.emailStatus, 'verified');
  assert.ok(r.emails.some((e) => e.email === 'lena@old-employer.example' && e.source === 'dataset "conference"'));
  assert.deepEqual(r.phones.map((p) => [p.phone, p.kind]).sort(), [['+49301234567', 'direct'], ['+49307654321', 'direct']]);
  // Sam's dataset address does not exist any more: invalid, and not the lead's email.
  const s = await cd.discoverContacts({ name: 'Sam Roe', company: 'Acme Growth', website: 'https://acmegrowth.example/' }, { verifier: v, store, fetchImpl: site({}), maxCandidates: 0 });
  assert.equal(s.email, '');
  assert.equal(s.emailStatus, 'invalid');
  assert.equal(s.emails.find((e) => e.email === 'sam.roe@acmegrowth.example').status, 'invalid');
});

// --- database, datasets, export -------------------------------------------------------

const person = (over = {}) => ({
  profileUrl: 'https://www.linkedin.com/in/jane-doe-seo',
  name: 'Jane Doe',
  title: 'SEO Lead',
  headline: 'SEO Lead at Acme Growth',
  company: 'Acme Growth',
  location: 'Austin, Texas, United States',
  website: 'https://acmegrowth.example/',
  email: 'jane.doe@acmegrowth.example',
  emailStatus: 'unverified',
  emails: [{ email: 'jane.doe@acmegrowth.example', kind: 'person', status: 'unverified', source: 'company website' }],
  phone: { phone: '+15125550142', raw: '+1 512 555 0142', status: 'valid', country: 'US' },
  phones: [{ phone: '+15125550142', raw: '+1 512 555 0142', status: 'valid', country: 'US', kind: 'direct', source: 'company website' }, { phone: '+15125550100', status: 'valid', kind: 'company', source: 'LinkedIn company page' }],
  discovery: 'email: …',
  keyword: 'SEO',
  ...over,
});

test('person leads: one per profile, updated with better findings, never merged with a business, deleted stays deleted', () => {
  const store = new LeadStore(':memory:');
  const a = store.savePersonLead(person());
  assert.equal(a.isNewLead, true);
  assert.equal(a.lead.kind, 'person');
  assert.equal(a.lead.source, 'linkedin');
  assert.deepEqual(a.lead.sources, ['linkedin']);
  assert.equal(store.hasPersonLead('https://www.linkedin.com/in/jane-doe-seo/'), true);
  // Found again: verified now, a new address added.
  const b = store.savePersonLead(person({ emailStatus: 'verified', emails: [{ email: 'jane.doe@acmegrowth.example', kind: 'person', status: 'verified', source: 'mail server' }, { email: 'jane@personal.example', kind: 'person', status: 'unverified', source: 'dataset' }] }));
  assert.equal(b.isNewLead, false);
  assert.equal(b.lead.emailStatus, 'verified');
  assert.deepEqual(b.lead.emails.map((e) => [e.email, e.status]).sort(), [['jane.doe@acmegrowth.example', 'verified'], ['jane@personal.example', 'unverified']]);
  // A later, worse finding never downgrades it.
  assert.equal(store.savePersonLead(person({ email: '', emailStatus: 'none', emails: [] })).lead.emailStatus, 'verified');
  // A colleague at the same company: a lead of their own (same website and company phone).
  const sam = store.savePersonLead(person({ profileUrl: 'https://www.linkedin.com/in/sam-roe', name: 'Sam Roe', email: '', emailStatus: 'none', emails: [], phone: null }));
  assert.equal(sam.isNewLead, true);
  // The company from a LinkedIn job: a business lead, not merged into a person.
  const co = store.saveLinkedInLead({ companyName: 'Acme Growth', companyUrl: 'https://www.linkedin.com/company/acme-growth', website: 'https://acmegrowth.example/', phone: { phone: '+15125550142', status: 'valid' }, email: 'jane.doe@acmegrowth.example', sourceUrl: 'https://www.linkedin.com/jobs/view/1/', sourceKind: 'job' });
  assert.equal(co.isNewLead, true);
  assert.equal(co.lead.kind, 'business');
  assert.equal(store.listLeads({ source: 'linkedin' }).length, 3);
  assert.equal(store.listLeads({ source: 'maps' }).length, 0, 'people are not Google Maps leads');
  // Search finds people by company and email.
  assert.equal(store.listLeads({ search: 'Acme Growth' }).length, 3);
  // Deleted: not added again, and not opened again.
  store.deleteLeads([sam.lead.id]);
  assert.equal(store.savePersonLead(person({ profileUrl: 'https://www.linkedin.com/in/sam-roe', name: 'Sam Roe' })).lead, null);
  assert.equal(store.hasPersonLead('https://www.linkedin.com/in/sam-roe'), true);
  assert.throws(() => store.savePersonLead(person({ profileUrl: 'https://evil.example/in/x' })), /LinkedIn profile/);
});

test('contact datasets: CSV columns by name, lookups by profile, name and company domain; export columns', () => {
  const csv = '﻿Full Name;Work Email;Mobile Phone;Company;Company Website;Job Title;LinkedIn URL\n"Doe, Jane";;+1 512 555 0142;Acme Growth;https://www.acmegrowth.example;SEO Lead;https://www.linkedin.com/in/jane-doe-seo/\nOmar Khan;omar@betarank.example;;Beta Rank;betarank.example;;\n;;;;;;\n';
  const { rows, columns } = contactRowsFromCsv(csv);
  assert.deepEqual(columns.sort(), ['company', 'email', 'linkedin', 'name', 'phone', 'title', 'website'].sort());
  const store = new LeadStore(':memory:');
  assert.deepEqual(store.importContactRecords('crm', rows), { imported: 2, skipped: 0 });
  assert.deepEqual(store.contactDatasets().map((d) => [d.dataset, d.records]), [['crm', 2]]);
  const byProfile = store.findContactRecords({ name: 'Jane Doe', domain: 'acmegrowth.example', profileUrl: 'https://www.linkedin.com/in/jane-doe-seo' });
  assert.equal(byProfile[0].match, 'person');
  assert.equal(byProfile[0].phone, '+1 512 555 0142');
  assert.equal(store.findContactRecords({ name: 'Omar Khan', domain: 'betarank.example' })[0].match, 'person');
  assert.equal(store.findContactRecords({ name: 'Someone Else', domain: 'betarank.example' })[0].match, 'domain', "a colleague's address is format evidence only");
  store.deleteContactDataset('crm');
  assert.deepEqual(store.contactDatasets(), []);
  // Export: the person columns.
  const lead = store.savePersonLead(person({ emailStatus: 'verified' })).lead;
  const out = leadsToCsv([lead]).replace(/^﻿/, '').split('\r\n');
  const header = out[0].split(',');
  const row = out[1];
  assert.deepEqual(header.slice(-5), ['LinkedIn Profile URL', 'Person Title', 'Company', 'All Phones', 'Contact Provider']);
  assert.match(row, /,Verified,https:\/\/www\.linkedin\.com\/in\/jane-doe-seo,SEO Lead,Acme Growth,/);
  assert.match(row, /\+15125550142 \(direct, valid\)/);
});

// --- the People search in Chrome --------------------------------------------------------

const exe = findChromeExecutable();
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'linkedin-people.html'), 'utf8');

async function runPeople(t, { config = {}, store = new LeadStore(':memory:'), location = 'USA', verifier = null, pacing = {}, signal = new AbortController().signal } = {}) {
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await context.addCookies([{ name: 'li_at', value: '1', domain: '.linkedin.com', path: '/', secure: true }]);
  const page = await context.newPage();
  const visited = [];
  await context.route('https://www.linkedin.com/**', (r) => {
    visited.push(r.request().url());
    return r.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture.replace('<script>', `<script>window.CONFIG = ${JSON.stringify(config)};</script><script>`) });
  });
  await context.route(/^https:\/\/(?!www\.linkedin\.com)/, (r) => r.fulfill({ status: 404, contentType: 'text/html', body: 'not found' }));
  const statuses = [];
  const leads = [];
  const session = new LinkedInSession({
    keyword: 'SEO',
    location,
    modes: { people: true, jobs: false, posts: false, companies: false },
    country: 'US',
    store,
    pages: { linkedin: async () => page },
    signal,
    verifier,
    fetchImpl: site(SITES),
    pacing: { liPage: [5, 5], liMaps: false, netRetries: [1], ...pacing },
    emit: (e, p) => (e === 'status' ? statuses.push(p.message) : leads.push(p)),
  });
  const outcome = await session.run();
  return { outcome, stats: session.stats.linkedin, store, statuses, visited, leads };
}

test('People search: every results page, each profile opened in turn, contacts discovered and saved; duplicates and unrelated people skipped', { skip: !exe && 'Google Chrome not installed' }, async (t) => {
  const { v } = await verifierFor(t, { mailboxes: ['jane.doe@acmegrowth.example', 'bob.stone@acmegrowth.example', 'omar@betarank.example', 'lena.fischer@gmail.example', 'sam.roe@acmegrowth.example'], catchAll: ['catchcorp.example'] }, ['acmegrowth.example', 'betarank.example', 'catchcorp.example', 'gmail.example']);
  const { outcome, stats, store, visited, leads, statuses } = await runPeople(t, { verifier: v });
  assert.equal(outcome.state, 'done', outcome.message);
  // People search with LinkedIn's US location filter, pages 1, 2, then the empty page 3.
  const searches = visited.filter((u) => u.includes('/search/results/people/'));
  assert.equal(searches.length, 3);
  assert.ok(searches.every((u) => u.includes(`geoUrn=${encodeURIComponent('["103644278"]')}`)), 'USA uses LinkedIn\'s location filter');
  assert.ok(!visited.some((u) => /\/jobs\//.test(u)), 'People search, not Jobs');
  // Profiles opened one by one, in results order; Jane only once; the LinkedIn Member card skipped.
  const profiles = visited.filter((u) => /\/in\/[^/]+\/?$/.test(new URL(u).pathname)).map((u) => new URL(u).pathname.split('/')[2]);
  assert.deepEqual(profiles, ['jane-doe-seo', 'omar-khan-1', 'lena-fischer', 'pat-lee', 'sam-roe']);
  assert.equal(stats.notRelevant, 1, 'the chef is not an SEO person');
  const by = Object.fromEntries(store.listLeads({ source: 'linkedin' }).map((l) => [l.name, l]));
  assert.deepEqual(Object.keys(by).sort(), ['Jane Doe', 'Lena Fischer 🚀', 'Omar Khan', 'Sam Roe']);
  // Jane: published next to her name on the team page, confirmed; direct number.
  assert.deepEqual([by['Jane Doe'].email, by['Jane Doe'].emailStatus, by['Jane Doe'].phone], ['jane.doe@acmegrowth.example', 'verified', '+15125550142']);
  assert.deepEqual([by['Jane Doe'].personTitle, by['Jane Doe'].companyName, by['Jane Doe'].address], ['SEO Lead', 'Acme Growth', 'Austin, Texas, United States']);
  assert.equal(by['Jane Doe'].profileUrl, 'https://www.linkedin.com/in/jane-doe-seo');
  // Omar: the company's format, confirmed by its mail server; only a company number.
  assert.deepEqual([by['Omar Khan'].email, by['Omar Khan'].emailStatus, by['Omar Khan'].phone], ['omar@betarank.example', 'verified', '']);
  assert.ok(by['Omar Khan'].phones.some((p) => p.kind === 'company'));
  // Lena: her company's server accepts everything, so nothing is built; her
  // LinkedIn contact info email (confirmed) and mobile are used.
  assert.deepEqual([by['Lena Fischer 🚀'].email, by['Lena Fischer 🚀'].emailStatus, by['Lena Fischer 🚀'].phone], ['lena.fischer@gmail.example', 'verified', '+49301234567']);
  // Sam: Jane's colleague; format evidence from jane.doe@ -> sam.roe@, confirmed.
  assert.deepEqual([by['Sam Roe'].email, by['Sam Roe'].emailStatus], ['sam.roe@acmegrowth.example', 'verified']);
  assert.equal(leads.length, 4);
  assert.equal(stats.verified, 4);
  assert.match(outcome.message, /5 profiles opened from 2 people results pages/);
  assert.ok(statuses.some((s) => /LinkedIn people: page 1/.test(s)));

  // A second search: profiles already saved are not opened again.
  const again = await runPeople(t, { store, verifier: v });
  assert.equal(again.stats.duplicates, 4);
  assert.deepEqual(again.visited.filter((u) => /\/in\//.test(u)).map((u) => new URL(u).pathname.split('/')[2]), ['pat-lee'], 'only the unrelated profile is looked at again');
});

test('People search: a city is added to the search words and checked on each profile; a login wall stops it with the reason', { skip: !exe && 'Google Chrome not installed' }, async (t) => {
  const { stats, visited, store } = await runPeople(t, { location: 'Austin' });
  const first = new URL(visited.find((u) => u.includes('/search/results/people/')));
  assert.equal(first.searchParams.get('keywords'), 'SEO Austin');
  assert.equal(first.searchParams.get('geoUrn'), null);
  assert.deepEqual(store.listLeads({ source: 'linkedin' }).map((l) => l.name), ['Jane Doe'], 'only the profile in Austin');
  assert.ok(stats.notRelevant >= 3);
  const wall = await runPeople(t, { config: { authwall: 'all' } });
  assert.equal(wall.outcome.state, 'unavailable');
  assert.match(wall.outcome.message, /log in to LinkedIn/i);
});
