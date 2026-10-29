'use strict';
// The Podcasts tab in the real app, without network: no Chats tab; the
// short header text; independent platform switches that persist (at least
// one stays on); platforms that need keys marked; the Platform keys dialog;
// pasted links handled without any request (unknown sites, Amazon Music
// links without a podcast name) and the search ending cleanly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { unlock, activationEnv } = require('./helpers');

const root = path.join(__dirname, '..', '..');

test('Podcasts tab: platform switches, keys dialog, links handled, no Chats tab', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-podcasts-'));
  const env = { ...process.env, ...activationEnv, LEAD_FINDER_USER_DATA: path.join(tmp, 'app'), LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome'), LEAD_FINDER_NO_UPDATES: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(env.LEAD_FINDER_USER_DATA);
  let app = await _electron.launch({ args: [root], cwd: root, env });
  let win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  t.after(async () => {
    await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  await unlock(win);
  const nav = win.getByRole('navigation', { name: 'Workspace' });
  assert.deepEqual(await nav.getByRole('button').allInnerTexts(), ['Leads', 'Podcasts', 'Outreach']);
  await nav.getByRole('button', { name: 'Podcasts' }).click();
  const pc = win.locator('section.podcasts');
  await pc.getByText('Discover podcasts and find contact emails automatically.').waitFor();
  assert.equal(await win.getByText(/Each podcast you choose/).count(), 0);
  assert.equal(await pc.getByRole('button', { name: /Find emails/ }).count(), 0, 'no manual Find emails button');

  const chip = (name) => pc.getByRole('switch', { name });
  const states = async () => Promise.all(['Apple Podcasts', 'Spotify', 'YouTube', 'Amazon Music'].map((n) => chip(n).getAttribute('aria-checked')));
  assert.equal(await pc.getByRole('switch').count(), 4, 'no Podcast Index');
  assert.deepEqual(await states(), ['true', 'false', 'false', 'false']);
  // Independent: Spotify and YouTube on, Apple off.
  await chip('Spotify').click();
  await chip('YouTube').click();
  await chip('Apple Podcasts').click();
  assert.deepEqual(await states(), ['false', 'true', 'true', 'false']);
  assert.doesNotMatch(await chip('Spotify').innerText(), /Key/, 'Spotify needs no keys');
  assert.match(await chip('Spotify').innerText(), /Chrome/, 'Spotify opens in Chrome');
  assert.match(await chip('YouTube').innerText(), /Key/, 'YouTube search needs a key');
  // At least one stays on.
  await chip('Spotify').click();
  await chip('YouTube').click();
  await win.locator('.toast').filter({ hasText: 'Keep at least one platform on.' }).waitFor();
  assert.deepEqual(await states(), ['false', 'false', 'true', 'false']);

  // Platform keys dialog: empty fields can't be sent; nothing is stored.
  await pc.getByRole('button', { name: 'Settings' }).click();
  const dlg = win.getByRole('dialog', { name: 'Search settings' });
  // Results per platform.
  assert.equal(await dlg.getByRole('radio', { name: '50' }).getAttribute('aria-checked'), 'true');
  await dlg.getByRole('radio', { name: '100' }).click();
  await win.waitForFunction(() => document.querySelector('[role=radio][aria-checked=true]')?.textContent === '100');
  assert.equal((await win.evaluate(() => window.leadFinder.podcastSettings())).limit, 100);
  assert.equal(await dlg.getByRole('button', { name: 'Connect' }).isDisabled(), true);
  assert.match(await dlg.locator('.pc-keys-title').innerText(), /YouTube API key/);
  assert.equal(await dlg.getByLabel('Client ID').count(), 0, 'no Spotify keys');
  await dlg.getByLabel('API key').waitFor();
  await dlg.getByRole('button', { name: 'Close', exact: true }).last().click();
  assert.equal(await dlg.count(), 0);

  // Links that need no request.
  const search = async (q) => {
    await pc.locator('#pc-q').fill(q);
    await pc.getByRole('button', { name: 'Search', exact: true }).click();
    await win.waitForFunction(() => /state-(done|stopped|failed)/.test(document.querySelector('.pc-run')?.className || ''), null, { timeout: 20_000 });
  };
  await search('https://music.amazon.com/podcasts/30a74ac6-1cf7-4ac4-bae2-1347e3927b0b');
  assert.equal(await pc.locator('.pc-run-msg').innerText(), 'No podcasts found');
  assert.match(await pc.locator('.pc-run-note').innerText(), /no podcast name/);
  await search('ftp://example.com/my-show');
  assert.match(await pc.locator('.pc-run-note').innerText(), /Only web addresses/);
  assert.equal(await pc.locator('#pc-q').isDisabled(), false, 'ready for the next search');

  // Switches are remembered.
  await app.close();
  app = await _electron.launch({ args: [root], cwd: root, env });
  win = await app.firstWindow();
  await unlock(win);
  await win.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Podcasts' }).click();
  await win.locator('section.podcasts').getByRole('switch', { name: 'YouTube' }).waitFor();
  assert.equal(await win.locator('section.podcasts').getByRole('switch', { name: 'YouTube' }).getAttribute('aria-checked'), 'true');
  assert.deepEqual(errors, []);
});

test('Podcast leads: select (rows, page, all matching), delete selected / all with confirmation, export selected / all', async (t) => {
  const { LeadStore } = require('../../src/database/db');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-podcast-mgmt-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  // 30 podcast leads, one with commas, quotes, Urdu and a line break, and a Google Maps lead.
  const seed = new LeadStore(path.join(userData, 'leads.db'));
  for (let i = 1; i <= 30; i++) seed.savePodcastLead({ id: String(i), title: `Show ${i}`, appleUrl: `https://podcasts.apple.com/x/id${i}`, status: 'not_found' });
  seed.savePodcastLead({ id: '99', title: 'Comma, "Quote" اردو', appleUrl: 'https://podcasts.apple.com/x/id99', email: 'hi@tricky.example', status: 'found', emails: [{ email: 'hi@tricky.example', kind: 'own', from: 'RSS feed' }] });
  seed.save({ placeKey: '0xmaps:1', mapsUrl: 'https://www.google.com/maps/place/x', name: 'Maps Shop', phoneRaw: '0300 1234567', address: 'Lahore', websiteStatus: 'no_website' });
  seed.close();
  const env = { ...process.env, ...activationEnv, LEAD_FINDER_USER_DATA: userData, LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome'), LEAD_FINDER_NO_UPDATES: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [root], cwd: root, env });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  t.after(async () => {
    await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  await unlock(win);
  await win.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Podcasts' }).click();
  const pc = win.locator('section.podcasts');
  await pc.getByRole('tab', { name: 'Table' }).click();
  await pc.locator('.pc-row').first().waitFor();
  const allCount = async () => Number((await pc.getByRole('tab', { name: /^All leads/ }).innerText()).match(/\d+/)[0]);
  const selCount = async () => ((await pc.locator('.pc-selbar').count()) ? Number((await pc.locator('.pc-selcount b').innerText()).replace(/\D/g, '')) : 0);
  const answer = (response) => app.evaluate(({ dialog }, r) => (dialog.showMessageBox = async () => ({ response: r })), response);
  const saveTo = (file) => app.evaluate(({ dialog }, f) => (dialog.showSaveDialog = async () => ({ canceled: false, filePath: f })), file);
  const podcastsInDb = () => win.evaluate(() => window.leadFinder.podcastLeads({ pageSize: 100 }).then((r) => r.total));
  const mapsInDb = () => win.evaluate(() => window.leadFinder.listLeads({ category: 'all', source: 'maps' }).then((r) => r.length));
  assert.equal(await allCount(), 31);
  // Nothing selected: no selection bar; bulk actions for everything.
  assert.equal(await pc.locator('.pc-selbar').count(), 0);
  await pc.getByRole('button', { name: 'Export all' }).waitFor();

  // Individual rows.
  await pc.getByRole('checkbox', { name: 'Select Show 30' }).check();
  await pc.getByRole('checkbox', { name: 'Select Show 29' }).check();
  assert.equal(await selCount(), 2);
  await pc.getByRole('checkbox', { name: 'Select Show 29' }).uncheck();
  assert.equal(await selCount(), 1);
  // The page (header checkbox), then the next page: selection is kept across pages.
  await pc.getByRole('checkbox', { name: 'Select all podcast leads on this page' }).check();
  assert.equal(await selCount(), 25);
  await pc.getByRole('button', { name: 'Next page' }).click();
  await win.waitForFunction(() => document.querySelector('.pc-page')?.textContent.includes('Page 2'));
  assert.match(await pc.locator('.pc-selcount').innerText(), /25 selected \(25 not on this page\)/);
  await pc.getByRole('checkbox', { name: 'Select all podcast leads on this page' }).check();
  assert.equal(await selCount(), 31);
  await pc.getByRole('checkbox', { name: 'Select all podcast leads on this page' }).uncheck();
  assert.equal(await selCount(), 25);
  await pc.getByRole('button', { name: 'Clear' }).click();
  assert.equal(await selCount(), 0);

  // With a filter: "select all matching" takes every match (all pages), nothing else.
  await pc.getByLabel('Filter podcasts').fill('Show 1');
  await win.waitForFunction(() => /1–11 of 11/.test(document.querySelector('.pc-pager')?.textContent || ''));
  await pc.getByRole('checkbox', { name: 'Select Show 1', exact: true }).check();
  await pc.getByRole('button', { name: 'Select all 11 matching' }).click();
  await win.waitForFunction(() => document.querySelector('.pc-selcount b')?.textContent === '11');
  await pc.getByLabel('Filter podcasts').fill('');
  await win.waitForFunction(() => /of 31/.test(document.querySelector('.pc-pager')?.textContent || ''));
  assert.equal(await selCount(), 11, 'the selection stays when the filter changes');

  // Delete selected: Cancel deletes nothing; Delete removes exactly those 11.
  await answer(1);
  await pc.getByRole('button', { name: 'Delete selected' }).click();
  await win.waitForTimeout(500);
  assert.equal(await podcastsInDb(), 31);
  assert.equal(await selCount(), 11);
  await answer(0);
  await pc.getByRole('button', { name: 'Delete selected' }).click();
  await win.locator('.toast').filter({ hasText: 'Deleted 11 podcast leads.' }).waitFor();
  assert.equal(await podcastsInDb(), 20);
  assert.equal(await allCount(), 20);
  assert.equal(await selCount(), 0);
  const left = await win.evaluate(() => window.leadFinder.podcastLeads({ pageSize: 100, sort: 'name', dir: 'asc' }).then((r) => r.rows.map((x) => x.name)));
  assert.ok(left.every((n) => !/^Show 1\d?$/.test(n)), 'Show 1 and 10-19 are gone');
  assert.ok(left.includes('Show 2') && left.includes('Comma, "Quote" اردو'));
  assert.equal(await mapsInDb(), 1, 'the Google Maps lead is untouched');

  // Export selected: exactly the selected leads, CSV-escaped.
  const out1 = path.join(tmp, 'selected.csv');
  await saveTo(out1);
  await pc.getByRole('checkbox', { name: 'Select Show 2', exact: true }).check();
  await pc.getByRole('checkbox', { name: 'Select Comma, "Quote" اردو' }).check();
  await pc.getByRole('button', { name: 'Export selected' }).click();
  await win.locator('.toast').filter({ hasText: 'Exported 2 podcast leads' }).waitFor();
  const csv1 = fs.readFileSync(out1, 'utf8');
  assert.equal(csv1.charCodeAt(0), 0xfeff);
  const rows1 = csv1.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(rows1.length, 3);
  assert.ok(rows1.some((r) => r.startsWith('"Comma, ""Quote"" اردو",')));
  assert.ok(rows1.some((r) => r.startsWith('Show 2,')));
  // Export all: every podcast lead, no other kind.
  await pc.getByRole('button', { name: 'Clear' }).click();
  const out2 = path.join(tmp, 'all.csv');
  await saveTo(out2);
  await pc.getByRole('button', { name: 'Export all' }).click();
  await win.locator('.toast').filter({ hasText: 'Exported 20 podcast leads' }).waitFor();
  const rows2 = fs.readFileSync(out2, 'utf8').trim().split('\r\n');
  assert.equal(rows2.length, 21);
  assert.ok(!rows2.some((r) => r.includes('Maps Shop')));

  // Delete all: Cancel keeps them; Delete removes every podcast lead only.
  await answer(1);
  await pc.getByRole('button', { name: 'Delete all' }).click();
  await win.waitForTimeout(500);
  assert.equal(await podcastsInDb(), 20);
  await answer(0);
  await pc.getByRole('button', { name: 'Delete all' }).click();
  await win.locator('.toast').filter({ hasText: 'Deleted 20 podcast leads.' }).waitFor();
  assert.equal(await podcastsInDb(), 0);
  assert.equal(await mapsInDb(), 1);
  await pc.getByRole('heading', { name: 'Find podcasts to reach out to' }).waitFor();
  assert.equal(await pc.getByRole('button', { name: 'Delete all' }).count(), 0, 'no bulk actions without leads');
  // An empty selection is refused by the app itself.
  assert.match((await win.evaluate(() => window.leadFinder.deletePodcasts({ ids: [] }))).error, /No podcast leads are selected/);
  assert.deepEqual(errors, []);
});
