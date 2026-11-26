'use strict';

// Claude through the Anthropic API (official SDK), with the same chat()
// interface as the other providers (groq.js): OpenAI-style messages and
// tools in, { message: { content, tool_calls }, model, provider } out, so
// the assistant (operator.js), the email and WhatsApp writers and the
// app's tools work with Claude unchanged.
//
// - The key is the user's own (Settings > AI Integrations), kept in the
//   app's encrypted vault; it never reaches the window or the logs.
// - Thinking is adaptive (always on for the current models); its blocks
//   come back with the answer and are sent back unchanged for the turn in
//   progress (the assistant's tool loop). Earlier turns go back without
//   their thinking blocks, which the API allows (the app trims and
//   rebuilds older history, which a replayed thinking block would not survive).
// - opts.schema asks for structured output (JSON Schema).
// - Opus and Sonnet requests carry Anthropic's server-side fallback for
//   refusals (fallbacks: "default"); a refusal that remains is an error
//   ('refusal'), never an empty answer.

const Anthropic = require('@anthropic-ai/sdk');
const { GroqError } = require('./groq');

const SDK = Anthropic.default || Anthropic;
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const FALLBACK_MODELS = /^claude-(opus|sonnet)-5-5$/;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const THINKING = new Set(['thinking', 'redacted_thinking']);

// OpenAI-style messages -> { system, messages } for the Messages API.
function toClaude(list) {
  const system = [];
  const messages = [];
  let lastUser = -1;
  list.forEach((m, i) => {
    if (m.role === 'user') lastUser = i;
  });
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const prev = messages[messages.length - 1];
    if (prev && prev.role === role) prev.content.push(...blocks);
    else messages.push({ role, content: [...blocks] });
  };
  list.forEach((m, i) => {
    if (m.role === 'system') {
      if (!messages.length) system.push(String(m.content || ''));
      else push('user', [{ type: 'text', text: `[Lead Finder] ${m.content}` }]);
      return;
    }
    if (m.role === 'user') {
      push('user', [{ type: 'text', text: String(m.content ?? '') || '(empty)' }]);
      return;
    }
    if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: String(m.tool_call_id), content: String(m.content ?? '') }]);
      return;
    }
    if (m.role === 'assistant') {
      let blocks;
      if (Array.isArray(m._claude) && m._claude.length) {
        // The turn in progress: exactly as Claude sent it (thinking included).
        // Earlier turns: without their thinking blocks.
        blocks = i > lastUser ? m._claude : m._claude.filter((b) => !THINKING.has(b.type));
      } else {
        blocks = [];
        if (m.content) blocks.push({ type: 'text', text: String(m.content) });
        for (const c of m.tool_calls || []) {
          let input = {};
          try {
            input = JSON.parse(c.function?.arguments || '{}') || {};
          } catch {}
          blocks.push({ type: 'tool_use', id: String(c.id), name: String(c.function?.name), input });
        }
      }
      if (!blocks.length) blocks = [{ type: 'text', text: '(no reply)' }];
      push('assistant', blocks);
    }
  });
  return { system: system.join('\n\n'), messages };
}

const toolsOf = (specs) => (specs || []).map((t) => ({ name: t.function.name, description: String(t.function.description || '').slice(0, 4000), input_schema: t.function.parameters || { type: 'object', properties: {} } }));

// The SDK's typed errors -> the app's error codes.
function mapError(err, L) {
  if (err instanceof GroqError) return err;
  const msg = String(err?.message || err || '');
  if (err instanceof SDK.AuthenticationError || err instanceof SDK.PermissionDeniedError) return new GroqError(`${L} rejected the API key. Check it in Settings > AI Integrations.`, 'invalid_key', { status: err.status });
  if (err instanceof SDK.RateLimitError) return new GroqError(`${L}’s rate limit was reached. Try again in a minute.`, 'rate_limit', { status: 429 });
  if (err instanceof SDK.NotFoundError) return new GroqError(`${L} does not offer this model (${msg.slice(0, 200)}).`, 'model', { status: 404 });
  if (err instanceof SDK.BadRequestError) {
    if (/credit balance|billing|purchase credits/i.test(msg)) return new GroqError(`${L} says the account has no credits left. Add credits in the Claude Console (Plans & Billing).`, 'credits', { status: 400 });
    return new GroqError(`${L} refused the request: ${msg.slice(0, 300)}`, 'request', { status: 400 });
  }
  if (err instanceof SDK.APIConnectionError) return new GroqError(`${L} could not be reached. Check the internet connection.`, 'network');
  if (err instanceof SDK.APIError && (err.status >= 500 || err.status === 529)) return new GroqError(`${L} is having problems right now. Try again shortly.`, 'server', { status: err.status });
  if (err instanceof SDK.APIError) return new GroqError(`${L} refused the request: ${msg.slice(0, 300)}`, 'request', { status: err.status });
  return new GroqError(`${L} could not be reached. Check the internet connection.`, 'network');
}

class Claude {
  // key() -> the Anthropic API key or null; model() -> the chosen model id;
  // base: the API address (tests only).
  constructor({ key, model = () => MODELS[0], base, log = () => {}, timeout = 180_000 }) {
    Object.assign(this, { key, chosen: model, base, log, timeout });
    this.models = MODELS;
  }

  get label() {
    return 'Claude';
  }

  get model() {
    return this.chosen();
  }

  configured() {
    return Boolean(this.key());
  }

  accepts(model) {
    return /^claude-/.test(String(model || ''));
  }

  client(key = this.key()) {
    if (!key) throw new GroqError('No Claude (Anthropic) API key is saved. Add it in Settings > AI Integrations.', 'no_key');
    return new SDK({ apiKey: key, ...(this.base ? { baseURL: this.base } : {}), maxRetries: 2, timeout: this.timeout });
  }

  // The key and the model, checked without a paid request: { ok, model, error }.
  async test(key = this.key()) {
    try {
      const m = await this.client(key).models.retrieve(this.model);
      return { ok: true, model: m.id };
    } catch (err) {
      const e = mapError(err, this.label);
      return { ok: false, error: e.message, code: e.code };
    }
  }

  // opts: { model, maxTokens, reasoning ('low'|'medium'|'high'), schema }.
  async chat(messages, tools, opts = {}) {
    const model = opts.model && this.accepts(opts.model) ? opts.model : this.model;
    const { system, messages: msgs } = toClaude(messages);
    const effort = ['low', 'medium', 'high'].includes(opts.reasoning) ? opts.reasoning : 'medium';
    const params = {
      model,
      // Thinking counts toward max_tokens: room for it besides the answer.
      max_tokens: Math.max(8000, Number(opts.maxTokens) || 0),
      ...(system ? { system } : {}),
      messages: msgs,
      ...(tools?.length ? { tools: toolsOf(tools) } : {}),
      output_config: { effort, ...(opts.schema ? { format: { type: 'json_schema', schema: opts.schema } } : {}) },
    };
    const withFallback = FALLBACK_MODELS.test(model);
    let res;
    try {
      const c = this.client();
      res = withFallback ? await c.beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' }) : await c.messages.create(params);
    } catch (err) {
      throw mapError(err, this.label);
    }
    if (res.stop_reason === 'refusal') throw new GroqError(`Claude declined this request${res.stop_details?.category ? ` (${res.stop_details.category})` : ''}.`, 'refusal');
    const content = Array.isArray(res.content) ? res.content : [];
    const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const calls = content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
    if (!text && !calls.length) throw new GroqError(res.stop_reason === 'max_tokens' ? 'Claude ran out of room for its answer.' : 'Claude returned an empty answer.', 'empty');
    return { message: { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}), _claude: content }, model: res.model || model, provider: this.label, usage: res.usage };
  }
}

module.exports = { Claude, MODELS, toClaude, mapError };
