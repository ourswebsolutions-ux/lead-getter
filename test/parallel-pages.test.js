'use strict';
// Google Maps and Facebook side by side in one Chrome session, the way the
// app uses it: attached over DevTools to Chrome's own profile context, Maps
// in its tabs, Facebook in a window of its own. Runs a throwaway headless
// Chrome with a temporary profile (the user's Chrome is never touched).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');
const { ChromeConnection, findChromeExecutable } = require('../src/browser/chrome');
const maps = require('../src/browser/maps');
const fb = require('../src/browser/facebook');

const exe = findChromeExecutable();
const fixtures = path.join(__dirname, 'fixtures');

async function chromeOverCdp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-parallel-'));
  const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  t.after(async () => {
    proc.kill();
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let port;
  for (let i = 0; i < 150 && !port; i++) {
    try {
      port = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  t.after(() => browser.close().catch(() => {}));
  const chrome = new ChromeConnection();
  chrome.browser = browser;
  chrome.context = browser.contexts()[0];
  return chrome;
}

async function windowOf(chrome, page) {
  const s = await chrome.context.newCDPSession(page);
  const { targetInfo } = await s.send('Target.getTargetInfo');
  await s.detach();
  const b = await chrome.browser.newBrowserCDPSession();
  const { windowId } = await b.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId });
  await b.detach();
  return windowId;
}

test('Maps tabs and the Facebook window work at the same time without touching each other', { skip: !exe && 'Google Chrome not installed' }, async (t) => {
  const chrome = await chromeOverCdp(t);
  await chrome.context.route('https://www.google.com/maps/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(fixtures, 'maps-results.html'), 'utf8') }));
  await chrome.context.route('https://www.facebook.com/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(fixtures, 'facebook-search.html'), 'utf8') }));
  await chrome.context.addCookies([{ name: 'c_user', value: '1', domain: '.facebook.com', path: '/', secure: true }]);

  const mapsMain = chrome.context.pages()[0] || (await chrome.context.newPage());
  const facebook = await chrome.newWindowPage();
  // Opened after Facebook's window (Chrome's "last used" window), yet next
  // to the Maps tab.
  const mapsCheck = await chrome.newTabBeside(mapsMain);
  const [wMaps, wFb, wCheck] = [await windowOf(chrome, mapsMain), await windowOf(chrome, facebook), await windowOf(chrome, mapsCheck)];
  assert.notEqual(wFb, wMaps, 'Facebook has a window of its own');
  assert.equal(wCheck, wMaps, 'new Maps tabs stay in the Maps window');
  assert.equal(await mapsCheck.evaluate(() => window.opener), null, 'no link back to the Maps page');

  // Both searches at once; Maps keeps switching between its tabs, as it
  // does when it checks websites.
  await mapsMain.goto('https://www.google.com/maps/search/x');
  let switching = true;
  const switcher = (async () => {
    while (switching) {
      await mapsCheck.bringToFront();
      await mapsMain.bringToFront();
    }
  })();
  const [mapsLinks, fbPosts] = await Promise.all([
    (async () => {
      let end = false;
      for (let i = 0; i < 40 && !end; i++) {
        ({ end } = await maps.scrollFeed(mapsMain));
        await mapsMain.waitForTimeout(250);
      }
      return maps.collectLinks(mapsMain);
    })(),
    (async () => {
      assert.deepEqual(await fb.openSearch(facebook, 'garments Lahore'), { mode: 'list' });
      await fb.expandSeeMore(facebook);
      let end = false;
      for (let i = 0; i < 20 && !end; i++) {
        ({ end } = await fb.scrollResults(facebook));
        await facebook.waitForTimeout(200);
      }
      assert.ok(end, 'Facebook kept loading results while Maps had the front');
      return fb.collectPosts(facebook);
    })(),
  ]);
  switching = false;
  await switcher;

  assert.equal(mapsLinks.length, 12, 'Maps read its whole list');
  assert.equal(fbPosts.length, 5, 'Facebook read every post, including those loaded by scrolling');
  assert.match(mapsMain.url(), /google\.com\/maps/, 'the Maps tab was never navigated by Facebook');
  assert.match(facebook.url(), /facebook\.com\/search\/posts/, 'the Facebook page was never navigated by Maps');
  assert.equal(await facebook.evaluate(() => document.visibilityState), 'visible');
});
