'use strict';
// The Inbox in the real app: a WhatsApp reply reaches the Inbox and the
// admin's email; an email reply (read from the account's inbox over IMAP)
// reaches the Inbox and the admin's WhatsApp; the admin's answers (on
// WhatsApp "#id ...", and by email) and the app's own reply box go to the
// client on the channel they used. Also: importing an Excel file of leads,
// and the Outreach frame fitting a large screen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { LeadStore } = require('../../src/database/db');
const { startSmtp } = require('../fake-smtp');
const { startImap } = require('../fake-imap');
const { unlock, activationEnv } = require('./helpers');

const root = path.join(__dirname, '..', '..');
const ADMIN = '923211234567';
const CLIENT = '923001234567';

function seed(file) {
  const s = new LeadStore(file);
  const re = s.ensureCategory('Real Estate');
  s.save({ placeKey: '0x1:0x7', mapsUrl: 'https://www.google.com/maps/place/Z1', name: 'Zahid Properties', phoneRaw: '03001234567', address: 'DHA, Lahore, Pakistan', websiteStatus: 'no_website', categoryId: re.id });
  const z = s.listLeads({})[0];
  s.saveLeadEmails(z.id, { emails: ['zahid@realty.pk'] });
  s.setWhatsAppResult('+923001234567', 'available', 'baileys');
  s.setState('assistant.settings', { admins: [ADMIN], suggestions: false, shutdownComputer: false, poolAuto: false, adminEmail: 'boss@axora.pk' });
  s.close();
  return z.id;
}

test('Inbox: replies from WhatsApp and email, alerts to the admin, answers relayed to the client; Excel import; large screen', { timeout: 300_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-inbox-e2e-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  const leadId = seed(path.join(userData, 'leads.db'));
  const smtp = await startSmtp();
  const imapMessages = [];
  const imap = await startImap({ messages: imapMessages, user: null });
  const waLog = path.join(tmp, 'wa-sent.log');
  const env = {
    ...process.env,
    ...activationEnv,
    LEAD_FINDER_USER_DATA: userData,
    LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome'),
    LEAD_FINDER_NO_UPDATES: '1',
    LEAD_FINDER_TEST_SECRETS: '1',
    LEAD_FINDER_TEST_SMTP_INSECURE: '1',
    LEAD_FINDER_TEST_BAILEYS: path.join(__dirname, 'fake-baileys.js'),
    LEAD_FINDER_TEST_BAILEYS_LOG: waLog,
    LEAD_FINDER_TEST_BAILEYS_NUMBERS: CLIENT,
    LEAD_FINDER_TEST_IMPORT_PICK: path.join(__dirname, '..', 'fixtures', 'leads.xlsx'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [root], cwd: root, env });
  t.after(async () => {
    await app.close().catch(() => {});
    await smtp.close();
    await imap.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const win = await app.firstWindow();
  win.on('dialog', (d) => d.accept());
  await unlock(win);
  const until = async (fn, ms = 30_000, what = 'condition') => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 250))) if (await fn()) return;
    throw new Error(`timed out waiting for ${what}`);
  };
  const waSent = () => (fs.existsSync(waLog) ? fs.readFileSync(waLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.text) : []);
  const toAdmin = () => waSent().filter((e) => e.jid.startsWith(ADMIN)).map((e) => e.text);
  const toClient = () => waSent().filter((e) => e.jid.startsWith(CLIENT)).map((e) => e.text);
  await until(async () => (await win.evaluate(() => window.leadFinder.waAccounts())).some((a) => a.state === 'open'), 15_000, 'WhatsApp');

  // An email campaign sent to the lead (the account's inbox is read over IMAP).
  const acc = await win.evaluate((a) => window.leadFinder.emailAccountAdd({ name: 'Local', senderName: 'Axora', email: 'sender@example.com', host: '127.0.0.1', port: a.smtp, username: 'sender@example.com', password: 'pw', encryption: 'none', imapOn: true, imapHost: '127.0.0.1', imapPort: a.imap }), { smtp: smtp.port, imap: imap.port });
  assert.ok(acc.ok, acc.error);
  const camp = await win.evaluate(() => window.leadFinder.emailCreate('Website offer'));
  await win.evaluate(([id, a]) => window.leadFinder.emailUpdate(id, { accountIds: [a], subject: 'Website for {business}', body: 'Hello,\n\nWe build websites.' }), [camp.id, acc.account.id]);
  await win.evaluate((id) => window.leadFinder.emailAddLeads(id, {}), camp.id);
  await win.evaluate((id) => window.leadFinder.emailStart(id), camp.id);
  await until(() => smtp.messages.some((m) => m.to.includes('zahid@realty.pk')), 30_000, 'the campaign email');

  // The lead is in a WhatsApp campaign too, and replies on WhatsApp.
  const wa = await win.evaluate(() => window.leadFinder.outreachCreate('WA offer'));
  assert.ok((await win.evaluate(([id, l]) => window.leadFinder.outreachAddLeads(id, [l]), [wa.id, leadId])).ok);
  await app.evaluate((_, a) => globalThis.__fakeWA.incoming(a, 'Haan, price batao'), CLIENT);
  await until(() => smtp.messages.some((m) => m.to.includes('boss@axora.pk')), 15_000, 'the admin email');
  const alert = smtp.messages.find((m) => m.to.includes('boss@axora.pk'));
  // The subject as a mail app shows it (encoded words decoded).
  const subject = /Subject: ([^\n]*)/.exec(alert.text)[1].replace(/=\?UTF-8\?Q\?([^?]*)\?=?\s*/gi, (_, w) => Buffer.from(w.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (__, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'));
  assert.match(subject, /^\[#1\] WhatsApp reply #1 from Zahid Properties/);
  assert.match(alert.text, /Haan, price batao/);

  // The admin answers on WhatsApp: "#1 ..." goes to the client.
  await app.evaluate((_, a) => globalThis.__fakeWA.incoming(a, '#1 Demo aaj bhej raha hoon'), ADMIN);
  await until(() => toClient().includes('Demo aaj bhej raha hoon'), 15_000, 'the relayed answer');
  await until(() => toAdmin().some((x) => /Sent to Zahid Properties \(WhatsApp\)/.test(x)), 10_000, 'the confirmation');

  // An email reply, read from the inbox: the admin is told on WhatsApp.
  imapMessages.push({ from: 'zahid@realty.pk', subject: 'Re: Website for Zahid Properties', text: 'Price kya hai?\n\nOn Mon, Axora wrote:\n> Hello' });
  const r = await win.evaluate((id) => window.leadFinder.emailCheckReplies(id), acc.account.id);
  assert.ok(r.ok, r.error);
  await until(() => toAdmin().some((x) => /Email reply #2 from Zahid Properties/.test(x) && /Price kya hai\?/.test(x)), 10_000, 'the WhatsApp alert');
  // The admin answers that email by email ([#2] in the subject): sent to the client by email.
  imapMessages.push({ from: 'boss@axora.pk', subject: 'Re: [#2] Email reply #2', text: 'Price 50,000 hai, demo kal.' });
  await win.evaluate((id) => window.leadFinder.emailCheckReplies(id), acc.account.id);
  await until(() => smtp.messages.some((m) => m.to.includes('zahid@realty.pk') && /Price 50,000 hai, demo kal\./.test(m.text)), 15_000, 'the emailed answer');
  assert.match(smtp.messages.filter((m) => m.to.includes('zahid@realty.pk')).at(-1).text, /Subject: Re: Website for Zahid Properties/);

  // The Inbox tab: only the leads who replied; answer from the app.
  await win.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Outreach' }).click();
  await win.getByRole('navigation', { name: 'Campaign channel' }).getByRole('button', { name: 'Inbox' }).click();
  const list = win.getByRole('region', { name: 'Conversations' });
  await list.getByRole('listitem').first().waitFor();
  assert.equal(await list.getByRole('listitem').count(), 2);
  await list.getByRole('button', { name: /Zahid Properties/ }).filter({ hasText: 'Demo aaj' }).click();
  const conv = win.getByRole('region', { name: 'Conversation', exact: true });
  await conv.getByText('Haan, price batao').waitFor();
  await conv.getByText('Demo aaj bhej raha hoon').waitFor();
  await conv.getByLabel('Your answer').fill('Shukriya! Kal 11 baje call karunga.');
  await conv.getByRole('button', { name: 'Send' }).click();
  await until(() => toClient().includes('Shukriya! Kal 11 baje call karunga.'), 15_000, 'the reply from the Inbox');
  // A new email reply arrives: the Inbox shows it by itself (the account's inbox is watched live).
  await until(() => imap.idling() > 0, 30_000, 'the account’s inbox to be watched');
  imapMessages.push({ from: 'zahid@realty.pk', subject: 'Re: Website for Zahid Properties', text: 'Theek hai, kal baat karte hain.' });
  imap.notify();
  await list.getByText(/Theek hai, kal baat karte hain\./).waitFor({ timeout: 15_000 });
  await win.setViewportSize({ width: 1920, height: 1080 }).catch(() => {});
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1920, 1080));
  await new Promise((r) => setTimeout(r, 500));
  await win.screenshot({ path: path.join(os.tmpdir(), 'lf-inbox.png') });

  // A large screen: the Outreach frame ends inside the window (nothing cut off at the bottom).
  await win.getByRole('navigation', { name: 'Campaign channel' }).getByRole('button', { name: 'Email' }).click();
  await win.getByRole('region', { name: 'Campaign list' }).getByText('Website offer').click();
  const frame = await win.evaluate(() => {
    const el = [...document.querySelectorAll('.outreach-shell > .outreach')].find((x) => !x.hidden);
    const main = el.querySelector('.or-main');
    main.scrollTop = main.scrollHeight;
    const hist = el.querySelector('[aria-label="Campaign history"]').getBoundingClientRect();
    return { bottom: el.getBoundingClientRect().bottom, height: window.innerHeight, histBottom: hist.bottom };
  });
  assert.ok(frame.bottom <= frame.height + 1, `the frame ends inside the window (${frame.bottom} > ${frame.height})`);
  assert.ok(frame.histBottom <= frame.height + 1, 'the last section can be scrolled into view');
  await win.screenshot({ path: path.join(os.tmpdir(), 'lf-email-big.png') });

  // Leads tab: importing an Excel file, columns mapped, into a new category.
  await win.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Leads' }).click();
  await win.getByRole('button', { name: 'Import', exact: true }).click();
  const dlg = win.getByRole('dialog', { name: 'Import leads' });
  await dlg.getByText('leads.xlsx').waitFor();
  assert.equal(await dlg.getByLabel('Email', { exact: true }).inputValue(), '1', 'the Email column was guessed');
  await dlg.getByLabel('Category', { exact: true }).selectOption('__new');
  await dlg.getByLabel('New category name').fill('Imported Realty');
  await dlg.getByRole('button', { name: /^Import \d+ rows?$/ }).click();
  await dlg.getByRole('status').getByText(/3\s*leads added/).waitFor();
  await dlg.getByText(/1 already saved/).waitFor(); // Zahid Properties: same email and phone
  const imported = await win.evaluate(() => window.leadFinder.listLeads({ source: 'import' }));
  assert.equal(imported.length, 3);
  assert.ok(imported.every((l) => l.category === 'Imported Realty'));
});
