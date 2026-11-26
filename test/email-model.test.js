'use strict';
// The model that writes campaign emails (Settings > AI Integrations): a
// Claude model through OpenRouter for emails only (the assistant keeps its
// models), a small token limit, a fallback that is reported (not hidden);
// and the email's design: bold phrases, a clean list, the closing question
// highlighted, a plain-text version without marks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAI } = require('../src/ai/service');
const { Vault } = require('../src/main/vault');
const { compose } = require('../src/email/campaigns');
const R = require('../src/ai/email-rules');

const PROMPT = fs.readFileSync(path.join(__dirname, 'fixtures', 'mahi-prompt.txt'), 'utf8').replace(/\r\n/g, '\n');
const EMAIL = `Hello there,
I noticed Evolve Commercial Cleaning Preston provides commercial cleaning across Preston. Busy cleaning teams often lose hours to bookings, client emails and paperwork, which pulls attention away from the sites themselves and from winning new contracts in the area.

At MahiVirtual, we can help your business with:
- **Admin support** to keep paperwork and rotas organised
- **Appointment and calendar scheduling** so no cleaning visit is missed
- **Email and inbox management** so client requests get quick replies
Our assistants fit around the way your team already works, so you stay focused on clients and quality.
Would you be open to a short call next week?

Kind regards,
Mahi`;

function makeAI({ groq = true, openrouter = true, answer }) {
  const m = new Map();
  const store = { getState: (k) => m.get(k), setState: (k, v) => m.set(k, v) };
  const vault = new Vault({ store, key: 's', cipher: null });
  if (groq) vault.set('groq', 'gsk_test0000000000000000000000');
  if (openrouter) vault.set('openrouter', 'sk-or-v1-test000000000000000000');
  store.setState('ai.main', 'groq');
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ host: new URL(url).host, model: body.model, max: body.max_tokens ?? body.max_completion_tokens });
    const sys = body.messages[0].content;
    if (sys === R.RULES_SYSTEM) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { role: 'assistant', content: '{}' } }] }) };
    return answer(body, url);
  };
  return { ai: createAI({ store, vault, toolDeps: { email: null, files: null, store: null }, fetchImpl }), calls, store };
}
const ok = (content) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }) });

test('a Claude model writes the emails through OpenRouter, with a small token limit; the assistant keeps its models', async () => {
  const { ai, calls } = makeAI({ answer: () => ok(JSON.stringify({ subject: 'Support for Evolve Commercial Cleaning Preston', body: EMAIL })) });
  assert.equal(ai.view().emailModel, 'auto');
  assert.equal(ai.setEmailModel('anthropic/claude-sonnet-5.5').ok, true);
  assert.equal(ai.setEmailModel('openai/anything').ok, false, 'only the listed models');
  const r = await ai.writeEmail({ instructions: PROMPT, business: { business_name: 'Evolve Commercial Cleaning Preston', category: 'Commercial cleaning service', address: 'Preston, UK' } });
  const writes = calls.filter((c) => c.max !== 1500 || true).slice(-1)[0];
  assert.equal(writes.host, 'openrouter.ai', 'OpenRouter first, although Groq is the main AI');
  assert.equal(writes.model, 'anthropic/claude-sonnet-5.5');
  assert.equal(writes.max, 1500);
  assert.ok(calls.every((c) => c.model === 'anthropic/claude-sonnet-5.5'), 'the prompt’s rules are read with it too');
  assert.match(r.body, /^Hello there,\n\nI noticed/, 'a blank line after the greeting');
  assert.match(r.body, /- \*\*Admin support\*\* to keep/, 'bold kept');
  assert.match(r.body, /\n\nBest,\nMahi$/);
  assert.equal(ai.view().emailModelLast.used, 'anthropic/claude-sonnet-5.5');
  assert.equal(ai.view().emailModelLast.problem, null);
  // The assistant's own model is unchanged.
  assert.equal(ai.apis.openrouter.model, 'openai/gpt-4o-mini');
});

test('no OpenRouter key: Claude cannot be chosen; a failing Claude call falls back and says why', async () => {
  const noKey = makeAI({ openrouter: false, answer: () => ok('{}') });
  const r = noKey.ai.setEmailModel('anthropic/claude-haiku-5.5');
  assert.equal(r.ok, false);
  assert.match(r.error, /OpenRouter API key/);

  const { ai, calls } = makeAI({
    answer: (body) =>
      body.model.startsWith('anthropic/')
        ? { ok: false, status: 402, headers: { get: () => null }, json: async () => ({ error: { message: 'This request requires more credits, or fewer max_tokens.' } }) }
        : ok(JSON.stringify({ subject: 'Support for Evolve', body: EMAIL })),
  });
  ai.setEmailModel('anthropic/claude-sonnet-5.5');
  const out = await ai.writeEmail({ instructions: PROMPT, business: { business_name: 'Evolve Commercial Cleaning Preston' } });
  assert.match(out.body, /Best,\nMahi$/, 'still written');
  assert.ok(calls.some((c) => c.host === 'api.groq.com'), 'by the other provider');
  const last = ai.view().emailModelLast;
  assert.equal(last.wanted, 'anthropic/claude-sonnet-5.5');
  assert.notEqual(last.used, 'anthropic/claude-sonnet-5.5');
  assert.match(last.problem, /no credits left/);
});

test('the email’s design: bold, a clean list, the closing question highlighted; plain text without marks', () => {
  const m = compose({ subject: 'Support for Evolve', body: EMAIL.replace('Kind regards,\nMahi', 'Best,\nMahi') }, {});
  const html = m.html;
  assert.match(html, /<p style="margin:0 0 14px">Hello there,<\/p>/, 'the greeting on its own');
  assert.match(html, /<ul style="[^"]*"><li style="[^"]*"><strong style="[^"]*">Admin support<\/strong> to keep paperwork and rotas organised<\/li>/);
  assert.equal((html.match(/<li /g) || []).length, 3);
  assert.match(html, /<p style="[^"]*">Our assistants fit around[^<]*<br>Would you be open to a short call next week\?<\/p>/, 'the text after the list is kept');
  assert.match(html, /background:#f3f6ff[^>]*>Our assistants[^<]*<br>Would you be open/, 'the call to action highlighted');
  assert.ok(!/\*\*/.test(html));
  assert.ok(!/\*\*/.test(m.text), 'plain text has no ** marks');
  assert.match(m.text, /- Admin support to keep paperwork/);
  // A user's own template without marks looks as before (paragraphs).
  const plain = compose({ subject: 's', body: 'Hello {name},\n\nWe build websites.\n\nBest,\nAli' }, { name: 'Zahid' });
  assert.match(plain.html, /<p style="margin:0 0 14px">Hello Zahid,<\/p>\n<p style="margin:0 0 14px">We build websites\.<\/p>/);
});
