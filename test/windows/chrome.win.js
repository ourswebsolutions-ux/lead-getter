'use strict';
// Windows only (GitHub's Windows runner has Chrome): the Lead Finder
// automation profile in a folder whose name has a space, as in
// %APPDATA%\Lead Finder\chrome-automation. Lead Finder starts Chrome there,
// finds it again, connects and verifies the profile, with no prompt.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const chrome = require('../../src/browser/chrome');

(async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lf ')), 'Lead Finder', 'chrome-automation');
  assert.ok(chrome.findChromeExecutable(), 'Chrome is installed');
  const conn = new chrome.ChromeConnection({ onStatus: (m) => console.log('[chrome]', m), options: () => ({ userDataDir: dir, autoLaunch: true }) });
  const profile = await conn.connect();
  console.log('connected', { name: profile.name, path: profile.path, via: profile.via, version: profile.chromeVersion });
  assert.equal(path.resolve(profile.userDataDir).toLowerCase(), path.resolve(dir).toLowerCase(), 'the automation folder, found again');
  const sessions = await chrome.listChromeSessions();
  const mine = sessions.find((s) => s.userDataDir.toLowerCase() === path.resolve(dir).toLowerCase());
  assert.ok(mine, `listed with its exact folder (got ${JSON.stringify(sessions.map((s) => s.userDataDir))})`);
  // A page loads in it.
  const page = await conn.context.newPage();
  await page.goto('data:text/html,<title>ok</title>');
  assert.equal(await page.title(), 'ok');
  await conn.disconnect();
  try {
    process.kill(mine.pid);
  } catch {}
  console.log('Automation profile with a space in its folder: all checks passed');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
