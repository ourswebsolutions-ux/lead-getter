'use strict';
// End-to-end UI test of the real Electron app (built renderer). Uses
// temporary app data and a missing Chrome executable, so the user's leads
// database and Chrome are not involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { LeadStore, localDate } = require('../../src/database/db');
const { unlock, activationEnv } = require('./helpers');

const root = path.join(__dirname, '..', '..');
const shots = process.env.LEAD_FINDER_SCREENSHOTS;

const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(12, 0, 0, 0);
  return d;
};

function seed(file) {
  const s = new LeadStore(file);
  const sw = s.ensureCategory('Software House');
  const re = s.ensureCategory('Real Estate');
  let i = 0;
  const add = (name, cat, when, phoneRaw = '0300 1234567', address = 'Gulberg, Lahore, Pakistan') =>
    s.save(
      { placeKey: `0x${++i}:0x9`, mapsUrl: `https://www.google.com/maps/place/S${i}`, name, phoneRaw, address, websiteStatus: 'no_website', categoryId: cat?.id ?? null },
      when.toISOString(),
    );
  add('Today Soft A', sw, new Date());
  add('Today Estate B', re, new Date(), '0673361621');
  add('خان اسٹیٹ, "Past" Estate', re, daysAgo(1));
  add('Past Soft C', sw, daysAgo(1));
  add('Old Soft D', sw, daysAgo(3));
  add('Old Uncategorized E', null, daysAgo(3));
  s.close();
}

async function launch(env) {
  const app = await _electron.launch(process.env.LEAD_FINDER_EXE ? { executablePath: process.env.LEAD_FINDER_EXE, args: [], env } : { args: [root], cwd: root, env });
  const win = await app.firstWindow();
  await unlock(win);
  await win.getByRole('heading', { name: 'Lead Finder' }).waitFor();
  return { app, win };
}

const names = (win) => win.locator('tbody td.name').allTextContents();

test('categories, today/past views, filters, exports and deletion through the real UI', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-e2e-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  seed(path.join(userData, 'leads.db'));
  const env = { ...process.env, ...activationEnv, LEAD_FINDER_USER_DATA: userData, LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome') };
  delete env.ELECTRON_RUN_AS_NODE;

  let { app, win } = await launch(env);
  t.after(async () => {
    await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));

  // Native dialogs answered by the test: save path and delete confirmations.
  const answer = (response, file) =>
    app.evaluate(({ dialog }, { response, file }) => {
      dialog.showMessageBox = async () => ({ response });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, { response, file });

  // --- Today is the default view: only today's leads.
  await win.getByRole('heading', { name: /Today's leads/ }).waitFor();
  assert.deepEqual((await names(win)).sort(), ['Today Estate B', 'Today Soft A']);

  // --- Category input: required, suggestions, one-click pick, title case.
  const start = win.getByRole('button', { name: 'Start Search' });
  await win.getByLabel('Search keyword').fill('Software House in Lahore');
  assert.ok(await start.isDisabled(), 'category required');
  const cat = win.getByRole('combobox', { name: 'Category', exact: true });
  await cat.fill('soft');
  const suggestions = win.locator('#cat-list');
  assert.deepEqual(await suggestions.getByRole('option').allTextContents(), ['Software House3']);
  await suggestions.getByRole('option', { name: /Software House/ }).click();
  assert.equal(await cat.inputValue(), 'Software House');
  assert.ok(await start.isEnabled());
  await cat.fill('real   estate');
  await win.getByLabel('Search keyword').click(); // blur
  assert.equal(await cat.inputValue(), 'Real Estate');
  await cat.fill('web  design agency');
  await win.getByLabel('Search keyword').click();
  assert.equal(await cat.inputValue(), 'Web Design Agency');
  // Starting saves the new category even though Chrome is unavailable here.
  await start.click();
  await win.locator('.state-error').waitFor({ timeout: 20_000 });
  assert.match(await win.locator('.progress .msg').textContent(), /Google Chrome is not installed or could not be located/);
  const filterOptions = await win.getByLabel('Show category').locator('option').allTextContents();
  assert.ok(filterOptions.some((o) => o.startsWith('Web Design Agency')), 'new category saved');
  await cat.fill('web design AGENCY');
  await win.getByLabel('Search keyword').click();
  await start.click();
  await win.locator('.state-error').waitFor();
  const after = await win.getByLabel('Show category').locator('option').allTextContents();
  assert.equal(after.filter((o) => /^web design agency/i.test(o)).length, 1, 'no duplicate category');

  // --- Today + category filter.
  const catFilter = win.getByLabel('Show category');
  await catFilter.selectOption({ label: 'Software House (3)' });
  await win.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
  assert.deepEqual(await names(win), ['Today Soft A']);
  await catFilter.selectOption('all');

  // --- Past leads: hidden from Today, available here.
  await win.getByRole('tab', { name: 'Past leads' }).click();
  await win.getByRole('heading', { name: /Past leads/ }).waitFor();
  await win.waitForFunction(() => document.querySelectorAll('tbody tr').length === 4);
  const dateSel = win.getByLabel('Show date');
  // All past dates + 2 dates with leads + Date range.
  await win.waitForFunction(() => document.querySelector('select[aria-label="Show date"]')?.options.length === 4);
  const dateOpts = await dateSel.locator('option').allTextContents();
  assert.equal(dateOpts[0], 'All past dates');
  assert.match(dateOpts[1], /\(2\)$/);
  assert.match(dateOpts[2], /\(2\)$/);
  // One date
  await dateSel.selectOption(localDate(daysAgo(1)));
  await win.waitForFunction(() => document.querySelectorAll('tbody tr').length === 2);
  // Category + date
  await catFilter.selectOption({ label: 'Software House (3)' });
  await win.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
  assert.deepEqual(await names(win), ['Past Soft C']);
  // Export category + date
  const out1 = path.join(tmp, 'cat-date.csv');
  await answer(0, out1);
  await win.getByRole('button', { name: /^Export CSV/ }).click();
  await win.locator('.notice.ok').first().waitFor();
  let csv = fs.readFileSync(out1, 'utf8').slice(1).trim().split('\r\n');
  assert.equal(csv[0], 'Business Name,Phone,Phone Status,Address,Google Maps URL,Website Status,WhatsApp,Category,Date Discovered,Source,Facebook Post URL,Facebook Page URL,Contact Name,Post Text,Email,Website,LinkedIn Company URL,LinkedIn Job URL,LinkedIn Post URL,Job Title,Discovery,Podcast Host,Apple Podcasts URL,RSS Feed URL,All Emails,Podcast Platforms,Search Keyword,Email Status,LinkedIn Profile URL,Person Title,Company,All Phones,Contact Provider');
  assert.equal(csv.length, 2);
  assert.match(csv[1], new RegExp(`^Past Soft C,.*,Software House,${localDate(daysAgo(1))} 12:00,Google Maps,,,,,,,,,,,,,,,,,,,,,,,$`));

  // Date range (all categories) covering 3 days ago .. yesterday
  await catFilter.selectOption('all');
  await dateSel.selectOption('range');
  await win.getByLabel('From date').fill(localDate(daysAgo(3)));
  await win.getByLabel('To date').fill(localDate(daysAgo(1)));
  await win.waitForFunction(() => document.querySelectorAll('tbody tr').length === 4);
  const out2 = path.join(tmp, 'range.csv');
  await answer(0, out2);
  await win.getByRole('button', { name: /^Export CSV/ }).click();
  await win.waitForFunction(() => /Exported 4 leads/.test([...document.querySelectorAll('.notice')].map((n) => n.textContent).join(' ')));
  csv = fs.readFileSync(out2, 'utf8');
  assert.match(csv, /"خان اسٹیٹ, ""Past"" Estate",.*,Real Estate,/);
  assert.match(csv, /Old Uncategorized E,.*,Uncategorized,/);
  assert.doesNotMatch(csv, /Today Soft A/);

  // Export all
  const out3 = path.join(tmp, 'all.csv');
  await answer(0, out3);
  await win.getByRole('button', { name: 'Export all' }).click();
  await win.waitForFunction(() => /Exported 6 leads/.test([...document.querySelectorAll('.notice')].map((n) => n.textContent).join(' ')));
  assert.equal(fs.readFileSync(out3, 'utf8').trim().split('\r\n').length, 7);

  if (shots) await win.screenshot({ path: path.join(shots, 'past-leads.png') });

  // --- Deletion. Cancel keeps everything.
  await answer(1, '');
  await win.getByRole('button', { name: 'Delete Old Soft D' }).click();
  await win.waitForTimeout(300);
  assert.equal(await win.locator('tbody tr').count(), 4);
  // Single delete
  await answer(0, '');
  await win.getByRole('button', { name: 'Delete Old Soft D' }).click();
  await win.waitForFunction(() => document.querySelectorAll('tbody tr').length === 3);
  // Multiple selected
  await win.getByRole('checkbox', { name: 'Select Past Soft C' }).check();
  await win.getByRole('checkbox', { name: 'Select Old Uncategorized E' }).check();
  await win.getByRole('button', { name: 'Delete selected (2)' }).click();
  await win.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
  assert.match((await names(win))[0], /Past" Estate/);

  // --- Back to today, delete all shown in one category only.
  await win.getByRole('tab', { name: 'Today' }).click();
  await win.getByRole('heading', { name: /Today's leads/ }).waitFor();
  await catFilter.selectOption({ label: 'Real Estate (2)' });
  await win.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
  await win.getByRole('button', { name: 'Delete all shown' }).click();
  await win.waitForFunction(() => document.querySelectorAll('tbody tr').length === 0);
  await catFilter.selectOption('all');
  await win.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
  assert.deepEqual(await names(win), ['Today Soft A']);
  const catsLeft = await catFilter.locator('option').allTextContents();
  assert.ok(catsLeft.some((o) => o.startsWith('Real Estate')), 'categories kept after deleting their leads');
  if (shots) await win.screenshot({ path: path.join(shots, 'today.png') });
  assert.deepEqual(errors, []);

  // --- Restart: history is still there.
  await app.close();
  ({ app, win } = await launch(env));
  assert.deepEqual(await names(win), ['Today Soft A']);
  await win.getByRole('tab', { name: 'Past leads' }).click();
  await win.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
  assert.match((await names(win))[0], /Past" Estate/);
});
