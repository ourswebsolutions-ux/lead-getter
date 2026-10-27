'use strict';
// Leads found during a search reach the Leads table on their own, in the
// real Electron app: saved to the app's database from the main process (as
// the Google Maps and Facebook workers do, interleaved) and announced on the
// same channel. Covers the window being behind Chrome, every filter (each
// new lead shows exactly when it matches), a reload racing new leads, no
// duplicate rows, the empty-state messages, and campaign history.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { LeadStore } = require('../../src/database/db');
const { unlock, activationEnv } = require('./helpers');

const root = path.join(__dirname, '..', '..');
const dbModule = path.join(root, 'src', 'database', 'db.js');

function seed(file) {
  const s = new LeadStore(file);
  const a = s.ensureCategory('Garments');
  s.ensureCategory('Real Estate');
  s.save({ placeKey: '0x100:0x1', mapsUrl: 'https://www.google.com/maps/place/Seen', name: 'Already Messaged Cloth', phoneRaw: '03009990001', address: 'Lahore, Pakistan', websiteStatus: 'no_website', categoryId: a.id });
  s.db.prepare("INSERT INTO outreach_sends (campaign_id, campaign_name, phone, stage, test, day, status, created_at, sent_at) VALUES (1, 'Garments', '+923009990001', 0, 0, '2026-10-25', 'read', 1, 1)").run();
  s.close();
  return a.id;
}

test('leads from both sources appear in the table as they are found', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-live-e2e-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  const dbFile = path.join(userData, 'leads.db');
  seed(dbFile);
  const env = { ...process.env, ...activationEnv, LEAD_FINDER_USER_DATA: userData, LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome'), LEAD_FINDER_NO_UPDATES: '1' };
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

  // In the main process: save like the search workers and announce the
  // lead on the app's channel. kind: 'maps' | 'facebook'.
  let n = 0;
  const found = (kind, name, phone, category = 'Garments') =>
    app.evaluate(
      ({ BrowserWindow }, a) => {
        const { LeadStore } = process.mainModule.require(a.dbModule);
        const s = new LeadStore(a.dbFile);
        try {
          const cat = s.ensureCategory(a.category);
          const r =
            a.kind === 'maps'
              ? s.save({ placeKey: `0x${a.n}:0x2`, mapsUrl: `https://www.google.com/maps/place/L${a.n}`, name: a.name, phoneRaw: a.phone, address: 'Lahore, Pakistan', websiteStatus: 'no_website', categoryId: cat.id })
              : s.saveFacebookLead({ phone: a.phone, country: 'PK', raw: a.phone, name: a.name, contactName: a.name, postUrl: `https://www.facebook.com/p${a.n}/posts/${a.n}`, text: `Call ${a.phone}`, categoryId: cat.id });
          if (r.lead) BrowserWindow.getAllWindows()[0].webContents.send('leads:added', r.lead);
          return r.lead?.id ?? null;
        } finally {
          s.close();
        }
      },
      { dbModule, dbFile, kind, name, phone, category, n: ++n },
    );
  const rows = win.locator('table tbody tr');
  const names = async () => (await rows.locator('td.name').allInnerTexts()).sort();
  const until = async (fn, what) => {
    const end = Date.now() + 8000;
    let last;
    while (Date.now() < end) {
      last = await fn();
      if (last === true) return;
      await win.waitForTimeout(100);
    }
    assert.fail(`${what} (last: ${JSON.stringify(last)})`);
  };
  const rowCount = (k) => until(async () => (await rows.count()) === k || (await rows.count()), `${k} rows`);
  const status = (state) => app.evaluate(({ BrowserWindow }, st) => BrowserWindow.getAllWindows()[0].webContents.send('search:status', { state: st, message: st === 'running' ? 'Searching' : 'Search finished' }), state);

  await rowCount(1);

  // --- A search runs: Maps and Facebook leads arrive interleaved, with no click.
  await status('running');
  await found('maps', 'Maps Cloth One', '+923001110001');
  await found('facebook', 'FB Fabrics One', '+923001110002');
  await found('maps', 'Maps Cloth Two', '+923001110003');
  await found('facebook', 'FB Fabrics Two', '+923001110004');
  await rowCount(5);
  // The same number from the other source updates the row; no duplicate.
  await found('facebook', 'FB Says Maps One', '+923001110001');
  await rowCount(5);
  await until(async () => (await rows.filter({ hasText: 'Maps Cloth One' }).locator('td.sources .chip').allInnerTexts()).join() === 'Maps,Facebook', 'merged row shows both sources');
  assert.equal(await rows.first().locator('td.name').innerText(), 'FB Fabrics Two', 'newest first');

  // --- The window is behind Chrome (hidden): leads still reach the table.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await found('maps', 'While Hidden', '+923001110005');
  await until(async () => (await win.evaluate(() => document.querySelectorAll('table tbody tr').length)) === 6 || (await win.evaluate(() => [document.visibilityState, document.querySelectorAll('table tbody tr').length])), 'lead added while the window is hidden');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());

  // --- Filters: a new lead shows exactly when it matches.
  const search = win.getByRole('searchbox', { name: 'Search leads' });
  await search.fill('Textile');
  await rowCount(0);
  await win.getByRole('heading', { name: 'No leads found' }).waitFor();
  await found('facebook', 'Textile Hub', '+923001110006');
  await found('maps', 'Unrelated Shop', '+923001110007');
  await until(async () => JSON.stringify(await names()) === '["Textile Hub"]' || (await names()), 'a matching lead shows with a search typed');
  await search.fill('');
  await rowCount(8);

  const campaign = win.getByRole('combobox', { name: 'Show campaign status' });
  await campaign.selectOption('unseen');
  await rowCount(7);
  await found('maps', 'New Unseen', '+923001110008');
  await rowCount(8);
  await campaign.selectOption('seen');
  await rowCount(1);
  await found('facebook', 'Not Seen Yet', '+923001110009');
  await win.waitForTimeout(600);
  assert.deepEqual(await names(), ['Already Messaged Cloth'], 'an Unseen lead does not enter the Seen view');
  await campaign.selectOption('all');

  const category = win.getByRole('combobox', { name: 'Show category' });
  const realEstate = await category.locator('option', { hasText: 'Real Estate' }).getAttribute('value');
  await category.selectOption(realEstate);
  await rowCount(0);
  await found('maps', 'Garments Again', '+923001110010', 'Garments');
  await found('facebook', 'Estate Agent', '+923001110011', 'Real Estate');
  await until(async () => JSON.stringify(await names()) === '["Estate Agent"]' || (await names()), 'only the selected category');
  await category.selectOption('all');

  const source = win.getByRole('combobox', { name: 'Show source' });
  await source.selectOption('facebook');
  // Facebook leads so far: FB Fabrics One/Two, Maps Cloth One (also on
  // Facebook), Textile Hub, Not Seen Yet, Estate Agent.
  await rowCount(6);
  await found('maps', 'Maps Only Later', '+923001110012');
  await found('facebook', 'FB Later', '+923001110013');
  await rowCount(7);
  await source.selectOption('all');

  // --- WhatsApp only: a number confirmed during the search shows up.
  await win.getByRole('checkbox', { name: 'WhatsApp numbers only' }).check();
  await rowCount(0);
  await app.evaluate(
    ({ BrowserWindow }, a) => {
      const { LeadStore } = process.mainModule.require(a.dbModule);
      const s = new LeadStore(a.dbFile);
      s.setWhatsAppResult('+923001110013', 'available', 'baileys');
      BrowserWindow.getAllWindows()[0].webContents.send('leads:whatsapp', { phone: '+923001110013', leads: s.listLeads().filter((l) => l.phone === '+923001110013') });
      s.close();
    },
    { dbModule, dbFile },
  );
  await until(async () => JSON.stringify(await names()) === '["FB Later"]' || (await names()), 'confirmed number appears under WhatsApp only');
  await win.getByRole('checkbox', { name: 'WhatsApp numbers only' }).uncheck();

  // --- A reload on its way while new leads arrive: none are lost.
  await rowCount(14);
  const before = 14;
  await win.evaluate(() => window.leadFinder.listLeads({ category: 'all' })); // warm
  await Promise.all([campaign.selectOption('unseen'), found('maps', 'Race One', '+923001110014'), found('facebook', 'Race Two', '+923001110015')]);
  await campaign.selectOption('all');
  await rowCount(before + 2);
  const all = await names();
  assert.equal(new Set(all).size, all.length, 'no duplicate rows');

  // --- Empty states.
  await win.getByRole('tab', { name: 'Past leads' }).click();
  await win.getByText('Leads from the running search are listed under Today.').waitFor();
  await win.getByRole('button', { name: 'Show Today' }).click();
  await search.fill('nothing matches this');
  await win.getByText(/No lead found so far matches the current filters/).waitFor();
  await win.getByRole('button', { name: 'Show all leads' }).click();
  await rowCount(before + 2);
  assert.equal(await search.inputValue(), '');
  await status('done');

  // --- Campaign history untouched; the messaged lead is still Seen.
  const check = new LeadStore(dbFile);
  assert.equal(check.db.prepare('SELECT COUNT(*) n FROM outreach_sends').get().n, 1);
  assert.equal(check.listLeads().find((l) => l.phone === '+923009990001').campaign, 'seen');
  assert.equal(check.listLeads().length, before + 2);
  check.close();
  assert.deepEqual(errors, []);
});
