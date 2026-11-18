'use strict';
// LinkedIn "My connections" in a real browser, on pages built like
// LinkedIn's: the connections list (loaded with "Show more results"), each
// profile and its Contact info, saved once; missing details left empty.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { LinkedInSession } = require('../src/browser/linkedin-session');
const { findChromeExecutable } = require('../src/browser/chrome');
const { LeadStore } = require('../src/database/db');
const { leadsToCsv } = require('../src/export/csv');

const exe = findChromeExecutable();
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'linkedin-connections.html'), 'utf8');

async function run(t, { store = new LeadStore(':memory:'), signal = new AbortController().signal, onStatus } = {}) {
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await context.addCookies([{ name: 'li_at', value: '1', domain: '.linkedin.com', path: '/', secure: true }]);
  const page = await context.newPage();
  const visited = [];
  await context.route('https://www.linkedin.com/**', (r) => {
    visited.push(new URL(r.request().url()).pathname);
    return r.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture });
  });
  await context.route(/^https:\/\/(?!www\.linkedin\.com)/, (r) => r.fulfill({ status: 404, body: '' }));
  const statuses = [];
  const leads = [];
  const cat = store.ensureCategory('LinkedIn Connections');
  const session = new LinkedInSession({
    keyword: 'LinkedIn connections',
    modes: { connections: true, people: false, jobs: false, posts: false, companies: false },
    country: 'PK',
    store,
    categoryId: cat.id,
    pages: { linkedin: async () => page },
    signal,
    fetchImpl: async () => new Response('', { status: 404 }),
    pacing: { liPage: [5, 5], liMaps: false, netRetries: [1] },
    emit: (e, p) => (e === 'status' ? (statuses.push(p.message), onStatus?.(p.message)) : e === 'lead' && leads.push(p)),
  });
  const outcome = await session.run();
  return { outcome, stats: session.stats.linkedin, store, statuses, visited, leads };
}

test('My connections: every connection (Show more results), profile and Contact info, saved once; nothing else searched', { skip: !exe && 'Google Chrome not installed' }, async (t) => {
  const store = new LeadStore(':memory:');
  const { outcome, stats, visited, leads, statuses } = await run(t, { store });
  assert.equal(outcome.state, 'done', outcome.message);
  assert.match(outcome.message, /5 connections read/);
  assert.equal(stats.connections, 5);
  assert.equal(leads.length, 5);
  assert.ok(!visited.some((u) => /\/search\//.test(u)), 'no LinkedIn search: only the connections');
  const opened = visited.filter((u) => /^\/in\/[^/]+\/?$/.test(u)).map((u) => u.split('/')[2]);
  assert.deepEqual(opened, ['ali-raza', 'sara-khan', 'omar-farooq', 'nina-shah', 'zain-ali'], 'each profile once, in list order');
  const by = Object.fromEntries(store.listLeads({ source: 'linkedin' }).map((l) => [l.name, l]));
  const ali = by['Ali Raza'];
  assert.deepEqual([ali.email, ali.phone, ali.websiteUrl, ali.profileUrl, ali.companyName, ali.address], ['ali@fitoutpro.example', '+971501234567', 'https://fitoutpro.example/', 'https://www.linkedin.com/in/ali-raza', 'Fit Out Pro', 'Dubai, United Arab Emirates']);
  assert.match(ali.discovery, /Address: Business Bay, Dubai/);
  assert.match(ali.discovery, /Connected: Nov 10, 2026/);
  assert.doesNotMatch(ali.discovery, /March 3/, 'the birthday is personal: not kept');
  // Missing details: left empty, the lead is still saved.
  assert.deepEqual([by['Sara Khan'].email, by['Sara Khan'].phone], ['', '']);
  assert.equal(by['Nina Shah'].phone, '+923001234567', 'a local number read with the profile’s country');
  assert.equal(by['Zain Ali'].websiteUrl, 'https://arcstudio.example/');
  assert.equal(by['Omar Farooq'].email, 'omar@buildco.example');
  assert.ok(statuses.some((m) => /LinkedIn connections: \d+ read/.test(m)), 'progress');
  // Export: a CSV with the LinkedIn columns.
  const csv = leadsToCsv(store.listLeads({ source: 'linkedin' }));
  assert.match(csv, /Ali Raza,\+971501234567,[^\n]*ali@fitoutpro\.example,https:\/\/fitoutpro\.example\//);
  assert.match(csv, /https:\/\/www\.linkedin\.com\/in\/ali-raza,CEO|https:\/\/www\.linkedin\.com\/in\/ali-raza,/);

  // Run again: nobody saved twice, no profile opened again.
  const again = await run(t, { store });
  assert.equal(again.stats.duplicates, 5);
  assert.equal(again.leads.length, 0);
  assert.equal(again.visited.filter((u) => /^\/in\/[^/]+\/?$/.test(u)).length, 0);
  assert.equal(store.listLeads({ source: 'linkedin' }).length, 5);
});

test('My connections: Stop ends it at once', { skip: !exe && 'Google Chrome not installed' }, async (t) => {
  const ctrl = new AbortController();
  const { outcome, store } = await run(t, { signal: ctrl.signal, onStatus: (m) => /Sara Khan: profile/.test(m) && ctrl.abort() });
  assert.equal(outcome.state, 'stopped');
  assert.ok(store.listLeads({ source: 'linkedin' }).length <= 2);
});
