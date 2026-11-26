'use strict';
// Claude through the Anthropic API (src/ai/claude.js, official SDK) against a
// local stand-in: the request it sends (model, system, tools, effort,
// structured output, refusal fallback), the tool loop (results in one user
// message; Claude's blocks of the turn in progress sent back unchanged,
// earlier turns without their thinking blocks), the key check, and errors
// mapped to the app's codes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Claude, toClaude } = require('../src/ai/claude');
const { startAnthropic, message, KEY } = require('./fake-anthropic');

const spec = (name) => ({ type: 'function', function: { name, description: `${name} tool`, parameters: { type: 'object', properties: { x: { type: 'integer' } }, additionalProperties: false } } });

test('one request: model, system, tools, effort, structured output; Opus and Sonnet carry the refusal fallback', async (t) => {
  const api = await startAnthropic(() => message([{ type: 'thinking', thinking: '', signature: 'sig1' }, { type: 'text', text: '{"subject":"Hi","body":"Hello"}' }]));
  t.after(() => api.close());
  let model = 'claude-opus-5-5';
  const c = new Claude({ key: () => KEY, base: api.url, model: () => model });
  const r = await c.chat([{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Write.' }], [spec('get_status')], { reasoning: 'low', maxTokens: 1500, schema: { type: 'object', properties: { subject: { type: 'string' } }, required: ['subject'], additionalProperties: false } });
  assert.equal(r.message.content, '{"subject":"Hi","body":"Hello"}');
  assert.equal(r.provider, 'Claude');
  assert.equal(r.message._claude[0].type, 'thinking', 'Claude’s blocks are kept for the turn');
  const { body, headers, path } = api.calls[0];
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.system, 'Be brief.');
  assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: 'Write.' }] }]);
  assert.deepEqual(body.tools, [{ name: 'get_status', description: 'get_status tool', input_schema: { type: 'object', properties: { x: { type: 'integer' } }, additionalProperties: false } }]);
  assert.equal(body.output_config.effort, 'low');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.ok(body.max_tokens >= 8000, 'room for thinking');
  assert.equal(body.thinking, undefined, 'adaptive thinking by default (no thinking field)');
  assert.equal(body.temperature, undefined);
  assert.equal(body.fallbacks, 'default');
  assert.match(headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(path, '/v1/messages');
  assert.equal(body.betas, undefined, 'the beta goes in the header only');
  model = 'claude-haiku-5-5';
  await c.chat([{ role: 'user', content: 'Hi' }], []);
  assert.equal(api.calls[1].body.fallbacks, undefined, 'Haiku: no server-side fallback');
  assert.equal(api.calls[1].body.model, 'claude-haiku-5-5');
  assert.equal(c.accepts('claude-sonnet-5-5'), true);
  assert.equal(c.accepts('openai/gpt-4o-mini'), false);
});

test('the tool loop: results in one user message; this turn’s blocks unchanged, earlier turns without thinking', () => {
  const think = { type: 'thinking', thinking: '', signature: 'S' };
  const earlier = [think, { type: 'text', text: 'Done before.' }];
  const now = [think, { type: 'tool_use', id: 'toolu_1', name: 'a', input: { x: 1 } }, { type: 'tool_use', id: 'toolu_2', name: 'b', input: {} }];
  const { system, messages } = toClaude([
    { role: 'system', content: 'Rules.' },
    { role: 'system', content: 'State.' },
    { role: 'user', content: 'First' },
    { role: 'assistant', content: 'Done before.', _claude: earlier },
    { role: 'user', content: 'Second' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_1' }, { id: 'toolu_2' }], _claude: now },
    { role: 'tool', tool_call_id: 'toolu_1', content: '{"ok":true}' },
    { role: 'tool', tool_call_id: 'toolu_2', content: '{"ok":false}' },
  ]);
  assert.equal(system, 'Rules.\n\nState.');
  assert.deepEqual(messages[1], { role: 'assistant', content: [{ type: 'text', text: 'Done before.' }] }, 'earlier turn: thinking left out');
  assert.deepEqual(messages[3].content, now, 'turn in progress: exactly as Claude sent it');
  assert.deepEqual(messages[4], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":true}' }, { type: 'tool_result', tool_use_id: 'toolu_2', content: '{"ok":false}' }] }, 'all results in one message');
  // History from other providers (no Claude blocks): tool calls rebuilt.
  const plain = toClaude([{ role: 'user', content: 'x' }, { role: 'assistant', content: 'Ok', tool_calls: [{ id: 'call_9', function: { name: 'c', arguments: '{"x":2}' } }] }, { role: 'tool', tool_call_id: 'call_9', content: 'r' }]);
  assert.deepEqual(plain.messages[1].content, [{ type: 'text', text: 'Ok' }, { type: 'tool_use', id: 'call_9', name: 'c', input: { x: 2 } }]);
});

test('answers with tool calls come back as the app expects', async (t) => {
  const api = await startAnthropic(() => message([{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'toolu_7', name: 'count_leads', input: { category: 'Real Estate' } }]));
  t.after(() => api.close());
  const c = new Claude({ key: () => KEY, base: api.url });
  const r = await c.chat([{ role: 'user', content: 'How many?' }], [spec('count_leads')]);
  assert.equal(r.message.content, 'Checking.');
  assert.deepEqual(r.message.tool_calls, [{ id: 'toolu_7', type: 'function', function: { name: 'count_leads', arguments: '{"category":"Real Estate"}' } }]);
});

test('errors: wrong key, no credits, refusal, empty, unreachable; the key check is free', async (t) => {
  let mode = 'ok';
  const api = await startAnthropic(() => {
    if (mode === 'credits') return { status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } } };
    if (mode === 'refusal') return message([], { stop: 'refusal' });
    if (mode === 'empty') return message([]);
    if (mode === 'notfound') return { status: 404, json: { type: 'error', error: { type: 'not_found_error', message: 'model: claude-x' } } };
    return message('ok');
  });
  t.after(() => api.close());
  const c = new Claude({ key: () => KEY, base: api.url });
  assert.deepEqual(await c.test(), { ok: true, model: 'claude-opus-5-5' });
  assert.equal(api.calls.length, 0, 'the key check sends no message');
  const wrong = new Claude({ key: () => 'sk-ant-wrong-key-00000000000000', base: api.url });
  const bad = await wrong.test();
  assert.equal(bad.code, 'invalid_key');
  await assert.rejects(wrong.chat([{ role: 'user', content: 'x' }], []), (e) => e.code === 'invalid_key');
  mode = 'credits';
  await assert.rejects(c.chat([{ role: 'user', content: 'x' }], []), (e) => e.code === 'credits' && /Plans & Billing/.test(e.message));
  mode = 'refusal';
  await assert.rejects(c.chat([{ role: 'user', content: 'x' }], []), (e) => e.code === 'refusal');
  mode = 'empty';
  await assert.rejects(c.chat([{ role: 'user', content: 'x' }], []), (e) => e.code === 'empty');
  mode = 'notfound';
  await assert.rejects(c.chat([{ role: 'user', content: 'x' }], []), (e) => e.code === 'model');
  const none = new Claude({ key: () => null });
  await assert.rejects(none.chat([{ role: 'user', content: 'x' }], []), (e) => e.code === 'no_key');
  const offline = new Claude({ key: () => KEY, base: 'http://127.0.0.1:9', timeout: 2000 });
  await assert.rejects(offline.chat([{ role: 'user', content: 'x' }], []), (e) => e.code === 'network');
});
