'use strict';
// WhatsApp chats and real-estate outreach in the real Electron app, with a
// scripted WhatsApp (test/e2e/fake-baileys.js): chat list and history, live
// messages, replies and receipts, the outreach campaign in test and live
// mode, reply handling, and the schedule surviving a restart.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { LeadStore } = require('../../src/database/db');
const { unlock, startLicenseServer, deviceIdOf } = require('./helpers');

const root = path.join(__dirname, '..', '..');
const shots = process.env.LEAD_FINDER_SCREENSHOTS;

function seed(file) {
  const s = new LeadStore(file);
  const cat = s.ensureCategory('Real Estate');
  let i = 0;
  const add = (name, phoneRaw) => s.save({ placeKey: `0x${++i}:0x7`, mapsUrl: `https://www.google.com/maps/place/O${i}`, name, phoneRaw, address: 'Lahore, Pakistan', websiteStatus: 'no_website', categoryId: cat.id });
  add('Zahid Properties', '03001234567');
  add('Best Realty', '03007654321');
  add('Grey Estate', '03009998887');
  s.setWhatsAppResult('+923001234567', 'available', 'baileys');
  s.setWhatsAppResult('+923007654321', 'available', 'baileys');
  s.setWhatsAppResult('+923009998887', 'unavailable', 'baileys');
  s.close();
}

const sends = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.text) : []);

async function launch(env) {
  const app = await _electron.launch({ args: [root], cwd: root, env });
  const win = await app.firstWindow();
  await unlock(win);
  return { app, win };
}

test('WhatsApp chats and outreach: history, live messages, campaign, replies, restart', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-outreach-e2e-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  seed(path.join(userData, 'leads.db'));
  const log = path.join(tmp, 'wa-sent.log');
  const lic = await startLicenseServer();
  t.after(() => lic.close());
  const env = {
    ...process.env,
    ...lic.env,
    LEAD_FINDER_USER_DATA: userData,
    LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome'),
    LEAD_FINDER_NO_UPDATES: '1',
    LEAD_FINDER_TEST_BAILEYS: path.join(__dirname, 'fake-baileys.js'),
    LEAD_FINDER_TEST_BAILEYS_LOG: log,
    LEAD_FINDER_TEST_BAILEYS_NUMBERS: '923001234567,923007654321',
    LEAD_FINDER_TEST_BAILEYS_HISTORY: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  let { app, win } = await launch(env);
  t.after(async () => {
    await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  await lic.activate(await deviceIdOf(win));
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  await win.getByRole('heading', { name: /Today's leads/ }).waitFor();

  // --- Workspace switch keeps the lead table as it was.
  const ws = win.getByRole('navigation', { name: 'Workspace' });
  assert.equal(await ws.getByRole('button', { name: 'Leads' }).getAttribute('aria-pressed'), 'true');
  await win.getByRole('tab', { name: 'Past leads' }).click();
  await ws.getByRole('button', { name: 'Chats' }).click();

  // --- Chats: the synced history is listed, unread, newest message first.
  const list = win.getByRole('listbox', { name: 'Chats' });
  const hist = list.getByRole('option').filter({ hasText: 'History Contact' });
  await hist.waitFor({ timeout: 20_000 });
  assert.match(await hist.innerText(), /Theek hai/);
  assert.match(await hist.innerText(), /\b1\b/, 'unread badge');
  await hist.getByRole('button').click();
  const pane = win.locator('.chat-pane');
  await pane.getByRole('heading', { name: 'History Contact' }).waitFor();
  const bubbles = pane.locator('.bubble .bubble-text');
  await win.waitForFunction(() => document.querySelectorAll('.chat-pane .bubble').length === 3);
  assert.deepEqual(await bubbles.allInnerTexts(), ['Plot ka rate kya hai?', 'Kal batata hoon.', 'Theek hai']);
  assert.equal(await pane.locator('.bubble.mine .ticks-read').count(), 1, 'read status from WhatsApp');
  await win.waitForFunction(() => !document.querySelector('.chat-item.on .unread-badge'));
  // Reply from the composer.
  await pane.getByLabel('Message').fill('Rate 1.2 crore hai.');
  await pane.getByRole('button', { name: 'Send' }).click();
  await win.waitForFunction(() => [...document.querySelectorAll('.chat-pane .bubble.mine .bubble-text')].some((b) => b.textContent === 'Rate 1.2 crore hai.'));
  assert.deepEqual(sends(log).map((s) => [s.jid, s.text]), [['923005556667@s.whatsapp.net', 'Rate 1.2 crore hai.']]);
  // A receipt for it turns into double ticks.
  const sentId = sends(log)[0].id;
  await app.evaluate((_e, id) => globalThis.__fakeWA.receipt('923005556667@s.whatsapp.net', id, 3), sentId);
  await win.waitForFunction(() => document.querySelectorAll('.chat-pane .bubble.mine .ticks-delivered').length === 1);
  // A new incoming message from someone else appears in the list, unread.
  await app.evaluate(() => globalThis.__fakeWA.incoming('923001234567', 'Assalam o alaikum', 'Zahid'));
  const zahidChat = list.getByRole('option').filter({ hasText: 'Zahid' });
  await zahidChat.waitFor();
  assert.match(await zahidChat.innerText(), /Lead|Zahid Properties/, 'matched to the lead');
  if (shots) await win.screenshot({ path: path.join(shots, 'chats.png') });

  // --- Back to Leads: still on "Past".
  await ws.getByRole('button', { name: 'Leads' }).click();
  await win.getByRole('heading', { name: /Past leads/ }).waitFor();
  assert.equal(await win.getByRole('tab', { name: 'Past leads' }).getAttribute('aria-selected'), 'true');
  await ws.getByRole('button', { name: 'Outreach' }).click();

  // --- Outreach: only verified leads can be added; names are safe.
  const out = win.locator('.outreach');
  await out.getByRole('heading', { name: 'Real-estate outreach' }).waitFor();
  await out.getByRole('button', { name: 'Add verified leads' }).click();
  const picker = win.getByRole('dialog', { name: 'Add verified leads' });
  await picker.waitFor();
  const names = await picker.locator('.picker-name').allInnerTexts();
  assert.deepEqual(names.sort(), ['Best Realty', 'Zahid Properties'], 'only WhatsApp-confirmed numbers');
  await picker.getByRole('button', { name: /Select all/ }).click();
  await picker.getByRole('button', { name: 'Add 2 leads' }).click();
  await picker.waitFor({ state: 'detached' });
  const rows = out.locator('.campaign-contacts tbody tr');
  await win.waitForFunction(() => document.querySelectorAll('.campaign-contacts tbody tr').length === 2);
  // Zahid's own WhatsApp name (from his message) or the business word; Best Realty has no safe name.
  const nameOf = async (phone) => rows.filter({ hasText: phone }).locator('input.name-edit').inputValue();
  assert.equal(await nameOf('+923001234567'), 'Zahid');
  assert.equal(await nameOf('+923007654321'), '');
  // Previews per contact, with the no-name version.
  await out.getByLabel('Preview for contact').selectOption('+923007654321');
  await win.waitForFunction(() => document.querySelector('.template-preview')?.textContent.includes('Assalam-o-Alaikum.'));
  await out.getByLabel('Preview for contact').selectOption('+923001234567');
  await win.waitForFunction(() => document.querySelector('.template-preview')?.textContent.includes('Assalam-o-Alaikum Zahid bhai.'));
  // Limits are enforced.
  await out.locator('.campaign-settings input[type=number]').nth(2).fill('20');
  await out.getByRole('button', { name: 'Save settings' }).click();
  await win.locator('.toast.error').filter({ hasText: /between 10 and 15/ }).waitFor();
  await out.locator('.campaign-settings input[type=number]').nth(2).fill('12');
  // Quiet hours (recipient time, Pakistan) placed away from the current hour,
  // so the test can send whenever it runs.
  const pkHour = (new Date().getUTCHours() + 5) % 24;
  await out.getByLabel('Quiet hours start').selectOption(String((pkHour + 6) % 24));
  await out.getByLabel('Quiet hours end').selectOption(String((pkHour + 10) % 24));
  await out.getByRole('button', { name: 'Save settings' }).click();
  await win.locator('.toast').filter({ hasText: 'Campaign settings saved.' }).waitFor();

  // --- Test run: the schedule runs, nothing reaches WhatsApp.
  await out.getByRole('button', { name: 'Start' }).click();
  await win.waitForFunction(() => document.querySelectorAll('.campaign-history tbody tr').length === 1, null, { timeout: 15_000 });
  assert.match(await out.locator('.campaign-history').innerText(), /test run[\s\S]*1 of 3[\s\S]*Sent/i);
  assert.equal(sends(log).length, 1, 'only the manual chat reply so far');
  await out.getByRole('button', { name: 'Stop' }).click();

  // --- Live: asks for confirmation, then sends message 1 to one contact.
  // Best Realty is excluded first (per-contact exclusion).
  await rows.filter({ hasText: '+923007654321' }).getByRole('button', { name: 'Exclude' }).click();
  await rows.filter({ hasText: '+923007654321' }).locator('.st-chip').filter({ hasText: 'Excluded' }).waitFor();
  await out.getByRole('button', { name: 'Live' }).click();
  await out.getByRole('button', { name: 'Save settings' }).click();
  await win.locator('.toast').filter({ hasText: 'Campaign settings saved.' }).last().waitFor();
  assert.equal(await out.locator('.campaign-history tbody tr').count(), 0, 'the simulation was cleared');
  await win.waitForFunction(() => document.querySelectorAll('.campaign-contacts .stage-dots span.on').length === 0);
  await out.getByRole('button', { name: 'Start' }).click();
  const ack = win.getByRole('dialog', { name: 'Start live outreach' });
  await ack.waitFor();
  assert.ok(await ack.getByRole('button', { name: 'Start sending' }).isDisabled());
  await ack.getByRole('checkbox').check();
  await ack.getByRole('button', { name: 'Start sending' }).click();
  await win.waitForFunction(() => document.querySelectorAll('.campaign-history tbody tr').length === 1, null, { timeout: 15_000 });
  const live = sends(log).slice(1);
  assert.equal(live.length, 1, 'exactly one campaign message');
  assert.deepEqual([live[0].jid, live[0].text], ['923001234567@s.whatsapp.net', 'Assalam-o-Alaikum Zahid bhai.']);
  const facts = await out.locator('.campaign-facts').innerText();
  assert.match(facts, /1 \/ 12 contacts/);
  assert.match(facts, /Test Account/);
  const nextDue = (await app.evaluate(() => null), await win.evaluate(() => window.leadFinder.outreachState())).nextDueAt;
  const gap = (nextDue - live[0].at) / 60_000;
  assert.ok(gap >= 45 && gap <= 60.1, `next message in ${gap.toFixed(1)} minutes`);
  if (shots) await win.screenshot({ path: path.join(shots, 'outreach.png') });

  // --- A reply stops the sequence for that contact.
  await app.evaluate(() => globalThis.__fakeWA.incoming('923001234567', 'Walaikum assalam, kaun?', 'Zahid'));
  await win.locator('.toast').filter({ hasText: /replied/ }).waitFor();
  await rows.filter({ hasText: '+923001234567' }).locator('.st-chip').filter({ hasText: 'Replied' }).waitFor();

  // --- Restart: still running, same count and next time; nothing re-sent.
  await app.close();
  ({ app, win } = await launch(env));
  await win.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Outreach' }).waitFor();
  await win.waitForFunction(() => document.querySelector('.campaign-facts'), null, { timeout: 20_000 }).catch(() => {});
  if (!(await win.locator('.outreach').isVisible())) await win.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Outreach' }).click();
  const after = await win.evaluate(() => window.leadFinder.outreachState());
  assert.equal(after.status, 'running');
  assert.equal(after.nextDueAt, nextDue, 'the next send time survived the restart');
  assert.equal(after.today.recipients, 1);
  await new Promise((r) => setTimeout(r, 5000)); // a few scheduler ticks
  assert.equal(sends(log).length, 2, 'nothing sent again after the restart');
  assert.ok(!sends(log).some((x) => x.jid === '923007654321@s.whatsapp.net'), 'the excluded contact was never messaged');
  assert.deepEqual(errors, []);
});
