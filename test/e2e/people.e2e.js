'use strict';
// LinkedIn People search in the real app: People is the default LinkedIn
// mode (not Jobs), with a Location field; "Verify emails" and the contact
// data panel (CSV datasets imported and removed) are stored; a person lead
// shows its title and company, its email with its status, opens its profile
// and exports with the person columns. The search itself starts LinkedIn
// only (Chrome is not installed here, so it ends there).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { unlock, activationEnv } = require('./helpers');

const root = path.join(__dirname, '..', '..');

test('People search: default mode, location, verification setting, contact datasets, person leads', async (t) => {
  const { LeadStore } = require('../../src/database/db');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-people-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  // Settings saved by an earlier version (Jobs, Posts, Companies): People takes over.
  const seed = new LeadStore(path.join(userData, 'leads.db'));
  seed.setState('linkedinModes', { jobs: true, posts: true, companies: true });
  seed.savePersonLead({
    profileUrl: 'https://www.linkedin.com/in/jane-doe-seo',
    name: 'Jane Doe',
    title: 'SEO Lead',
    headline: 'SEO Lead at Acme Growth',
    company: 'Acme Growth',
    location: 'Austin, Texas, United States',
    website: 'https://acmegrowth.example/',
    email: 'jane.doe@acmegrowth.example',
    emailStatus: 'verified',
    emails: [{ email: 'jane.doe@acmegrowth.example', kind: 'person', status: 'verified', source: 'company website' }],
    phone: { phone: '+15125550142', raw: '+1 512 555 0142', status: 'valid', country: 'US' },
    phones: [{ phone: '+15125550142', status: 'valid', kind: 'direct', source: 'company website' }],
    discovery: 'email: jane.doe@acmegrowth.example verified',
    providers: ['contactout'],
    keyword: 'SEO',
  });
  seed.close();
  const csvFile = path.join(tmp, 'crm-export.csv');
  fs.writeFileSync(csvFile, 'Full Name,Work Email,Phone,Company,Website\nOmar Khan,omar@betarank.example,,Beta Rank,betarank.example\nLena Fischer,,+49 30 1234567,Catch Corp,catchcorp.example\n');
  // A Chrome folder with ContactOut in its profile "Work" (only its settings entry and folder).
  const chromeDir = path.join(tmp, 'chrome');
  const coId = 'jjdemeiffadmmjhkbbpglgnlgeafomjo';
  fs.mkdirSync(path.join(chromeDir, 'Profile 3', 'Extensions', coId, '5.18.3_0'), { recursive: true });
  fs.writeFileSync(path.join(chromeDir, 'Profile 3', 'Preferences'), JSON.stringify({ extensions: { settings: { [coId]: { disable_reasons: [] } } } }));
  fs.writeFileSync(path.join(chromeDir, 'Local State'), JSON.stringify({ profile: { info_cache: { 'Profile 3': { name: 'Work' } } } }));
  const env = { ...process.env, ...activationEnv, LEAD_FINDER_USER_DATA: userData, LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome'), LEAD_FINDER_CHROME_USER_DATA: chromeDir, LEAD_FINDER_NO_UPDATES: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [root], cwd: root, env });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  t.after(async () => {
    await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  await unlock(win);

  // LinkedIn on: People (not Jobs) is the mode; its search bar and Location.
  await win.getByRole('switch', { name: 'LinkedIn Lead Search' }).click();
  const mode = (name) => win.getByRole('checkbox', { name: `LinkedIn ${name}` });
  // The boxes show the stored settings: they change once the app has saved them.
  const setBox = async (box, on) => {
    await box.click();
    await win.waitForFunction(([sel, want]) => document.querySelector(sel)?.checked === want, [`input[aria-label="${await box.getAttribute('aria-label')}"]`, on]);
  };
  assert.deepEqual(await Promise.all(['People', 'Jobs', 'Posts', 'Companies'].map((m) => mode(m).isChecked())), [true, false, false, false]);
  assert.equal(await win.locator('#li-kw').getAttribute('placeholder'), 'e.g. SEO');
  await win.locator('#li-loc').waitFor();
  // People off (Jobs on): no Location; back on.
  await setBox(mode('Jobs'), true);
  await setBox(mode('People'), false);
  await win.locator('#li-loc').waitFor({ state: 'detached' });
  await setBox(mode('People'), true);
  await setBox(mode('Jobs'), false);
  assert.deepEqual((await win.evaluate(() => window.leadFinder.linkedinSettings())).modes, { people: true, jobs: false, posts: false, companies: false });

  // Contacts from: ContactOut by default (it is installed in this Chrome), named in the tooltip; reveal on (ContactOut masks values until "View").
  const from = win.getByRole('combobox', { name: 'Contacts from' });
  assert.equal(await from.inputValue(), 'contactout');
  assert.match(await win.locator('.provider-select').getAttribute('title'), /enabled in your Chrome profile Work/);
  const revealBox = win.getByRole('checkbox', { name: 'Reveal with ContactOut credits' });
  assert.equal(await revealBox.isChecked(), true);
  await setBox(revealBox, false);
  assert.equal((await win.evaluate(() => window.leadFinder.linkedinSettings())).contact.reveal, false);
  await from.selectOption('builtin');
  await revealBox.waitFor({ state: 'detached' });
  assert.equal((await win.evaluate(() => window.leadFinder.linkedinSettings())).contact.provider, 'builtin');
  await from.selectOption('both');
  await revealBox.waitFor();

  // Verify emails: on by default, stored.
  const verify = win.getByRole('checkbox', { name: 'Verify emails' });
  assert.equal(await verify.isChecked(), true);
  await setBox(verify, false);
  assert.equal((await win.evaluate(() => window.leadFinder.linkedinSettings())).contact.verify, false);
  await setBox(verify, true);

  // Contact data: import a CSV (the open dialog answered with the file), then remove it.
  await app.evaluate(({ dialog }, f) => (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })), csvFile);
  await win.getByRole('button', { name: /^Contact data/ }).click();
  const panel = win.getByRole('dialog', { name: 'Contact data' });
  await panel.getByRole('button', { name: 'Import contacts CSV…' }).click();
  await win.locator('.toast').filter({ hasText: 'Imported 2 contacts from "crm-export"' }).waitFor();
  await panel.getByText('crm-export').waitFor();
  assert.match(await win.getByRole('button', { name: /^Contact data/ }).innerText(), /\(2\)/);
  // A verifier address must be a web address.
  const bad = await win.evaluate(() => window.leadFinder.setLinkedInSettings({ contact: { verify: true, verifierUrl: 'ftp://x' } }));
  assert.match(bad.error, /http/);
  await panel.getByRole('button', { name: 'Remove dataset crm-export' }).click();
  await panel.getByText('crm-export').waitFor({ state: 'detached' });

  // The person lead: name, title · company, email with its status, direct number.
  const row = win.locator('tbody tr').filter({ hasText: 'Jane Doe' });
  await row.waitFor();
  assert.match(await row.innerText(), /SEO Lead · Acme Growth/);
  assert.match(await row.locator('.chip-ok').innerText(), /Verified/);
  assert.match(await row.innerText(), /\+15125550142/);
  assert.match(await row.innerText(), /LinkedIn/);
  assert.equal(await row.locator('.src-contactout').innerText(), 'ContactOut');
  // The Source filter (LinkedIn) keeps it; Google Maps does not.
  await win.getByLabel('Show source').selectOption('maps');
  await row.waitFor({ state: 'detached' });
  await win.getByLabel('Show source').selectOption('linkedin');
  await row.waitFor();
  // Its LinkedIn button opens the profile.
  const opened = [];
  await app.evaluate(({ shell }) => {
    globalThis.__opened = [];
    shell.openExternal = async (u) => globalThis.__opened.push(u);
  });
  await row.getByRole('button', { name: 'Open Jane Doe on LinkedIn' }).first().click();
  opened.push(...(await app.evaluate(() => globalThis.__opened)));
  assert.deepEqual(opened, ['https://www.linkedin.com/in/jane-doe-seo']);
  // Export: the person columns.
  const out = path.join(tmp, 'people.csv');
  await app.evaluate(({ dialog }, f) => (dialog.showSaveDialog = async () => ({ canceled: false, filePath: f })), out);
  await win.evaluate(() => window.leadFinder.exportCsv('shown', { category: 'all', source: 'linkedin' }));
  const csv = fs.readFileSync(out, 'utf8');
  assert.match(csv, /LinkedIn Profile URL,Person Title,Company,All Phones/);
  assert.match(csv, /Verified,https:\/\/www\.linkedin\.com\/in\/jane-doe-seo,SEO Lead,Acme Growth,"'\+15125550142 \(direct, valid\)/);

  // Start: LinkedIn alone, with its search and location.
  await win.getByRole('switch', { name: 'Google Maps search' }).click();
  await win.locator('#li-kw').fill('SEO');
  await win.locator('#li-loc').fill('USA');
  await win.getByRole('button', { name: 'Start Search' }).click();
  await win.waitForFunction(() => window.leadFinder.getStatus().then((s) => s.state === 'failed' || s.state === 'done' || s.state === 'stopped'), null, { timeout: 60_000 });
  const st = await win.evaluate(() => window.leadFinder.getStatus());
  assert.deepEqual(st.sources, ['linkedin']);
  assert.equal(st.linkedinKeyword, 'SEO');
  assert.equal(await win.evaluate(() => localStorage.getItem('lf-linkedin-location')), 'USA');
  assert.deepEqual(errors, []);
});
