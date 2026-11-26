'use strict';
// Claude as the campaigns' writer: switching a category on never sends
// (email and WhatsApp); once started, each message is written by Claude
// from the lead's details and the campaign's prompt and then sent; Claude
// writes the follow-ups from the earlier messages; pausing stops follow-ups
// too; resuming sends nothing twice; switching off stops safely. Claude is
// scripted (no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { startSmtp } = require('./fake-smtp');
const { startMx, testEngine } = require('./fake-mx');
const { EmailAccounts } = require('../src/email/accounts');
const { EmailCampaigns } = require('../src/email/campaigns');
const { EmailVerification } = require('../src/email/verification');
const { Vault } = require('../src/main/vault');
const { LeadStore } = require('../src/database/db');
const { OutreachStore } = require('../src/database/wa-store');
const { Outreach } = require('../src/whatsapp/outreach');

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const cipher = { encrypt: (t) => Buffer.from(String(t), 'utf8').reverse(), decrypt: (b) => Buffer.from(b).reverse().toString('utf8') };
function memState() {
  const m = new Map();
  return { getState: (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setState: (k, v) => m.set(k, JSON.stringify(v)) };
}
const LEADS = [
  { id: 1, name: 'Evolve Commercial Cleaning', contactName: 'Sarah Jones', email: 'sarah@good.test', categoryId: 1, kind: 'business' },
  { id: 2, name: 'Sparkle Cleaners', email: 'sparkle@good.test', categoryId: 1, kind: 'business' },
];

// Claude, scripted: every call recorded.
function claudeWriter() {
  const calls = [];
  const writer = async (x) => {
    calls.push(x);
    if (!x.claude) throw new Error('not asked as Claude');
    const who = x.business.business_name;
    if (x.followup) return { subject: x.subject, body: `Hi there,\n\nFollowing up on my note to ${who} (${x.followup.earlier.length} earlier).\n\nBest,\nMahi`, problems: [] };
    return { subject: `Admin help for ${who}`, body: `Hi there,\n\nA personal email for ${who}.\n\nBest,\nMahi`, problems: [] };
  };
  return { calls, writer };
}

async function emailWorld(t) {
  const smtp = await startSmtp();
  const mx = await startMx({ exists: (e) => !e.includes('nouser') });
  const state = memState();
  const db = new DatabaseSync(':memory:');
  const accounts = new EmailAccounts({ store: state, vault: new Vault({ store: state, key: 'email.secrets', cipher }), allowInsecure: true });
  const time = { now: Date.parse('2026-11-23T05:00:00Z') };
  const claude = claudeWriter();
  let on = true;
  const campaigns = new EmailCampaigns({ db, accounts, leads: (f = {}) => LEADS.filter((l) => (f.ids ? f.ids.includes(l.id) : f.category ? String(l.categoryId) === String(f.category) : true)), clock: () => time.now, tickMs: 60_000, writer: claude.writer, random: () => 0 });
  campaigns.verification = new EmailVerification({ db, state: { get: state.getState, set: state.setState }, makeEngine: testEngine(mx), clock: () => time.now });
  campaigns.claudeReady = () => on;
  t.after(async () => {
    campaigns.dispose();
    accounts.dispose();
    campaigns.verification.stop();
    await smtp.close();
    await mx.close();
  });
  const acc = accounts.add({ name: 'SMTP', senderName: 'Info Axoraweb', email: 'info@axora.test', host: '127.0.0.1', port: smtp.port, username: 'u', password: 'pw', encryption: 'none' }).account;
  const run = async (ms) => {
    for (const end = time.now + ms; time.now < end; time.now += MIN) await campaigns.tick();
  };
  return { smtp, campaigns, acc, time, run, claude, setOn: (v) => (on = v) };
}

test('email: a category switched on stays paused and sends nothing; Start: Claude writes each email from the lead and the prompt, then it is sent; follow-ups by Claude; pause stops them; resume sends nothing twice; off stops', { timeout: 60_000 }, async (t) => {
  const w = await emailWorld(t);
  const cc = w.campaigns.categoryCampaign('1', 'Cleaning');
  w.campaigns.update(cc.id, { accountIds: [w.acc.id], aiWrite: true, writer: 'claude', body: 'We are MahiVirtual. Offer virtual assistants. Sign as Mahi.', delaySeconds: 60, followups: { on: true, steps: [{ days: 2, subject: '', body: '' }] } });
  // No way to reach Claude: it cannot start (and says why).
  w.setOn(false);
  assert.match(w.campaigns.problems(w.campaigns.row(cc.id)).join(' '), /OpenRouter key/);
  w.setOn(true);
  assert.deepEqual(w.campaigns.problems(w.campaigns.row(cc.id)), []);
  // Switched on: paused, its leads queued, nothing sent.
  const on = await w.campaigns.setCategoryEnabled('1', 'Cleaning', true);
  assert.equal(on.ok, true);
  assert.equal(w.campaigns.summary(cc.id).status, 'paused');
  assert.equal(w.campaigns.summary(cc.id).pauseReason, 'not_started');
  assert.equal(w.campaigns.counts(cc.id).total, 2);
  await w.run(10 * MIN);
  assert.equal(w.smtp.messages.length, 0, 'switching on never sends');
  assert.equal(w.claude.calls.length, 0, 'nothing is written before Start');
  // Start: Claude writes each email from the lead and the prompt, then it is sent.
  assert.ok((await w.campaigns.start(cc.id)).ok);
  await w.run(5 * MIN);
  assert.equal(w.smtp.messages.length, 2);
  assert.equal(w.claude.calls.length, 2);
  assert.ok(w.claude.calls.every((x) => x.claude === true && x.instructions === 'We are MahiVirtual. Offer virtual assistants. Sign as Mahi.' && x.leadId && x.business.business_name), 'Claude, with the prompt and the lead’s details');
  assert.match(w.smtp.messages[0].text, /Subject: Admin help for (Evolve Commercial Cleaning|Sparkle Cleaners)/);
  assert.match(w.smtp.messages[0].text, /A personal email for/);
  // Paused before the follow-ups are due: none is written or sent, even when due.
  w.campaigns.pause(cc.id, 'user');
  await w.run(2 * DAY + 10 * MIN);
  assert.equal(w.smtp.messages.length, 2, 'a paused campaign sends no follow-ups');
  assert.equal(w.claude.calls.filter((x) => x.followup).length, 0);
  // Resume: Claude writes each follow-up from the earlier email; each goes out once.
  assert.ok((await w.campaigns.resume(cc.id)).ok);
  await w.run(10 * MIN);
  assert.equal(w.smtp.messages.length, 4);
  const fu = w.claude.calls.filter((x) => x.followup);
  assert.equal(fu.length, 2);
  assert.equal(fu[0].followup.earlier.length, 1, 'the follow-up sees the first email');
  assert.ok(w.smtp.messages.slice(2).every((m) => /Following up on my note/.test(m.text) && /Subject: Re: Admin help/.test(m.text)));
  await w.run(3 * DAY);
  assert.equal(w.smtp.messages.length, 4, 'nothing twice');
  // Off: stopped, history kept.
  assert.ok((await w.campaigns.setCategoryEnabled('1', 'Cleaning', false)).ok);
  assert.equal(w.campaigns.summary(cc.id).status, 'stopped');
  assert.equal(w.campaigns.counts(cc.id).sent, 2);
});

function waWorld() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-aiwa-'));
  const db = new LeadStore(path.join(dir, 'leads.db'));
  const clock = { t: Date.parse('2026-10-21T05:00:00Z') };
  const sent = [];
  const transport = { ready: () => true, send: async (phone, text) => (sent.push({ phone, text, at: clock.t }), { id: `WA${sent.length}` }) };
  const claude = [];
  const o = new Outreach({
    store: new OutreachStore(db.db),
    state: { get: (k) => db.getState(k), set: (k, v) => db.setState(k, v) },
    transport,
    details: (c) => ({ business: c.leadId ? db.leadById(c.leadId)?.name : null }),
    facts: (c) => ({ business_name: c.leadId ? db.leadById(c.leadId)?.name : null }),
    clock: () => clock.t,
    random: () => 0.5,
    tickMs: 1e9,
    leads: (filter = {}) => db.listLeads(filter),
  });
  o.writer = async (x) => {
    claude.push(x);
    if (!x.claude) throw new Error('not asked as Claude');
    return x.followup ? `Follow-up ${x.followup.step} for ${x.business.business_name} (after: ${x.followup.earlier.join(' | ')})` : `Hello ${x.business.business_name}, a personal WhatsApp message.`;
  };
  const cat = db.ensureCategory('Garments');
  let n = 0;
  const lead = (name, phoneRaw) => {
    n++;
    db.save({ placeKey: `0x${n}:0xa`, mapsUrl: `https://maps/${n}`, name, phoneRaw, address: 'Lahore, Pakistan', websiteStatus: 'no_website', categoryId: cat.id });
    const phone = db.listLeads({}).find((l) => l.name === name).phone;
    db.setWhatsAppResult(phone, 'available', 'baileys');
    return phone;
  };
  const run = async (ms) => {
    for (const end = clock.t + ms; clock.t < end; clock.t += MIN / 2) await o.tick();
  };
  return { db, o, sent, claude, cat, lead, run, clock };
}

test('WhatsApp: switched on stays paused; Start: Claude writes each message, then it is sent; AI follow-ups after their days, never after a reply; pause holds them', { timeout: 60_000 }, async () => {
  const w = waWorld();
  const A = w.lead('Garment House', '03001110001');
  const B = w.lead('Fabric Point', '03001110002');
  const id = w.o.categoryCampaign(String(w.cat.id), 'Garments');
  assert.equal(w.o.configure(id, { aiWrite: true, writer: 'claude', aiPrompt: 'MahiVirtual: virtual assistants. Friendly, short.', followups: { on: true, days: [2] }, interval: 1, test: false, quietStart: 23, quietEnd: 6 }).ok, true);
  const r = w.o.setCategoryEnabled(String(w.cat.id), 'Garments', true, { acknowledge: true });
  assert.equal(r.ok, true);
  assert.equal(w.o.load(id).status, 'paused');
  assert.equal(w.o.load(id).pauseReason, 'not_started');
  assert.equal(w.o.store.contacts(id).length, 2, 'queue filled');
  await w.run(30 * MIN);
  assert.equal(w.sent.length, 0, 'switching on never sends');
  assert.equal(w.claude.length, 0);
  assert.equal(w.o.start(id, { acknowledge: true }).ok, true);
  await w.run(10 * MIN);
  assert.equal(w.sent.length, 2);
  assert.match(w.sent[0].text, /a personal WhatsApp message/);
  assert.equal(w.claude.length, 2);
  assert.ok(w.claude.every((x) => x.claude && x.instructions === 'MahiVirtual: virtual assistants. Friendly, short.'));
  // B replies; the campaign is paused when A's follow-up comes due.
  w.o.store.setContact(id, B, { repliedAt: w.clock.t }, w.clock.t);
  w.o.pause(id, 'user');
  await w.run(2 * 24 * 60 * MIN + 30 * MIN);
  assert.equal(w.sent.length, 2, 'paused: no follow-up');
  assert.equal(w.claude.filter((x) => x.followup).length, 0, 'paused: nothing written either');
  assert.equal(w.o.resume(id).ok, true);
  await w.run(30 * MIN);
  assert.equal(w.sent.length, 3);
  const fus = w.claude.filter((x) => x.followup);
  assert.equal(fus.length, 1, 'only A: B replied');
  assert.match(fus[0].followup.earlier[0], /a personal WhatsApp message/);
  assert.equal(w.sent[2].phone, A);
  assert.match(w.sent[2].text, /^Follow-up 1 for Garment House/);
  await w.run(5 * 24 * 60 * MIN);
  assert.equal(w.sent.length, 3, 'one follow-up configured: no more; nothing twice');
  // Off: stopped.
  assert.equal(w.o.setCategoryEnabled(String(w.cat.id), 'Garments', false).ok, true);
  assert.equal(w.o.load(id).status, 'stopped');
});
