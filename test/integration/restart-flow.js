'use strict';
// Real test of the automatic restart path for a Chrome running on a
// non-default profile folder. Uses its own temporary folder; the user's
// everyday Chrome is never touched.
//   node test/integration/restart-flow.js [keyword maxListings]
// With a keyword it also runs a short real Google Maps search there.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const chrome = require('../../src/browser/chrome');
const { SearchSession } = require('../../src/browser/search-session');
const { LeadStore } = require('../../src/database/db');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-restart-'));
  process.env.LEAD_FINDER_CHROME_USER_DATA = dir;
  const exe = chrome.findChromeExecutable();

  const mainPid = async () => (await chrome.listChromeSessions()).find((s) => s.userDataDir === dir)?.pid;
  // Mark first run as done (test folder only), like any profile in daily use.
  fs.writeFileSync(path.join(dir, 'First Run'), '');
  // 0. Warm-up run so the folder is a used profile, past Chrome's first-run pages.
  spawn(exe, [`--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check'], { detached: true, stdio: 'ignore' }).unref();
  await sleep(6000);
  process.kill(await mainPid(), 'SIGTERM');
  await sleep(4000);

  // 1. A normal Chrome (no debugging) on that folder, with a marker tab.
  spawn(exe, [`--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', 'https://example.com/?lead-finder-marker'], { detached: true, stdio: 'ignore' }).unref();
  await sleep(6000);
  const before = (await chrome.listChromeSessions()).find((s) => s.userDataDir === dir);
  console.log('[1] running without debugging:', before && { pid: before.pid, debugPort: before.debugPort });
  console.log('    endpoint before:', (await chrome.findDebugEndpoint(dir)).endpoint);

  // 2. Lead Finder connects: should restart gracefully and reconnect.
  const conn = new chrome.ChromeConnection({ onStatus: (m) => console.log('    [status]', m) });
  const t0 = Date.now();
  const profile = await conn.connect();
  const after = (await chrome.listChromeSessions()).find((s) => s.userDataDir === dir);
  console.log(`[2] connected in ${Math.round((Date.now() - t0) / 1000)}s`, {
    profilePath: profile.path,
    sameFolder: path.dirname(profile.path) === dir,
    oldPid: before.pid,
    newPid: after?.pid,
    chrome: profile.chromeVersion,
    via: profile.via,
  });
  await sleep(2500);
  const urls = conn.context.pages().map((p) => p.url());
  console.log('[3] tabs after relaunch:', urls);
  console.log('    marker tab restored:', urls.some((u) => u.includes('lead-finder-marker')));

  const keyword = process.argv[2];
  if (keyword) {
    const max = Number(process.argv[3] || 5);
    const store = new LeadStore(':memory:');
    const tabs = { main: profile.page };
    const tab = async (k) => (tabs[k] && !tabs[k].isClosed() ? tabs[k] : (tabs[k] = await conn.context.newPage()));
    const ac = new AbortController();
    const s = new SearchSession({
      keyword,
      store,
      signal: ac.signal,
      pages: { main: () => tab('main'), check: () => tab('check'), detail: () => tab('detail') },
      emit: (e, p) => {
        if (e === 'lead') console.log('    [lead]', JSON.stringify(p));
        else {
          console.log(`    [${p.state}] ${p.message} (processed=${p.processed} leads=${p.leads})`);
          if (p.processed >= max) ac.abort();
        }
      },
    });
    console.log('[4] search', keyword, await s.run());
    for (const row of store.db.prepare('SELECT name, website_status, website_detail, phone, address FROM businesses').all()) {
      console.log('    [row]', JSON.stringify(row));
    }
  }

  // Cleanup: this test Chrome is ours, so close it (gracefully) and remove its folder.
  await conn.disconnect();
  process.kill(after.pid, 'SIGTERM');
  await sleep(3000);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('[5] cleaned up');
})().catch((e) => {
  console.error('[error]', e.code || '', e.message);
  process.exit(1);
});
