'use strict';

// The assistant's AI providers: Groq and OpenRouter, both OpenAI-compatible
// chat APIs with tool (function) calling. The models are chosen here, not
// in the window: MODELS is tried in order (a model a provider retires or
// does not offer moves on to the next one), and LEAD_FINDER_GROQ_MODEL /
// LEAD_FINDER_OPENROUTER_MODEL can put another one first. API keys are read
// from the vault for each request and never logged or returned; error
// messages are rewritten so they cannot carry them.

const TIMEOUT = 60_000;

class GroqError extends Error {
  constructor(message, code, { status = 0, retryAfter = 0 } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// Anything that looks like a key is removed from text that leaves this module.
const scrub = (s) =>
  String(s || '')
    .replace(/gsk_[A-Za-z0-9]{8,}/g, '[key]')
    .replace(/sk-or-[A-Za-z0-9-]{8,}/g, '[key]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [key]')
    .slice(0, 300);

class ChatAPI {
  // key() -> the API key or null; fetchImpl: fetch (replaceable in tests);
  // base: the API address (tests only); fallback() / setFallback(id):
  // another chat model the key offers, found by test() when none of the
  // models is available (kept in the app's settings).
  constructor({ key, fetchImpl = fetch, base, models, log = () => {}, fallback = () => null, setFallback = () => {} }) {
    Object.assign(this, { key, fetchImpl, base: String(base || this.constructor.API).replace(/\/$/, ''), log, setFallback });
    const first = process.env[this.constructor.MODEL_ENV];
    const extra = fallback();
    this.models = [...new Set([...(first ? [first] : []), ...(models || this.constructor.MODELS), ...(extra ? [extra] : [])])];
    this.model = this.models[0];
  }

  get label() {
    return this.constructor.LABEL;
  }

  configured() {
    return Boolean(this.key());
  }

  headers(key) {
    return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  }

  async request(path, { method = 'GET', body = null, key = this.key(), timeout = TIMEOUT, auth = true } = {}) {
    const L = this.label;
    if (auth && !key) throw new GroqError(`No ${L} API key is saved. Add it in Settings > AI.`, 'no_key');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: auth ? this.headers(key) : { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new GroqError(err?.name === 'AbortError' ? `${L} did not answer in time.` : `${L} could not be reached. Check the internet connection.`, 'network');
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {}
    if (res.ok && !data?.error) return data;
    const detail = scrub(data?.error?.message || '');
    const code = data?.error?.code || '';
    const status = res.ok ? Number(data?.error?.code) || 500 : res.status;
    if (status === 401 || status === 403) throw new GroqError(`${L} rejected the API key. Check it in Settings > AI.`, 'invalid_key', { status });
    if (status === 402) throw new GroqError(`${L} says the account has no credits left. Add credits on ${L}'s site.`, 'credits', { status });
    if (status === 429) throw new GroqError(`${L}’s rate limit was reached. Try again in a minute.`, 'rate_limit', { status, retryAfter: Number(res.headers?.get?.('retry-after')) || 0 });
    if (status === 404 || /model_not_found|decommissioned|does not exist|not a valid model|no endpoints found/i.test(`${code} ${detail}`)) throw new GroqError(`${L} does not offer this model (${detail || status}).`, 'model', { status });
    if (code === 'tool_use_failed') throw new GroqError('The AI produced an invalid action.', 'tool_use_failed', { status });
    if (status >= 500) throw new GroqError(`${L} is having problems right now. Try again shortly.`, 'server', { status });
    throw new GroqError(`${L} refused the request${detail ? `: ${detail}` : ''}.`, 'request', { status });
  }

  // The chat models the key can use (ids).
  async availableModels(key) {
    const list = await this.request('/models', { key, timeout: 20_000 });
    return (list?.data || []).map((m) => m.id);
  }

  // Checks a key (the saved one, or `key` before saving): { ok, model, error }.
  async test(key = this.key()) {
    try {
      const ids = new Set(await this.availableModels(key));
      let model = this.models.find((m) => ids.has(m)) || null;
      if (!model) {
        // Providers retire models: any other chat model the key offers.
        model = [...ids].find((id) => !this.constructor.NOT_CHAT.test(id)) || null;
        if (!model) return { ok: false, error: 'The key works, but no chat model is available to it.' };
        this.models.push(model);
        this.setFallback(model);
      }
      this.model = model;
      return { ok: true, model };
    } catch (err) {
      return { ok: false, error: err.message, code: err.code };
    }
  }

  // opts: { maxTokens, reasoning ('low' | 'medium' | 'high', for models that think first) }.
  body(model, messages, tools, opts = {}) {
    return { model, messages, temperature: 0.2, max_tokens: opts.maxTokens || 1200, ...(tools?.length ? { tools, tool_choice: 'auto' } : {}) };
  }

  // One chat completion: { message: { content, tool_calls }, model, provider }.
  async chat(messages, tools, opts = {}) {
    let lastErr = null;
    for (const model of this.models.slice(Math.max(0, this.models.indexOf(this.model)))) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const data = await this.request('/chat/completions', { method: 'POST', body: this.body(model, messages, tools, opts) });
          this.model = model;
          const message = data?.choices?.[0]?.message;
          if (!message) throw new GroqError(`${this.label} returned an empty answer.`, 'empty');
          return { message, model, provider: this.label };
        } catch (err) {
          lastErr = err;
          if (err.code === 'model') break; // the next model
          if (err.code === 'tool_use_failed' || err.code === 'server' || err.code === 'empty') continue; // once more
          throw err;
        }
      }
    }
    throw lastErr || new GroqError(`${this.label} did not answer.`, 'empty');
  }
}

class Groq extends ChatAPI {
  static LABEL = 'Groq';
  static API = 'https://api.groq.com/openai/v1';
  static MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];
  static MODEL_ENV = 'LEAD_FINDER_GROQ_MODEL';
  // Not chat models (speech, safety classifiers): never picked as a fallback.
  static NOT_CHAT = /whisper|tts|orpheus|playai|guard|prompt-guard|safeguard|distil/i;

  body(model, messages, tools, opts = {}) {
    const { max_tokens, ...rest } = super.body(model, messages, tools, opts);
    return { ...rest, max_completion_tokens: max_tokens, ...(/gpt-oss/.test(model) ? { reasoning_effort: opts.reasoning || 'low' } : {}) };
  }
}

class OpenRouter extends ChatAPI {
  static LABEL = 'OpenRouter';
  static API = 'https://openrouter.ai/api/v1';
  // Models with dependable tool calling, cheapest first.
  static MODELS = ['openai/gpt-4o-mini', 'openai/gpt-4.1-mini', 'google/gemini-2.5-flash', 'openai/gpt-4o'];
  static MODEL_ENV = 'LEAD_FINDER_OPENROUTER_MODEL';
  static NOT_CHAT = /embed|whisper|tts|image|moderation|guard/i;

  headers(key) {
    return { ...super.headers(key), 'X-Title': 'Lead Finder' };
  }

  // The key is checked on its own (the model list needs none); then the
  // models that can call tools.
  async availableModels(key) {
    await this.request('/key', { key, timeout: 20_000 });
    const list = await this.request('/models?supported_parameters=tools', { timeout: 20_000, auth: false });
    return (list?.data || []).map((m) => m.id);
  }
}

// The main provider, with the other as a stand-in when it fails for a
// reason the other one does not share (limits, outages, a rejected key).
class Providers {
  // list: [ChatAPI]; main() -> label of the main one.
  constructor(list, main = () => list[0]?.label) {
    this.list = list;
    this.main = main;
  }

  ordered() {
    const m = this.main();
    return [...this.list].sort((a, b) => (b.label === m) - (a.label === m)).filter((p) => p.configured());
  }

  configured() {
    return this.list.some((p) => p.configured());
  }

  async chat(messages, tools, opts) {
    let lastErr = null;
    for (const p of this.ordered()) {
      try {
        return await p.chat(messages, tools, opts);
      } catch (err) {
        lastErr = err;
        if (!['rate_limit', 'server', 'network', 'invalid_key', 'credits', 'model', 'empty', 'no_key'].includes(err.code)) throw err;
      }
    }
    throw lastErr || new GroqError('No AI key is saved. Add one in Settings > AI.', 'no_key');
  }
}

const MODELS = Groq.MODELS;
module.exports = { Groq, OpenRouter, Providers, ChatAPI, GroqError, MODELS, scrub };
