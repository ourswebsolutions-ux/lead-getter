'use strict';
// SMS campaigns in the real app, with the scripted phone of
// test/fixtures/fake-bt-helper.py (Message Access): a campaign with a
// personalised message, recipients from leads (picker with select all), an
// opted-out lead, an Excel file (mapping, check: valid / invalid / repeated),
// the preview with real data, sending one at a time (pause, resume), each
// recipient's status (submitted -> sent -> delivered as the phone reports,
// skipped with its reason), and the campaign list.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { unlock, activationEnv } = require('./helpers');

const root = path.join(__dirname, '..', '..');

test('SMS campaign: leads and an Excel file, preview, sending with pause, statuses, opted out skipped', async (t) => {
  const { LeadStore } = require('../../src/database/db');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-campaign-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  const seed = new LeadStore(path.join(userData, 'leads.db'));
  seed.save({ placeKey: 'p1', mapsUrl: 'https://www.google.com/maps/place/A', name: 'Acme Plumbing', keyword: 'plumber', phone: '+923001234567', address: '5 Mall Rd, Gulberg, Lahore, Punjab 54000, Pakistan', websiteStatus: 'no_website' });
  seed.save({ placeKey: 'p2', mapsUrl: 'https://www.google.com/maps/place/B', name: 'Bright Dental', keyword: 'dentist', phone: '+923214455667', websiteStatus: 'no_website' });
  seed.save({ placeKey: 'p3', mapsUrl: 'https://www.google.com/maps/place/C', name: 'Corner Shop', keyword: 'shop', phone: '+923335550000', websiteStatus: 'no_website' });
  seed.optOut('+923335550000', 'STOP');
  seed.setState('phoneCountry', 'PK');
  seed.close();
  const env = { ...process.env, ...activationEnv, LEAD_FINDER_USER_DATA: userData, LEAD_FINDER_NO_UPDATES: '1', LEAD_FINDER_BT_HELPER: path.join(root, 'test', 'fixtures', 'fake-bt-helper.py') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [root], cwd: root, env });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  win.on('dialog', (d) => d.accept());
  t.after(async () => {
    await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  await unlock(win);
  const counts = async () => (await win.evaluate(() => window.leadFinder.smsCampaigns()))[0];
  const until = async (fn, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 500))) if (await fn()) return;
    throw new Error(`Timed out: ${fn}`);
  };

  // The phone (Hands-Free and Message Access).
  await win.getByRole('button', { name: 'Dialer' }).click();
  const phone = win.getByRole('region', { name: 'Phone' });
  await phone.getByRole('button', { name: 'Find phone' }).click();
  await phone.getByRole('button', { name: 'Connect Test Phone' }).click();
  await win.getByRole('dialog', { name: 'Pair phone' }).getByRole('button', { name: 'Codes match' }).click();
  await phone.locator('.dl-pill').filter({ hasText: 'Connected' }).waitFor();

  // A campaign with its own message.
  await win.getByRole('button', { name: 'Messages' }).click();
  const messages = win.getByRole('region', { name: 'Messages' });
  await messages.getByText(/SMS through your phone/).waitFor();
  await messages.getByRole('button', { name: 'Campaigns' }).click();
  await messages.getByRole('button', { name: 'New campaign' }).first().click();
  await messages.getByLabel('New campaign name').fill('Websites Lahore');
  await messages.getByRole('button', { name: 'Create' }).click();
  const text = messages.getByLabel('Campaign message');
  await text.fill('Assalam-o-Alaikum {name}, kya ');
  await messages.getByRole('button', { name: '{business_name}' }).click(); // inserted at the cursor
  await text.press('End');
  await text.type(' aapka business hai? ({city})');
  assert.equal(await text.inputValue(), 'Assalam-o-Alaikum {name}, kya {business_name} aapka business hai? ({city})');
  await messages.getByRole('button', { name: 'Save' }).click();
  await win.locator('.toast').filter({ hasText: 'Saved.' }).waitFor();
  await messages.getByLabel('Speed').selectOption('fast');

  // Recipients from leads: select all, the opted-out one included (it is skipped when sending).
  await messages.getByRole('button', { name: 'From leads' }).click();
  const picker = win.getByRole('dialog', { name: 'Choose leads' });
  await picker.getByText('Bright Dental').waitFor();
  await picker.getByLabel('Location').fill('lahore');
  await picker.getByText('Bright Dental').waitFor({ state: 'detached' });
  await picker.getByLabel('Location').fill('');
  await picker.getByLabel('Select all filtered').check();
  await picker.getByRole('button', { name: 'Add 3 leads' }).click();
  await win.locator('.toast').filter({ hasText: '3 added' }).waitFor();

  // Recipients from an Excel file: mapping, the check, then add.
  await app.evaluate(({ dialog }, f) => (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })), path.join(root, 'test', 'fixtures', 'numbers.xlsx'));
  await messages.getByRole('button', { name: 'Import file' }).click();
  const imp = win.getByRole('dialog', { name: 'Import contacts' });
  await imp.getByRole('button', { name: /Choose a file/ }).click();
  assert.equal(await imp.getByLabel('Column for City').inputValue(), '3');
  await imp.getByRole('button', { name: 'Check contacts' }).click();
  assert.match(await imp.innerText(), /4\s+Valid, will be added/);
  assert.match(await imp.innerText(), /1\s+Invalid, left out/);
  assert.match(await imp.innerText(), /1\s+Repeated in the file/);
  await imp.getByRole('button', { name: 'Add 4 contacts' }).click();
  await win.locator('.toast').filter({ hasText: '4 contacts added' }).waitFor();

  // The preview, with real data.
  const preview = messages.getByLabel('Preview', { exact: true });
  // Newest leads first: Corner Shop (no city: no empty brackets), Bright Dental, then Acme Plumbing in Lahore.
  await preview.getByText('Assalam-o-Alaikum Corner Shop, kya Corner Shop aapka business hai?', { exact: true }).waitFor();
  await preview.getByRole('button', { name: 'Next preview' }).click();
  await preview.getByText(/Bright Dental/).first().waitFor();
  await preview.getByRole('button', { name: 'Next preview' }).click();
  await preview.getByText('Assalam-o-Alaikum Acme Plumbing, kya Acme Plumbing aapka business hai? (Lahore)').waitFor();
  const stats = messages.locator('.cp-stats');
  assert.match(await stats.innerText(), /7\s+Recipients/);

  // Start; pause after the first; resume; it finishes by itself.
  await messages.getByRole('button', { name: 'Start' }).click();
  await until(async () => (await counts()).counts.pending < 6, 20_000); // the first is handed to the phone (and the opted-out one skipped)
  await messages.getByRole('button', { name: 'Pause' }).click();
  await messages.locator('.cp-head .dl-pill').filter({ hasText: 'Paused' }).waitFor();
  const paused = (await win.evaluate(() => window.leadFinder.smsCampaigns()))[0].counts;
  await new Promise((r) => setTimeout(r, 12_000));
  assert.deepEqual((await win.evaluate(() => window.leadFinder.smsCampaigns()))[0].counts.pending, paused.pending); // nothing sent while paused
  await messages.getByRole('button', { name: 'Resume' }).click();
  // One every 15 s: about a minute and a half for the rest.
  await until(async () => (await counts()).status === 'done', 150_000);
  await until(async () => (await counts()).counts.delivered === 6, 30_000);
  const c = (await win.evaluate(() => window.leadFinder.smsCampaigns()))[0];
  assert.deepEqual({ total: c.counts.total, delivered: c.counts.delivered, skipped: c.counts.skipped, failed: c.counts.failed }, { total: 7, delivered: 6, skipped: 1, failed: 0 });
  // Each recipient's status; the opted-out lead skipped with its reason.
  const rec = messages.getByRole('region', { name: 'Recipients' });
  await rec.locator('tr').filter({ hasText: 'Corner Shop' }).getByText('Opted out: never texted').waitFor();
  assert.match(await rec.locator('tr').filter({ hasText: 'Zoë Müller' }).innerText(), /Delivered/);
  // The sent texts, personalised; the leads are SMS sent.
  const sent = await win.evaluate(() => window.leadFinder.smsMessages('+923214455667'));
  assert.equal(sent.messages[0].body, 'Assalam-o-Alaikum Bright Dental, kya Bright Dental aapka business hai?');
  const leads = await win.evaluate(() => window.leadFinder.listLeads({ category: 'all' }));
  assert.equal(leads.find((l) => l.name === 'Acme Plumbing').smsStatus, 'seen');
  assert.equal(leads.find((l) => l.name === 'Corner Shop').smsStatus, 'unseen');
  // The campaign list.
  const card = messages.locator('.cp-card').filter({ hasText: 'Websites Lahore' });
  assert.match(await card.innerText(), /Finished/);
  assert.match(await card.innerText(), /6 sent · 6 delivered · 0 failed/);
  assert.deepEqual(errors, []);
});
