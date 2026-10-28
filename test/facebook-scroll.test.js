'use strict';
// Facebook's infinite results, end to end in a throwaway headless Chrome:
// the real page code and FacebookSession read the posts on screen, scroll,
// wait for Facebook to load more (a delayed, IntersectionObserver-driven
// fixture with a loading indicator), and repeat until the end of the
// results, a stall, or the post limit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { findChromeExecutable } = require('../src/browser/chrome');
const { LeadStore } = require('../src/database/db');
const { FacebookSession } = require('../src/browser/facebook-session');

const exe = findChromeExecutable();
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'facebook-infinite.html'), 'utf8');

async function run(t, config, pacing = {}) {
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await context.addCookies([{ name: 'c_user', value: '1', domain: '.facebook.com', path: '/', secure: true }]);
  const page = await context.newPage();
  await page.route('https://www.facebook.com/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture.replace('<script>', `<script>window.CONFIG = ${JSON.stringify(config)};</script><script>`) }));
  const store = new LeadStore(':memory:');
  const statuses = [];
  const session = new FacebookSession({
    keyword: 'garments Lahore',
    country: 'PK',
    store,
    pages: { facebook: async () => page },
    signal: new AbortController().signal,
    pacing: { fbScroll: [100, 100], fbLoad: 5000, fbStallRetries: 2, fbStallWait: [200, 200], netRetries: [1], ...pacing },
    emit: (e, p) => e === 'status' && statuses.push(p.message),
  });
  const outcome = await session.run();
  return { outcome, stats: session.stats.facebook, store, statuses };
}

test('scrolls, waits for each new batch, reads every post once, until the end of the results', { skip: !exe && 'Google Chrome not installed' }, async (t) => {
  const { outcome, stats, store, statuses } = await run(t, { pages: 5 });
  assert.equal(outcome.state, 'done', outcome.message);
  // 5 batches of 3, loaded one after another while scrolling.
  assert.deepEqual(stats, { posts: 15, detected: 10, numbers: 10, unverified: 0, leads: 10, newLeads: 10, duplicates: 0, failures: 0 });
  assert.equal(store.listLeads().length, 10);
  assert.ok(store.listLeads().every((l) => /^\+9230010000\d\d$/.test(l.phone) && l.source === 'facebook'));
  assert.equal(outcome.message, '15 posts read, 10 valid numbers, 10 new leads. End of the results for "garments Lahore".');
  // Progress said what it was doing.
  assert.ok(statuses.some((m) => /^Facebook: 3 posts read · 2 valid numbers · 2 new leads · loading more posts$/.test(m)));
  assert.ok(!statuses.some((m) => /waiting for more posts/.test(m)), 'every batch arrived on the first wait');
});

test('when no more posts load (no end marker), it retries, then stops and says so', { skip: !exe && 'Google Chrome not installed' }, async (t) => {
  const { outcome, stats, statuses } = await run(t, { pages: 10, stall: 2 }, { fbLoad: 2000 });
  assert.equal(outcome.state, 'done');
  assert.deepEqual([stats.posts, stats.newLeads], [6, 4]);
  assert.match(outcome.message, /No more posts loaded for "garments Lahore" after 2 tries\.$/);
  assert.ok(statuses.some((m) => /waiting for more posts \(try 1 of 2\)/.test(m)));
});

test('stops at the post limit', { skip: !exe && 'Google Chrome not installed' }, async (t) => {
  const { outcome, stats } = await run(t, { pages: 10 }, { fbMaxPosts: 7 });
  assert.equal(stats.posts, 7);
  assert.match(outcome.message, /Stopped at 7 posts for "garments Lahore"\.$/);
});
