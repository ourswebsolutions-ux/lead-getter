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

test('Email sequences: follow-ups, schedule, signature, lead status and history, stop, duplicate, dashboard', { timeout: 300_000 }, async (t) => {
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
  const camp = await win.evaluate(() => window.leadFinder.emailCreate('Agencies outreach'));
  await win.evaluate(([id, a]) => window.leadFinder.emailUpdate(id, { accountIds: [a], subject: 'Website for {business}', body: 'Hello,\n\nWe build websites.' }), [camp.id, acc.account.id]);
  await win.getByRole('region', { name: 'Campaign list' }).getByText('Agencies outreach').click();
  const compose = win.getByRole('region', { name: 'Email', exact: true });
  await compose.getByLabel('Signature').fill('Best,\nAli');
  await compose.getByRole('button', { name: 'Save', exact: true }).click();

  // Follow-ups: two steps.
  const fu = win.getByRole('region', { name: 'Follow-ups' });
  await fu.getByRole('switch', { name: 'Send follow-ups' }).click();
  await fu.getByRole('button', { name: 'Add follow-up' }).click();
  await fu.getByLabel('Follow-up 1 email').fill('Just following up, {name}.');
  await fu.getByRole('button', { name: 'Add follow-up' }).click();
  await fu.getByLabel('Follow-up 2: days to wait').fill('4');
  await fu.getByLabel('Follow-up 2 email').fill('Last note.');
  await fu.getByRole('listitem', { name: 'Follow-up 2' }).getByText('Day 7').waitFor();
  await fu.getByRole('button', { name: 'Save follow-ups' }).click();
  await win.getByText('Follow-ups saved: 2 steps.').waitFor();
  const saved = await win.evaluate((id) => window.leadFinder.emailCampaign(id), camp.id);
  assert.deepEqual(saved.campaign.followups.steps.map((x) => x.days), [2, 4]);
  assert.equal(saved.campaign.signature, 'Best,\nAli');

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

  // Sent: the first emails, each lead's follow-up 1 scheduled.
  const added = await win.evaluate((id) => window.leadFinder.emailAddLeads(id, {}), camp.id);
  assert.equal(added.added, 2, JSON.stringify(added));
  const started = await win.evaluate((id) => window.leadFinder.emailStart(id), camp.id);
  assert.ok(started.ok, started.error);
  await until(() => smtp.messages.length >= 1, 30_000, 'the first email');
  assert.match(smtp.messages[0].text, /We build websites\.\n\nBest,\nAli/);
  const rows = win.getByRole('region', { name: 'Recipients' });
  const first = smtp.messages[0].to[0];
  const row = rows.locator('tr', { hasText: first });
  await row.getByText('Follow-up scheduled').waitFor({ timeout: 15_000 });
  await row.getByText(/follow-up 1/).waitFor();
  // Its history: the first email, then follow-up 1 scheduled.
  await row.getByRole('button', { name: `History of ${first}` }).click();
  const hist = win.getByRole('dialog', { name: 'Email history' });
  await hist.getByText('First email').waitFor();
  await hist.getByText('Follow-up 1').waitFor();
  await hist.getByText(/scheduled for/).waitFor();
  await win.screenshot({ path: path.join(os.tmpdir(), 'lf-seq-history.png') });
  await hist.getByRole('button', { name: 'Close' }).click();
  // Stopped by hand.
  await row.getByRole('button', { name: `Stop ${first}` }).click();
  await row.getByText('Stopped', { exact: true }).waitFor();
  const t1 = (await win.evaluate((id) => window.leadFinder.emailCampaign(id), camp.id)).campaign;
  assert.ok(t1.followupCounts.cancelled >= 1);
  await win.screenshot({ path: path.join(os.tmpdir(), 'lf-seq.png'), fullPage: true });

  // A copy: the same follow-ups and schedule, as a draft.
  await win.getByRole('button', { name: 'Duplicate campaign' }).click();
  await win.getByText('“Agencies outreach (copy)” created (a draft).').waitFor();
  const all = (await win.evaluate(() => window.leadFinder.emailCampaigns())).campaigns;
  const copy = all.find((c) => c.name === 'Agencies outreach (copy)');
  assert.deepEqual(copy.followups.steps.map((x) => x.days), [2, 4]);
  assert.equal(copy.status, 'draft');
  const dash = (await win.evaluate(() => window.leadFinder.emailDashboard())).dashboard;
  assert.ok(dash.sent >= 1);
  assert.ok(dash.followupsPending >= 0);
});
