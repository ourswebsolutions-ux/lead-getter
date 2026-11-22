'use strict';
// Click tracking in the real app: the tracking file saved for upload, the
// tracking address connected from Outreach > Email, a campaign email with
// tracked links, a click (through the real Worker code, served locally)
// fetched with "Check clicks now" and shown on the recipient and in the totals.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { LeadStore } = require('../../src/database/db');
const { startSmtp } = require('../fake-smtp');
const { startTracker } = require('../fake-tracker');
const { unlock, activationEnv } = require('./helpers');

const root = path.join(__dirname, '..', '..');
const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

test('Click tracking: set up, tracked campaign links, clicks shown', { timeout: 240_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-track-e2e-'));
  const userData = path.join(tmp, 'app');
  const saveDir = path.join(tmp, 'saved');
  fs.mkdirSync(userData);
  fs.mkdirSync(saveDir);
  const s = new LeadStore(path.join(userData, 'leads.db'));
  const cat = s.ensureCategory('Real Estate');
  s.save({ placeKey: '0x1:0x7', mapsUrl: 'https://www.google.com/maps/place/Z1', name: 'Zahid Properties', address: 'DHA, Lahore, Pakistan', websiteStatus: 'no_website', categoryId: cat.id });
  s.saveLeadEmails(s.listLeads({})[0].id, { emails: ['zahid@realty.pk'] });
  s.close();
  const smtp = await startSmtp();
  const srv = await startTracker();
  const env = { ...process.env, ...activationEnv, LEAD_FINDER_USER_DATA: userData, LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome'), LEAD_FINDER_NO_UPDATES: '1', LEAD_FINDER_TEST_SECRETS: '1', LEAD_FINDER_TEST_SMTP_INSECURE: '1', LEAD_FINDER_TEST_SAVE_DIR: saveDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [root], cwd: root, env });
  t.after(async () => {
    await app.close().catch(() => {});
    await smtp.close();
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const win = await app.firstWindow();
  win.on('dialog', (d) => d.accept());
  await unlock(win);

  await win.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Outreach' }).click();
  await win.getByRole('navigation', { name: 'Campaign channel' }).getByRole('button', { name: 'Email' }).click();
  const card = win.getByRole('region', { name: 'Click tracking' });
  await card.getByRole('button', { name: 'Set up' }).click();
  const dlg = win.getByRole('dialog', { name: 'Click tracking' });
  await dlg.getByRole('button', { name: 'Save index.php' }).click();
  await win.getByText(/Saved: .*index\.php/).waitFor();
  assert.match(fs.readFileSync(path.join(saveDir, 'index.php'), 'utf8'), /^<\?php\n\/\/ Lead Finder click tracking/);
  await dlg.getByRole('button', { name: 'Show Worker code' }).click();
  await dlg.getByLabel('Worker code').getByText(/export default/).waitFor();
  // A wrong address first: a clear error.
  await dlg.getByLabel('Tracking address').fill('http://127.0.0.1:1/t/');
  await dlg.getByRole('button', { name: 'Connect' }).click();
  await dlg.getByRole('alert').getByText(/could not be reached/).waitFor();
  await dlg.getByLabel('Tracking address').fill(srv.base);
  await dlg.getByRole('button', { name: 'Connect' }).click();
  await dlg.waitFor({ state: 'detached' });
  await card.getByText(/On · 127\.0\.0\.1/).waitFor();

  // A campaign with a link (made through the app's own calls), sent.
  const acc = await win.evaluate((port) => window.leadFinder.emailAccountAdd({ name: 'Local', senderName: 'Axora', email: 'sender@example.com', host: '127.0.0.1', port, username: 'sender@example.com', password: 'pw', encryption: 'none', imapOn: false }), smtp.port);
  assert.ok(acc.ok, acc.error);
  const camp = await win.evaluate(() => window.leadFinder.emailCreate('Website offer'));
  await win.evaluate(([id, a]) => window.leadFinder.emailUpdate(id, { accountIds: [a], subject: 'Website for {business}', body: 'Hello,\n\nSee our demo: https://axora.pk/demo\n\nAli' }), [camp.id, acc.account.id]);
  await win.evaluate((id) => window.leadFinder.emailAddLeads(id, {}), camp.id);
  await win.getByRole('region', { name: 'Campaign list' }).getByText('Website offer').click();
  const compose = win.getByRole('region', { name: 'Email', exact: true });
  assert.equal(await compose.getByLabel(/Track link clicks/).isChecked(), true);
  await win.evaluate((id) => window.leadFinder.emailStart(id), camp.id);
  const until = async (fn, ms, what) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 250))) if (await fn()) return;
    throw new Error(`timed out waiting for ${what}`);
  };
  await until(() => smtp.messages.some((m) => m.to.includes('zahid@realty.pk')), 30_000, 'the campaign email');
  const raw = smtp.messages.find((m) => m.to.includes('zahid@realty.pk')).text;
  const link = /(http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+&u=[\w-]+&s=[\w-]+)/.exec(raw)?.[1];
  assert.ok(link, 'the email has a tracked link');
  assert.match(raw, />https:\/\/axora\.pk\/demo<\/a>/, 'the reader sees the real address');

  // The lead clicks (well after delivery, as a person would), then "Check clicks now".
  await new Promise((r) => setTimeout(r, 15_500));
  const res = await fetch(link, { redirect: 'manual', headers: { 'User-Agent': BROWSER } });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://axora.pk/demo');
  await card.getByRole('button', { name: 'Check clicks now' }).click();
  await win.getByText('1 new click.').waitFor();
  const stats = win.getByRole('group', { name: 'Progress' });
  await stats.getByText('Clicked').locator('..').getByText('1', { exact: true }).waitFor();
  await win.getByRole('region', { name: 'Recipients' }).getByText('Clicked', { exact: true }).waitFor();
  await win.screenshot({ path: path.join(os.tmpdir(), 'lf-tracking.png') });
});
