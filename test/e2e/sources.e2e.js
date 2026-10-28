'use strict';
// The three source switches (Google Maps, Facebook, LinkedIn) in the real
// app: any one, two or all three; at least one; LinkedIn's own search bar;
// the keyword and category only needed by Google Maps and Facebook; only
// the selected sources start, each with its own progress row.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { unlock, activationEnv } = require('./helpers');

const root = path.join(__dirname, '..', '..');

test('source switches: any combination, LinkedIn search bar, only the selected sources run', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-sources-'));
  const env = { ...process.env, ...activationEnv, LEAD_FINDER_USER_DATA: path.join(tmp, 'app'), LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome'), LEAD_FINDER_NO_UPDATES: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(env.LEAD_FINDER_USER_DATA);
  let app = await _electron.launch({ args: [root], cwd: root, env });
  let win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  t.after(async () => {
    await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  await unlock(win);
  const sw = (name) => win.getByRole('switch', { name });
  const start = win.getByRole('button', { name: 'Start Search' });
  // The hint is hidden on narrow windows (to save space); its text is checked.
  const hintIs = (text) => win.waitForFunction((t) => document.querySelector('.source-hint')?.textContent.trim() === t, text);

  // Default: Google Maps on, the others off.
  assert.deepEqual(
    [await sw('Google Maps search').getAttribute('aria-checked'), await sw('Facebook Lead Search').getAttribute('aria-checked'), await sw('LinkedIn Lead Search').getAttribute('aria-checked')],
    ['true', 'false', 'false'],
  );
  assert.equal(await win.locator('#li-kw').count(), 0, 'no LinkedIn bar while LinkedIn is off');

  // None on: nothing can start, and the app says why.
  await sw('Google Maps search').click();
  await hintIs('Turn on at least one source.');
  assert.equal(await start.isDisabled(), true);
  assert.equal(await win.locator('#kw').count(), 0, 'no keyword without Google Maps or Facebook');
  assert.match((await win.evaluate(() => window.leadFinder.startSearch('x y', 'Cat', 'without', ''))).error, /at least one source/);

  // LinkedIn alone: its own search bar; category optional; the website filter is Google Maps'.
  await sw('LinkedIn Lead Search').click();
  await win.locator('#li-kw').waitFor();
  assert.equal(await win.locator('#site').count(), 0);
  assert.equal(await win.getByText('Category (optional)').count(), 1);
  assert.equal(await start.isDisabled(), true, 'needs a LinkedIn search');
  await win.locator('#li-kw').fill('Full Stack Developer');
  assert.equal(await start.isDisabled(), false);
  await hintIs('LinkedIn only.');
  await start.click();
  // Only LinkedIn started: one progress row, then Chrome isn't installed here.
  await win.locator('.workers .worker').first().waitFor({ timeout: 20_000 }).catch(() => {});
  await win.locator('.state-error').waitFor({ timeout: 30_000 });
  const st = await win.evaluate(() => window.leadFinder.getStatus());
  assert.deepEqual(st.sources, ['linkedin']);
  assert.equal(st.linkedinKeyword, 'Full Stack Developer');
  assert.match(st.message, /Google Chrome is not installed/);

  // Facebook + LinkedIn (no Google Maps): keyword and category needed again, plus the LinkedIn search.
  await sw('Facebook Lead Search').click();
  await win.locator('#kw').waitFor();
  assert.equal(await start.isDisabled(), true);
  await win.locator('#kw').fill('garments Lahore');
  await win.getByRole('combobox', { name: 'Category', exact: true }).fill('Garments');
  await win.locator('#kw').click();
  assert.equal(await start.isDisabled(), false);
  await hintIs('Facebook + LinkedIn, side by side.');
  await start.click();
  await win.waitForFunction(() => window.leadFinder.getStatus().then((s) => s.state === 'error'));
  assert.deepEqual((await win.evaluate(() => window.leadFinder.getStatus())).sources, ['facebook', 'linkedin']);

  // All three: kept across a restart, as are the LinkedIn search and the switches.
  await sw('Google Maps search').click();
  await hintIs('Google Maps + Facebook + LinkedIn, side by side.');
  await app.close();
  app = await _electron.launch({ args: [root], cwd: root, env });
  win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(e.message));
  await unlock(win);
  for (const name of ['Google Maps search', 'Facebook Lead Search', 'LinkedIn Lead Search']) {
    await win.waitForFunction((n) => document.querySelector(`[role="switch"][aria-label="${n}"]`)?.getAttribute('aria-checked') === 'true', name);
  }
  assert.equal(await win.locator('#li-kw').inputValue(), 'Full Stack Developer');
  assert.deepEqual(errors, []);
});
