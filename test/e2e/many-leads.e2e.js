'use strict';
// A long lead list in the real Electron app: the table draws 500 rows at a
// time with "Show more", and a new filter or search starts from the top.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { LeadStore } = require('../../src/database/db');
const { unlock } = require('./helpers');

const root = path.join(__dirname, '..', '..');
const TOTAL = 1200;

function seed(file) {
  const s = new LeadStore(file);
  const cat = s.ensureCategory('Real Estate');
  s.transaction(() => {
    for (let i = 0; i < TOTAL; i++) {
      s.save({ placeKey: `0x${i}:0x9`, mapsUrl: `https://www.google.com/maps/place/M${i}`, name: `Many Leads ${i}`, phoneRaw: `0300${1000000 + i}`, address: 'Lahore, Pakistan', websiteStatus: 'no_website', categoryId: cat.id });
    }
  });
  s.close();
}

test('a long lead list is drawn in pages', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-many-e2e-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  seed(path.join(userData, 'leads.db'));
  const env = {
    ...process.env,
    LEAD_FINDER_USER_DATA: userData,
    LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome'),
    LEAD_FINDER_NO_UPDATES: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [root], cwd: root, env });
  t.after(async () => {
    await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const win = await app.firstWindow();
  await unlock(win);
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  await win.getByRole('heading', { name: /Today's leads/ }).waitFor();

  const rows = win.locator('table tbody tr');
  const more = win.getByRole('button', { name: /^Show \d+ more$/ });
  await win.getByText(`Showing 500 of ${TOTAL.toLocaleString('en-US')} leads`).waitFor({ timeout: 20_000 });
  assert.equal(await rows.count(), 500);
  // Newest first, as before.
  assert.match(await rows.first().innerText(), new RegExp(`Many Leads ${TOTAL - 1}\\b`));

  await more.click();
  await win.getByText(`Showing 1,000 of ${TOTAL.toLocaleString('en-US')} leads`).waitFor();
  assert.equal(await rows.count(), 1000);
  assert.equal(await more.innerText(), 'Show 200 more');
  await more.click();
  await more.waitFor({ state: 'detached' });
  assert.equal(await rows.count(), TOTAL);

  // Select all still means every matching lead, not only the drawn ones.
  await win.getByRole('checkbox', { name: 'Select all shown leads' }).check();
  await win.getByRole('button', { name: `Delete selected (${TOTAL})` }).waitFor();
  await win.getByRole('checkbox', { name: 'Select all shown leads' }).uncheck();

  // A search shows its own (short) result in full; clearing it starts over at 500.
  const search = win.getByRole('searchbox', { name: 'Search leads' });
  await search.fill('Many Leads 11');
  await win.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 111);
  assert.equal(await more.count(), 0);
  await search.fill('');
  await win.getByText(`Showing 500 of ${TOTAL.toLocaleString('en-US')} leads`).waitFor();
  assert.equal(await rows.count(), 500);

  assert.deepEqual(errors, []);
});
