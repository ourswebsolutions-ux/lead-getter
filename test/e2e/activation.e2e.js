'use strict';
// Subscription activation in the real Electron app, end to end with a real
// SMTP exchange (local mail server): paid features without a plan, choose a
// plan -> Activate -> email to the administrator only -> code entry ->
// Verify & Activate; email failure, wrong code, expired code, restart with
// a waiting code, reuse, the plan kept across restarts and its end.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { LeadStore } = require('../../src/database/db');
const { unlock, activationEnv, codeFor, mail } = require('./helpers');

const root = path.join(__dirname, '..', '..');
const shots = process.env.LEAD_FINDER_SCREENSHOTS;
const MIN = 60_000;
const DAY = 86_400_000;

async function launch(env) {
  const app = await _electron.launch({ args: [root], cwd: root, env });
  if (process.env.E2E_DEBUG) app.process().stderr.on('data', (d) => process.stderr.write(d));
  const win = await app.firstWindow();
  await unlock(win, '1357', { plan: null });
  // Links the app opens are recorded instead.
  await app.evaluate(({ shell }) => {
    global.opened = [];
    shell.openExternal = async (u) => void global.opened.push(u);
  });
  return { app, win };
}

// Moves the app's time forward while it is closed (its clock never goes
// back below the latest time it has seen).
function advance(userData, ms) {
  const store = new LeadStore(path.join(userData, 'leads.db'));
  store.setState('activation.seen', Math.max(Date.now(), store.getState('activation.seen') || 0) + ms);
  store.close();
}

test('activation: Activate -> SMTP email -> code entry -> Verify & Activate, with failures, expiry, restarts and reuse', async (t) => {
  const smtp = await mail;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-activation-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  const env = { ...process.env, ...activationEnv, LEAD_FINDER_USER_DATA: userData, LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome'), LEAD_FINDER_NO_UPDATES: '1', LEAD_FINDER_TEST_BAILEYS: path.join(__dirname, 'fake-baileys.js') };
  delete env.ELECTRON_RUN_AS_NODE;
  let { app, win } = await launch(env);
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  t.after(async () => {
    smtp.setMode('accept');
    await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const status = () => win.evaluate(() => window.leadFinder.activationStatus());
  // Looked up in the current window (the app is restarted several times).
  const P = () => win.getByRole('dialog', { name: 'Subscription' });
  const E = () => P().locator('.sub-error');
  const typeCode = async (code) => {
    await P().getByLabel('Digit 1').click();
    await win.keyboard.type(code, { delay: 25 });
  };

  // ---- No plan: the pill asks to activate; paid features are refused in the main process.
  await win.locator('.plan-pill', { hasText: 'Activate' }).waitFor();
  await win.getByLabel('Search keyword').fill('Real Estate Lahore');
  await win.getByRole('combobox', { name: 'Category', exact: true }).fill('Real Estate');
  await win.getByLabel('Search keyword').click();
  await win.getByRole('button', { name: 'Start Search' }).click();
  await P().waitFor();
  assert.match(await P().locator('.sub-notice').textContent(), /needs an active plan/);
  for (const call of [() => window.leadFinder.exportCsv('all', {}), () => window.leadFinder.whatsappConnect(), () => window.leadFinder.whatsappSend(1, 'hi'), () => window.leadFinder.whatsappRecheck('+923001234567'), () => window.leadFinder.chatsSend('923001234567@s.whatsapp.net', 'hi')]) {
    assert.equal((await win.evaluate(call)).subscription, 'none', String(call));
  }
  const id = (await P().getByTestId('activation-id').textContent()).trim();
  assert.match(id, /^LF-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const opts = await P().locator('.plan-opt').allInnerTexts();
  assert.equal(opts.length, 3);
  assert.match(opts[0], /Monthly[\s\S]*PKR 3,000/);
  assert.match(opts[1], /6 Months[\s\S]*PKR 10,000/);
  assert.match(opts[2], /Lifetime[\s\S]*Never expires[\s\S]*PKR 20,000/);
  if (shots) await win.screenshot({ path: path.join(shots, 'activation-choose.png') });

  // ---- Email failure: the user is told; no code entry, nothing to enter.
  smtp.setMode('auth-fail');
  const before = smtp.messages.length;
  await P().getByRole('button', { name: 'Activate Monthly' }).click();
  await E().filter({ hasText: /could not be sent: the email account rejected the login/ }).waitFor({ timeout: 30_000 });
  assert.equal(await P().getByRole('group', { name: 'Activation code' }).count(), 0);
  assert.equal(await P().getByText(/Request sent/).count(), 0);
  assert.equal((await status()).pending, null);
  assert.equal(smtp.messages.length, before);
  smtp.setMode('accept');

  // ---- Activate: the code is emailed to the administrator only, with ID, plan and price.
  await P().getByRole('button', { name: 'Activate Monthly' }).click();
  await P().getByRole('heading', { name: /Request sent: Monthly \(PKR 3,000\)/ }).waitFor({ timeout: 30_000 });
  const m = smtp.messages.at(-1);
  assert.deepEqual(m.to, ['admin@example.com']);
  assert.match(m.text, new RegExp(`Activation ID: ${id}`));
  assert.match(m.text, /Plan: Monthly/);
  assert.match(m.text, /Price: PKR 3,000/);
  const codeA = await codeFor(id);
  assert.match(codeA, /^\d{6}$/);
  // The window shows how to get the code, never the code.
  const sent = await P().locator('.act-sent').innerText();
  assert.match(sent, /Contact us on WhatsApp \+923245237429 or call to pay and receive your 6-digit code/);
  assert.ok(sent.includes(id));
  assert.match(sent, /expires at .*\(10 min\)/);
  assert.ok(!(await win.evaluate(() => document.body.innerText)).includes(codeA));
  if (shots) await win.screenshot({ path: path.join(shots, 'activation-code.png') });
  // WhatsApp and Call carry the ID and plan.
  await P().getByRole('button', { name: 'WhatsApp' }).click();
  await P().getByRole('button', { name: 'Call' }).click();
  await win.waitForTimeout(200);
  const opened = await app.evaluate(() => global.opened);
  assert.match(opened[0], /^https:\/\/wa\.me\/923245237429\?text=/);
  const msg = decodeURIComponent(opened[0].split('text=')[1]);
  assert.ok(msg.includes(id));
  assert.match(msg, /Plan: Monthly \(PKR 3,000\)/);
  assert.equal(opened[1], 'tel:+923245237429');

  // ---- A wrong code: refused, tries counted.
  const wrong = String((Number(codeA) + 1) % 1e6).padStart(6, '0');
  await typeCode(wrong);
  await P().getByRole('button', { name: 'Verify & Activate' }).click();
  await E().filter({ hasText: 'Wrong code. 4 tries left.' }).waitFor();
  assert.equal((await status()).state, 'none');
  if (shots) await win.screenshot({ path: path.join(shots, 'activation-wrong.png') });

  // ---- The code expires after 10 minutes (restart 11 minutes later).
  await app.close();
  advance(userData, 11 * MIN);
  ({ app, win } = await launch(env));
  win.on('pageerror', (e) => errors.push(e.message));
  assert.equal((await status()).pending, null);
  assert.equal((await win.evaluate((c) => window.leadFinder.verifyActivation(c, 'monthly'), codeA)).reason, 'expired');
  assert.equal((await status()).state, 'none');

  // ---- A new request for 6 Months; the app restarts before the code is entered.
  await win.locator('.plan-pill').click();
  await P().locator('.plan-opt', { hasText: '6 Months' }).click();
  await P().getByRole('button', { name: 'Activate 6 Months' }).click();
  await P().getByRole('heading', { name: /Request sent: 6 Months \(PKR 10,000\)/ }).waitFor({ timeout: 30_000 });
  const codeB = await codeFor(id);
  assert.match(smtp.messages.at(-1).text, /Plan: 6 Months[\s\S]*Price: PKR 10,000/);
  await app.close();
  ({ app, win } = await launch(env));
  win.on('pageerror', (e) => errors.push(e.message));
  await win.locator('.plan-pill').click();
  await P().getByRole('heading', { name: /Request sent: 6 Months/ }).waitFor();

  // ---- Verify & Activate: the plan starts at once with its expiry.
  await typeCode(codeB);
  await P().getByRole('button', { name: 'Verify & Activate' }).click();
  await P().getByRole('heading', { name: '6 Months plan activated' }).waitFor();
  assert.match(await P().locator('.act-done').innerText(), /Valid until \w+/);
  if (shots) await win.screenshot({ path: path.join(shots, 'activation-done.png') });
  await P().getByRole('button', { name: 'Done' }).click();
  await P().waitFor({ state: 'detached' });
  await win.locator('.plan-pill', { hasText: /6 Months · 18\d days left/ }).waitFor();
  const st = await status();
  assert.equal(st.state, 'active');
  assert.equal(st.plan, 'six_months');
  // Used once only.
  assert.equal((await win.evaluate((c) => window.leadFinder.verifyActivation(c, 'six_months'), codeB)).ok, false);
  // Paid features run now (the search goes on to Chrome).
  await win.getByLabel('Search keyword').fill('Real Estate Lahore');
  await win.getByRole('combobox', { name: 'Category', exact: true }).fill('Real Estate');
  await win.getByLabel('Search keyword').click();
  await win.getByRole('button', { name: 'Start Search' }).click();
  await win.locator('.state-error').waitFor({ timeout: 20_000 });
  assert.match(await win.locator('.progress .msg').textContent(), /Google Chrome is not installed/);

  // ---- Kept across restarts; after 6 months the plan ends and features stop.
  await app.close();
  ({ app, win } = await launch(env));
  win.on('pageerror', (e) => errors.push(e.message));
  await win.locator('.plan-pill', { hasText: /6 Months · \d+ days left/ }).waitFor();
  await app.close();
  advance(userData, 190 * DAY);
  ({ app, win } = await launch(env));
  win.on('pageerror', (e) => errors.push(e.message));
  await win.locator('.plan-pill', { hasText: 'Plan ended · Renew' }).waitFor();
  const r = await win.evaluate(() => window.leadFinder.startSearch('Real Estate Lahore', 'Real Estate'));
  assert.equal(r.subscription, 'expired');
  assert.match(r.error, /6 Months plan has ended/);
  assert.deepEqual(errors, []);
});
