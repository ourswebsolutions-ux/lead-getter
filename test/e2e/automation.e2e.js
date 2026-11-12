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
  // One section at a time, chosen in the sub-tabs.
  const nav = panel.getByRole('navigation', { name: 'Settings sections' });
  for (const name of ['Chrome', 'Continuous search', 'CAPTCHA', 'Background']) {
    await nav.getByRole('button', { name }).click();
    await panel.getByRole('region', { name }).waitFor();
  }
  assert.equal(await nav.getByRole('button', { name: 'New search' }).count(), 0, 'no separate search form');
  if (shots) await win.screenshot({ path: path.join(shots, 'settings-top.png') });

  // Start with the computer: written as an autostart entry, and it turns the
  // background engine on.
  await panel.getByRole('switch', { name: 'Start with the computer' }).click();
  await win.waitForFunction(() => document.querySelector('[aria-label="Start with the computer"]')?.getAttribute('aria-checked') === 'true');
  assert.match(fs.readFileSync(autostart, 'utf8'), /Exec=".*" --background/);
  assert.equal(await panel.getByRole('switch', { name: 'Background engine' }).getAttribute('aria-checked'), 'true');
  await panel.getByRole('switch', { name: 'Auto resume after restart' }).click();
  await nav.getByRole('button', { name: 'Chrome' }).click();
  await panel.getByText(/Chrome asks “Allow” for this profile/).waitFor();
  await panel.getByRole('radio', { name: /Lead Finder automation profile/ }).click();
  await panel.getByText(/chrome-automation/).waitFor();
  await panel.getByText('Ready for unattended use').waitFor();

  // Continuous search: only a switch and the countries; the search is the Leads tab's.
  await nav.getByRole('button', { name: 'Continuous search' }).click();
  await panel.getByRole('switch', { name: 'Continuous search' }).click();
  await panel.getByRole('button', { name: 'Pakistan' }).click();
  await panel.getByRole('button', { name: 'UAE' }).click();
  await panel.getByText('Pakistan → UAE → again').waitFor();
  if (shots) await win.screenshot({ path: path.join(shots, 'settings-search.png') });
  const saved = await win.evaluate(() => window.leadFinder.automationGet());
  assert.deepEqual([saved.search.continuous, saved.search.countries], [true, ['Pakistan', 'UAE']]);

  // The Leads tab's Start Search now goes country after country. Chrome is
  // not installed here, which only the user can fix: it says so.
  await win.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Leads' }).click();
  await win.getByPlaceholder(/Software House in Lahore/).fill('Shoes Shop');
  await win.locator('#cat').fill('Shoes');
  await win.getByRole('button', { name: /Start Search/ }).click();
  let t1 = null;
  for (let i = 0; i < 60 && t1?.status !== 'failed'; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    t1 = (await win.evaluate(() => window.leadFinder.autopilotState())).tasks.find((x) => x.origin === 'leads');
  }
  assert.deepEqual([t1.keyword, t1.countries, t1.status], ['Shoes Shop', ['Pakistan', 'UAE'], 'failed']);
  assert.match(t1.reason, /Chrome is not installed/);
  await win.waitForFunction(() => /Continuous search stopped: .*Chrome/.test(document.body.innerText));
  const shoes = await win.evaluate(() => window.leadFinder.autopilotState());
  assert.equal(shoes.tasks.filter((x) => x.origin === 'leads').length, 1);

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
  assert.deepEqual([s.startWithOS, s.background, s.autoResume, s.chrome.profile, s.search.continuous], [true, true, true, 'automation', true]);
  assert.equal((await win.evaluate(() => window.leadFinder.autopilotState())).tasks[0].status, 'failed', 'kept as it was');
  await win.evaluate(() => window.leadFinder.automationSet({ startWithOS: false, background: false }));
  assert.equal(fs.existsSync(autostart), false, 'autostart entry removed');
  const closed = new Promise((r) => app.process().once('exit', r));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()); // the window's X button
  await closed;
  assert.deepEqual(errors, []);
});
