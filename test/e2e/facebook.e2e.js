'use strict';
// Facebook Lead Search in the real Electron app: the switch above the Leads
// table is stored by the app (it survives a restart and is what a search
// reads), and Facebook leads sit in the same table with a Source column,
// Source filter, search and Seen/Unseen status.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { DatabaseSync } = require('node:sqlite');
const { LeadStore } = require('../../src/database/db');
const { unlock } = require('./helpers');

const root = path.join(__dirname, '..', '..');

function seed(file) {
  const s = new LeadStore(file);
  const cat = s.ensureCategory('Garments');
  s.save({ placeKey: '0x1:0xf', mapsUrl: 'https://www.google.com/maps/place/MapsOnly', name: 'Maps Only Cloth', phoneRaw: '03001111111', address: 'Lahore, Pakistan', websiteStatus: 'no_website', categoryId: cat.id });
  s.save({ placeKey: '0x2:0xf', mapsUrl: 'https://www.google.com/maps/place/Both', name: 'Both Sources Textile', phoneRaw: '03002222222', address: 'Lahore, Pakistan', websiteStatus: 'no_website', categoryId: cat.id });
  s.saveFacebookLead({ phone: '+923002222222', country: 'PK', raw: '0300 2222222', name: 'Both FB', contactName: 'Both FB', postUrl: 'https://www.facebook.com/both/posts/1', text: 'Textile wholesale 0300 2222222', categoryId: cat.id });
  s.saveFacebookLead({ phone: '+923003333333', country: 'PK', raw: '0300 3333333', name: 'Hamid Fabrics', contactName: 'Hamid Fabrics', postUrl: 'https://www.facebook.com/hamid/posts/7', pageUrl: 'https://www.facebook.com/hamid', text: 'Fabric suppliers, call 0300 3333333', categoryId: cat.id });
  // The Facebook lead was already messaged by a campaign.
  s.db.prepare("INSERT INTO outreach_sends (campaign_id, campaign_name, phone, stage, test, day, status, created_at, sent_at) VALUES (1, 'Garments', '+923003333333', 0, 0, '2026-10-25', 'delivered', 1, 1)").run();
  s.close();
}

async function launch(env) {
  const app = await _electron.launch({ args: [root], cwd: root, env });
  const win = await app.firstWindow();
  await unlock(win);
  return { app, win };
}

test('Facebook Lead Search switch and Facebook leads in the Leads table', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-facebook-e2e-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  const dbFile = path.join(userData, 'leads.db');
  seed(dbFile);
  const env = { ...process.env, LEAD_FINDER_USER_DATA: userData, LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome'), LEAD_FINDER_NO_UPDATES: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  let { app, win } = await launch(env);
  t.after(async () => {
    await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  await win.getByRole('heading', { name: /Today's leads/ }).waitFor();

  // --- The switch: off by default, stored by the app, kept after a restart.
  const sw = win.getByRole('switch', { name: 'Facebook Lead Search' });
  assert.equal(await sw.getAttribute('aria-checked'), 'false');
  await win.getByText('Off: Google Maps only.').waitFor();
  await sw.click();
  await win.getByText(/On: public Facebook posts are searched at the same time as Google Maps/).waitFor();
  assert.equal(await sw.getAttribute('aria-checked'), 'true');
  await app.close();
  const stored = new DatabaseSync(dbFile, { readOnly: true });
  assert.equal(stored.prepare("SELECT value FROM app_state WHERE key = 'facebookSearch'").get()?.value, 'true', 'the backend has the setting');
  stored.close();
  ({ app, win } = await launch(env));
  win.on('pageerror', (e) => errors.push(e.message));
  await win.getByRole('heading', { name: /Today's leads/ }).waitFor();
  await win.getByRole('switch', { name: 'Facebook Lead Search', checked: true }).waitFor();

  // --- One table for both sources; the number found in both is one lead.
  const rows = win.locator('table tbody tr');
  await win.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 3);
  const row = (name) => rows.filter({ hasText: name });
  assert.deepEqual(await row('Maps Only Cloth').locator('td.sources .chip').allInnerTexts(), ['Maps']);
  assert.deepEqual(await row('Both Sources Textile').locator('td.sources .chip').allInnerTexts(), ['Maps', 'Facebook']);
  assert.deepEqual(await row('Hamid Fabrics').locator('td.sources .chip').allInnerTexts(), ['Facebook']);
  assert.match(await row('Hamid Fabrics').innerText(), /Not checked/);
  assert.match(await row('Hamid Fabrics').innerText(), /Seen/);
  await row('Hamid Fabrics').getByRole('button', { name: 'Open Hamid Fabrics on Facebook' }).waitFor();

  // --- Source filter, with search and the Seen/Unseen filter.
  const source = win.getByRole('combobox', { name: 'Show source' });
  await source.selectOption('facebook');
  await win.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 2);
  await source.selectOption('maps');
  await win.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 2);
  assert.equal(await row('Hamid Fabrics').count(), 0);
  await source.selectOption('all');
  await win.getByRole('combobox', { name: 'Show campaign status' }).selectOption('seen');
  await win.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 1);
  assert.equal(await row('Hamid Fabrics').count(), 1);
  await win.getByRole('combobox', { name: 'Show campaign status' }).selectOption('all');
  await win.getByRole('searchbox', { name: 'Search leads' }).fill('3333333');
  await win.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 1);
  assert.equal(await row('Hamid Fabrics').count(), 1);
  await win.getByRole('searchbox', { name: 'Search leads' }).fill('');
  await win.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 3);

  if (process.env.LEAD_FINDER_SCREENSHOTS) await win.screenshot({ path: path.join(process.env.LEAD_FINDER_SCREENSHOTS, 'facebook-leads.png') });

  // --- Switching off is stored too.
  await win.getByRole('switch', { name: 'Facebook Lead Search' }).click();
  await win.getByText('Off: Google Maps only.').waitFor();
  assert.deepEqual(await win.evaluate(() => window.leadFinder.facebookSearch()), { on: false });
  assert.deepEqual(errors, []);
});
