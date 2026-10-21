'use strict';
// App lock, subscription gating and application flow, website filter and
// "WhatsApp only" export, in the real Electron app against a real licence
// server (test keys; outgoing mail captured).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { LeadStore } = require('../../src/database/db');
const { startLicenseServer, deviceIdOf } = require('./helpers');
const { readMachineId } = require('../../src/main/license');

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

  // ================= 2. Subscription gating and application =================
  const startSearch = async () => {
    await win.getByLabel('Search keyword').fill('Real Estate Lahore');
    await win.getByRole('combobox', { name: 'Category', exact: true }).fill('Real Estate');
    await win.getByLabel('Search keyword').click();
    await win.getByRole('button', { name: 'Start Search' }).click();
  };
  const plans = win.getByRole('dialog', { name: 'Subscription plans' });
  const closePlans = async () => {
    await plans.getByRole('button', { name: 'Close' }).click();
    await plans.waitFor({ state: 'detached' });
  };

  // Free trial: a new computer has 3 free searches.
  await win.getByRole('button', { name: 'Free: 3 searches left' }).waitFor();
  await startSearch();
  await win.locator('.state-error').waitFor({ timeout: 20_000 });
  assert.match(await win.locator('.progress .msg').textContent(), /Google Chrome is not installed/, 'trial search allowed');
  assert.equal((await win.evaluate(() => window.leadFinder.subscriptionStatus())).trial.remaining, 3, 'a search that never reached Chrome uses no free search');
  // All free searches used (counted on the server for this computer).
  const machine = crypto.createHash('sha256').update(`lead-finder:${readMachineId()}`).digest('hex');
  await lic.sql('insert into $S.trials (machine_id, used, updated_at) values ($1, 3, $2) on conflict (machine_id) do update set used = 3', [machine, new Date().toISOString()]);
  await startSearch();
  await plans.waitFor();
  assert.match(await plans.innerText(), /Your 3 free searches have been used/);
  const cards = await plans.locator('.plan-card').allInnerTexts();
  assert.deepEqual(
    cards.map((c) => c.replace(/\s+/g, ' ').trim()),
    ['Monthly PKR 3,000 1 month Apply for Subscription', 'Six Months PKR 10,000 6 months Apply for Subscription', 'Lifetime PKR 20,000 One-time payment, never expires Apply for Subscription'],
  );
  if (shots) await win.screenshot({ path: path.join(shots, 'access-plans.png') });
  await closePlans();
  assert.equal((await win.evaluate(() => window.leadFinder.exportCsv('all', {}))).subscription, 'trial_used');
  assert.equal((await win.evaluate(() => window.leadFinder.whatsappConnect())).subscription, 'trial_used');

  // Apply: plan, screenshot (native dialog answered), message.
  const png = path.join(tmp, 'payment.png');
  fs.writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(300)]));
  const notImage = path.join(tmp, 'payment.png.txt');
  fs.writeFileSync(notImage, 'hello');
  await win.getByRole('button', { name: 'Get a plan' }).click();
  await plans.getByRole('button', { name: 'Apply for Subscription' }).nth(1).click();
  const submit = plans.getByRole('button', { name: 'Submit application' });
  assert.ok(await submit.isDisabled(), 'screenshot required');
  // Where to pay: the three accounts with the selected plan's price.
  const pay = await plans.locator('.pay-box').innerText();
  assert.match(pay, /Send PKR 10,000 for the Six Months plan/);
  for (const m of ['NayaPay', 'JazzCash', 'Easypaisa']) assert.match(pay, new RegExp(`${m}\\s+03245237429\\s+PKR 10,000`));
  await app.evaluate(({ dialog }, f) => (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })), notImage);
  await plans.getByRole('button', { name: 'Choose image…' }).click();
  await win.locator('.toast.error').filter({ hasText: /PNG, JPEG or WebP/ }).waitFor();
  await app.evaluate(({ dialog }, f) => (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })), png);
  await plans.getByRole('button', { name: 'Choose image…' }).click();
  await plans.getByRole('img', { name: 'Payment screenshot preview' }).waitFor();
  assert.ok(await submit.isEnabled(), 'the screenshot is enough; the message is optional');
  await plans.getByLabel(/Message or transaction ID/).fill('Paid PKR 10,000 by JazzCash, TID 778899');
  if (shots) await win.screenshot({ path: path.join(shots, 'access-apply.png') });
  await submit.click();
  await plans.getByRole('heading', { name: 'Application submitted' }).waitFor();
  const appId = (await plans.locator('b.mono').textContent()).trim();
  assert.match(appId, /^LF-[0-9A-F]{10}$/);
  assert.match(await plans.innerText(), /Pending Approval/);
  await plans.getByRole('button', { name: 'Done' }).click();
  await win.getByRole('button', { name: 'Pending approval' }).waitFor();

  // The administrator's email: details, screenshot, two action buttons.
  assert.equal(lic.mails.length, 1);
  const mail = lic.mails[0];
  assert.equal(mail.to, 'info.axoraweb@gmail.com');
  assert.match(mail.subject, new RegExp(`${appId}: Six Months \\(PKR 10,000\\)`));
  assert.match(mail.html, /TID 778899/);
  assert.ok(mail.attachments[0].content.equals(fs.readFileSync(png)));
  const href = (a) => mail.html.match(new RegExp(`href="([^"]*/${a}\\?token=[^"]+)"`))[1].replace(/&amp;/g, '&');

  // Pending: still blocked, but another application can be submitted.
  await startSearch();
  await plans.waitFor();
  assert.match(await plans.innerText(), /awaiting approval/);
  assert.equal(await plans.getByRole('button', { name: 'Apply for Subscription' }).first().isEnabled(), true);
  await plans.getByRole('button', { name: 'Apply for Subscription' }).first().click();
  await plans.getByRole('button', { name: 'Choose image…' }).click();
  await plans.getByRole('button', { name: 'Submit application' }).click(); // no message
  await plans.getByRole('heading', { name: 'Application submitted' }).waitFor();
  await plans.getByRole('button', { name: 'Done' }).click();
  assert.equal(lic.mails.length, 2);
  assert.notEqual(lic.mails[1].subject.match(/LF-[0-9A-F]+/)[0], appId);
  assert.equal((await win.evaluate(() => window.leadFinder.subscriptionStatus())).pendingApplications, 2);

  // Approve from the email: the link opens a confirmation page, its button confirms.
  const open = async (url) => {
    const r = await fetch(url);
    return { status: r.status, html: await r.text() };
  };
  const press = async (url) => {
    const u = new URL(url);
    const r = await fetch(`${u.origin}${u.pathname}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(u.searchParams.get('token'))}` });
    return { status: r.status, html: await r.text() };
  };
  const page = await open(href('approve'));
  assert.match(page.html, /Approve Subscription\?/);
  assert.match(page.html, /<form method="post"/);
  assert.equal((await win.evaluate(() => window.leadFinder.subscriptionStatus())).reason, 'pending', 'opening the link changes nothing');
  const approved = await press(href('approve'));
  assert.match(approved.html, /Subscription approved/);
  assert.equal((await press(href('approve'))).status, 409, 'no duplicate approval');
  assert.equal((await press(href('cancel'))).status, 409, 'cancel link spent too');
  assert.match((await open(href('approve'))).html, /already been used/);

  // Active: the search passes the subscription check and reaches Chrome.
  await startSearch();
  await win.locator('.state-error').waitFor({ timeout: 20_000 });
  assert.match(await win.locator('.progress .msg').textContent(), /Google Chrome is not installed/);
  await win.getByRole('button', { name: /days left/ }).waitFor();

  // Expiry (server clock decides): blocked again with the expired message.
  const deviceId = await deviceIdOf(win);
  await lic.sql('update $S.licenses set expires_at = $1 where device_id = $2', [new Date(Date.now() - 60_000).toISOString(), deviceId]);
  await startSearch();
  await plans.waitFor();
  assert.match(await plans.innerText(), /Your subscription has expired/);
  await closePlans();
  // Modifying local app state does not help: the status is re-signed by the server each time.
  await win.evaluate(() => localStorage.setItem('subscription', JSON.stringify({ allowed: true })));
  assert.equal((await win.evaluate(() => window.leadFinder.subscriptionStatus())).allowed, false);

  // Cancellation: new application, cancelled by email; can apply again.
  await win.locator('.plan-pill').click();
  await plans.getByRole('button', { name: 'Apply for Subscription' }).first().click();
  await plans.getByRole('button', { name: 'Choose image…' }).click();
  await plans.getByLabel(/Message or transaction ID/).fill('Monthly renewal, TID 1122');
  await plans.getByRole('button', { name: 'Submit application' }).click();
  await plans.getByRole('heading', { name: 'Application submitted' }).waitFor();
  await plans.getByRole('button', { name: 'Done' }).click();
  const cancelHref = lic.mails.at(-1).html.match(/href="([^"]*\/cancel\?token=[^"]+)"/)[1].replace(/&amp;/g, '&');
  assert.match((await press(cancelHref)).html, /Application cancelled/);
  const st = await win.evaluate(() => window.leadFinder.subscriptionStatus());
  assert.equal(st.allowed, false);
  assert.equal(st.subscription.state, 'expired', 'expired subscription stays expired after a cancelled renewal');

  // Lifetime access.
  await lic.activate(deviceId, 'lifetime');
  await win.evaluate(() => window.leadFinder.subscriptionStatus());
  await win.getByRole('button', { name: 'Lifetime' }).waitFor();

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
});

test('without a reachable server the plans and payment accounts still show, with the exact reason', async (t) => {
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
  await win.getByRole('button', { name: 'Plans' }).click();
  const plans = win.getByRole('dialog', { name: 'Subscription plans' });
  await plans.locator('.plan-card').first().waitFor();
  const text = await plans.innerText();
  assert.match(text, /subscription server is not running \(http:\/\/127\.0\.0\.1:9\)\. Start it with "npm run server"/);
  assert.doesNotMatch(text, /Check the internet connection/);
  assert.equal(await plans.locator('.plan-card').count(), 3);
  await plans.getByRole('button', { name: 'Apply for Subscription' }).nth(2).click();
  assert.match(await plans.locator('.pay-box').innerText(), /Send PKR 20,000 for the Lifetime plan/);
  if (shots) await win.screenshot({ path: path.join(shots, 'access-offline-plans.png') });
});
