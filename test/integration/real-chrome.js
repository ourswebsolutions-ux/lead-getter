'use strict';
// Integration run against the user's real, already-running Chrome.
//   node test/integration/real-chrome.js "Real Estate Lahore" [maxListings]
// Requires "Allow remote debugging for this browser instance" to be on at
// chrome://inspect/#remote-debugging; Chrome will ask you to Allow the
// connection. Leads go to a temporary database, not the app's.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChromeConnection } = require('../../src/browser/chrome');
const { SearchSession } = require('../../src/browser/search-session');
const { LeadStore } = require('../../src/database/db');

const keyword = process.argv[2] || 'Real Estate Lahore';
const maxListings = Number(process.argv[3] || 6);

(async () => {
  const conn = new ChromeConnection({ onStatus: (m) => console.log(`[chrome] ${m}`) });
  const profile = await conn.connect();
  console.log('[chrome] connected', {
    profile: profile.name,
    dir: profile.dir,
    account: profile.account,
    path: profile.path,
    defaultUserDataDir: profile.isDefaultUserDataDir,
    otherOpen: profile.otherOpenProfiles,
    chrome: profile.chromeVersion,
    via: profile.via,
  });

  const opened = [profile.page];
  const tabs = { main: profile.page };
  const tab = async (k) => {
    if (!tabs[k] || tabs[k].isClosed()) {
      tabs[k] = await conn.context.newPage();
      opened.push(tabs[k]);
    }
    return tabs[k];
  };

  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lf-int-')), 'leads.db');
  const store = new LeadStore(dbFile);
  const controller = new AbortController();
  const session = new SearchSession({
    keyword,
    store,
    signal: controller.signal,
    pages: { main: () => tab('main'), check: () => tab('check'), detail: () => tab('detail') },
    emit: (event, p) => {
      if (event === 'lead') console.log('[lead]', JSON.stringify(p));
      else {
        console.log(`[status] ${p.state} | ${p.message} | processed=${p.processed} leads=${p.leads}`);
        if (p.processed >= maxListings && !controller.signal.aborted) controller.abort();
      }
    },
  });
  const stats = await session.run();
  console.log('[done]', stats);
  for (const row of store.db.prepare('SELECT name, website_status, website_detail, phone, address FROM businesses').all()) {
    console.log('[row]', JSON.stringify(row));
  }
  store.close();
  if (process.env.KEEP_TABS !== '1') for (const p of opened) await p.close().catch(() => {});
  await conn.disconnect();
  console.log('[chrome] disconnected; Chrome left running');
})().catch((err) => {
  console.error('[error]', err.code || '', err.message);
  process.exit(1);
});
