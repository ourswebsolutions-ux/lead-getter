'use strict';
// Email sequences in the real app: follow-ups and a sending schedule set up
// in Outreach > Email, the first email sent, the lead's follow-up scheduled
// (its status, its history), a lead stopped by hand, a copy of the campaign,
// and the email dashboard. (The days between emails are tested in
// test/email-sequences.test.js with a clock that can be moved.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { LeadStore } = require('../../src/database/db');
const { startSmtp } = require('../fake-smtp');
const { startMx } = require('../fake-mx');
const { unlock, activationEnv } = require('./helpers');

const root = path.join(__dirname, '..', '..');

test('Email sequences: a category campaign with follow-up days, schedule, its own email checks, hidden recipients, stop', { timeout: 300_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-seq-e2e-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  const s = new LeadStore(path.join(userData, 'leads.db'));
  const cat = s.ensureCategory('Agencies');
  for (const [i, [name, mail]] of [['Good Co', 'ali@good.test'], ['Fine Co', 'sara@fine.test']].entries()) {
    s.save({ placeKey: `0x7:${i}`, mapsUrl: `https://www.google.com/maps/place/S${i}`, name, address: 'Lahore, Pakistan', websiteStatus: 'no_website', categoryId: cat.id });
    s.saveLeadEmails(s.listLeads({}).find((l) => l.name === name).id, { emails: [mail] });
  }
  s.close();
  const smtp = await startSmtp();
  const mx = await startMx({ exists: (e) => !e.includes('nouser') });
  const env = { ...process.env, ...activationEnv, LEAD_FINDER_USER_DATA: userData, LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome'), LEAD_FINDER_NO_UPDATES: '1', LEAD_FINDER_TEST_SECRETS: '1', LEAD_FINDER_TEST_SMTP_INSECURE: '1', LEAD_FINDER_TEST_MX_PORT: String(mx.port) };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [root], cwd: root, env });
  t.after(async () => {
    await app.close().catch(() => {});
    await smtp.close();
    await mx.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const win = await app.firstWindow();
  win.on('dialog', (d) => d.accept());
  await unlock(win);
  const until = async (fn, ms, what) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 250))) if (await fn()) return;
    throw new Error(`timed out waiting for ${what}`);
  };
  await win.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Outreach' }).click();
  await win.getByRole('navigation', { name: 'Campaign channel' }).getByRole('button', { name: 'Email' }).click();
  // The dashboard, with nothing selected.
  await win.getByRole('region', { name: 'Email dashboard' }).getByText('Follow-ups scheduled').waitFor();

  const acc = await win.evaluate((port) => window.leadFinder.emailAccountAdd({ name: 'Local', senderName: 'Ali', email: 'sender@example.com', host: '127.0.0.1', port, username: 'sender@example.com', password: 'pw', encryption: 'none', imapOn: false }), smtp.port);
  // The category's campaign (the only kind made in the window now).
  const key = (await win.evaluate(() => window.leadFinder.emailCategories())).categories.find((c) => c.name === 'Agencies').key;
  const camp = await win.evaluate((k) => window.leadFinder.emailCategoryCampaign(k), key);
  await win.evaluate(([id, a]) => window.leadFinder.emailUpdate(id, { accountIds: [a], subject: 'Website for {business}', body: 'Hello,\n\nWe build websites.\n\nBest,\nAli' }), [camp.id, acc.account.id]);
  const cats = win.getByRole('region', { name: 'Category campaigns' });
  await cats.getByText('Agencies', { exact: true }).click();
  // Email verification: this category's checks only.
  const ver = win.getByRole('region', { name: 'Email verification' });
  await ver.getByText(/Agencies: 2 emails/).waitFor({ timeout: 30_000 });
  await ver.getByRole('group', { name: 'Verification counts' }).getByText('Valid').locator('..').getByText('2', { exact: true }).waitFor({ timeout: 30_000 });
  assert.equal(await win.getByRole('region', { name: 'Campaign list' }).count(), 0, 'no list of own campaigns');
  assert.equal(await win.getByRole('region', { name: 'Campaign history' }).count(), 0, 'no history list');

  // Follow-ups: a switch and days (day 3, 6, 10 at first).
  const fu = win.getByRole('region', { name: 'Follow-ups' });
  await fu.getByRole('switch', { name: 'Send follow-ups' }).click();
  await win.getByText('Follow-ups on: day 3, day 6, day 10.').waitFor();
  await fu.getByLabel('Follow-up 3 day').fill('12');
  await fu.getByRole('button', { name: 'Save', exact: true }).click();
  await win.getByText('Follow-ups on: day 3, day 6, day 12.').waitFor();
  const saved = await win.evaluate((id) => window.leadFinder.emailCampaign(id), camp.id);
  assert.deepEqual(saved.campaign.followups.steps.map((x) => x.days), [2, 3, 6], 'kept as days after the previous email');
  assert.equal(await fu.locator('textarea').count(), 0, 'no follow-up text to write: the AI writes them');

  // Schedule: on, every day, all day (so this test can send now), Karachi time.
  const sch = win.getByRole('region', { name: 'Sending schedule' });
  await sch.getByRole('switch', { name: 'Only on these days and hours' }).click();
  for (const d of ['Sun', 'Sat']) await sch.getByRole('button', { name: d, exact: true }).click();
  await sch.getByLabel('Sending from').fill('00:00');
  await sch.getByLabel('Sending until').fill('23:59');
  await sch.getByLabel('Time zone').selectOption('Asia/Karachi');
  await sch.getByRole('button', { name: 'Save schedule' }).click();
  await win.getByText('Sending schedule saved.').waitFor();
  const sc = (await win.evaluate((id) => window.leadFinder.emailCampaign(id), camp.id)).campaign.schedule;
  assert.deepEqual([sc.on, sc.days, sc.start, sc.end, sc.tz], [true, [0, 1, 2, 3, 4, 5, 6], 0, 1439, 'Asia/Karachi']);

  // Switched on: the first emails, each lead's follow-up 1 scheduled.
  await cats.getByRole('switch', { name: 'Agencies email campaign' }).click();
  await until(() => smtp.messages.length >= 1, 30_000, 'the first email');
  assert.match(smtp.messages[0].text, /We build websites\.\n\nBest,\nAli/);
  const rows = win.getByRole('region', { name: 'Recipients' });
  assert.equal(await rows.locator('tr').count(), 0, 'the recipients are hidden until asked for');
  await rows.getByRole('button', { name: /^Show \(/ }).click();
  const first = smtp.messages[0].to[0];
  const row = rows.locator('tr', { hasText: first });
  await row.getByText('Follow-up scheduled').waitFor({ timeout: 15_000 });
  await row.getByText(/Next: follow-up 1/).waitFor();
  // Stopped by hand.
  await row.getByRole('button', { name: `Stop ${first}` }).click();
  await row.getByText('Stopped', { exact: true }).waitFor();
  const t1 = (await win.evaluate((id) => window.leadFinder.emailCampaign(id), camp.id)).campaign;
  assert.ok(t1.followupCounts.cancelled >= 1);
  await win.screenshot({ path: path.join(os.tmpdir(), 'lf-seq.png'), fullPage: true });
  const dash = (await win.evaluate(() => window.leadFinder.emailDashboard())).dashboard;
  assert.ok(dash.sent >= 1);
});
