'use strict';
// Email verification in the real app: saved leads' emails are verified in
// the background (against a local mail server: one valid mailbox, one that
// does not exist, a disposable address, a catch-all domain, an unreachable
// server, a domain that does not exist); the counts, the Leads filter and
// badges show the results; a campaign with every lead emails only the valid
// one; allowing catch-all lets that one through; an address can be tested
// from the settings.
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
const LEADS = [
  ['Good Co', 'ali@good.test'],
  ['Gone Co', 'nouser@good.test'],
  ['Temp Mail Co', 'x@mailinator.com'],
  ['Catch Co', 'any@catchall.test'],
  ['Down Co', 'z@unreachable.test'],
  ['No Domain Co', 'q@gone.invalid'],
];

test('Email verification: background checks, counts, Leads filter, only valid emails sent, catch-all when allowed', { timeout: 300_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-verify-e2e-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  const s = new LeadStore(path.join(userData, 'leads.db'));
  const cat = s.ensureCategory('Agencies');
  LEADS.forEach(([name], i) => s.save({ placeKey: `0x9:${i}`, mapsUrl: `https://www.google.com/maps/place/V${i}`, name, address: 'Lahore, Pakistan', websiteStatus: 'no_website', categoryId: cat.id }));
  for (const [name, mail] of LEADS) s.saveLeadEmails(s.listLeads({}).find((l) => l.name === name).id, { emails: [mail] });
  s.close();
  const smtp = await startSmtp();
  const mx = await startMx({ exists: ['ali@good.test'], catchAll: ['catchall.test'] });
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

  // Verified in the background as soon as the app runs.
  await win.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Outreach' }).click();
  await win.getByRole('navigation', { name: 'Campaign channel' }).getByRole('button', { name: 'Email' }).click();
  const card = win.getByRole('region', { name: 'Email verification' });
  // The checks of the category that is open.
  await win.getByRole('region', { name: 'Category campaigns' }).getByText('Agencies', { exact: true }).click();
  await card.getByText(/Agencies: 6 emails/).waitFor({ timeout: 30_000 });
  const count = (label) => card.getByRole('group', { name: 'Verification counts' }).getByText(label, { exact: true }).locator('..').locator('strong');
  await until(async () => (await count('Valid').textContent()) === '1' && (await count('Invalid').textContent()) === '2' && (await count('Risky').textContent()) === '1' && (await count('Catch-all').textContent()) === '1', 60_000, 'the background checks');
  assert.ok(!mx.rcpts.includes('x@mailinator.com'), 'a disposable address is known without asking its server');

  // Leads: the verification filter and badges.
  await win.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Leads' }).click();
  const rows = win.locator('table tbody tr');
  await win.getByLabel('Show email verification').selectOption('valid');
  await until(async () => (await rows.count()) === 1 && /Good Co/.test(await rows.first().textContent()), 15_000, 'the Valid filter');
  await win.getByLabel('Show email verification').selectOption('invalid');
  await until(async () => (await rows.count()) === 2, 15_000, 'the Invalid filter');
  const gone = rows.filter({ hasText: 'Gone Co' }).locator('.em-vbadge');
  assert.equal(await gone.textContent(), 'Invalid');
  assert.match(await gone.getAttribute('title'), /mailbox does not exist/);
  await win.getByLabel('Show email verification').selectOption('all');

  // A campaign with every lead: only the valid address is emailed.
  const acc = await win.evaluate((port) => window.leadFinder.emailAccountAdd({ name: 'Local', senderName: 'Axora', email: 'sender@example.com', host: '127.0.0.1', port, username: 'sender@example.com', password: 'pw', encryption: 'none', imapOn: false }), smtp.port);
  assert.ok(acc.ok, acc.error);
  const camp = await win.evaluate(() => window.leadFinder.emailCreate('Verified only'));
  await win.evaluate(([id, a]) => window.leadFinder.emailUpdate(id, { accountIds: [a], subject: 'Hello {business}', body: 'Hello,\n\nA short note.\n\nAli' }), [camp.id, acc.account.id]);
  const added = await win.evaluate((id) => window.leadFinder.emailAddLeads(id, {}), camp.id);
  assert.equal(added.added, 2, 'the valid lead and the one still being verified');
  assert.equal(added.unverified, 4, 'invalid, disposable and catch-all leads are not added');
  assert.ok((await win.evaluate((id) => window.leadFinder.emailStart(id), camp.id)).ok);
  await until(() => smtp.messages.some((m) => m.to.includes('ali@good.test')), 30_000, 'the email to the valid address');
  await new Promise((r) => setTimeout(r, 6_000));
  assert.deepEqual(smtp.messages.flatMap((m) => m.to), ['ali@good.test'], 'nothing else was sent');

  await win.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Outreach' }).click();
  await win.getByRole('region', { name: 'Campaign list' }).getByText('Verified only').click();
  const recipients = win.getByRole('region', { name: 'Recipients' });
  await recipients.getByRole('button', { name: /^Show \(/ }).click();
  await recipients.getByLabel('Recipients by verification').waitFor();
  const down = recipients.locator('tr', { hasText: 'z@unreachable.test' });
  assert.equal(await down.locator('.em-state').first().textContent(), 'Verifying', 'still being verified (asked again later)');
  assert.match(await down.locator('.em-vbadge').textContent(), /Checking again later|Verifying/);
  await win.screenshot({ path: path.join(os.tmpdir(), 'lf-verify.png') });

  // Settings: test one address; allow catch-all, and that lead can be emailed.
  await card.getByRole('button', { name: 'Verification settings' }).click();
  const dlg = win.getByRole('dialog', { name: 'Verification settings' });
  await dlg.getByLabel('Test an address').fill('nouser@good.test');
  await dlg.getByRole('button', { name: 'Check', exact: true }).click();
  await dlg.getByRole('status').getByText(/would not be sent to/).waitFor({ timeout: 30_000 });
  assert.match(await dlg.getByRole('status').textContent(), /Invalid/);
  await win.screenshot({ path: path.join(os.tmpdir(), 'lf-verify-settings.png') });
  await dlg.getByLabel('Catch-all addresses').check();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.waitFor({ state: 'detached' });
  await win.evaluate((id) => window.leadFinder.emailPause(id), camp.id);
  const again = await win.evaluate((id) => window.leadFinder.emailAddLeads(id, {}), camp.id);
  assert.equal(again.added, 1, `the catch-all lead (${JSON.stringify(again)})`);
  assert.ok((await win.evaluate((id) => window.leadFinder.emailResume(id), camp.id)).ok);
  await until(() => smtp.messages.some((m) => m.to.includes('any@catchall.test')), 30_000, 'the catch-all email');
  assert.ok(!smtp.messages.some((m) => /nouser|mailinator|gone\.invalid/.test(m.to.join(' '))));
});
