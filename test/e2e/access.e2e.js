'use strict';
// App lock, website filter and "WhatsApp only" export, in the real Electron
// app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { LeadStore } = require('../../src/database/db');

const root = path.join(__dirname, '..', '..');
const shots = process.env.LEAD_FINDER_SCREENSHOTS;

function seed(file) {
  const s = new LeadStore(file);
  const cat = s.ensureCategory('Real Estate');
  let i = 0;
  const add = (name, phoneRaw, websiteStatus, websiteDetail, isLead = true) =>
    s.save({ placeKey: `0x${++i}:0x3`, mapsUrl: `https://www.google.com/maps/place/A${i}`, name, phoneRaw, address: 'Lahore, Pakistan', websiteStatus, websiteDetail, isLead, categoryId: cat.id });
  add('No Site WA', '03001234567', 'no_website');
  add('No Site Plain', '03007654321', 'no_website');
  add('Has Site WA', '03211234567', 'has_website', 'example.pk');
  s.setWhatsAppResult('+923001234567', 'available', 'baileys');
  s.setWhatsAppResult('+923211234567', 'available', 'baileys');
  s.setWhatsAppResult('+923007654321', 'unavailable', 'baileys');
  s.close();
}

async function launch(env) {
  const app = await _electron.launch(process.env.LEAD_FINDER_EXE ? { executablePath: process.env.LEAD_FINDER_EXE, args: [], env } : { args: [root], cwd: root, env });
  const win = await app.firstWindow();
  return { app, win };
}

const typePin = async (win, pin) => win.keyboard.type(pin, { delay: 40 });

test('app lock, website filter, WhatsApp-only export', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-access-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  seed(path.join(userData, 'leads.db'));
  const env = { ...process.env, LEAD_FINDER_USER_DATA: userData, LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome') };
  delete env.ELECTRON_RUN_AS_NODE;
  let { app, win } = await launch(env);
  const pageErrors = [];
  const watch = (w) => w.on('pageerror', (e) => pageErrors.push(e.message));
  watch(win);
  t.after(async () => {
    await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ================= 1. Four-digit lock =================
  await win.getByRole('dialog', { name: 'Create your PIN' }).waitFor();
  // Nothing is reachable while locked, even by calling the bridge directly.
  await assert.rejects(win.evaluate(() => window.leadFinder.listLeads({})), /Locked/);
  await assert.rejects(win.evaluate(() => window.leadFinder.startSearch('x y', 'Real Estate')), /Locked/);
  assert.equal(await win.locator('table').count(), 0, 'no lead data rendered');
  // Mismatched confirmation starts over.
  await typePin(win, '2468');
  await win.getByRole('dialog', { name: 'Confirm your PIN' }).waitFor();
  await typePin(win, '2469');
  await win.getByRole('dialog', { name: 'Create your PIN' }).waitFor();
  assert.match(await win.locator('.lock-error').textContent(), /do not match/);
  await typePin(win, '2468');
  await win.getByRole('dialog', { name: 'Confirm your PIN' }).waitFor();
  await typePin(win, '2468');
  await win.getByRole('heading', { name: 'Lead Finder' }).waitFor();
  if (shots) await win.screenshot({ path: path.join(shots, 'access-app.png') });

  // Restarting asks for the PIN again; wrong PIN is refused.
  await app.close();
  ({ app, win } = await launch(env));
  watch(win);
  await win.getByRole('dialog', { name: 'Enter your PIN' }).waitFor();
  if (shots) await win.screenshot({ path: path.join(shots, 'access-lock.png') });
  await typePin(win, '1111');
  await win.waitForFunction(() => /Incorrect PIN/.test(document.querySelector('.lock-error')?.textContent || ''));
  await assert.rejects(win.evaluate(() => window.leadFinder.listLeads({})), /Locked/);
  await typePin(win, '2468');
  await win.getByRole('heading', { name: 'Lead Finder' }).waitFor();

  // Change the PIN.
  await win.getByRole('button', { name: 'Security' }).click();
  await win.getByRole('menuitem', { name: 'Change PIN' }).click();
  const dlg = win.getByRole('dialog', { name: 'Change PIN' });
  await dlg.getByLabel('Current PIN').fill('0000');
  await dlg.getByLabel('New PIN', { exact: true }).fill('9753');
  await dlg.getByLabel('Confirm new PIN').fill('9753');
  await dlg.getByRole('button', { name: 'Save PIN' }).click();
  assert.match(await dlg.locator('.composer-error').textContent(), /current PIN is incorrect/);
  await dlg.getByLabel('Current PIN').fill('2468');
  await dlg.getByRole('button', { name: 'Save PIN' }).click();
  await dlg.waitFor({ state: 'detached' });
  // Lock now; reloading the window does not get around it.
  await win.getByRole('button', { name: 'Security' }).click();
  await win.getByRole('menuitem', { name: 'Lock now' }).click();
  await win.getByRole('dialog', { name: 'Enter your PIN' }).waitFor();
  await win.reload();
  await win.getByRole('dialog', { name: 'Enter your PIN' }).waitFor();
  await assert.rejects(win.evaluate(() => window.leadFinder.listLeads({})), /Locked/);
  await typePin(win, '2468');
  await win.waitForFunction(() => /Incorrect PIN/.test(document.querySelector('.lock-error')?.textContent || ''));
  await typePin(win, '9753');
  await win.getByRole('heading', { name: 'Lead Finder' }).waitFor();

  // ================= 2. No subscription anywhere: everything is free =================
  assert.equal(await win.locator('.plan-pill').count(), 0, 'no plan button');
  assert.equal(await win.getByText(/Activation code|Subscription|Get a plan|Free · |leads left|Upgrade/).count(), 0, 'no subscription text');
  for (const k of ['subscriptionStatus', 'requestActivation', 'verifyActivationCode']) assert.equal(await win.evaluate((n) => typeof window.leadFinder[n], k), 'undefined', `no ${k} in the bridge`);
  await win.getByLabel('Search keyword').fill('Real Estate Lahore');
  await win.getByRole('combobox', { name: 'Category', exact: true }).fill('Real Estate');
  await win.getByLabel('Search keyword').click();
  await win.getByRole('button', { name: 'Start Search' }).click();
  await win.locator('.state-error').waitFor({ timeout: 20_000 });
  assert.match(await win.locator('.progress .msg').textContent(), /Google Chrome is not installed/, 'the search goes straight to Chrome');
  assert.equal((await win.evaluate(() => window.leadFinder.whatsappConnect())).subscription, undefined, 'WhatsApp needs no plan');

  // ================= 3. Website filter (search + table) =================
  const opts = await win.locator('#site option').allTextContents();
  assert.deepEqual(opts, ['Without website', 'With website', 'All businesses']);
  assert.equal(await win.locator('#site').inputValue(), 'without');
  const names = () => win.locator('tbody td.name').allTextContents();
  await win.waitForFunction(() => document.querySelectorAll('tbody tr').length === 3);
  await win.getByLabel('Show websites').selectOption('with');
  await win.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
  assert.deepEqual(await names(), ['Has Site WA']);
  assert.match(await win.locator('tbody tr td').nth(4).innerText(), /Website\s*example\.pk/);
  await win.getByLabel('Show websites').selectOption('without');
  await win.waitForFunction(() => document.querySelectorAll('tbody tr').length === 2);
  await win.getByLabel('Show websites').selectOption('all');

  // ================= 4. WhatsApp-only view and export =================
  await win.getByLabel('WhatsApp numbers only').check();
  await win.waitForFunction(() => document.querySelectorAll('tbody tr').length === 2);
  assert.deepEqual((await names()).sort(), ['Has Site WA', 'No Site WA']);
  const out = path.join(tmp, 'wa.csv');
  await app.evaluate(({ dialog }, f) => (dialog.showSaveDialog = async () => ({ canceled: false, filePath: f })), out);
  await win.getByRole('button', { name: /^Export CSV/ }).click();
  await win.locator('.toast.ok').first().waitFor();
  const csv = fs.readFileSync(out, 'utf8');
  assert.match(csv, /No Site WA,\+923001234567/);
  assert.match(csv, /Has Site WA,\+923211234567/);
  assert.doesNotMatch(csv, /No Site Plain/);
  assert.deepEqual(pageErrors, []);
});
