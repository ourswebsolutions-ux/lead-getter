'use strict';
// The Free Trial in the real app: it starts by itself on a new computer,
// shows the days and leads left, stops at 30 leads with the plans on offer,
// tells the administrator by the same mailer, and comes back unchanged after
// the app's data is cleared.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { unlock, activationConfig, activationEnv, mail } = require('./helpers');

const root = path.join(__dirname, '..', '..');

test('Free Trial: automatic, 5 days and 30 leads shown, the 31st blocked, not reset by clearing the app’s data', { timeout: 300_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-trial-e2e-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  const env = {
    ...process.env,
    ...activationEnv,
    LEAD_FINDER_ACTIVATION_CONFIG: JSON.stringify({ ...activationConfig, trial: { days: 5, leads: 30 } }),
    LEAD_FINDER_USER_DATA: userData,
    LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome'),
    LEAD_FINDER_NO_UPDATES: '1',
    LEAD_FINDER_TEST_DAILY_LEADS: '{}',
    LEAD_FINDER_TEST_TRIAL_FILE: path.join(tmp, 'device-mark'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = async () => {
    const app = await _electron.launch({ args: [root], cwd: root, env });
    const win = await app.firstWindow();
    await unlock(win, '1357', { plan: null });
    return { app, win };
  };
  let { app, win } = await launch();
  t.after(async () => {
    await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // --- Active at once: no payment, no code, no administrator.
  await win.locator('.plan-pill', { hasText: 'Free Trial · 5 days left' }).waitFor();
  const st = await win.evaluate(() => window.leadFinder.activationStatus());
  assert.deepEqual([st.state, st.plan], ['active', 'free_trial']);
  assert.equal(Date.parse(st.expiresAt) - Date.parse(st.activatedAt), 5 * 86_400_000);
  const chip = win.getByLabel('Trial leads and days left');
  await chip.filter({ hasText: '30 of 30 leads left · 5 days left' }).waitFor();
  const smtp = await mail;
  for (let i = 0; i < 40 && !smtp.messages.some((m) => m.text.includes(st.activationId) && /Free Trial/.test(m.text)); i++) await new Promise((r) => setTimeout(r, 250));
  assert.ok(smtp.messages.some((m) => m.text.includes(st.activationId) && /Plan: Free Trial/.test(m.text)), 'the administrator was told by email');

  const save = (a, n) => a.evaluate((_e, i) => globalThis.__leadFinderTest.saveLead({ placeKey: `0x${i}:0x2`, mapsUrl: `https://www.google.com/maps/place/T${i}`, name: `Lead ${i}`, phoneRaw: `0300${String(2000000 + i)}`, address: 'Lahore, Pakistan', websiteStatus: 'no_website' }), n);
  for (let n = 1; n <= 29; n++) assert.ok((await save(app, n)).isNewLead);
  await chip.filter({ hasText: '1 of 30 leads left' }).waitFor();

  // --- Duplicates use nothing; the 30th saves; the 31st is blocked with the plans.
  assert.equal((await save(app, 3)).isNewLead, false);
  assert.ok((await save(app, 30)).isNewLead);
  assert.deepEqual(await save(app, 31), { isNewLead: false, limitReached: true });
  const msg = 'You have used all 30 leads of your Free Trial. Upgrade your plan to find more leads.';
  const panel = win.getByRole('dialog', { name: 'Subscription' });
  await panel.waitFor();
  assert.match(await panel.locator('.sub-notice').innerText(), /used all 30 leads of your Free Trial/);
  const plans = await panel.getByRole('radiogroup', { name: 'Plan' }).innerText();
  assert.match(plans, /Monthly[\s\S]*6 Months[\s\S]*Lifetime/);
  assert.doesNotMatch(plans, /Free Trial/);
  await panel.getByRole('button', { name: 'Close' }).click();
  await win.getByRole('alert').filter({ hasText: msg }).waitFor();
  const search = await win.evaluate(() => window.leadFinder.startSearch('plumber', 'Plumbers', 'all', false, 'Lahore'));
  assert.equal(search.error, msg);

  // --- Clearing the app's data: the same trial, its leads still used.
  await app.close();
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(userData);
  ({ app, win } = await launch());
  await win.locator('.plan-pill', { hasText: 'Free Trial' }).waitFor();
  const after = await win.evaluate(() => window.leadFinder.activationStatus());
  assert.equal(after.expiresAt, st.expiresAt, 'the same end date');
  await win.getByLabel('Trial leads and days left').filter({ hasText: '0 of 30 leads left' }).waitFor();
  assert.equal((await save(app, 40)).limitReached, true);
});
