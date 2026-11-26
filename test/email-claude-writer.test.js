'use strict';
// Email campaigns written by Claude (writer 'claude'): nothing is sent until
// Claude has written an email; Claude gets the prompt and each business's
// facts (emails_to_write), saves what it wrote (save_written_emails); the
// app checks each one like its own AI emails (exact sign-off, the prompt's
// length) and refuses one that misses a rule; written ones go out in order,
// then follow-ups once Claude has written them. The app's own AI (Groq /
// OpenRouter) is never asked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { startSmtp } = require('./fake-smtp');
const { startMx, testEngine } = require('./fake-mx');
const { EmailAccounts } = require('../src/email/accounts');
const { EmailCampaigns } = require('../src/email/campaigns');
const { EmailVerification } = require('../src/email/verification');
const { Vault } = require('../src/main/vault');
const { createAI } = require('../src/ai/service');
const { buildClaudeTools } = require('../src/claude/tools');
const { check } = require('../src/claude/host');

const PROMPT = fs.readFileSync(path.join(__dirname, 'fixtures', 'mahi-prompt.txt'), 'utf8').replace(/\r\n/g, '\n');
const MIN = 60_000;
const DAY = 24 * 3600_000;
const LEADS = [
  { id: 1, name: 'Evolve Commercial Cleaning Preston', contactName: 'Sarah Jones', email: 'sarah@good.test', category: 'Commercial cleaning service', address: 'Preston, UK', categoryId: 1 },
  { id: 2, name: 'Sparkle Cleaners', email: 'sparkle@good.test', category: 'Cleaning service', address: 'Lahore, Pakistan', categoryId: 1 },
];
const cipher = { encrypt: (t) => Buffer.from(String(t), 'utf8').reverse(), decrypt: (b) => Buffer.from(b).reverse().toString('utf8') };
function memState() {
  const m = new Map();
  return { getState: (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setState: (k, v) => m.set(k, JSON.stringify(v)) };
}

// About 115 words, as the prompt asks; signed the wrong way on purpose.
const GOOD = `Hi Sarah,

Running Evolve Commercial Cleaning in Preston means keeping cleaners, client sites and bookings moving at the same time, and the admin around that can easily take over the working day for a small team.

At MahiVirtual, we can help your business with:
- Admin support, so quotes, rotas and client paperwork stay organised every week.
- Email and inbox management, so new enquiries and client requests get quick replies.
- Appointment and calendar scheduling, so cleaning visits are booked without clashes.

Our assistants work quietly in the background and fit around the way your team already works, so you can stay focused on clients and quality.

Would you be open to a short call this week to see if this could help?

Kind regards,
Mahi from MahiVirtual`;

test('Claude writes the campaign’s emails: nothing is sent before; checked, saved, sent in order; then follow-ups', { timeout: 60_000 }, async (t) => {
  const smtp = await startSmtp();
  const mx = await startMx({ exists: ['sarah@good.test', 'sparkle@good.test'] });
  const state = memState();
  const db = new DatabaseSync(':memory:');
  const accounts = new EmailAccounts({ store: state, vault: new Vault({ store: state, key: 'email.secrets', cipher }), allowInsecure: true });
  const time = { now: Date.parse('2026-11-23T09:00:00Z') };
  let apiCalls = 0;
  const campaigns = new EmailCampaigns({ db, accounts, leads: (f = {}) => LEADS.filter((l) => (f.ids ? f.ids.includes(l.id) : true)), clock: () => time.now, tickMs: 60_000, random: () => 0, writer: async () => (apiCalls++, { subject: 'x', body: 'written by the app' }) });
  campaigns.verification = new EmailVerification({ db, state: { get: state.getState, set: state.setState }, makeEngine: testEngine(mx), clock: () => time.now });
  t.after(async () => {
    campaigns.dispose();
    accounts.dispose();
    campaigns.verification.stop();
    await smtp.close();
    await mx.close();
  });
  // The app's AI service with no key at all (the user has only Claude).
  const m = new Map();
  const aiStore = { getState: (k) => m.get(k), setState: (k, v) => m.set(k, v) };
  const ai = createAI({ store: aiStore, vault: new Vault({ store: aiStore, key: 's', cipher: null }), toolDeps: { email: null, files: null, store: null }, fetchImpl: async () => assert.fail('no AI provider is asked') });
  const tools = Object.fromEntries(buildClaudeTools({ store: { listLeads: () => [], listCategories: () => ({ categories: [] }) }, email: { campaigns }, checkEmail: (x) => ai.checkEmail(x) }).map((x) => [x.name, x]));

  const acc = accounts.add({ name: 'SMTP', senderName: 'Info Axoraweb', email: 'info@axora.test', host: '127.0.0.1', port: smtp.port, username: 'u', password: 'pw', encryption: 'none' }).account;
  const c = campaigns.create({ name: 'Cleaning UK' });
  assert.ok(campaigns.update(c.id, { accountIds: [acc.id], body: PROMPT, aiWrite: true, writer: 'claude', delaySeconds: 60, followups: { on: true, steps: [{ days: 2, subject: '', body: '' }] } }).ok);
  campaigns.addLeads(c.id, {});
  assert.deepEqual(campaigns.problems(campaigns.row(c.id)), [], 'no Groq / OpenRouter key needed');
  assert.ok((await campaigns.start(c.id)).ok);

  const run = async (ms) => {
    for (const end = time.now + ms; time.now < end; time.now += MIN) await campaigns.tick();
  };
  await run(10 * MIN);
  assert.equal(smtp.messages.length, 0, 'nothing is sent before Claude writes it');
  let s = campaigns.summary(c.id);
  assert.equal(s.waiting, 'claude', JSON.stringify({ status: s.status, pause: s.pauseText, counts: s.counts, verify: s.verify }));
  assert.deepEqual(s.claude, { written: 0, toWrite: 2, followupsWritten: 0, followupsToWrite: 0 });
  const preview = await campaigns.render(c.id);
  assert.match(preview.error, /Claude has not written any email/);

  // Claude reads what to write.
  const todo = await tools.emails_to_write.run({ campaign_id: c.id, limit: 5 });
  assert.equal(todo.prompt, PROMPT);
  assert.deepEqual(todo.items.map((x) => [x.type, x.email]), [['first_email', 'sarah@good.test'], ['first_email', 'sparkle@good.test']]);
  assert.equal(todo.items[0].lead.business_name, 'Evolve Commercial Cleaning Preston');
  assert.match(todo.items[0].lead.contact_name, /^Sarah/);

  // Input checks (as the MCP host applies them) and the app's own checks.
  assert.match(check(tools.save_written_emails.parameters, { campaign_id: c.id, emails: [{ email: 'x', body: 'y' }] }), /emails\[0\]\.step is required/);
  const short = await tools.save_written_emails.run({ campaign_id: c.id, emails: [{ email: 'sparkle@good.test', step: 0, subject: 'Help for Sparkle', body: 'Hello there,\n\nWe help cleaners. Interested?\n\nBest,\nMahi' }] });
  assert.equal(short.saved, 0);
  assert.match(short.not_saved[0].problems.join(' '), /too short/);
  const saved = await tools.save_written_emails.run({ campaign_id: c.id, emails: [{ email: 'sarah@good.test', step: 0, subject: 'Admin help for Evolve Commercial Cleaning', body: GOOD }, { email: 'nobody@else.test', step: 0, subject: 'x', body: GOOD }] });
  assert.equal(saved.saved, 1);
  assert.match(saved.not_saved[0].problems[0], /Not a recipient/);
  assert.deepEqual(saved.still_to_write, { first_emails: 1, follow_ups: 0 });
  const kept = db.prepare('SELECT ai_subject, ai_body FROM email_recipients WHERE email = ?').get('sarah@good.test');
  assert.match(kept.ai_body, /^Hi Sarah,\n/);
  assert.match(kept.ai_body, /Would you be open to a short call this week to see if this could help\?\n\nBest,\nMahi$/, 'the prompt’s exact sign-off, the wrong one removed');
  assert.ok(!/Kind regards|MahiVirtual\s*$/.test(kept.ai_body));
  assert.equal((await campaigns.render(c.id)).to, 'sarah@good.test');

  // Only the written one goes out; the other waits for Claude.
  await run(10 * MIN);
  assert.equal(smtp.messages.length, 1);
  assert.deepEqual(smtp.messages[0].to, ['sarah@good.test']);
  assert.match(smtp.messages[0].text, /Subject: Admin help for Evolve Commercial Cleaning/);
  assert.match(smtp.messages[0].text, /Best,\r?\nMahi/);
  s = campaigns.summary(c.id);
  assert.equal(s.waiting, 'claude');
  assert.equal(s.claude.toWrite, 1);

  // Two days later Sarah's follow-up is due: it waits for Claude too.
  await run(2 * DAY + 10 * MIN);
  assert.equal(smtp.messages.length, 1);
  const next = await tools.emails_to_write.run({ campaign_id: c.id });
  const fu = next.items.find((x) => x.type === 'follow_up');
  assert.equal(fu.email, 'sarah@good.test');
  assert.equal(fu.step, 1);
  assert.match(fu.subject, /^Re: Admin help for Evolve Commercial Cleaning/);
  assert.match(fu.earlier_emails[0], /^Hi Sarah,/);
  const fuSaved = await tools.save_written_emails.run({ campaign_id: c.id, emails: [{ email: 'sarah@good.test', step: 1, subject: fu.subject, body: 'Hi Sarah,\n\nJust following up on my note about admin support for Evolve. Would a 10-minute call next week be useful?\n\nThanks,\nMahi' }] });
  assert.equal(fuSaved.saved, 1, JSON.stringify(fuSaved.not_saved));
  await run(10 * MIN);
  assert.equal(smtp.messages.length, 2);
  const second = smtp.messages[1];
  assert.match(second.text, /Subject: Re: Admin help for Evolve Commercial Cleaning/);
  assert.match(second.text, /In-Reply-To: /);
  assert.match(second.text, /Best,\r?\nMahi/);
  assert.equal(apiCalls, 0, 'the app’s own AI writer was never used');

  // Back to the app's writer: Claude's tools say so.
  campaigns.pause(c.id, 'user');
  assert.ok(campaigns.update(c.id, { writer: 'api' }).ok);
  assert.match((await tools.emails_to_write.run({ campaign_id: c.id })).error, /Claude does not write/);
});
