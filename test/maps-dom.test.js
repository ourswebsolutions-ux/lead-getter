'use strict';
// DOM extraction against a mocked Maps page in a throwaway headless Chrome
// (temporary profile; the user's profile is never touched by unit tests).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const maps = require('../src/browser/maps');
const { findChromeExecutable } = require('../src/browser/chrome');

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'maps-results.html'), 'utf8');
const exe = findChromeExecutable();

test('Maps DOM: links, scrolling, details, and block detection', { skip: !exe && 'Google Chrome not installed' }, async (t) => {
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://www.google.com/maps/**', (r) => r.fulfill({ contentType: 'text/html', body: fixture }));
  await page.goto('https://www.google.com/maps/search/x');

  let links = await maps.collectLinks(page);
  assert.equal(links.length, 5);
  assert.equal(links[0].name, 'Al Noor Real Estate');
  assert.equal(maps.placeKey(links[0].url), '0x1:0xa');

  // Scroll until the end marker appears; every listing is collected once.
  // Slow CI machines render the next batch late, so allow a generous budget.
  let end = false;
  for (let i = 0; i < 40 && !end; i++) {
    ({ end } = await maps.scrollFeed(page));
    await page.waitForTimeout(250);
  }
  ({ end } = await maps.scrollFeed(page));
  links = await maps.collectLinks(page);
  const where = await page.evaluate(() => {
    const l = document.getElementById('list');
    return { cards: document.querySelectorAll('#feed a').length, scrollTop: l.scrollTop, scrollHeight: l.scrollHeight, clientHeight: l.clientHeight, overflowY: getComputedStyle(l).overflowY };
  });
  assert.ok(end, `end of list not reached: ${JSON.stringify(where)}`);
  assert.equal(links.length, 12);

  assert.ok(await maps.openListing(page, links[0]));
  let d = await maps.extractDetails(page);
  assert.equal(d.name, 'Al Noor Real Estate');
  assert.equal(d.website, '');
  assert.equal(d.address, '12 Main Blvd, Gulberg III, Lahore, Pakistan');
  assert.equal(d.phoneTel, '+923001234567');
  assert.equal(d.phoneText, '0300 1234567');
  assert.ok(d.infoLoaded);

  assert.ok(await maps.openListing(page, links[1]));
  d = await maps.extractDetails(page);
  assert.match(d.website, /zahidproperties\.pk/);
  assert.equal(d.phoneTel, '');

  assert.ok(await maps.openListing(page, links[2]));
  d = await maps.extractDetails(page);
  assert.equal(d.name, 'خان اسٹیٹ ایجنسی');
  assert.equal(d.address, 'جوہر ٹاؤن، لاہور');

  assert.ok(await maps.openListing(page, links[3]));
  assert.ok((await maps.extractDetails(page)).closed);

  // Details shown beside the list: the feed is still there.
  assert.ok(await maps.returnToResults(page));

  // Missing card -> false, so the caller can fall back.
  assert.equal(await maps.openListing(page, { url: 'https://www.google.com/maps/place/nope', name: 'nope' }), false);

  assert.equal(await maps.detectBlock(page), null);
  await page.setContent('<form action="https://www.google.com/sorry/index"><div id="captcha-form"></div></form>');
  assert.equal(await maps.detectBlock(page), 'captcha');
  await page.setContent('<p>Our systems have detected unusual traffic from your computer network.</p>');
  assert.equal(await maps.detectBlock(page), 'rate_limit');
});
