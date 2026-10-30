'use strict';
// Numbers and Messages in the real app, with the scripted phone of
// test/fixtures/fake-bt-helper.py (Hands-Free and Message Access): a number
// category, importing an Excel file and pasted numbers (mapping, duplicates,
// international format), search and status filters, Do not call, calling a
// number from its category (Call Seen; the lead with another number is
// untouched), the Auto Dialer on that category, SMS: the inbox, sending
// with a template, delivered, SMS sent on the lead (apart from WhatsApp
// and calls).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { unlock, activationEnv } = require('./helpers');

const root = path.join(__dirname, '..', '..');

test('Numbers: categories, Excel and pasted import, calls, Auto Dialer by category; Messages: SMS', async (t) => {
  const { LeadStore } = require('../../src/database/db');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-numbers-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  const seed = new LeadStore(path.join(userData, 'leads.db'));
  seed.save({ placeKey: 'p1', mapsUrl: 'https://www.google.com/maps/place/A', name: 'Acme Plumbing', keyword: 'plumber', phone: '+923001234567', websiteStatus: 'no_website' });
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

  // Connect the phone (Dialer).
  await win.getByRole('button', { name: 'Dialer' }).click();
  const phone = win.getByRole('region', { name: 'Phone' });
  await phone.getByRole('button', { name: 'Find phone' }).click();
  await phone.getByRole('button', { name: 'Connect Test Phone' }).click();
  await win.getByRole('dialog', { name: 'Pair phone' }).getByRole('button', { name: 'Codes match' }).click();
  await phone.locator('.dl-pill').filter({ hasText: 'Connected' }).waitFor();
  // Two columns: the Auto Dialer and Recent calls on the left, the dial pad on the right.
  const left = await win.locator('.dl-left').boundingBox();
  const pad = await win.getByRole('region', { name: 'Dial pad' }).boundingBox();
  assert.ok(left.x + left.width <= pad.x, 'left column, then the dialer');
  assert.ok(await win.getByRole('region', { name: 'Auto Dialer' }).evaluate((el) => el.closest('.dl-left') !== null));
  await win.getByLabel('Microphone').waitFor(); // microphone and speaker choice by the dial pad
  await win.getByLabel('Speaker or headphones').waitFor();

  // Numbers: a category, an Excel import with its mapping.
  await win.getByRole('button', { name: 'Numbers' }).click();
  const numbers = win.getByRole('region', { name: 'Numbers' });
  await numbers.getByRole('button', { name: 'New category' }).first().click();
  await numbers.getByLabel('Category name').fill('SEO USA');
  await numbers.getByLabel('Category name').press('Enter');
  await numbers.getByRole('heading', { name: 'SEO USA' }).waitFor();
  await app.evaluate(({ dialog }, f) => (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })), path.join(root, 'test', 'fixtures', 'numbers.xlsx'));
  await numbers.getByRole('button', { name: 'Import numbers' }).click();
  const imp = win.getByRole('dialog', { name: 'Import numbers' });
  await imp.getByRole('button', { name: /Choose a file/ }).click();
  assert.equal(await imp.getByLabel('Column for Phone number').inputValue(), '2');
  assert.equal(await imp.getByLabel('Column for Name').inputValue(), '0');
  assert.equal(await imp.getByLabel('Column for Business').inputValue(), '1');
  await imp.getByRole('button', { name: 'Import', exact: true }).click();
  await win.locator('.toast').filter({ hasText: '4 numbers added · 1 repeated in the file · 1 without a phone number' }).waitFor();
  const table = numbers.locator('table.nm-table');
  await table.getByText('+923001112233').waitFor();
  assert.equal(await table.locator('tbody tr').count(), 4);
  // Pasted numbers: one is already in the category, one is also a lead.
  await numbers.getByRole('button', { name: 'Import numbers' }).click();
  await imp.getByLabel(/Or paste numbers/).fill('0300 1112233\n0300 1234567\n0333 7778889');
  await imp.getByRole('button', { name: 'Continue' }).click();
  await imp.getByRole('button', { name: 'Import', exact: true }).click();
  await win.locator('.toast').filter({ hasText: '2 numbers added · 1 already in this category · 1 also in another category or your leads' }).waitFor();
  await table.getByText('+923337778889').waitFor();
  const dupRow = table.locator('tbody tr').filter({ hasText: '+923001234567' });
  await dupRow.getByText('Duplicate').waitFor();
  // Stats, search, Do not call.
  assert.match(await numbers.locator('.nm-stats').innerText(), /6\s+Total/);
  await numbers.getByLabel('Search numbers').fill('web works');
  await table.locator('tbody tr').filter({ hasText: 'Ali Raza' }).waitFor({ state: 'detached' });
  assert.equal(await table.locator('tbody tr').count(), 1);
  assert.match(await table.innerText(), /Sara Khan/);
  await numbers.getByLabel('Search numbers').fill('');
  await table.locator('tbody tr').filter({ hasText: 'Ali Raza' }).waitFor();
  await table.locator('tbody tr').filter({ hasText: '+447911123456' }).getByRole('button', { name: /Call Unseen/ }).click();
  await table.locator('tbody tr').filter({ hasText: '+447911123456' }).getByRole('button', { name: /Do not call/ }).waitFor();

  // Call a number from its category: it becomes Call Seen; the lead (another channel status) stays as it was.
  await table.locator('tbody tr').filter({ hasText: 'Ali Raza' }).getByRole('button', { name: 'Call Ali Raza' }).click();
  const dialPad = win.getByRole('region', { name: 'Dial pad' });
  await dialPad.locator('.dl-state').filter({ hasText: 'Connected' }).waitFor();
  assert.match(await dialPad.innerText(), /Ali Raza/);
  await dialPad.getByRole('button', { name: 'End call' }).click();
  await win.getByRole('button', { name: 'Numbers' }).click();
  await table.locator('tbody tr').filter({ hasText: 'Ali Raza' }).getByRole('button', { name: /Call Seen/ }).waitFor();
  const acme = (await win.evaluate(() => window.leadFinder.listLeads({ category: 'all' })))[0];
  assert.equal(acme.callStatus, 'unseen');

  // The Auto Dialer on this category: only its unseen, valid, mobile numbers, none called before.
  await win.getByRole('button', { name: 'Dialer' }).click();
  await win.evaluate(() => window.leadFinder.autoDialSettings({ hours: { on: false }, gapSeconds: 5 }));
  const auto = win.getByRole('region', { name: 'Auto Dialer' });
  const listId = (await win.evaluate(() => window.leadFinder.numberLists()))[0].id;
  await auto.getByLabel('Auto Dialer calls').selectOption(String(listId));
  // Sara, +923001234567 (also the lead Acme, not yet called) and +923337778889; not Ali (called), the landline, the UK do-not-call.
  await auto.getByText(/3 ready/).waitFor();
  await auto.getByRole('switch', { name: 'Auto Dialer' }).click();
  await dialPad.getByText('Sara Khan').waitFor({ timeout: 20_000 });
  await dialPad.locator('.dl-state').filter({ hasText: 'Connected' }).waitFor();
  await dialPad.getByRole('button', { name: 'End call' }).click();
  await auto.getByText(/Next call in (59|60)s/).waitFor();
  await auto.getByRole('switch', { name: 'Auto Dialer' }).click();
  const st = await win.evaluate(() => window.leadFinder.autoDialState());
  assert.equal(st.status, 'off');
  assert.equal(st.processed, 1);
  // Recent calls: two.
  assert.equal(await win.getByRole('region', { name: 'Recent calls' }).locator('li').count(), 2);

  // Messages: the inbox message, then a reply with a template, delivered; the lead is SMS sent.
  await win.getByRole('button', { name: 'Messages' }).click();
  const messages = win.getByRole('region', { name: 'Messages' });
  await messages.getByText(/SMS through your phone/).waitFor();
  const thread = messages.getByRole('button', { name: /Acme Plumbing/ });
  await thread.waitFor();
  await thread.click();
  await messages.locator('.ms-bubble.in').filter({ hasText: 'Is the offer still open?' }).waitFor();
  await messages.getByRole('button', { name: 'Templates' }).click();
  const tpl = win.getByRole('dialog', { name: 'SMS templates' });
  await tpl.getByLabel('Template name').fill('Reply');
  await tpl.getByLabel('Template text').fill('Hi {business}, yes it is!');
  await tpl.getByRole('button', { name: 'Save' }).click();
  await messages.getByLabel('Use a template').selectOption({ label: 'Reply' });
  assert.equal(await messages.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Hi Acme Plumbing, yes it is!');
  await messages.getByRole('button', { name: 'Send' }).click();
  await messages.locator('.ms-bubble.out').filter({ hasText: 'yes it is' }).waitFor();
  await messages.locator('.ms-bubble.out').filter({ hasText: 'Delivered' }).waitFor({ timeout: 15_000 });
  const lead = (await win.evaluate(() => window.leadFinder.listLeads({ category: 'all' })))[0];
  assert.equal(lead.smsStatus, 'seen');
  assert.equal(lead.campaign, 'unseen'); // WhatsApp: separate
  // A text to an imported number from its category.
  await win.getByRole('button', { name: 'Numbers' }).click();
  await table.locator('tbody tr').filter({ hasText: '+923337778889' }).getByRole('button', { name: /Text/ }).click();
  await messages.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello');
  await messages.getByRole('button', { name: 'Send' }).click();
  await messages.locator('.ms-bubble.out').filter({ hasText: 'Hello' }).waitFor();
  await win.getByRole('button', { name: 'Numbers' }).click();
  await table.locator('tbody tr').filter({ hasText: '+923337778889' }).getByText('SMS sent').waitFor();
  assert.deepEqual(errors, []);
});
