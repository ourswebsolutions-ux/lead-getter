'use strict';
// Settings > Automation in the real app: opened from the header menu, its
// switches kept across restarts, a continuous search added and controlled
// (no Chrome here: it waits and retries, never fails silently), and closing
// the window with and without the background engine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { unlock, activationEnv } = require('./helpers');

const root = path.join(__dirname, '..', '..');
const shots = process.env.LEAD_FINDER_SCREENSHOTS;

test('Settings: automation switches, continuous searches, background close', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-automation-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  const autostart = path.join(tmp, 'autostart', 'lead-finder.desktop');
  const env = { ...process.env, ...activationEnv, LEAD_FINDER_USER_DATA: userData, LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome'), LEAD_FINDER_NO_UPDATES: '1', LEAD_FINDER_TEST_BAILEYS: path.join(__dirname, 'fake-baileys.js'), LEAD_FINDER_TEST_AUTOSTART: autostart };
  delete env.ELECTRON_RUN_AS_NODE;
  let app = await _electron.launch({ args: [root], cwd: root, env });
  t.after(async () => {
    await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  let win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  await unlock(win, '1357');

  // Its own page in the top bar (also reachable from the lock menu).
  await win.getByRole('button', { name: 'Security' }).click();
  await win.getByRole('menuitem', { name: 'Settings' }).click();
  const panel = win.getByRole('region', { name: 'Settings' });
  await panel.waitFor();
  assert.equal(await win.getByRole('button', { name: 'Settings', pressed: true }).count(), 1, 'the Settings tab is selected');
  // One section at a time, chosen in the section menu.
  const nav = panel.getByRole('navigation', { name: 'Settings sections' });
  for (const name of ['Chrome', 'Continuous search', 'New search', 'CAPTCHA', 'Background']) {
    await nav.getByRole('button', { name }).click();
    await panel.getByRole('region', { name: name === 'New search' ? 'New continuous search' : name }).waitFor();
  }
  assert.equal(await panel.getByText('Windows sign-in').count(), 0, 'Windows only');
  if (shots) await win.screenshot({ path: path.join(shots, 'settings-top.png') });

  // Start with the computer: written as an autostart entry, and it turns the
  // background engine on.
  await panel.getByRole('switch', { name: 'Start with the computer' }).click();
  await win.waitForFunction(() => document.querySelector('[aria-label="Start with the computer"]')?.getAttribute('aria-checked') === 'true');
  assert.match(fs.readFileSync(autostart, 'utf8'), /Exec=".*" --background/);
  assert.equal(await panel.getByRole('switch', { name: 'Background engine' }).getAttribute('aria-checked'), 'true');
  await panel.getByRole('switch', { name: 'Auto resume after restart' }).click();
  await nav.getByRole('button', { name: 'Chrome' }).click();
  await panel.getByText(/Why Chrome asks/).waitFor();
  if (shots) await win.screenshot({ path: path.join(shots, 'settings-chrome-allow.png') });
  await panel.getByRole('radio', { name: /Lead Finder automation profile/ }).click();
  await win.waitForFunction(() => document.querySelector('[role="radio"][aria-checked="true"]')?.textContent.includes('automation profile'));
  await panel.getByText(/chrome-automation/).waitFor();
  await panel.getByText('Ready for unattended use').waitFor();

  // A continuous search: Chrome is not installed here, which only the user
  // can fix, so it stops with the reason instead of retrying.
  if (shots) await win.screenshot({ path: path.join(shots, 'settings-chrome.png') });
  await nav.getByRole('button', { name: 'New search' }).click();
  await panel.getByRole('textbox', { name: 'Continuous search keyword' }).fill('Shoes Shop');
  await panel.getByLabel('Continuous search category').fill('Shoes');
  const start = panel.getByRole('button', { name: 'Start continuous search' });
  assert.equal(await start.isDisabled(), true, 'needs a country');
  await panel.getByRole('button', { name: 'Pakistan' }).click();
  await panel.getByRole('button', { name: 'UAE' }).click();
  if (shots) await win.screenshot({ path: path.join(shots, 'settings-new.png') });
  await start.click();
  await panel.getByText('Shoes Shop', { exact: true }).waitFor(); // back on the list of searches
  let t1 = null;
  for (let i = 0; i < 60 && t1?.status !== 'failed'; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    t1 = (await win.evaluate(() => window.leadFinder.autopilotState())).tasks[0];
  }
  assert.equal(t1.status, 'failed');
  assert.match(t1.reason, /Chrome is not installed/);
  await panel.getByText('Needs attention').waitFor();
  if (shots) {
    await win.screenshot({ path: path.join(shots, 'settings-search.png') });
    await win.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await new Promise((r) => setTimeout(r, 700)); // colours fade in
    await win.screenshot({ path: path.join(shots, 'settings-search-dark.png') });
    await win.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  }
  await panel.getByRole('button', { name: 'Stop Shoes Shop' }).click();
  await panel.getByText('Stopped', { exact: true }).first().waitFor();

  // Closing the window keeps the app running.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()); // the window's X button
  await new Promise((r) => setTimeout(r, 1000));
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible())), [false]);
  await app.close();

  // Kept after a restart; with the background engine off, closing quits.
  app = await _electron.launch({ args: [root], cwd: root, env });
  win = await app.firstWindow();
  await unlock(win, '1357', { plan: null });
  const s = await win.evaluate(() => window.leadFinder.automationGet());
  assert.deepEqual([s.startWithOS, s.background, s.autoResume, s.chrome.profile], [true, true, true, 'automation']);
  assert.equal((await win.evaluate(() => window.leadFinder.autopilotState())).tasks[0].status, 'completed', 'a stopped search stays stopped');
  await win.evaluate(() => window.leadFinder.automationSet({ startWithOS: false, background: false }));
  assert.equal(fs.existsSync(autostart), false, 'autostart entry removed');
  const closed = new Promise((r) => app.process().once('exit', r));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()); // the window's X button
  await closed;
  assert.deepEqual(errors, []);
});
