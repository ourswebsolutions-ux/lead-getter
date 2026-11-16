'use strict';
// Search control with a real Chrome (Lead Finder's automation profile) on
// real Google Maps and the test WhatsApp: Stop from the Leads tab ends the
// search and nothing starts after it; a search set up on WhatsApp runs to
// the end of its results, the admin is asked what is next, and the pool is
// not started by itself; "next" asks; "leads" counts.
//   node --test test/integration/search-control.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { unlock, activationEnv } = require('../e2e/helpers');

const root = path.join(__dirname, '..', '..');
const ADMIN = '923211234567';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

test('Stop ends the search; a WhatsApp search runs to its end; nothing starts by itself', { timeout: 20 * 60_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-control-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  const waLog = path.join(tmp, 'wa-sent.log');
  const env = { ...process.env, ...activationEnv, LEAD_FINDER_USER_DATA: userData, LEAD_FINDER_NO_UPDATES: '1', LEAD_FINDER_TEST_BAILEYS: path.join(root, 'test', 'e2e', 'fake-baileys.js'), LEAD_FINDER_TEST_BAILEYS_LOG: waLog, LEAD_FINDER_TEST_MAX_LISTINGS: '3' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [root], cwd: root, env });
  const profileDir = path.join(userData, 'chrome-automation');
  t.after(async () => {
    await app.close().catch(() => {});
    const { execSync } = require('node:child_process');
    for (const l of execSync('ps -eo pid=,args=').toString().split('\n')) if (/\/chrome(\s|$)/.test(l.split(' --')[0]) && l.includes(profileDir)) try { process.kill(Number(l.trim().split(/\s+/)[0])); } catch {}
    await sleep(1500);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const win = await app.firstWindow();
  await unlock(win, '2468');
  const api = (fn, arg) => win.evaluate(([f, a]) => window.leadFinder[f](a), [fn, arg]);
  const tasks = async () => (await api('autopilotState')).tasks;
  const status = () => api('getStatus');
  const toAdmin = () => (fs.existsSync(waLog) ? fs.readFileSync(waLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.text && e.jid.startsWith(ADMIN)).map((e) => e.text) : []);
  const until = async (what, fn, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn().catch(() => null);
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out: ${what}`);
      await sleep(700);
    }
  };
  const admin = async (text, re, ms = 20_000) => {
    const n = toAdmin().length;
    await app.evaluate((_, a) => globalThis.__fakeWA.incoming(a.from, a.text), { from: ADMIN, text });
    return until(`reply to "${text}"`, async () => toAdmin().slice(n).find((m) => re.test(m)), ms);
  };
  for (let i = 0; i < 50 && !(await api('waAccounts')).some((a) => a.state === 'open'); i++) await sleep(200);
  const set = await api('automationSet', { chrome: { profile: 'automation', autoRestart: true }, search: { continuous: true, countries: ['Oman', 'Qatar'] } });
  assert.equal(set.ok, true, set.error);
  await api('automationSet', { adminNumber: ADMIN });
  await api('automationSet', { adminNumber: ADMIN });

  // 1. Leads tab: a search, stopped while it opens a listing.
  await win.getByPlaceholder(/Software House in Lahore/).fill('Shoes Shop');
  await win.locator('#cat').fill('Shoes');
  await win.getByRole('button', { name: /Start Search/ }).click();
  await until('opening a listing', async () => /Opening listing|Not a lead|Saved/.test((await status()).message), 4 * 60_000);
  log('stopping during:', (await status()).message);
  const stoppedAt = Date.now();
  await win.getByRole('button', { name: /Stop Search/ }).click();
  await until('stopped', async () => ['stopped', 'done'].includes((await status()).state), 30_000);
  log(`stopped in ${Date.now() - stoppedAt} ms`);
  const afterStop = await tasks();
  assert.ok(afterStop.every((x) => !['running', 'pending', 'waiting'].includes(x.status)), 'nothing waiting to run');
  // Nothing continues: no new search, no status from a search, for 25 s.
  const quiet = (await status()).message;
  await sleep(25_000);
  const later = await status();
  assert.ok(!['running', 'connecting'].includes(later.state), `no search started after Stop (${later.state}: ${later.message})`);
  assert.equal(later.message, quiet, 'no search activity after Stop');
  assert.ok((await tasks()).every((x) => !['running', 'pending', 'waiting'].includes(x.status)));
  log('nothing ran after Stop');

  // 2. WhatsApp: a search set up step by step, run to the end of its results.
  await admin('search', /Which country/);
  await admin('Oman', /Select a category/);
  await admin('Shoes', /Which business type/);
  await admin('Shoe Stores', /Should I start this search\?/);
  await admin('yes', /Search started successfully/);
  // While it runs: a search added to the pool must not start by itself.
  await admin('pool add', /one per line/);
  await admin('Qatar, Shoes, Sports Shops', /Add 1 search to the pool\?/);
  await admin('yes', /Added 1 to the search pool/);
  await admin('status', /Lead Finder status/);
  const done = await until('the completion message', async () => toAdmin().find((m) => /Current search completed: Oman → Shoes → Shoe Stores/.test(m)), 8 * 60_000);
  log('admin told:', done.split('\n')[0], '|', done.split('\n')[1]);
  assert.match(done, /What would you like to search next\?[\s\S]*Nothing starts until you choose/);
  await sleep(20_000);
  const list = await tasks();
  assert.equal(list.find((x) => x.keyword === 'Sports Shops').status, 'queued', 'the pool did not start by itself');
  assert.ok(!['running', 'connecting'].includes((await status()).state), 'no search started after the completion');
  const finished = list.find((x) => x.keyword === 'Shoe Stores');
  assert.deepEqual([finished.status, finished.exhausted], ['completed', true]);
  assert.ok(finished.processed >= 1);

  // 3. Counts and "next".
  const counts = await admin('leads', /Lead counts/);
  log(counts.replace(/\n/g, ' | '));
  assert.match(counts, /Oman → Shoes → Shoe Stores\nFound: \d+ · Checked: \d+ · Remaining: \d+ · New leads: \d+\nStatus: Completed/);
  const next = await admin('next', /Which search should I start next\?/);
  assert.match(next, /1\. Qatar → Shoes → Sports Shops/);
  await admin('cancel', /Cancelled/);
  assert.equal((await tasks()).find((x) => x.keyword === 'Sports Shops').status, 'queued');
});
