'use strict';
// The ContactOut extension as a contact provider for LinkedIn People search:
//  - reading its panel: only values it shows (masked ones ignored), labels,
//    "nothing found", login prompts, credit limits, a panel still showing
//    the previous person;
//  - finding whether it is installed and enabled in a Chrome profile;
//  - the People search with it in a headless Chrome: its panel opened with
//    its own button, read on each profile, reveal buttons clicked only when
//    allowed, saved with ContactOut as the source; a login or an exhausted
//    credit balance ends its use (never worked around); not installed in the
//    profile in use: no profile is opened, and the profiles that have it are named.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const ext = require('../src/browser/extension-contacts');
const { LinkedInSession } = require('../src/browser/linkedin-session');
const { findChromeExecutable } = require('../src/browser/chrome');
const { LeadStore } = require('../src/database/db');
const { leadsToCsv } = require('../src/export/csv');

const panel = (text, buttons = []) => ({ text, mailtos: [], tels: [], buttons });

test('reading the panel: shown values only, with their labels; masked values, other people and states', () => {
  const ok = ext.parsePanel(panel('Jane Doe\nSEO Lead at Acme Growth\nWork email\njane.doe@acmegrowth.example ✓\nPersonal email\nj***@gmail.com\nMobile\n+1 512 555 0142\nOffice\n+1 (512) ***-**00', ['Copy']), { name: 'Jane Doe', country: 'US' });
  assert.equal(ok.state, 'ok');
  assert.deepEqual(ok.emails, [{ email: 'jane.doe@acmegrowth.example', label: 'work' }]);
  assert.deepEqual(ok.phones.map((p) => [p.phone, p.label]), [['+15125550142', 'mobile']]);
  assert.ok(ok.masked >= 2, 'hidden values are counted, never completed');
  // Only a button to reveal (credits): nothing shown yet.
  const reveal = ext.parsePanel(panel('Omar Khan\nSEO Specialist\n***@gmail.com\nView email\n903*****\nView phone\nFind work email', ['View email', 'View phone', 'Find work email']), { name: 'Omar Khan' });
  assert.deepEqual([reveal.state, reveal.revealable], ['none', ['View email', 'View phone']], '"Find work email" is a separate search, not a reveal');
  assert.equal(reveal.masked, 2);
  assert.equal(ext.parsePanel(panel('Lena Fischer\nNo contact information found for this profile.'), { name: 'Lena Fischer' }).state, 'none');
  assert.equal(ext.parsePanel(panel('You have run out of credits. Upgrade your plan to see emails.'), { name: 'Sam Roe' }).state, 'limit');
  assert.equal(ext.parsePanel(panel('Please log in to ContactOut to continue', ['Log in']), { name: 'Sam Roe' }).state, 'login');
  assert.equal(ext.parsePanel(panel('Verify you are human'), { name: 'Sam Roe' }).state, 'checkpoint');
  assert.equal(ext.parsePanel(panel('Jane Doe\njane.doe@acmegrowth.example'), { name: 'Omar Khan' }).state, 'other_person', "the previous profile's details are not this person's");
  assert.equal(ext.parsePanel(panel('Loading…'), { name: 'Omar Khan' }).state, 'loading');
});

test('installed and enabled: per Chrome profile, from the profile settings and extension folder only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-ext-'));
  const id = ext.PROVIDERS.contactout.extensionId;
  const profile = (name, entry, withFolder = true) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    if (entry) fs.writeFileSync(path.join(dir, name, 'Preferences'), JSON.stringify({ extensions: { settings: { [id]: entry } } }));
    if (withFolder) fs.mkdirSync(path.join(dir, name, 'Extensions', id, '5.18.3_0'), { recursive: true });
  };
  profile('Default', null, false);
  profile('Profile 3', { disable_reasons: [], manifest: { version: '5.18.3' } });
  profile('Profile 7', { disable_reasons: [1] });
  fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({ profile: { info_cache: { 'Profile 3': { name: 'Work' }, 'Profile 7': { name: 'Old' } } } }));
  try {
    assert.deepEqual(ext.extensionState(path.join(dir, 'Default')), { installed: false, enabled: false, version: '' });
    assert.deepEqual(ext.extensionState(path.join(dir, 'Profile 3')), { installed: true, enabled: true, version: '5.18.3' });
    assert.equal(ext.extensionState(path.join(dir, 'Profile 7')).enabled, false);
    assert.deepEqual(ext.installedIn(dir).map((p) => [p.name, p.enabled]), [['Work', true], ['Old', false]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- the search, in Chrome ------------------------------------------------------------

const exe = findChromeExecutable();
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'linkedin-people.html'), 'utf8');

// ContactOut's panel page for each profile (?p=), after a short load.
// RESULTS[id]: html shown; a reveal button replaces itself with `revealed`.
const RESULTS = {
  'jane-doe-seo': '<h3>Jane Doe</h3><p>SEO Lead at Acme Growth</p><div>Work email</div><div><a href="mailto:jane.doe@acmegrowth.example">jane.doe@acmegrowth.example</a></div><div>Personal email</div><div>j***@gmail.com</div><div>Mobile</div><div>+1 512 555 0142</div>',
  'omar-khan-1': '<h3>Omar Khan</h3><p>SEO Specialist</p><div>***@betarank.example</div><button id="r">View email</button><button>Find work email</button><div id="out"></div>',
  'lena-fischer': '<h3>Lena Fischer</h3><p>No contact information found for this profile.</p>',
  'sam-roe': '<p>You have run out of credits. Upgrade your plan to see contact details.</p>',
};
const coPage = (id) => `<!doctype html><html><body><div id="app">Loading…</div><script>
  setTimeout(() => {
    document.getElementById('app').innerHTML = ${JSON.stringify(RESULTS[id] || '<p>Please log in to ContactOut to continue</p><button>Log in</button>')};
    const r = document.getElementById('r');
    if (r) r.onclick = () => { document.getElementById('out').innerHTML = '<div>Work email</div><div>omar@betarank.example</div>'; r.remove(); };
  }, 700);
</script></body></html>`;

// ContactOut 5.18's panel as seen live: masked values with "View email" /
// "View phone" (they use credits), "Find work email" (a separate search),
// and a monthly limit message once the reveals are used up.
const V2 = {
  'jane-doe-seo': { before: '<h3>Jane Doe</h3><p>SEO Lead at Acme Growth</p><p>***@gmail.com</p><p>***@acmegrowth.example</p><button id="ve">View email</button><p>903*****</p><button id="vp">View phone</button><button id="fw">Find work email</button><div id="out"></div>', after: '<p>jane.doe@acmegrowth.example</p><p>jane.d@gmail.example</p><p>+1 512 555 0142</p>' },
  'omar-khan-1': { before: '<h3>Omar Khan</h3><p>SEO Specialist</p><p>No contact information found.</p><button id="fw">Find work email</button>' },
  'lena-fischer': { before: '<h3>Lena Fischer</h3><p>***@gmail.com</p><button id="ve">View email</button><div id="out"></div>', after: 'LIMIT' },
  'sam-roe': { before: '<h3>Sam Roe</h3><p>***@acmegrowth.example</p><button id="ve">View email</button><div id="out"></div>', after: 'LIMIT' },
};
const coPageV2 = (id) => `<!doctype html><html><body><div id="app">Loading…</div><script>
  setTimeout(() => {
    const r = ${JSON.stringify(V2[id] || { before: '<p>Please log in to ContactOut to continue</p>' })};
    document.getElementById('app').innerHTML = r.before;
    const reveal = () => {
      if (r.after === 'LIMIT') { document.getElementById('app').insertAdjacentHTML('afterbegin', '<h4>Monthly email limit reached</h4><p>Upgrade now for unlimited email reveals or come back next month for more.</p><button>Upgrade Now</button>'); return; }
      document.getElementById('out').innerHTML = r.after;
      document.querySelectorAll('#ve, #vp').forEach((b) => b.remove());
      document.querySelectorAll('p').forEach((p) => /[*]{3}/.test(p.textContent) && p.remove());
    };
    for (const b of document.querySelectorAll('#ve, #vp')) b.onclick = reveal;
    const fw = document.getElementById('fw');
    if (fw) fw.onclick = () => { window.FIND_WORK = true; document.getElementById('app').insertAdjacentHTML('beforeend', '<p>worksearch@should-not-click.example</p>'); };
  }, 600);
</script></body></html>`;
const buttonPage = '<!doctype html><html><body style="margin:0"><div id="b" style="width:32px;height:84px;background:#6552ff;cursor:pointer"></div><script>document.getElementById("b").onclick = () => parent.postMessage("co-toggle", "*");</script></body></html>';

async function runPeople(t, { extension, config = { contactout: true }, store = new LeadStore(':memory:') } = {}) {
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await context.addCookies([{ name: 'li_at', value: '1', domain: '.linkedin.com', path: '/', secure: true }]);
  const page = await context.newPage();
  const visited = [];
  const coLoads = [];
  await context.route('https://www.linkedin.com/**', (r) => {
    visited.push(r.request().url());
    return r.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture.replace('<script>', `<script>window.CONFIG = ${JSON.stringify(config)};</script><script>`) });
  });
  await context.route('https://contactout.com/**', (r) => {
    const u = new URL(r.request().url());
    if (u.pathname.startsWith('/extension/action_button')) return r.fulfill({ contentType: 'text/html', body: buttonPage });
    const id = u.searchParams.get('p');
    coLoads.push(id);
    return r.fulfill({ contentType: 'text/html; charset=utf-8', body: config.contactout === 'v2' ? coPageV2(id) : coPage(id) });
  });
  await context.route(/^https:\/\/(?!www\.linkedin\.com|contactout\.com)/, (r) => r.fulfill({ status: 404, contentType: 'text/html', body: 'not found' }));
  const fetched = [];
  const statuses = [];
  const session = new LinkedInSession({
    keyword: 'SEO',
    location: 'USA',
    modes: { people: true, jobs: false, posts: false, companies: false },
    country: 'US',
    store,
    pages: { linkedin: async () => page },
    signal: new AbortController().signal,
    verifier: null,
    extension,
    fetchImpl: async (url) => (fetched.push(url), new Response('not found', { status: 404 })),
    pacing: { liPage: [5, 5], liMaps: false, netRetries: [1] },
    emit: (e, p) => e === 'status' && statuses.push(p.message),
  });
  const outcome = await session.run();
  return { outcome, stats: session.stats.linkedin, store, visited, coLoads, fetched, statuses };
}

const contactout = (over = {}) => ({ provider: ext.PROVIDERS.contactout, only: true, reveal: false, timeout: 5000, preflight: { installed: true, enabled: true, where: ['Ali'] }, ...over });

test('ContactOut on each profile: its panel opened with its own button, what it shows saved with ContactOut as the source; credits used up end it', { skip: !exe && 'Google Chrome not installed' }, async (t) => {
  const { outcome, stats, store, coLoads, fetched, statuses } = await runPeople(t, { extension: contactout() });
  assert.equal(outcome.state, 'done', outcome.message);
  const by = Object.fromEntries(store.listLeads({ source: 'linkedin' }).map((l) => [l.name, l]));
  // Jane: the work email and the mobile ContactOut shows; the masked personal email is not taken.
  assert.deepEqual([by['Jane Doe'].email, by['Jane Doe'].phone], ['jane.doe@acmegrowth.example', '+15125550142']);
  assert.deepEqual(by['Jane Doe'].emails.map((e) => [e.email, e.from]), [['jane.doe@acmegrowth.example', 'ContactOut (work)']]);
  assert.deepEqual(by['Jane Doe'].contactProviders, ['contactout']);
  assert.equal(by['Jane Doe'].emailStatus, 'unverified', 'not checked with a mail server here (verification off)');
  // Omar: ContactOut only offers to reveal (credits); "Reveal with credits" is off, so nothing.
  assert.deepEqual([by['Omar Khan'].email, by['Omar Khan'].contactProviders], ['', []], JSON.stringify(by['Omar Khan'].emails) + by['Omar Khan'].discovery);
  assert.match(by['Omar Khan'].discovery, /ContactOut: ContactOut showed no contact details \(it offers to reveal them with your credits/);
  // Lena: ContactOut found nothing; the email her LinkedIn Contact info shares is credited to LinkedIn, not ContactOut.
  assert.deepEqual(by['Lena Fischer 🚀'].emails.map((e) => [e.email, e.from]), [['lena.fischer@gmail.example', 'LinkedIn contact info']]);
  assert.deepEqual(by['Lena Fischer 🚀'].contactProviders, []);
  assert.match(by['Lena Fischer 🚀'].discovery, /ContactOut showed no contact details/);
  // Sam: credits used up: ContactOut is not used further, and (it being the only source) the search stops.
  assert.match(outcome.message, /credits or limit are used up.*stopped using ContactOut/);
  assert.ok(statuses.some((s) => /stopped using ContactOut/.test(s)));
  assert.equal(stats.fromExtension, 1);
  // ContactOut only: no website or email-format discovery was done.
  assert.deepEqual(fetched, []);
  // The extension loads itself on every profile (the unrelated one too); Lead Finder reads it on the people it keeps.
  assert.deepEqual(coLoads.filter(Boolean), ['jane-doe-seo', 'omar-khan-1', 'lena-fischer', 'pat-lee', 'sam-roe']);
  // The export names the provider.
  assert.match(leadsToCsv([by['Jane Doe']]), /,ContactOut\r\n$/);
});

test('ContactOut reveal buttons are clicked only with "Reveal with credits" on', { skip: !exe && 'Google Chrome not installed' }, async (t) => {
  const { store } = await runPeople(t, { extension: contactout({ reveal: true }) });
  const omar = store.listLeads({ source: 'linkedin' }).find((l) => l.name === 'Omar Khan');
  assert.equal(omar.email, 'omar@betarank.example');
  assert.deepEqual(omar.contactProviders, ['contactout']);
});

test('ContactOut not in the Chrome profile in use: no profile is opened, and the profiles that have it are named; not loaded: it is reported, not invented', { skip: !exe && 'Google Chrome not installed' }, async (t) => {
  const none = await runPeople(t, { extension: contactout({ preflight: { installed: false, enabled: false, where: ['Ali'] } }) });
  assert.ok(!none.visited.some((u) => /\/in\//.test(u)), 'no profile opened');
  assert.match(none.outcome.message, /ContactOut is not installed in the Chrome profile Lead Finder is using\. It is installed in the Chrome profile "Ali"/);
  // Installed but its panel never appears on the pages (e.g. signed out of Chrome sync, blocked): stops after two profiles.
  const missing = await runPeople(t, { extension: contactout(), config: {} });
  assert.match(missing.outcome.message, /ContactOut did not appear on LinkedIn profiles/);
  assert.equal(missing.stats.profiles, 2);
  assert.ok(missing.store.listLeads({ source: 'linkedin' }).every((l) => !l.email));
});

test('LinkedIn 2026 layout and ContactOut 5.18 (as seen live): button iframe, panel off screen until clicked, View email/phone revealed, a monthly limit stops it', { skip: !exe && 'Google Chrome not installed' }, async (t) => {
  const { outcome, store, stats } = await runPeople(t, { extension: contactout({ reveal: true }), config: { contactout: 'v2', layout: '2026' } });
  const by = Object.fromEntries(store.listLeads({ source: 'linkedin' }).map((l) => [l.name, l]));
  // The profile is read without an h1: name, headline, location, company.
  assert.equal(stats.profiles >= 3, true, `profiles: ${stats.profiles}`);
  const jane = by['Jane Doe'];
  assert.deepEqual([jane.personTitle, jane.companyName, jane.address], ['SEO Lead', 'Acme Growth', 'Austin, Texas, United States']);
  // ContactOut opened with its own button; "View email" and "View phone" revealed the values it had masked.
  assert.deepEqual(jane.emails.map((e) => e.email).sort(), ['jane.d@gmail.example', 'jane.doe@acmegrowth.example']);
  assert.ok(jane.emails.every((e) => e.from.startsWith('ContactOut')));
  assert.equal(jane.phone, '+15125550142');
  assert.deepEqual(jane.contactProviders, ['contactout']);
  // "Find work email" (a separate search) is never clicked.
  assert.ok(!JSON.stringify(store.listLeads()).includes('should-not-click'));
  // Omar: nothing found. Lena: the monthly limit: ContactOut's use ends, and (only source) the search stops.
  assert.equal(by['Omar Khan'].email, '');
  assert.equal(by['Lena Fischer 🚀']?.contactProviders.length || 0, 0);
  assert.match(outcome.message, /credits or limit are used up.*stopped using ContactOut/);
  assert.equal(by['Sam Roe'], undefined, 'no profile opened after the limit');
});
