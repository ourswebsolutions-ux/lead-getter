'use strict';
// Email campaigns and the Groq assistant in the real app: an SMTP account
// added in the form, a campaign written, recipients added from the Leads
// database and really sent (local SMTP server); the Groq key saved and
// tested in Settings; the Assistant answering from the real database and
// running an action only after Confirm; the admin's free-text WhatsApp
// message answered by the AI; everything still there after a restart.
// Groq is a local stand-in that answers like its API (tool calls included).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { _electron } = require('playwright-core');
const { LeadStore } = require('../../src/database/db');
const { startSmtp } = require('../fake-smtp');
const { unlock, activationEnv } = require('./helpers');

const root = path.join(__dirname, '..', '..');
const ADMIN = '923211234567';
const KEY = 'gsk_e2eTESTKEY000000000000000000';

function seed(file) {
  const s = new LeadStore(file);
  const re = s.ensureCategory('Real Estate');
  s.save({ placeKey: '0x1:0x9', mapsUrl: 'https://www.google.com/maps/place/R1', name: 'Zahid Properties', phoneRaw: '03001234567', address: 'Lahore, Pakistan', websiteStatus: 'no_website', categoryId: re.id });
  s.save({ placeKey: '0x2:0x9', mapsUrl: 'https://www.google.com/maps/place/R2', name: 'Noor Estate', phoneRaw: '03007654321', address: 'Lahore, Pakistan', websiteStatus: 'no_website', categoryId: re.id });
  s.save({ placeKey: '0x3:0x9', mapsUrl: 'https://www.google.com/maps/place/R3', name: 'No Mail Realty', phoneRaw: '03007654322', address: 'Lahore, Pakistan', websiteStatus: 'no_website', categoryId: re.id });
  const [a, b] = s.listLeads({}).filter((l) => l.name !== 'No Mail Realty');
  s.saveLeadEmails(a.id, { emails: [`${a.name.split(' ')[0].toLowerCase()}@realty.pk`] });
  s.saveLeadEmails(b.id, { emails: [`${b.name.split(' ')[0].toLowerCase()}@realty.pk`] });
  const food = s.ensureCategory('Restaurants');
  s.save({ placeKey: '0x4:0x9', mapsUrl: 'https://www.google.com/maps/place/F1', name: 'Karachi Grill', phoneRaw: '03007654329', address: 'Gulberg, Lahore', websiteStatus: 'no_website', categoryId: food.id });
  s.saveLeadEmails(s.listLeads({}).find((l) => l.name === 'Karachi Grill').id, { emails: ['owner@karachigrill.pk'] });
  // The admin, with no automatic offers (they would open a question).
  s.setState('assistant.settings', { admins: [ADMIN], suggestions: false, shutdownComputer: false, poolAuto: false });
  s.close();
}

// Groq's chat API, scripted on the conversation.
async function fakeGroq() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const ok = req.headers.authorization === `Bearer ${KEY}`;
      const send = (status, json) => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(json)));
      if (!ok) return send(401, { error: { message: 'Invalid API Key' } });
      if (req.url.endsWith('/models')) return send(200, { data: [{ id: 'openai/gpt-oss-120b' }] });
      const { messages } = JSON.parse(body);
      calls.push(messages);
      // The email writer (no tools): a JSON email from the business facts.
      if (/You write ONE personalised outreach email/.test(messages[0].content)) {
        const u = JSON.parse(messages[1].content);
        return send(200, { choices: [{ message: { role: 'assistant', content: JSON.stringify({ subject: `AI idea for ${u.business.business_name}`, body: `Salam,\n\n${u.business.business_name} in ${u.business.address} has no website yet. ${u.instructions}\n\n${u.sender.name}` }) } }] });
      }
      const last = messages.at(-1);
      const reply = (content) => send(200, { choices: [{ message: { role: 'assistant', content } }] });
      const tool = (name, args) => send(200, { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `t${calls.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
      if (last.role === 'tool') {
        const r = JSON.parse(last.content);
        if (r.status === 'awaiting_user_confirmation') return reply(`Ye karun? ${r.will_do} Confirm karein (yes / no).`);
        if (r.confirmed_by_user && r.started) return reply(`Search shuru: ${r.linkedin}`);
        if (r.confirmed_by_user) return reply(r.ok === false ? `Nahi hua: ${r.error}` : 'Ho gaya: campaign stop kar di.');
        if (r.count != null) return reply(`Total ${r.count} leads hain, ${r.with_email} ke paas email hai.`);
        if (r.email) return reply(`Email campaigns: ${r.email.map((c) => `${c.name} (${c.sent} sent)`).join(', ')}`);
        return reply('OK');
      }
      const text = String(last.content || '').toLowerCase();
      const att = /\[attached: ([^(]+) \(file_id ([a-f0-9]{16}), (\w+)\)/i.exec(String(last.content || ''));
      if (att) return reply(`File mil gayi: ${att[1].trim()} (${att[3]})`);
      const acc = /\[The app itself handled the email account\(s\)[^:]*: ([^\]]+)\]/.exec(String(last.content || ''));
      if (acc) return reply(`Account: ${acc[1].split(' (account id')[0]}`);
      if (/kitne leads/.test(text)) return tool('count_leads', {});
      if (/linkdin|linkedin/.test(text)) return tool('start_lead_search', { sources: ['linkedin'], linkedin_mode: 'connections' });
      if (/stop/.test(text)) return tool('stop_campaign', { channel: 'email', campaign_id: 1 });
      if (/campaigns? (ki|ka)/.test(text)) return tool('list_campaigns', { channel: 'email' });
      return reply('Main samjha nahi.');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/openai/v1`, calls, close: () => new Promise((r) => server.close(r)) };
}

test('Email campaigns, Groq settings, the Assistant and AI on WhatsApp, in the real app', { timeout: 300_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-ai-e2e-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  seed(path.join(userData, 'leads.db'));
  const smtp = await startSmtp();
  const groq = await fakeGroq();
  const waLog = path.join(tmp, 'wa-sent.log');
  const env = {
    ...process.env,
    ...activationEnv,
    LEAD_FINDER_USER_DATA: userData,
    LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome'),
    LEAD_FINDER_NO_UPDATES: '1',
    LEAD_FINDER_TEST_SECRETS: '1',
    LEAD_FINDER_TEST_SMTP_INSECURE: '1',
    LEAD_FINDER_TEST_GROQ_URL: groq.url,
    LEAD_FINDER_TEST_PROVIDER_PORT: String(smtp.port),
    LEAD_FINDER_TEST_BAILEYS: path.join(__dirname, 'fake-baileys.js'),
    LEAD_FINDER_TEST_BAILEYS_LOG: waLog,
    LEAD_FINDER_TEST_BAILEYS_NUMBERS: '923001234567',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  let app = await _electron.launch({ args: [root], cwd: root, env });
  t.after(async () => {
    await app.close().catch(() => {});
    await smtp.close();
    await groq.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  let win = await app.firstWindow();
  win.on('dialog', (d) => d.accept());
  await unlock(win);
  const nav = () => win.getByRole('navigation', { name: 'Workspace' });
  const until = async (fn, ms = 30_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 250))) if (await fn()) return;
    throw new Error('timed out');
  };

  // --- Outreach > Email: an account through the form (saved, never shown again).
  await nav().getByRole('button', { name: 'Outreach' }).click();
  await win.getByRole('navigation', { name: 'Campaign channel' }).getByRole('button', { name: 'Email' }).click();
  const accounts = win.getByRole('region', { name: 'Email accounts' });
  await accounts.getByRole('button', { name: 'Add' }).click();
  const form = win.getByRole('dialog', { name: 'Add email account' });
  await form.getByRole('button', { name: 'Gmail' }).click();
  await form.getByLabel('Account name').fill('Company Gmail');
  await form.getByLabel('Sender name').fill('Axora');
  await form.getByLabel('Email address').fill('team@axora.pk');
  await form.getByLabel('SMTP password').fill('gmail-app-password');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await accounts.getByText('Company Gmail').waitFor();
  const listed = await win.evaluate(() => window.leadFinder.emailAccounts());
  assert.equal(listed.accounts[0].host, 'smtp.gmail.com');
  assert.equal(listed.accounts[0].hasPassword, true);
  assert.ok(!JSON.stringify(listed).includes('gmail-app-password'), 'the password never comes back to the window');
  // The local test server (plain SMTP: test builds only).
  const local = await win.evaluate((port) => window.leadFinder.emailAccountAdd({ name: 'Local SMTP', senderName: 'Axora', email: 'sender@example.com', host: '127.0.0.1', port, username: 'sender@example.com', password: 'pw', encryption: 'none' }), smtp.port);
  assert.ok(local.ok, local.error);
  await accounts.getByRole('button', { name: 'Test Local SMTP' }).click();
  await until(async () => (await win.evaluate(() => window.leadFinder.emailAccounts())).accounts.find((a) => a.name === 'Local SMTP')?.status === 'ok');

  // --- Several accounts at once (Add > Add several accounts), each set up and tested.
  await accounts.getByRole('button', { name: 'Add', exact: true }).click();
  await win.getByRole('button', { name: 'Add several accounts' }).click();
  const imp = win.getByRole('dialog', { name: 'Add several sending accounts' });
  await imp.getByLabel('Accounts to import').fill('sales.one@gmail.com, abcd efgh ijkl mnop, Sales One\nsales.two@outlook.com, Pa55word!x');
  await imp.getByRole('button', { name: 'Import', exact: true }).click();
  await imp.getByRole('list', { name: 'Import results' }).getByText('sales.two@outlook.com').waitFor();
  assert.equal(await imp.locator('.em-import-results li.ok').count(), 2, 'both added and connected');
  await imp.getByRole('button', { name: 'Done' }).click();
  await accounts.getByText('sales.one@gmail.com').first().waitFor();

  // --- A campaign: account, subject, body, recipients, start.
  await win.getByRole('region', { name: 'Campaign list' }).getByRole('button', { name: 'New' }).click();
  const compose = win.getByRole('region', { name: 'Email', exact: true });
  await compose.getByRole('group', { name: 'Send from' }).getByLabel('Send from Local SMTP').check();
  await compose.getByRole('group', { name: 'Send from' }).getByLabel('Send from sales.one@gmail.com').check();
  await until(async () => (await win.evaluate(() => window.leadFinder.emailCampaign(1))).campaign.accountIds.length === 2);
  await compose.getByLabel('Minutes between emails').fill('0.5');
  await compose.getByLabel('Subject').fill('Website for {business}');
  await compose.locator('textarea').fill('Hello {name},\n\nWe build websites for real estate businesses.');
  await compose.getByRole('button', { name: 'Save' }).click();
  await win.getByRole('button', { name: 'Add recipients' }).click();
  const picker = win.getByRole('dialog', { name: 'Add recipients' });
  await picker.getByLabel('Category').selectOption({ label: 'Real Estate' });
  await picker.getByText(/2\s*can be emailed/).waitFor();
  await picker.getByRole('button', { name: /Add all 2/ }).click();
  await win.getByRole('region', { name: 'Recipients' }).getByText('zahid@realty.pk').waitFor();
  await win.getByRole('button', { name: 'Start' }).click(); // the confirm dialog is accepted
  for (let i = 0; i < 100 && smtp.messages.length < 2; i++) await new Promise((r) => setTimeout(r, 300));
  assert.equal(smtp.messages.length, 2, 'both emails sent');
  assert.deepEqual(smtp.messages.map((m) => /From: .*<([^>]+)>/.exec(m.text)[1]).sort(), ['sales.one@gmail.com', 'sender@example.com'], 'one from each sending account');
  assert.ok(smtp.messages.some((m) => /Subject: Website for Zahid Properties/.test(m.text)));
  assert.ok(smtp.messages.every((m) => /List-Unsubscribe/.test(m.text) && /unsubscribe/.test(m.text)));
  await until(async () => (await win.evaluate(() => window.leadFinder.emailCampaign(1))).campaign.status === 'completed');
  await new Promise((r) => setTimeout(r, 600));
  await win.screenshot({ path: path.join(os.tmpdir(), 'lf-email.png'), fullPage: true });

  // --- Settings > Groq AI: key, Save, Test.
  await nav().getByRole('button', { name: 'Settings' }).click();
  await win.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'AI', exact: true }).click();
  const groqCard = win.getByRole('group', { name: 'Groq settings' });
  await groqCard.getByLabel('Groq API Key').fill(KEY);
  await groqCard.getByRole('button', { name: 'Save API Key' }).click();
  await groqCard.locator('.st-groq-status', { hasText: 'Saved, not tested' }).waitFor();
  await groqCard.getByRole('button', { name: 'Test Connection' }).click();
  await groqCard.locator('.st-groq-status', { hasText: 'Connected' }).waitFor();
  await win.screenshot({ path: path.join(os.tmpdir(), 'lf-groq.png') });
  assert.ok(!JSON.stringify(await win.evaluate(() => window.leadFinder.aiSettings())).includes(KEY), 'the key never comes back');

  // --- A category campaign written by the AI: switch ON, each email personal.
  await nav().getByRole('button', { name: 'Outreach' }).click();
  const catsCard = win.getByRole('region', { name: 'Category campaigns' });
  await catsCard.getByText('Restaurants').click();
  const comp2 = win.getByRole('region', { name: 'Email', exact: true });
  await comp2.getByRole('group', { name: 'Send from' }).getByLabel('Send from Local SMTP').check();
  await comp2.getByText('Subject', { exact: true }).waitFor();
  await comp2.getByRole('switch', { name: 'Write each email with AI' }).click();
  await comp2.getByText('Subject', { exact: true }).waitFor({ state: 'detached' }); // AI on: only the prompt (the AI writes the subject)
  await comp2.getByText('Your prompt for the AI').waitFor();
  assert.equal(await comp2.getByLabel('Minutes between emails').inputValue(), '1', 'the delay is shown in minutes');
  await comp2.locator('textarea').fill('We build websites for restaurants. Offer a free menu page.');
  await comp2.getByRole('button', { name: 'Save' }).click();
  await until(async () => (await win.evaluate(() => window.leadFinder.emailCampaigns())).campaigns.some((c) => c.category && c.aiWrite));
  const before = smtp.messages.length;
  await catsCard.getByRole('switch', { name: 'Restaurants email campaign' }).click();
  await until(() => smtp.messages.length > before);
  const aiMail = smtp.messages.at(-1);
  assert.deepEqual(aiMail.to, ['owner@karachigrill.pk']);
  assert.match(aiMail.text, /Subject: AI idea for Karachi Grill/);
  assert.match(aiMail.text, /Gulberg, Lahore has no website yet\. We build websites for restaurants/);
  assert.ok(groq.calls.some((m) => /owner@karachigrill\.pk/.test(m[1]?.content || '')), 'the business details went to the AI');
  await win.screenshot({ path: path.join(os.tmpdir(), 'lf-email-ai.png'), fullPage: true });

  // --- WhatsApp: the same AI switch; on, only the prompt shows.
  await win.getByRole('navigation', { name: 'Campaign channel' }).getByRole('button', { name: 'WhatsApp' }).click();
  const wa = win.locator('.outreach').first();
  const waRow = wa.getByRole('list', { name: 'Category campaigns' }).getByRole('listitem').filter({ hasText: 'Real Estate' });
  await waRow.locator('.campaign-item').click();
  await wa.getByRole('heading', { name: 'Real Estate', exact: true }).waitFor();
  await wa.getByRole('tab', { name: /^Messages/ }).click();
  await wa.getByRole('button', { name: 'Add Message' }).waitFor();
  await wa.getByRole('switch', { name: 'Write each message with AI' }).click();
  await wa.getByRole('button', { name: 'Add Message' }).waitFor({ state: 'detached' }); // AI on: the message editor is hidden
  await wa.getByRole('region', { name: 'AI prompt' }).locator('textarea').fill('Free website offer, Roman Urdu, short.');
  await win.getByRole('region', { name: 'Unsaved changes' }).getByRole('button', { name: 'Save settings' }).click();
  const waId = (await win.evaluate(() => window.leadFinder.outreachOverview())).campaigns.find((c) => c.category).id;
  await until(async () => (await win.evaluate((i) => window.leadFinder.outreachState(i), waId)).config.aiWrite === true);
  assert.equal((await win.evaluate((i) => window.leadFinder.outreachState(i), waId)).config.aiPrompt, 'Free website offer, Roman Urdu, short.');
  await win.screenshot({ path: path.join(os.tmpdir(), 'lf-wa-ai.png') });
  await win.getByRole('navigation', { name: 'Campaign channel' }).getByRole('button', { name: 'Email' }).click();
  await nav().getByRole('button', { name: 'Assistant' }).click();

  // --- The Assistant: answers from the database; an action waits for Confirm.
  const box = win.getByRole('textbox', { name: 'Message' });
  await box.fill('Kitne leads available hain?');
  await box.press('Enter');
  await win.getByText('Total 4 leads hain, 3 ke paas email hai.').waitFor();
  // An account written in the chat: added by the app; the AI never sees the password.
  await box.fill('mera gmail chat.user@gmail.com hai, app password qwer tyui opas dfgh');
  await box.press('Enter');
  await win.getByText('Account: chat.user@gmail.com: added, connected').waitFor();
  assert.ok((await win.evaluate(() => window.leadFinder.emailAccounts())).accounts.some((a) => a.email === 'chat.user@gmail.com' && a.status === 'ok'));
  await box.fill('Email campaign stop kar do');
  await box.press('Enter');
  const confirm = win.getByRole('group', { name: 'Confirm action' });
  await confirm.waitFor();
  assert.notEqual((await win.evaluate(() => window.leadFinder.emailCampaign(1))).campaign.status, 'stopped', 'nothing done before Confirm');
  await confirm.getByRole('button', { name: 'Confirm' }).click();
  await win.getByText('Ho gaya: campaign stop kar di.').waitFor();
  assert.equal((await win.evaluate(() => window.leadFinder.emailCampaign(1))).campaign.status, 'stopped');
  assert.ok(groq.calls.every((m) => !/gmail-app-password|qwer ?tyui|qwertyuiopasdfgh/.test(JSON.stringify(m)) && !JSON.stringify(m).includes(KEY)), 'no secret ever sent to the AI');

  // Any search: LinkedIn My connections, started with the Leads tab's engine after Confirm.
  await box.fill('acha ab linkdin search start kro with my connection');
  await box.press('Enter');
  await win.getByRole('group', { name: 'Confirm action' }).getByRole('button', { name: 'Confirm' }).click();
  await win.getByText('Search shuru: LinkedIn connections').waitFor();
  // (No Chrome in this test: the search ends with Chrome's error, as it would from the Leads tab.)
  await until(async () => /error|stopped|done/.test((await win.evaluate(() => window.leadFinder.getStatus())).state || ''));
  assert.equal((await win.evaluate(() => window.leadFinder.getStatus())).keyword, 'LinkedIn connections', 'the Leads tab engine ran the LinkedIn connections search');

  // --- WhatsApp: the admin's free text goes to the AI; fixed commands still work.
  for (let i = 0; i < 50 && !(await win.evaluate(() => window.leadFinder.waAccounts())).some((a) => a.state === 'open'); i++) await new Promise((r) => setTimeout(r, 200));
  const toAdmin = () => (fs.existsSync(waLog) ? fs.readFileSync(waLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.text && e.jid.startsWith(ADMIN)).map((e) => e.text) : []);
  const ask = async (text, re) => {
    const n = toAdmin().length;
    await app.evaluate((_, a) => globalThis.__fakeWA.incoming(a.from, a.text), { from: ADMIN, text });
    for (let i = 0; i < 100; i++) {
      const got = toAdmin();
      if (got.length > n && re.test(got.at(-1))) return got.at(-1);
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`no reply matching ${re}; got ${JSON.stringify(toAdmin().slice(-2))}`);
  };
  await ask('Email campaigns ki progress batao', /Email campaigns: .*Email campaign 1 \(2 sent\)/);
  await ask('status', /Lead Finder status/);
  // A photo sent on WhatsApp reaches the assistant as an attached file.
  const n0 = toAdmin().length;
  const png = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(32)]);
  await app.evaluate((_, a) => globalThis.__fakeWA.incomingMedia(a.from, { kind: 'image', data: Buffer.from(a.png, 'base64'), mimetype: 'image/png', caption: 'campaign mein ye image lagao' }), { from: ADMIN, png: png.toString('base64') });
  for (let i = 0; i < 100 && !(toAdmin().length > n0 && /File mil gayi/.test(toAdmin().at(-1))); i++) await new Promise((r) => setTimeout(r, 200));
  assert.match(toAdmin().at(-1), /File mil gayi: photo-\d+\.png \(image\)/);
  assert.match(String(groq.calls.at(-1).at(-1).content), /campaign mein ye image lagao/);

  // --- Restart: the conversation and the campaign history are kept.
  await app.close();
  app = await _electron.launch({ args: [root], cwd: root, env });
  win = await app.firstWindow();
  await unlock(win);
  await win.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Assistant' }).click();
  await win.getByText('Total 4 leads hain, 3 ke paas email hai.').waitFor();
  const after = await win.evaluate(() => window.leadFinder.emailCampaign(1));
  assert.equal(after.campaign.counts.sent, 2);
  assert.ok(after.campaign.log.some((l) => /Completed: 2 sent/.test(l.text)), JSON.stringify(after.campaign.log));
  await win.screenshot({ path: path.join(os.tmpdir(), 'lf-assistant.png') });
});
