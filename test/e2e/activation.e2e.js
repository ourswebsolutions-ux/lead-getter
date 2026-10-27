'use strict';
// Subscription activation in the real Electron app: Activation ID, plan
// choice, contacting the administrator, entering the code (wrong computer,
// wrong plan, expired, reused, valid), paid features before and after, the
// plan kept across restarts, plan end and renewal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { LeadStore } = require('../../src/database/db');
const { activationIdFor } = require('../../src/main/activation-code');
const { unlock, activationEnv, testCode } = require('./helpers');

const root = path.join(__dirname, '..', '..');
const shots = process.env.LEAD_FINDER_SCREENSHOTS;
const DAY = 86_400_000;

async function launch(env) {
  const app = await _electron.launch({ args: [root], cwd: root, env });
  const win = await app.firstWindow();
  await unlock(win, '1357', { plan: null });
  // Links the app opens are recorded instead.
  await app.evaluate(({ shell }) => {
    global.opened = [];
    shell.openExternal = async (u) => void global.opened.push(u);
  });
  return { app, win };
}

test('activation: choose a plan, send the Activation ID, enter the code; plan end and renewal', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-activation-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  const env = { ...process.env, ...activationEnv, LEAD_FINDER_USER_DATA: userData, LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome'), LEAD_FINDER_NO_UPDATES: '1', LEAD_FINDER_TEST_BAILEYS: path.join(__dirname, 'fake-baileys.js') };
  delete env.ELECTRON_RUN_AS_NODE;
  let { app, win } = await launch(env);
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  t.after(async () => {
    await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ---- No plan: the pill asks to activate; Start Search opens the panel.
  const pill = win.locator('.plan-pill');
  await pill.filter({ hasText: 'Activate' }).waitFor();
  await win.getByLabel('Search keyword').fill('Real Estate Lahore');
  await win.getByRole('combobox', { name: 'Category', exact: true }).fill('Real Estate');
  await win.getByLabel('Search keyword').click();
  await win.getByRole('button', { name: 'Start Search' }).click();
  const panel = win.getByRole('dialog', { name: 'Subscription' });
  await panel.waitFor();
  assert.match(await panel.locator('.sub-notice').textContent(), /needs an active plan/);
  // The other paid features are refused in the main process too.
  for (const call of [() => window.leadFinder.exportCsv('all', {}), () => window.leadFinder.whatsappConnect(), () => window.leadFinder.whatsappSend(1, 'hi'), () => window.leadFinder.whatsappRecheck('+923001234567'), () => window.leadFinder.chatsSend('923001234567@s.whatsapp.net', 'hi')]) {
    assert.equal((await win.evaluate(call)).subscription, 'none', String(call));
  }
  const id = (await panel.getByTestId('activation-id').textContent()).trim();
  assert.match(id, /^LF-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const opts = await panel.locator('.plan-opt').allInnerTexts();
  assert.equal(opts.length, 3);
  assert.match(opts[0], /Monthly[\s\S]*PKR 3,000/);
  assert.match(opts[1], /6 Months[\s\S]*PKR 10,000/);
  assert.match(opts[2], /Lifetime[\s\S]*Never expires[\s\S]*PKR 20,000/);
  if (shots) await win.screenshot({ path: path.join(shots, 'activation-panel.png') });

  // ---- Contact the administrator: WhatsApp message with the ID and plan.
  await panel.getByRole('button', { name: 'WhatsApp' }).click();
  await win.waitForTimeout(200);
  let opened = await app.evaluate(() => global.opened);
  assert.equal(opened.length, 1);
  assert.match(opened[0], /^https:\/\/wa\.me\/\d+\?text=/);
  const msg = decodeURIComponent(opened[0].split('text=')[1]);
  assert.match(msg, /Monthly plan \(PKR 3,000\)/);
  assert.ok(msg.includes(id));
  await panel.getByRole('button', { name: /^Call / }).click();
  await win.waitForTimeout(200);
  opened = await app.evaluate(() => global.opened);
  assert.match(opened[1], /^tel:\+?\d+$/);
  // Contact links come from the app's own config, never from the page.
  assert.equal((await win.evaluate(() => window.leadFinder.contactAdmin('https://evil.example', 'x'))).ok, true);
  opened = await app.evaluate(() => global.opened);
  assert.match(opened[2], /^https:\/\/wa\.me\//);

  // ---- Wrong codes are refused with a reason; nothing is activated.
  // Typing the 4th digit submits; the boxes empty after a refusal.
  const digits = panel.getByRole('group', { name: 'Activation code' });
  const typeCode = async (code) => {
    await digits.getByLabel('Digit 1').click();
    await win.keyboard.type(code, { delay: 30 });
  };
  const tryCode = async (code, re) => {
    await typeCode(code);
    await panel.locator('.sub-error').filter({ hasText: re }).waitFor();
    await win.waitForFunction(() => document.querySelector('[aria-label="Digit 1"]').value === '');
  };
  const code = testCode(id, 'monthly');
  const other = testCode(activationIdFor('another-computer'), 'monthly');
  if (other !== code) await tryCode(other, /Wrong code/);
  const life = testCode(id, 'lifetime');
  if (life !== code) await tryCode(life, /Lifetime plan. Choose Lifetime/);
  const old = testCode(id, 'monthly', { now: new Date(Date.now() - 4 * DAY) });
  if (old !== code) await tryCode(old, /expired/);
  assert.equal((await win.evaluate(() => window.leadFinder.activationStatus())).state, 'none');
  if (shots) await win.screenshot({ path: path.join(shots, 'activation-wrong.png') });

  // ---- The right code activates the plan immediately.
  await typeCode(code);
  await panel.getByRole('heading', { name: 'Monthly plan activated' }).waitFor();
  if (shots) await win.screenshot({ path: path.join(shots, 'activation-done.png') });
  await panel.getByRole('button', { name: 'Done' }).click();
  await panel.waitFor({ state: 'detached' });
  await pill.filter({ hasText: /Monthly · (30|31) days left/ }).waitFor();
  // Used once only.
  assert.equal((await win.evaluate((c) => window.leadFinder.activate(c, 'monthly'), code)).reason, 'used');
  // Paid features now run (the search goes on to Chrome).
  await win.getByRole('button', { name: 'Start Search' }).click();
  await win.locator('.state-error').waitFor({ timeout: 20_000 });
  assert.match(await win.locator('.progress .msg').textContent(), /Google Chrome is not installed/);

  // ---- Kept across restarts.
  await app.close();
  ({ app, win } = await launch(env));
  win.on('pageerror', (e) => errors.push(e.message));
  await win.locator('.plan-pill', { hasText: /Monthly · \d+ days left/ }).waitFor();

  // ---- The plan ends (time moves past its end): features stop, renewal is offered.
  await app.close();
  const store = new LeadStore(path.join(userData, 'leads.db'));
  store.setState('activation.seen', Date.now() + 40 * DAY);
  store.close();
  ({ app, win } = await launch(env));
  win.on('pageerror', (e) => errors.push(e.message));
  await win.locator('.plan-pill', { hasText: 'Plan ended · Renew' }).waitFor();
  const r = await win.evaluate(() => window.leadFinder.startSearch('Real Estate Lahore', 'Real Estate'));
  assert.equal(r.subscription, 'expired');
  assert.match(r.error, /Monthly plan has ended/);
  assert.equal((await win.evaluate(() => window.leadFinder.exportCsv('all', {}))).subscription, 'expired');
  await win.locator('.plan-pill').click();
  const renew = win.getByRole('dialog', { name: 'Subscription' });
  await renew.locator('.sub-chip', { hasText: 'Ended' }).waitFor();
  if (shots) await win.screenshot({ path: path.join(shots, 'activation-ended.png') });
  // The old code can't be used again; a new 6 Months code renews.
  await renew.locator('.plan-opt', { hasText: 'Monthly' }).click();
  await renew.getByLabel('Digit 1').click();
  await win.keyboard.type(code, { delay: 30 });
  await renew.locator('.sub-error').waitFor();
  await renew.locator('.plan-opt', { hasText: '6 Months' }).click();
  await renew.getByLabel('Digit 1').click();
  await win.keyboard.type(testCode(id, 'six_months', { now: new Date(Date.now() + 40 * DAY) }), { delay: 30 });
  await renew.getByRole('heading', { name: '6 Months plan activated' }).waitFor();
  await renew.getByRole('button', { name: 'Done' }).click();
  await win.locator('.plan-pill', { hasText: /6 Months · \d+ days left/ }).waitFor();
  assert.equal((await win.evaluate(() => window.leadFinder.activationStatus())).state, 'active');
  assert.deepEqual(errors, []);
});
