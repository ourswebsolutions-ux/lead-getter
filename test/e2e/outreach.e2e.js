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
const { unlock, activationEnv } = require('./helpers');

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
  const env = {
    ...process.env,
    ...activationEnv,
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

  // --- Outreach: one campaign per lead category, with an ON/OFF switch.
  const out = win.locator('.outreach');
  const catRow = (name) => out.getByRole('list', { name: 'Category campaigns' }).getByRole('listitem').filter({ hasText: name });
  await catRow('Real Estate').waitFor();
  assert.match(await catRow('Real Estate').innerText(), /2 ready · 0 seen · 1 not on WhatsApp/);
  assert.match(await catRow('Real Estate').innerText(), /OFF/);
  const sw = () => catRow('Real Estate').getByRole('switch', { name: 'Real Estate campaign' });
  assert.equal(await sw().getAttribute('aria-checked'), 'false');
  // Its settings (while OFF): no leads to pick by hand; limits are enforced.
  await catRow('Real Estate').locator('.campaign-item').click();
  await out.getByRole('heading', { name: 'Real Estate', exact: true }).waitFor();
  const cid = (await win.evaluate(() => window.leadFinder.outreachOverview())).campaigns.find((c) => c.category).id;
  const stateOf = (id) => win.evaluate((i) => window.leadFinder.outreachState(i), id);
  assert.equal(await out.getByRole('button', { name: 'Add verified leads' }).count(), 0, 'no manual selection');
  await out.getByLabel('Daily limit').fill('20');
  await out.getByRole('button', { name: 'Save settings' }).click();
  await win.locator('.toast.error').filter({ hasText: /between 10 and 15/ }).waitFor();
  await out.getByLabel('Daily limit').fill('12');
  // Sending hours (recipient time, Pakistan) placed away from the current
  // hour, so the test can send whenever it runs.
  const pkHour = (new Date().getUTCHours() + 5) % 24;
  await out.getByLabel('Sending hours from').selectOption(String((pkHour + 10) % 24));
  await out.getByLabel('Sending hours to').selectOption(String((pkHour + 6) % 24));
  await out.getByRole('button', { name: 'Save settings' }).click();
  await win.locator('.toast').filter({ hasText: 'Campaign settings saved.' }).waitFor();

  // --- Switch ON (test run): the queue fills by itself; messages go out one
  // by one (simulated); a lead's messages about a minute apart.
  await sw().click();
  await win.waitForFunction(() => document.querySelectorAll('.campaign-contacts tbody tr').length === 2, null, { timeout: 15_000 });
  const rows = out.locator('.campaign-contacts tbody tr');
  const nameOf = async (phone) => rows.filter({ hasText: phone }).locator('input.name-edit').inputValue();
  assert.equal(await nameOf('+923001234567'), 'Zahid');
  assert.equal(await nameOf('+923007654321'), '');
  assert.equal(await sw().getAttribute('aria-checked'), 'true');
  await win.waitForFunction(() => document.querySelectorAll('.campaign-sent tbody tr').length === 1, null, { timeout: 15_000 });
  assert.match(await out.locator('.campaign-sent').innerText(), /test run[\s\S]*1 of 3[\s\S]*Sent/i);
  assert.match(await out.locator('.campaign-status').innerText(), /Next message to the same contact in about a minute/);
  assert.match(await catRow('Real Estate').innerText(), /Running/);
  await win.waitForFunction(() => document.querySelectorAll('.campaign-sent tbody tr').length === 2, null, { timeout: 120_000 });
  const sim = (await stateOf(cid)).sends;
  const simGap = (sim[0].sentAt - sim[1].sentAt) / 1000;
  assert.ok(simGap >= 55 && simGap <= 100, `test run: message 2 ${simGap}s after message 1`);
  assert.equal(sim[0].phone, sim[1].phone, 'the same lead');
  assert.equal(sends(log).length, 1, 'nothing reached WhatsApp (only the manual chat reply)');
  // OFF: scheduling stops.
  await sw().click();
  await win.waitForFunction(() => document.querySelector('.campaign-list [role=switch]')?.getAttribute('aria-checked') === 'false');
  assert.match(await catRow('Real Estate').innerText(), /OFF/);
  // Previews per lead: names, the no-name version, the business name.
  await out.getByLabel('Preview for contact').selectOption('+923007654321');
  await win.waitForFunction(() => document.querySelector('.template-preview')?.textContent.includes('Assalam-o-Alaikum.'));
  await out.getByLabel('Preview for contact').selectOption('+923001234567');
  await win.waitForFunction(() => document.querySelector('.template-preview')?.textContent.includes('Assalam-o-Alaikum Zahid bhai.'));
  await win.waitForFunction(() => document.querySelectorAll('.template-preview')[2]?.textContent.includes('Kya aap Zahid Properties ke naam se real estate'));

  // --- Live: asks for confirmation, then message 1 to one lead.
  // Best Realty is excluded first (per-lead exclusion).
  await rows.filter({ hasText: '+923007654321' }).getByRole('button', { name: 'Exclude' }).click();
  await rows.filter({ hasText: '+923007654321' }).locator('.st-chip').filter({ hasText: 'Excluded' }).waitFor();
  await out.getByRole('button', { name: 'Live' }).click();
  await out.getByRole('button', { name: 'Save settings' }).click();
  await win.locator('.toast').filter({ hasText: 'Campaign settings saved.' }).last().waitFor();
  assert.equal(await out.locator('.campaign-sent tbody tr').count(), 0, 'the simulation was cleared');
  await win.waitForFunction(() => document.querySelectorAll('.campaign-contacts .stage-dots span.on').length === 0);
  await sw().click();
  const ack = win.getByRole('dialog', { name: 'Start live outreach' });
  await ack.waitFor();
  assert.ok(await ack.getByRole('button', { name: 'Start sending' }).isDisabled());
  await ack.getByRole('checkbox').check();
  await ack.getByRole('button', { name: 'Start sending' }).click();
  await win.waitForFunction(() => document.querySelectorAll('.campaign-sent tbody tr').length === 1, null, { timeout: 15_000 });
  const live = sends(log).slice(1);
  assert.equal(live.length, 1, 'exactly one campaign message');
  assert.deepEqual([live[0].jid, live[0].text], ['923001234567@s.whatsapp.net', 'Assalam-o-Alaikum Zahid bhai.']);
  const facts = await out.locator('.campaign-facts').innerText();
  assert.match(facts, /1 \/ 12 contacts/);
  assert.match(facts, /Test Account/);
  const firstState = await stateOf(cid);
  const soon = (firstState.nextDueAt - live[0].at) / 1000;
  assert.ok(soon >= 55 && soon <= 66, `message 2 to the same lead due ${soon}s later`);
  assert.equal(firstState.current, '+923001234567');
  if (shots) await win.screenshot({ path: path.join(shots, 'outreach.png') });

  // --- Leads tab: Zahid is now Seen; filters and search.
  await ws.getByRole('button', { name: 'Leads' }).click();
  await win.getByRole('tab', { name: 'Today' }).click();
  const leadNames = () => win.locator('main.content table tbody tr td.name').allInnerTexts();
  const campaignFilter = win.getByLabel('Show campaign status');
  await campaignFilter.selectOption('seen');
  await win.waitForFunction(() => [...document.querySelectorAll('main.content table tbody tr td.name')].map((t) => t.textContent).join('|') === 'Zahid Properties');
  assert.match(await win.locator('main.content table tbody tr').first().innerText(), /Seen/);
  await campaignFilter.selectOption('unseen');
  await win.waitForFunction(() => document.querySelectorAll('main.content table tbody tr td.name').length === 2);
  assert.deepEqual((await leadNames()).sort(), ['Best Realty', 'Grey Estate']);
  await win.getByLabel('Search leads').fill('best');
  await win.waitForFunction(() => [...document.querySelectorAll('main.content table tbody tr td.name')].map((t) => t.textContent).join('|') === 'Best Realty');
  await win.getByLabel('Search leads').fill('');
  await campaignFilter.selectOption('all');
  await win.waitForFunction(() => document.querySelectorAll('main.content table tbody tr td.name').length === 3);
  if (shots) await win.screenshot({ path: path.join(shots, 'leads-seen.png') });
  await ws.getByRole('button', { name: 'Outreach' }).click();

  // --- A reply stops the sequence for that contact.
  await app.evaluate(() => globalThis.__fakeWA.incoming('923001234567', 'Walaikum assalam, kaun?', 'Zahid'));
  await win.locator('.toast').filter({ hasText: /replied/ }).waitFor();
  await rows.filter({ hasText: '+923001234567' }).locator('.st-chip').filter({ hasText: 'Replied' }).waitFor();
  // The reply ends Zahid's sequence; the next contact is 45-60 minutes after
  // his last message.
  let replyState;
  for (let i = 0; i < 90; i++) {
    replyState = await stateOf(cid);
    if (replyState.current === null) break; // the scheduler's next tick (every 30 s) moves on
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(replyState.current, null);
  const nextDue = replyState.nextDueAt;
  const gap = (nextDue - live[0].at) / 60_000;
  assert.ok(gap >= 45 && gap <= 60.1, `next contact in ${gap.toFixed(1)} minutes: ${JSON.stringify({ status: replyState.status, waiting: replyState.waiting, current: replyState.current, nextDueAt: nextDue, live0: live[0].at, contacts: replyState.contacts.map((c) => [c.phone, c.state, c.stage, c.lastSentAt]), sends: replyState.sends.map((x) => [x.phone, x.stage, x.status, x.sentAt]) })}`);
  assert.equal(sends(log).length, 2, 'no further message to Zahid');

  // --- Restart: still running, same count and next time; nothing re-sent.
  await app.close();
  ({ app, win } = await launch(env));
  await win.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Outreach' }).waitFor();
  await win.waitForFunction(() => document.querySelector('.campaign-facts'), null, { timeout: 20_000 }).catch(() => {});
  if (!(await win.locator('.outreach').isVisible())) await win.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Outreach' }).click();
  const after = await win.evaluate((i) => window.leadFinder.outreachState(i), cid);
  assert.equal(after.status, 'running');
  assert.equal(after.nextDueAt, nextDue, 'the next send time survived the restart');
  assert.equal(after.today.recipients, 1);
  await new Promise((r) => setTimeout(r, 5000)); // a few scheduler ticks
  assert.equal(sends(log).length, 2, 'nothing sent again after the restart');
  assert.ok(!sends(log).some((x) => x.jid === '923007654321@s.whatsapp.net'), 'the excluded contact was never messaged');

  // --- Delete the campaign: Zahid stays Seen and never re-enters a queue,
  // even when the category is switched ON again (a new campaign).
  const out2 = win.locator('.outreach');
  const row2 = () => out2.getByRole('list', { name: 'Category campaigns' }).getByRole('listitem').filter({ hasText: 'Real Estate' });
  await out2.getByRole('checkbox', { name: 'Select Real Estate' }).check();
  await out2.getByRole('button', { name: 'Delete selected' }).click();
  const confirmDlg = win.getByRole('alertdialog', { name: 'Delete campaigns?' });
  await confirmDlg.waitFor();
  assert.match(await confirmDlg.innerText(), /Real Estate[\s\S]*Previously contacted/);
  await confirmDlg.getByRole('button', { name: 'Delete 1' }).click();
  await win.locator('.toast').filter({ hasText: '1 campaign deleted.' }).waitFor();
  await win.waitForFunction(() => /1 ready · 1 seen/.test(document.querySelector('.campaign-list')?.textContent || ''));
  assert.match(await row2().innerText(), /OFF/);
  await row2().getByRole('switch').click(); // test run by default
  await win.waitForFunction(() => document.querySelectorAll('.campaign-contacts tbody tr').length === 1, null, { timeout: 15_000 });
  assert.match(await out2.locator('.campaign-contacts tbody tr').innerText(), /\+923007654321/, 'only Best Realty; Zahid (Seen) is not queued again');
  assert.match(await out2.getByRole('table', { name: 'Previously contacted' }).innerText(), /Zahid Properties[\s\S]*\+923001234567/);
  await row2().getByRole('switch').click();
  if (shots) await win.screenshot({ path: path.join(shots, 'campaigns.png') });
  assert.equal(sends(log).length, 2, 'still nothing more sent');
  assert.deepEqual(errors, []);
});
