'use strict';
// The Groq client against a local server that answers like Groq's
// OpenAI-compatible API: key check, tool calls, retired models, rate limits,
// and errors that never carry the key.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Groq, MODELS } = require('../src/ai/groq');

const KEY = 'gsk_TESTKEY1234567890abcdefghij';

async function fakeGroq(t, handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const r = { method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null };
      seen.push(r);
      const out = handler(r) || { status: 404, json: { error: { message: 'not found' } } };
      res.writeHead(out.status || 200, { 'content-type': 'application/json', ...(out.headers || {}) });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return { base: `http://127.0.0.1:${server.address().port}/openai/v1`, seen };
}

test('Test connection: a good key and an available model; a rejected key is reported without the key', async (t) => {
  const g = await fakeGroq(t, (r) => {
    if (r.url === '/openai/v1/models') return r.auth === `Bearer ${KEY}` ? { json: { data: [{ id: 'openai/gpt-oss-20b' }, { id: 'whisper-large-v3' }] } } : { status: 401, json: { error: { message: `Invalid API Key ${r.auth}`, code: 'invalid_api_key' } } };
  });
  const ok = await new Groq({ key: () => KEY, base: g.base }).test();
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.model, 'openai/gpt-oss-20b', 'the first available model in the backend list');
  // None of the backend's models offered (retired): another chat model, remembered.
  let saved = null;
  const g2 = await fakeGroq(t, (r) => (r.url === '/openai/v1/models' ? { json: { data: [{ id: 'whisper-large-v3' }, { id: 'qwen/qwen3.6-27b' }] } } : null));
  const other = await new Groq({ key: () => KEY, base: g2.base, setFallback: (m) => (saved = m) }).test();
  assert.equal(other.model, 'qwen/qwen3.6-27b');
  assert.equal(saved, 'qwen/qwen3.6-27b');
  const bad = await new Groq({ key: () => 'gsk_WRONGKEY99999999999999', base: g.base }).test();
  assert.equal(bad.ok, false);
  assert.match(bad.error, /rejected the API key/);
  assert.ok(!bad.error.includes('WRONGKEY'));
  const none = await new Groq({ key: () => null, base: g.base }).test();
  assert.match(none.error, /No Groq API key/);
});

test('Chat with tools: the request carries the tools; a retired model moves on to the next one; tool calls come back', async (t) => {
  const g = await fakeGroq(t, (r) => {
    if (r.url !== '/openai/v1/chat/completions') return null;
    if (r.body.model === MODELS[0]) return { status: 404, json: { error: { message: `The model ${MODELS[0]} does not exist`, code: 'model_not_found' } } };
    return { json: { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'x1', type: 'function', function: { name: 'get_status', arguments: '{}' } }] } }] } };
  });
  const groq = new Groq({ key: () => KEY, base: g.base });
  const { message, model } = await groq.chat([{ role: 'user', content: 'status batao' }], [{ type: 'function', function: { name: 'get_status', parameters: { type: 'object', properties: {} } } }]);
  assert.equal(model, MODELS[1]);
  assert.equal(message.tool_calls[0].function.name, 'get_status');
  const sent = g.seen.at(-1).body;
  assert.equal(sent.tools[0].function.name, 'get_status');
  assert.equal(sent.tool_choice, 'auto');
  assert.equal(groq.model, MODELS[1], 'remembered for the next request');
});

test('Rate limit and server errors: clear messages, a retry for a bad tool call, never the key', async (t) => {
  let n = 0;
  const g = await fakeGroq(t, (r) => {
    if (r.url !== '/openai/v1/chat/completions') return null;
    n++;
    if (r.body.messages[0].content === 'rate') return { status: 429, headers: { 'retry-after': '7' }, json: { error: { message: `Rate limit for key ${KEY}` } } };
    if (n === 2) return { status: 400, json: { error: { message: 'Failed to call a function', code: 'tool_use_failed' } } };
    return { json: { choices: [{ message: { role: 'assistant', content: 'ok' } }] } };
  });
  const groq = new Groq({ key: () => KEY, base: g.base, models: ['m1'] });
  await assert.rejects(groq.chat([{ role: 'user', content: 'rate' }]), (err) => err.code === 'rate_limit' && err.retryAfter === 7 && !err.message.includes(KEY));
  const r = await groq.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(r.message.content, 'ok', 'retried once after an invalid tool call');
  const down = new Groq({ key: () => KEY, base: 'http://127.0.0.1:9/openai/v1', models: ['m1'] });
  await assert.rejects(down.chat([{ role: 'user', content: 'hi' }]), (err) => err.code === 'network');
});

const { OpenRouter, Providers } = require('../src/ai/groq');
const OR_KEY = 'sk-or-v1-TESTKEY0000000000000000000000';

test('OpenRouter: key checked on /key, models that can call tools; chat with its headers; no credits reported clearly', async (t) => {
  const g = await fakeGroq(t, (r) => {
    if (r.url === '/openai/v1/key') return r.auth === `Bearer ${OR_KEY}` ? { json: { data: { label: 'x' } } } : { status: 401, json: { error: { message: 'No auth credentials found', code: 401 } } };
    if (r.url === '/openai/v1/models?supported_parameters=tools') return { json: { data: [{ id: 'openai/gpt-4o-mini' }, { id: 'meta/llama' }] } };
    if (r.url === '/openai/v1/chat/completions') {
      if (r.body.messages[0].content === 'broke') return { status: 402, json: { error: { message: 'Insufficient credits', code: 402 } } };
      return { json: { choices: [{ message: { role: 'assistant', content: `ok from ${r.body.model}` } }] } };
    }
    return null;
  });
  const or = new OpenRouter({ key: () => OR_KEY, base: g.base });
  const ok = await or.test();
  assert.deepEqual(ok, { ok: true, model: 'openai/gpt-4o-mini' });
  const bad = await new OpenRouter({ key: () => 'sk-or-v1-WRONG000000000000000000', base: g.base }).test();
  assert.match(bad.error, /OpenRouter rejected the API key/);
  const r = await or.chat([{ role: 'user', content: 'hi' }], []);
  assert.equal(r.message.content, 'ok from openai/gpt-4o-mini');
  assert.equal(r.provider, 'OpenRouter');
  await assert.rejects(or.chat([{ role: 'user', content: 'broke' }]), (err) => err.code === 'credits' && /no credits/.test(err.message));
});

test('Main AI with a stand-in: Groq rate-limited, OpenRouter answers; the main one can be switched; one key alone works', async (t) => {
  const g = await fakeGroq(t, (r) => {
    if (r.url !== '/openai/v1/chat/completions') return null;
    if (r.auth === `Bearer ${KEY}`) return { status: 429, json: { error: { message: 'Rate limit' } } };
    return { json: { choices: [{ message: { role: 'assistant', content: 'from openrouter' } }] } };
  });
  let groqKey = KEY;
  const groq = new Groq({ key: () => groqKey, base: g.base, models: ['m'] });
  const or = new OpenRouter({ key: () => OR_KEY, base: g.base, models: ['m'] });
  let main = 'Groq';
  const ai = new Providers([groq, or], () => main);
  assert.equal((await ai.chat([{ role: 'user', content: 'x' }])).provider, 'OpenRouter', 'Groq failed: OpenRouter took over');
  main = 'OpenRouter';
  assert.equal(ai.ordered()[0].label, 'OpenRouter');
  groqKey = null;
  assert.deepEqual(ai.ordered().map((p) => p.label), ['OpenRouter']);
  assert.equal(ai.configured(), true);
});

test('The email writer: instructions and business facts go to the AI; its JSON answer (even inside a code block) becomes subject and body', async () => {
  const { createAI } = require('../src/ai/service');
  const { Vault } = require('../src/main/vault');
  const m = new Map();
  const store = { getState: (k) => m.get(k), setState: (k, v) => m.set(k, v) };
  const vault = new Vault({ store, key: 's', cipher: null });
  vault.set('groq', KEY);
  let sent = null;
  const fetchImpl = async (url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { role: 'assistant', content: '```json\n{"subject": "A website for Zahid Properties", "body": "Hi Zahid,\\n\\nI noticed Zahid Properties has no website yet..."}\n```' } }] }) };
  };
  const ai = createAI({ store, vault, toolDeps: { email: null, files: null, store: null }, fetchImpl });
  const out = await ai.writeEmail({ instructions: 'We build websites. Friendly, English.', subject: '', sender: { name: 'Ali', email: 'ali@axora.pk' }, business: { business_name: 'Zahid Properties', website: 'no website found', address: 'DHA Lahore' } });
  assert.equal(out.subject, 'A website for Zahid Properties');
  assert.match(out.body, /^Hi Zahid,\n\nI noticed/);
  const userMsg = JSON.parse(sent.messages[1].content);
  assert.equal(userMsg.business.address, 'DHA Lahore');
  assert.ok(sent.messages[0].content.includes('We build websites. Friendly, English.'), 'the prompt is the system message');
  assert.equal(userMsg.instructions, undefined, 'and only the facts are the user message');
  assert.match(sent.messages[0].content, /Never invent/);
  assert.equal(sent.tools, undefined, 'no tools for writing');
});

test('The email writer follows the prompt: it is the brief (first, in the system message), placeholders left by the AI are filled from the facts, a broken answer is asked for once more', async () => {
  const { createAI } = require('../src/ai/service');
  const { Vault } = require('../src/main/vault');
  const m = new Map();
  const store = { getState: (k) => m.get(k), setState: (k, v) => m.set(k, v) };
  const vault = new Vault({ store, key: 's', cipher: null });
  vault.set('groq', KEY);
  const bodies = [];
  const answers = ['Sure! Here is your email: Subject - Hello', JSON.stringify({ subject: 'Website for [Business Name]', body: 'Assalam o Alaikum {name},\n\n[Business Name] ki website nahi hai. Hum 25,000 mein bana dete hain.\n\nAli' })];
  const { RULES_SYSTEM } = require('../src/ai/email-rules');
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    // The prompt's rules are read first (this one has none to check).
    const rules = body.messages[0].content === RULES_SYSTEM;
    if (!rules) bodies.push(body);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { role: 'assistant', content: rules ? '{"signoff": null}' : answers.shift() } }] }) };
  };
  const ai = createAI({ store, vault, toolDeps: { email: null, files: null, store: null }, fetchImpl });
  const prompt = 'Roman Urdu mein likho. Template:\nAssalam o Alaikum {name},\n[Business Name] ki website nahi hai. Hum 25,000 mein bana dete hain.\nAli';
  const out = await ai.writeEmail({ instructions: prompt, sender: { name: 'Ali' }, business: { business_name: 'Zahid Properties', contact_name: 'Zahid Khan' } });
  assert.equal(bodies.length, 2, 'the unusable first answer was asked for again');
  const sys = bodies[0].messages[0].content;
  assert.ok(sys.indexOf(prompt) > 0 && sys.indexOf(prompt) < sys.indexOf('Notes from the app'), 'the prompt comes before the app’s notes');
  assert.match(sys, /keep its structure and wording/);
  assert.equal(bodies[0].max_completion_tokens, 4000);
  assert.equal(bodies[0].reasoning_effort, 'medium', 'gpt-oss thinks a little more for emails');
  assert.equal(out.subject, 'Website for Zahid Properties');
  assert.equal(out.body, 'Assalam o Alaikum Zahid,\n\nZahid Properties ki website nahi hai. Hum 25,000 mein bana dete hain.\n\nAli');
});
