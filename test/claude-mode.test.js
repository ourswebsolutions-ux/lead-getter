'use strict';
// Claude as the writer and the assistant, against a local stand-in for the
// Anthropic API: which way Claude is reached (Anthropic key, else OpenRouter
// with the Claude model chosen in Settings), the assistant's chat through
// Claude with the app's tools (sending still waits for a yes), emails and
// WhatsApp messages written by Claude from the campaign's prompt and the
// lead's details (structured output, the lead's analysis kept, the prompt's
// sign-off and greeting), follow-ups from the earlier messages.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAI } = require('../src/ai/service');
const { Vault } = require('../src/main/vault');
const { LeadStore } = require('../src/database/db');
const { RULES_SYSTEM } = require('../src/ai/email-rules');
const { startAnthropic, message, KEY } = require('./fake-anthropic');

const PROMPT = fs.readFileSync(path.join(__dirname, 'fixtures', 'mahi-prompt.txt'), 'utf8').replace(/\r\n/g, '\n');
const EMAIL = `Hi Sarah,

Evolve Commercial Cleaning keeps offices across Preston spotless, which means a steady stream of bookings, quotes and client emails landing on a small team that would rather be out on site than at a desk all afternoon long.

At MahiVirtual, we can help your business with:
- **Appointment and calendar scheduling** so every cleaning visit is booked without clashes
- **Email and inbox management** so client requests get quick, friendly replies
- **Bookkeeping support** to keep invoices and payments in order

Would a short call next week be useful to see how this could work for Evolve?

Kind regards,
The MahiVirtual team`;

function world() {
  const m = new Map();
  const leads = new LeadStore(':memory:');
  const store = { db: leads.db, getState: (k) => m.get(k), setState: (k, v) => m.set(k, v) };
  const cat = leads.ensureCategory('Cleaning');
  leads.save({ placeKey: '0x1:0x1', mapsUrl: 'https://maps/1', name: 'Evolve Commercial Cleaning Preston', address: 'Preston, UK', websiteStatus: 'no_website', categoryId: cat.id });
  const vault = new Vault({ store, key: 's', cipher: null });
  const toolDeps = { store: leads, email: { accounts: { list: () => [] }, campaigns: { list: () => [] } }, outreach: () => null, waAccounts: () => [], search: { status: () => ({ running: false }), pool: () => [] }, plan: () => ({ state: 'active' }), version: 'test' };
  return { store, vault, leads, make: (base) => createAI({ store, vault, toolDeps, bases: { claude: base } }) };
}

test('how Claude is reached: Anthropic key, else OpenRouter with the Claude model chosen in Settings', () => {
  const w = world();
  const ai = w.make();
  assert.equal(ai.mode.ready(), false, 'no key: no Claude');
  ai.saveKey('sk-or-v1-test00000000000000000000', 'openrouter');
  assert.deepEqual(ai.mode.route(), { provider: 'OpenRouter', via: 'OpenRouter', model: 'anthropic/claude-opus-5.5' }, 'Opus by default');
  ai.setEmailModel('anthropic/claude-sonnet-5.5');
  assert.equal(ai.mode.route().model, 'anthropic/claude-sonnet-5.5', 'the model chosen in Settings');
  ai.saveKey(KEY, 'claude');
  assert.deepEqual(ai.mode.route(), { provider: 'Claude', via: 'Anthropic API', model: 'claude-sonnet-5-5' }, 'an Anthropic key is used first');
  assert.equal(ai.mode.opts().only, true, 'Claude or nothing (no silent stand-in)');
});

test('the assistant talks through Claude with the app’s tools; this turn’s reasoning sent back, earlier turns without it; deleting still waits for a yes', async (t) => {
  const api = await startAnthropic((body) => {
    const last = body.messages[body.messages.length - 1];
    const text = last.content.map((b) => b.text || '').join(' ');
    const results = last.content.filter((b) => b.type === 'tool_result');
    if (results.length) return message(`Done: ${results[0].content.slice(0, 80)}`);
    if (/how many leads/i.test(text)) return message([{ type: 'thinking', thinking: '', signature: 'T1' }, { type: 'tool_use', id: 'toolu_a', name: 'count_leads', input: { category: 'Cleaning' } }]);
    if (/delete/i.test(text)) return message([{ type: 'tool_use', id: 'toolu_d', name: 'delete_leads', input: { lead_ids: [1] } }]);
    return message('Ok.');
  });
  t.after(() => api.close());
  const w = world();
  const ai = w.make(api.url);
  ai.saveKey(KEY, 'claude');
  const r = await ai.operator.handle('app', 'How many leads in Cleaning?');
  assert.equal(r.ok, true, r.error);
  assert.match(r.reply, /Done: \{"ok":true,"count":1/);
  const [first, second] = api.calls.map((c) => c.body);
  assert.ok(first.tools.length > 50 && first.tools.some((x) => x.name === 'search_leads') && first.tools.some((x) => x.name === 'campaign_report'), 'Claude has the app’s tools');
  assert.equal(first.model, 'claude-opus-5-5');
  assert.equal(second.messages.at(-2).content[0].type, 'thinking', 'this turn: Claude’s blocks sent back unchanged');
  assert.equal(second.system, first.system, 'the same system message for every round of a turn');
  await ai.operator.handle('app', 'Thanks');
  assert.ok(!api.calls.at(-1).body.messages.some((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'thinking')), 'earlier turns go back without thinking');
  const del = await ai.operator.handle('app', 'Delete lead 1');
  assert.ok(del.pending, 'waits for the user’s yes');
  assert.equal(w.leads.listLeads({}).length, 1);
});

test('emails and WhatsApp messages by Claude from the campaign prompt and the lead’s details; analysis kept; follow-ups see the earlier messages', async (t) => {
  const api = await startAnthropic((body) => {
    const sys = body.system || '';
    if (sys === RULES_SYSTEM) return message(JSON.stringify({ signoff: 'Best,\nMahi', greeting_named: 'Hi {first_name},', greeting_unnamed: 'Hello there,', required_lines: ['At MahiVirtual, we can help your business with:'], bullets: { min: 2, max: 4 }, questions: { min: 1, max: 1 }, words: { min: 100, max: 140 }, mention_business: true }));
    if (/WhatsApp/.test(sys) && /follow-up 1/.test(sys)) return message(JSON.stringify({ analysis: { summary: 'Commercial cleaner in Preston.', needs: ['bookings'], angle: 'admin load' }, message: 'Hi Sarah, just checking you saw my note about admin help for Evolve. Worth a quick chat?' }));
    if (/WhatsApp/.test(sys)) return message(JSON.stringify({ analysis: { summary: 'Commercial cleaner in Preston.', needs: ['bookings'], angle: 'admin load' }, message: 'Hi Sarah, saw Evolve keeps Preston offices spotless. We take bookings and emails off small teams. Open to a quick chat?' }));
    return message(JSON.stringify({ analysis: { summary: 'Commercial cleaning company serving offices in Preston.', needs: ['booking management', 'client email replies'], angle: 'a small team buried in admin' }, subject: 'Admin help for Evolve Commercial Cleaning', body: EMAIL }));
  });
  t.after(() => api.close());
  const w = world();
  const ai = w.make(api.url);
  ai.saveKey(KEY, 'claude');
  const lead = w.leads.listLeads({})[0];
  const business = { business_name: 'Evolve Commercial Cleaning Preston', contact_name: 'Sarah Jones', category: 'Cleaning', address: 'Preston, UK' };
  const out = await ai.writeEmail({ instructions: PROMPT, claude: true, leadId: lead.id, business, sender: { name: 'Info Axoraweb' } });
  assert.equal(out.subject, 'Admin help for Evolve Commercial Cleaning');
  assert.match(out.body, /^Hi Sarah,\n\n/);
  assert.match(out.body, /\n\nBest,\nMahi$/, 'the prompt’s sign-off, the wrong one removed');
  assert.ok(!/Info Axoraweb|Kind regards/.test(out.body));
  assert.deepEqual(out.problems, []);
  const req = api.calls.find((c) => c.body.output_config?.format?.schema?.required?.includes('subject')).body;
  assert.match(req.system, /At MahiVirtual, we can help your business with:/, 'the campaign prompt is Claude’s brief');
  assert.match(req.messages[0].content[0].text, /Evolve Commercial Cleaning Preston/, 'the lead’s details from Lead Finder');
  assert.ok(!/Info Axoraweb/.test(JSON.stringify(req)), 'the account name is not sent: the prompt has the sign-off');
  assert.equal(ai.mode.insight(lead.id).summary, 'Commercial cleaning company serving offices in Preston.');
  const wa = await ai.writeWhatsApp({ instructions: 'MahiVirtual: virtual assistants. Friendly, English.', claude: true, leadId: lead.id, business, sender: {} });
  assert.match(wa, /^Hi Sarah, saw Evolve/);
  assert.match(api.calls.at(-1).body.system, /MahiVirtual: virtual assistants/);
  const fu = await ai.writeWhatsApp({ instructions: 'MahiVirtual', claude: true, leadId: lead.id, business, sender: {}, followup: { step: 1, earlier: [wa] } });
  assert.match(fu, /just checking/);
  assert.deepEqual(JSON.parse(api.calls.at(-1).body.messages[0].content[0].text).earlier_messages, [wa]);
  assert.deepEqual(ai.mode.activities().map((e) => e.type).sort(), ['email', 'wa_followup', 'whatsapp']);
});

test('no way to reach Claude: Claude-written campaigns say so (nothing falls back silently)', async () => {
  const w = world();
  const ai = w.make();
  await assert.rejects(ai.writeEmail({ instructions: PROMPT, claude: true, business: { business_name: 'X' } }), (e) => e.code === 'no_key' && /OpenRouter key/.test(e.message));
  await assert.rejects(ai.writeWhatsApp({ instructions: 'x', claude: true, business: { business_name: 'X' } }), (e) => e.code === 'no_key');
});
