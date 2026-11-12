'use strict';
// Continuous search, for real: the Electron app, a real Chrome (Lead
// Finder's automation profile, in a temporary folder) and real Google Maps.
// Nothing is simulated except the size of each search (2 listings per
// country, LEAD_FINDER_TEST_MAX_LISTINGS) and shorter waits between
// countries. Checks: country rotation and rounds, leads saved at once and
// never twice, the window closed while the work goes on, Chrome killed and
// recovered, the app killed (power cut) and resumed at a "sign-in" start
// before the PIN, and a CAPTCHA page: paused, notified, resumed once gone.
//   node --test test/integration/autopilot-real.test.js
// Needs Google Chrome and a display; searches Google Maps (a few requests).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { _electron, chromium } = require('playwright-core');
const { LeadStore } = require('../../src/database/db');
const { unlock, activationEnv } = require('../e2e/helpers');

const root = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function until(what, fn, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(1000);
  }
}

test('continuous search with real Chrome and Google Maps: rotation, background, Chrome crash, power cut, CAPTCHA', { timeout: 40 * 60_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-autopilot-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  const profileDir = path.join(userData, 'chrome-automation');
  const env = {
    ...process.env,
    ...activationEnv,
    LEAD_FINDER_USER_DATA: userData,
    LEAD_FINDER_NO_UPDATES: '1',
    LEAD_FINDER_TEST_BAILEYS: path.join(root, 'test', 'e2e', 'fake-baileys.js'),
    LEAD_FINDER_TEST_MAX_LISTINGS: '3',
    LEAD_FINDER_TEST_AUTOPILOT: JSON.stringify({ betweenCountries: 5000, betweenRounds: 15_000, retryBase: 5000, retryMax: 30_000 }),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  const launch = async (args = []) => {
    app = await _electron.launch({ args: [root, ...args], cwd: root, env });
    app.process().stderr.on('data', () => {});
    return app;
  };
  const chromePids = () => {
    try {
      // Chrome's own processes only (its main process carries the folder).
      return execSync('ps -eo pid=,args=')
        .toString()
        .split('\n')
        .filter((l) => /\/chrome(\s|$)/.test(l.split(' --')[0]) && l.includes(`--user-data-dir=${profileDir}`))
        .map((l) => Number(l.trim().split(/\s+/)[0]))
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  t.after(async () => {
    await app?.close().catch(() => {});
    for (const pid of chromePids()) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    await sleep(2000);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const state = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('window.leadFinder.autopilotState()'));
  const task = async () => (await state()).tasks[0];
  const leadsInDb = () => {
    const s = new LeadStore(path.join(userData, 'leads.db'));
    try {
      return s.db.prepare("SELECT place_key, name FROM businesses WHERE qualified = 1 AND place_key NOT LIKE 'pc:%' AND place_key NOT LIKE 'lp:%'").all();
    } finally {
      s.close();
    }
  };
  const autoLog = () => {
    try {
      return fs.readFileSync(path.join(userData, 'automation.log'), 'utf8');
    } catch {
      return '';
    }
  };

  // 1. Set up: PIN, plan, Settings (through the real UI calls).
  await launch();
  let win = await app.firstWindow();
  await unlock(win, '2468');
  const set = await win.evaluate(() => window.leadFinder.automationSet({ background: true, autoResume: true, chrome: { profile: 'automation', autoRestart: true } }));
  assert.equal(set.ok, true, set.error);
  assert.equal(set.settings.chrome.profile, 'automation');
  const added = await win.evaluate(() => window.leadFinder.autopilotAdd({ keyword: 'Shoes Shop', category: 'Shoes', countries: ['Oman', 'Qatar', 'Bahrain', 'Kuwait'], websiteFilter: 'all' }));
  assert.equal(added.ok, true, added.error);
  await win.evaluate(() => window.leadFinder.autopilotEngine('start'));
  log('started');

  // 2. First country: real Chrome started on the automation folder, leads saved.
  await until('Oman searched', async () => (await task()).index === 1, 8 * 60_000);
  assert.ok(fs.existsSync(path.join(profileDir, 'Local State')), 'Chrome runs on Lead Finder’s own folder');
  const afterOman = leadsInDb();
  log('Oman done', afterOman.length, 'leads', (await task()).reason);
  assert.ok(chromePids().length > 0, 'Chrome was started by Lead Finder');

  // 3. Close the window: the app keeps working in the background.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()); // the window's X button
  await sleep(1500);
  const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()));
  assert.deepEqual(visible, [false], 'the window is hidden, not closed');
  await until('Qatar searched with the window closed', async () => (await task()).index === 2, 8 * 60_000);
  log('Qatar done with the window closed', leadsInDb().length, 'leads');

  // 4. Chrome crashes while Bahrain opens a listing: reopened, the work goes on.
  const status = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('window.leadFinder.getStatus()'));
  await until('Bahrain opening a listing', async () => /Shoes Shop in Bahrain/.test(autoLog()) && /Opening listing/.test((await status()).message), 3 * 60_000);
  const killed = chromePids();
  for (const pid of killed) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  log('Chrome killed', killed.length, 'processes');
  const noticed = await until('the search noticed Chrome closing', async () => {
    const m = (await status()).message;
    return /Chrome closed unexpectedly|Reopening|Reconnect|Connecting to Chrome|Starting Chrome/i.test(m) ? m : null;
  }, 60_000);
  log('noticed:', noticed);
  await until('Chrome reopened by Lead Finder', async () => chromePids().some((p) => !killed.includes(p)), 3 * 60_000);
  await until('Bahrain finished after the crash', async () => (await task()).index === 3, 8 * 60_000);
  assert.notEqual((await task()).status, 'failed');
  log('recovered from the Chrome crash');

  // 5. Power cut while Kuwait opens a listing: app and Chrome die at once.
  await until('Kuwait opening a listing', async () => /Shoes Shop in Kuwait/.test(autoLog()) && /Opening listing/.test((await status()).message), 3 * 60_000);
  app.process().kill('SIGKILL');
  for (const pid of chromePids()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  await sleep(1500);
  log('app and Chrome killed (power cut)');
  const beforeRestart = leadsInDb();
  const afterRound1 = beforeRestart;
  // Started at sign-in: hidden, and resumed before anyone enters the PIN.
  await launch(['--background']);
  win = await app.firstWindow();
  await sleep(3000);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false, 'a sign-in start stays in the tray');
  assert.equal((await win.evaluate(() => window.leadFinder.lockState())).unlocked, false, 'the window stays locked');
  await until('Kuwait searched again before the PIN', async () => /notice resumed[\s\S]*Shoes Shop in Kuwait/.test(autoLog().split('started in the background').at(-1)) && chromePids().length > 0, 3 * 60_000);
  log('resumed at Kuwait before the PIN');
  await unlock(win, '2468', { plan: null });

  // 6. CAPTCHA: Google's verification page in the search tab. The search
  // pauses (and says so); once the page is gone it carries on by itself.
  await until('Kuwait searching', async () => /Opening listing|Not a lead|Saved|Waiting for results|Results loaded/.test((await status()).message), 3 * 60_000);
  const port = Number(fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
  const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const mapsPage = cdp.contexts()[0].pages().find((p) => /google\.[a-z.]+\/maps/.test(p.url()));
  assert.ok(mapsPage, 'the Google Maps tab');
  const back = mapsPage.url();
  await mapsPage.goto(`https://www.google.com/sorry/index?continue=${encodeURIComponent(back)}`).catch(() => {});
  log('CAPTCHA page shown');
  const pausedMsg = await until('the search paused on the CAPTCHA', async () => {
    const st = await status();
    return st.state === 'paused' && /CAPTCHA|unusual traffic/i.test(st.message) ? st.message : null;
  }, 2 * 60_000);
  log('paused:', pausedMsg);
  assert.ok(/notice captcha/.test(autoLog()), 'the user is notified');
  await sleep(5000);
  assert.equal((await status()).state, 'paused', 'no retry loop: it waits for the user');
  await mapsPage.goto(back).catch(() => {}); // "the user completes it"
  await cdp.close();
  await until('carried on after the check', async () => (await status()).state !== 'paused', 3 * 60_000);
  log('resumed after the CAPTCHA:', (await status()).message);

  // 7. Leads: none lost, none twice.
  await until('Kuwait finished after the CAPTCHA', async () => (await task()).round === 2, 8 * 60_000);
  const final = leadsInDb();
  const keys = final.map((l) => l.place_key);
  assert.equal(new Set(keys).size, keys.length, 'no business saved twice');
  for (const l of beforeRestart) assert.ok(keys.includes(l.place_key), `kept after the power cut: ${l.name}`);
  assert.ok(final.length >= afterRound1.length);
  const last = await task();
  log('final', { leads: final.length, round: last.round, index: last.index, status: last.status, reason: last.reason, counted: last.leads });
  await win.evaluate(() => window.leadFinder.autopilotEngine('stop'));
});
