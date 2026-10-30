'use strict';
// LinkedIn People search with contact discovery, against the user's real,
// already-running Chrome (logged in to LinkedIn).
//   node test/integration/linkedin-people.js "SEO" "USA" [maxProfiles] [contactout|builtin|both] [reveal]
// contactout: contacts from the ContactOut extension of that Chrome profile
// (it must be installed, enabled and signed in there); reveal: also click
// ContactOut's reveal buttons (uses your ContactOut credits).
// Requires "Allow remote debugging for this browser instance" at
// chrome://inspect/#remote-debugging; Chrome asks you to Allow the
// connection. Opens a few profiles in a new window, slowly, then stops.
// Leads go to a temporary database, not the app's.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChromeConnection } = require('../../src/browser/chrome');
const { LinkedInSession } = require('../../src/browser/linkedin-session');
const { EmailVerifier } = require('../../src/browser/email-verify');
const { robotsChecker } = require('../../src/browser/robots');
const { LeadStore } = require('../../src/database/db');
const { PROVIDERS, extensionState, installedIn } = require('../../src/browser/extension-contacts');

const keyword = process.argv[2] || 'SEO';
const location = process.argv[3] || 'USA';
const maxProfiles = Number(process.argv[4] || 3);
const provider = process.argv[5] || 'contactout';
const reveal = process.argv[6] === 'reveal';

(async () => {
  const conn = new ChromeConnection({ onStatus: (m) => console.log(`[chrome] ${m}`) });
  const profile = await conn.connect();
  console.log('[chrome] connected', { profile: profile.name, chrome: profile.chromeVersion });
  const st = extensionState(profile.path, PROVIDERS.contactout);
  console.log('[contactout] in this profile:', st, '| enabled in:', installedIn(path.dirname(profile.path)).filter((p) => p.enabled).map((p) => p.name));
  const page = await conn.newWindowPage();
  const store = new LeadStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lf-people-')), 'leads.db'));
  const controller = new AbortController();
  const session = new LinkedInSession({
    keyword,
    location,
    modes: { people: true, jobs: false, posts: false, companies: false },
    store,
    signal: controller.signal,
    pages: { linkedin: async () => page },
    verifier: new EmailVerifier(),
    extension: provider === 'builtin' ? null : { provider: PROVIDERS.contactout, only: provider === 'contactout', reveal, preflight: { ...st, where: installedIn(path.dirname(profile.path)).filter((p) => p.enabled).map((p) => p.name) } },
    allow: robotsChecker({ signal: controller.signal }),
    emit: (event, p) => {
      if (event === 'lead') {
        console.log('[lead]', JSON.stringify({ providers: p.contactProviders, name: p.name, title: p.personTitle, company: p.companyName, location: p.address, profile: p.profileUrl, email: p.email, emailStatus: p.emailStatus, phone: p.phone, emails: p.emails, phones: p.phones }));
      } else {
        console.log(`[status] ${p.message}`);
        if (session.stats.linkedin.profiles >= maxProfiles && !controller.signal.aborted) controller.abort();
      }
    },
  });
  console.log('[done]', await session.run());
  for (const l of store.listLeads({ source: 'linkedin' })) console.log(`- ${l.name} | ${l.personTitle} @ ${l.companyName} | ${l.email || '(no email)'} ${l.emailStatus} | ${l.phone || '(no direct phone)'}\n  ${l.discovery}`);
  await page.close().catch(() => {});
  await conn.disconnect();
})().catch((err) => {
  console.error('[failed]', err);
  process.exit(1);
});
