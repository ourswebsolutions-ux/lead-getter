'use strict';
// App lock, the Free plan, activation (email, administrator's approval,
// 4-digit code) and the daily allowance, website filter and "WhatsApp only"
// export, in the real Electron app against a real licence server (test keys;
// outgoing mail captured).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { LeadStore } = require('../../src/database/db');
const { startLicenseServer, deviceIdOf } = require('./helpers');

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

test('app lock, subscription flow and gating, website filter, WhatsApp-only export', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-access-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  seed(path.join(userData, 'leads.db'));
  const lic = await startLicenseServer();
  const env = { ...process.env, ...lic.env, LEAD_FINDER_USER_DATA: userData, LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome') };
  delete env.ELECTRON_RUN_AS_NODE;
  let { app, win } = await launch(env);
  const pageErrors = [];
  const watch = (w) => w.on('pageerror', (e) => pageErrors.push(e.message));
  watch(win);
  t.after(async () => {
    await app.close().catch(() => {});
    await lic.close();
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

  // ================= 2. Free plan, activation by email and code, daily allowance =================
  const startSearch = async () => {
    await win.getByLabel('Search keyword').fill('Real Estate Lahore');
    await win.getByRole('combobox', { name: 'Category', exact: true }).fill('Real Estate');
    await win.getByLabel('Search keyword').click();
    await win.getByRole('button', { name: 'Start Search' }).click();
  };
  const panel = win.getByRole('dialog', { name: 'Subscription' });
  const closePanel = async () => {
    await panel.getByRole('button', { name: 'Close' }).click();
    await panel.waitFor({ state: 'detached' });
  };
  const refresh = () => win.evaluate(() => window.leadFinder.subscriptionStatus());
  const pill = win.locator('.plan-pill');

  // A new installation is on Free: 5 Google Maps + 5 Facebook leads a day.
  await win.getByRole('button', { name: 'Free · 10 left' }).waitFor();
  await startSearch();
  await win.locator('.state-error').waitFor({ timeout: 20_000 });
  assert.match(await win.locator('.progress .msg').textContent(), /Google Chrome is not installed/, 'Free can search');
  // Paid features stay paid.
  assert.equal((await win.evaluate(() => window.leadFinder.exportCsv('all', {}))).subscription, 'free');
  assert.equal((await win.evaluate(() => window.leadFinder.whatsappConnect())).subscription, 'free');

  // The panel: plan, today's leads as meters, the paid plans and where to pay.
  await pill.click();
  await panel.waitFor();
  assert.equal(await panel.locator('.sub-title h2').textContent(), 'Free');
  const meters = async () => (await panel.locator('.meter-row').allInnerTexts()).map((x) => x.replace(/\s+/g, ' ').trim());
  assert.deepEqual(await meters(), ['Google Maps 0 / 5', 'Facebook 0 / 5']);
  assert.deepEqual(
    (await panel.locator('.plan-opt').allInnerTexts()).map((x) => x.replace(/\s+/g, ' ').trim()),
    ['Monthly 100 leads a day PKR 3,000', 'Six Months 250 leads a day PKR 10,000', 'One-Time Unlimited PKR 20,000'],
  );
  assert.match(await panel.locator('.pay-line').innerText(), /Pay to\s+03245237429\s+NayaPay · JazzCash · Easypaisa/);
  assert.equal(await panel.getByText(/Device ID/).count(), 0, 'no internal IDs');
  if (shots) await win.screenshot({ path: path.join(shots, 'access-free.png') });

  // Choose a plan: the Activation ID and code go to the administrator only.
  await panel.getByText('Six Months', { exact: true }).click();
  await panel.getByRole('button', { name: 'Get activation code' }).click();
  await panel.getByRole('heading', { name: 'Enter activation code' }).waitFor();
  assert.equal(await panel.getByLabel('Email').count(), 0, 'no email is asked for');
  assert.equal(lic.sent.length, 1);
  const mail = lic.sent[0];
  assert.equal(mail.to, 'info.axoraweb@gmail.com', 'the only recipient is the administrator');
  const actId = mail.text.match(/Activation ID: (ACT-\S+)/)[1];
  assert.match(mail.text, /Plan: Six Months: PKR 10,000, 250 leads a day/);
  const code = mail.text.match(/Activation code: (\d{4})/)[1];
  assert.match(await panel.innerText(), new RegExp(`Six Months · ${actId}`));
  await win.locator('.pill-dot').waitFor();
  assert.match(await panel.getByRole('button', { name: /New code in 0:\d\d/ }).textContent(), /New code in/);
  if (shots) await win.screenshot({ path: path.join(shots, 'access-code.png') });
  // Reopening the panel shows the same request (no new code).
  await closePanel();
  await pill.click();
  await panel.getByRole('heading', { name: 'Enter activation code' }).waitFor();
  assert.equal(lic.sent.length, 1);

  // A wrong code activates nothing; the right one (pasted) activates the plan.
  const wrong = code === '0000' ? '1111' : '0000';
  await panel.getByLabel('Digit 1').click();
  await win.keyboard.type(wrong, { delay: 40 });
  await panel.getByRole('alert').filter({ hasText: 'Incorrect code. 4 attempts left.' }).waitFor();
  assert.equal((await refresh()).plan.id, 'free');
  await panel.getByLabel('Digit 1').click();
  await win.evaluate((c) => {
    const dt = new DataTransfer();
    dt.setData('text', c);
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, code);
  await panel.getByRole('heading', { name: 'Six Months activated' }).waitFor();
  if (shots) await win.screenshot({ path: path.join(shots, 'access-activated.png') });
  await panel.getByRole('button', { name: 'Done' }).click();
  await win.getByRole('button', { name: 'Six Months · 250 left' }).waitFor();
  const deviceId = await deviceIdOf(win);

  // Active: the search passes and reaches Chrome; paid features open up.
  await startSearch();
  await win.locator('.state-error').waitFor({ timeout: 20_000 });
  assert.match(await win.locator('.progress .msg').textContent(), /Google Chrome is not installed/);
  await pill.click();
  assert.deepEqual([await panel.locator('.sub-title h2').textContent(), await panel.locator('.sub-chip').textContent()], ['Six Months', 'Active']);
  assert.match(await panel.locator('.sub-line').textContent(), /Until .* · 18\d days left/);
  assert.deepEqual(await meters(), ['Today 0 / 250']);
  await panel.getByRole('button', { name: 'Renew or upgrade' }).waitFor();
  if (shots) await win.screenshot({ path: path.join(shots, 'access-paid.png') });
  await closePanel();

  // Today's leads used up (the server's count): searching is refused with the reason.
  const day = (await refresh()).credits.day;
  lic.sql("INSERT INTO credit_usage (account, day, bucket, used) VALUES (?, ?, 'total', 250)", [`device:${deviceId}`, day]);
  await refresh();
  await win.getByRole('button', { name: 'Six Months · 0 left' }).waitFor();
  await startSearch();
  await panel.waitFor();
  assert.match(await panel.locator('.sub-notice').innerText(), /Today's 250 leads are used up\. More at/);
  await closePanel();
  lic.sql('DELETE FROM credit_usage WHERE account = ?', [`device:${deviceId}`]);

  // Suspended by the administrator: nothing can be saved.
  lic.sql("UPDATE subscriptions SET status = 'suspended' WHERE device_id = ?", [deviceId]);
  await refresh();
  await win.getByRole('button', { name: 'Suspended' }).waitFor();
  await startSearch();
  await panel.waitFor();
  assert.match(await panel.innerText(), /Contact Axora Web Solutions to restore access/);
  await closePanel();

  // Expired: back to Free (the server's clock decides; local state doesn't help).
  lic.sql("UPDATE subscriptions SET status = 'active', expires_at = ? WHERE device_id = ?", [new Date(Date.now() - 60_000).toISOString(), deviceId]);
  await win.evaluate(() => localStorage.setItem('subscription', JSON.stringify({ allowed: true })));
  const expired = await refresh();
  assert.deepEqual([expired.allowed, expired.plan.id, expired.plan.state, expired.reason], [false, 'free', 'expired', 'expired']);
  await pill.click();
  assert.equal(await panel.locator('.sub-chip').textContent(), 'Expired');
  assert.match(await panel.locator('.sub-line').textContent(), /Six Months ended/);
  await closePanel();

  // One-Time: unlimited.
  await lic.activate(deviceId, 'lifetime');
  await refresh();
  await win.getByRole('button', { name: 'One-Time', exact: true }).waitFor();
  await pill.click();
  assert.match(await panel.locator('.usage').innerText(), /Unlimited leads/);
  assert.equal(await panel.getByRole('button', { name: 'Renew or upgrade' }).count(), 0);
  await closePanel();

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

test('without a reachable server the panel says why, without guessing a plan', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-access2-'));
  const env = { ...process.env, LEAD_FINDER_USER_DATA: tmp, LEAD_FINDER_LICENSE_URL: 'http://127.0.0.1:9' };
  delete env.ELECTRON_RUN_AS_NODE;
  const { app, win } = await launch(env);
  t.after(async () => {
    await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  await win.getByRole('dialog', { name: 'Create your PIN' }).waitFor();
  await typePin(win, '1357');
  await win.getByRole('dialog', { name: 'Confirm your PIN' }).waitFor();
  await typePin(win, '1357');
  await win.getByRole('heading', { name: 'Lead Finder' }).waitFor();
  await win.getByRole('button', { name: 'Plan · offline' }).click();
  const panel = win.getByRole('dialog', { name: 'Subscription' });
  await panel.getByRole('heading', { name: "Can't reach the subscription server" }).waitFor();
  const text = await panel.innerText();
  assert.match(text, /subscription server is not running \(http:\/\/127\.0\.0\.1:9\)\. Start it with "npm run server"/);
  assert.equal(await panel.locator('.meter').count(), 0, 'no usage is shown without the server');
  if (shots) await win.screenshot({ path: path.join(shots, 'access-offline.png') });
});
