'use strict';

// The AI assistant in the app: Groq and/or OpenRouter (the main one, the
// other as a stand-in), their keys (in the vault) and status, the operator
// and the window's calls. The window only ever learns whether a key is
// saved and whether it works, never the key.

const { Groq, OpenRouter, Providers } = require('./groq');
const { buildTools } = require('./tools');
const { Operator } = require('./operator');
const { extractAccounts } = require('../email/credentials');

// Per provider: where its status is kept and its key's name in the vault.
const PROVIDERS = {
  groq: { Class: Groq, statusKey: 'ai.settings', vaultName: 'groq', hint: 'it starts with gsk_' },
  openrouter: { Class: OpenRouter, statusKey: 'ai.openrouter', vaultName: 'openrouter', hint: 'it starts with sk-or-' },
};
const MAIN_KEY = 'ai.main';

// bases: { groq, openrouter } API addresses (tests only).
function createAI({ store, vault, toolDeps, log = () => {}, send = () => {}, fetchImpl, base, bases = {} }) {
  const status = (id) => ({ status: 'none', testedAt: null, error: null, ...(store.getState(PROVIDERS[id].statusKey) || {}) });
  const setStatus = (id, s) => store.setState(PROVIDERS[id].statusKey, { ...status(id), ...s });
  const apis = {};
  for (const [id, p] of Object.entries(PROVIDERS)) {
    apis[id] = new p.Class({ key: () => vault.get(p.vaultName), fetchImpl, base: (id === 'groq' ? base || bases.groq : bases[id]) || undefined, log, fallback: () => status(id).fallbackModel || null, setFallback: (m) => setStatus(id, { fallbackModel: m }) });
  }
  // The main AI: the one chosen, else whichever has a key (Groq first).
  const mainId = () => {
    const chosen = store.getState(MAIN_KEY);
    if (chosen && vault.has(PROVIDERS[chosen]?.vaultName)) return chosen;
    return Object.keys(PROVIDERS).find((id) => vault.has(PROVIDERS[id].vaultName)) || 'groq';
  };
  const ai = new Providers([apis.groq, apis.openrouter], () => apis[mainId()].label);
  const groq = apis.groq;
  const tools = buildTools(toolDeps);
  const statusTool = tools.find((t) => t.name === 'get_status');
  const operator = new Operator({
    groq: ai,
    tools,
    state: { get: (k) => store.getState(k), set: (k, v) => store.setState(k, v) },
    log,
    // A short live summary for the AI each turn (the same facts get_status gives).
    context: () => {
      const s = statusTool.run({});
      return JSON.stringify({ leads: s.leads, lead_search: s.lead_search?.running ? s.lead_search : 'none running', whatsapp_accounts: s.whatsapp_accounts, email_accounts: s.email_accounts, active_whatsapp_campaigns: s.whatsapp_campaigns, active_email_campaigns: s.email_campaigns, subscription: { state: s.subscription?.state, plan: s.subscription?.plan, days_left: s.subscription?.days_left } });
    },
    onEvent: (e) => send('ai:event', e),
    credentials: toolDeps.email?.addFromText ? (text) => toolDeps.email.addFromText(text) : null,
    redact: (text) => extractAccounts(text).redacted,
  });

  const providerView = (id) => {
    const s = status(id);
    const configured = vault.has(PROVIDERS[id].vaultName);
    return { configured, status: configured ? s.status : 'none', testedAt: configured ? s.testedAt : null, error: configured ? s.error : null };
  };
  // For the window: never the keys.
  const view = () => {
    const groqV = providerView('groq');
    const orV = providerView('openrouter');
    const main = mainId();
    const mv = main === 'groq' ? groqV : orV;
    return { configured: groqV.configured || orV.configured, status: mv.status, testedAt: mv.testedAt, error: mv.error, main, groq: groqV, openrouter: orV, persistent: vault.persistent };
  };
  const idOf = (p) => (PROVIDERS[p] ? p : 'groq');

  async function test(provider = 'groq') {
    const id = idOf(provider);
    const L = apis[id].label;
    if (!vault.has(PROVIDERS[id].vaultName)) return { ok: false, error: `Save your ${L} API key first.`, settings: view() };
    const r = await apis[id].test();
    setStatus(id, { status: r.ok ? 'connected' : 'failed', testedAt: Date.now(), error: r.ok ? null : r.error });
    log(`assistant: ${L} connection ${r.ok ? 'works' : `failed: ${r.error}`}`); // never the key
    return { ok: r.ok, error: r.ok ? null : r.error, settings: view() };
  }

  function saveKey(raw, provider = 'groq') {
    const id = idOf(provider);
    const L = apis[id].label;
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!key) {
      vault.delete(PROVIDERS[id].vaultName);
      setStatus(id, { status: 'none', testedAt: null, error: null });
      return { ok: true, settings: view() };
    }
    if (key.length < 20 || key.length > 300 || /\s/.test(key)) return { ok: false, error: `That does not look like a ${L} API key (${PROVIDERS[id].hint}).`, settings: view() };
    vault.set(PROVIDERS[id].vaultName, key);
    setStatus(id, { status: 'untested', testedAt: null, error: null });
    log(`assistant: ${L} API key saved`);
    return { ok: true, settings: view() };
  }

  function setMain(provider) {
    store.setState(MAIN_KEY, idOf(provider));
    return { ok: true, settings: view() };
  }

  // One personalised email: the user's instructions + the business's facts.
  // Resolves { subject, body } (plain text; the app adds the unsubscribe line).
  async function writeEmail({ instructions, subject = '', sender = {}, business = {} }) {
    const system = [
      'You write ONE personalised outreach email from the sender to one business, following the sender’s instructions (their offer, tone and language — write in the language of the instructions).',
      'Use the business facts given to make it specific and relevant (their category, area, whether they have a website, what they do). Never invent anything that is not in the facts or the instructions: no made-up names, numbers, reviews, prices or claims.',
      'Greet the contact by first name only if contact_name is given and looks like a person’s name; otherwise use a neutral greeting.',
      'Plain text only: no markdown, no placeholders like [Name], no subject line inside the body. 60 to 170 words. Sign off with the sender’s name if given.',
      'Do not add an unsubscribe line (the app adds one).',
      subject ? `Subject: use exactly this subject, filling {name} / {business} from the facts (drop a placeholder whose value is unknown): ${subject}` : 'Write a short, specific subject (at most 9 words, no clickbait, no ALL CAPS).',
      'Reply with JSON only: {"subject": "...", "body": "..."}',
    ].join('\n');
    const user = JSON.stringify({ instructions: String(instructions || '').slice(0, 4000), sender, business });
    const { message } = await ai.chat([{ role: 'system', content: system }, { role: 'user', content: user }], []);
    const text = String(message?.content || '');
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    let out = null;
    try {
      out = JSON.parse(json);
    } catch {}
    if (!out || typeof out.body !== 'string') throw Object.assign(new Error('the AI did not answer in the expected form'), { code: 'ai_empty' });
    return { subject: String(out.subject || subject || ''), body: out.body.replace(/\r\n/g, '\n') };
  }

  // One personalised WhatsApp message: the user's prompt + the business's facts.
  async function writeWhatsApp({ instructions, sender = {}, business = {} }) {
    const system = [
      'You write ONE short, personal WhatsApp message from the sender to one business, following the sender’s instructions (their offer, tone and language — write in the language of the instructions; Roman Urdu if they write Roman Urdu).',
      'Use the business facts to make it specific (their name, category, area, whether they have a website). Never invent anything that is not in the facts or the instructions: no made-up names, numbers, reviews, prices or claims.',
      'Greet the contact by first name only if contact_name is given and looks like a person’s name.',
      'Plain text, 20 to 70 words, at most one emoji, no links unless the instructions give one, no placeholders like [Name], like a real person writing on WhatsApp (not an advert).',
      'Reply with JSON only: {"message": "..."}',
    ].join('\n');
    const user = JSON.stringify({ instructions: String(instructions || '').slice(0, 4000), sender, business });
    const { message } = await ai.chat([{ role: 'system', content: system }, { role: 'user', content: user }], []);
    const text = String(message?.content || '');
    let out = null;
    try {
      out = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    } catch {}
    const msg = typeof out?.message === 'string' ? out.message : !text.includes('{') ? text : '';
    if (!msg.trim()) throw Object.assign(new Error('the AI did not answer in the expected form'), { code: 'ai_empty' });
    return msg.replace(/\r\n/g, '\n').trim();
  }

  function registerIpc(handle, pickFiles) {
    handle('ai:settings', () => view());
    handle('ai:saveKey', (key, provider) => saveKey(key, provider));
    handle('ai:test', (provider) => test(provider));
    handle('ai:setMain', (provider) => setMain(provider));
    handle('ai:history', () => ({ ok: true, ...operator.view('app') }));
    handle('ai:clear', () => {
      operator.clear('app');
      return { ok: true, ...operator.view('app') };
    });
    handle('ai:attach', async () => pickFiles({ title: 'Attach files for the assistant' }));
    handle('ai:send', async (text, fileIds) => {
      const files = (Array.isArray(fileIds) ? fileIds : []).map((id) => toolDeps.files.info(String(id))).filter(Boolean).map((f) => ({ id: f.id, name: f.name, kind: f.kind }));
      const r = await operator.handle('app', typeof text === 'string' ? text : '', { files, source: 'app' });
      for (const id of Object.keys(PROVIDERS)) if (!r.ok && new RegExp(`${apis[id].label} rejected the API key`).test(r.error || '')) setStatus(id, { status: 'failed', error: r.error, testedAt: Date.now() });
      return { ...r, ...operator.view('app') };
    });
  }

  // The admin's WhatsApp message (not a fixed command): the AI's reply text.
  async function whatsappReply(phone, text, media = null) {
    const files = [];
    if (media) {
      // The file the admin sent, downloaded and kept in the app like an attached one.
      let data;
      try {
        data = await media.download();
      } catch (err) {
        return `Sorry, I could not download that file: ${err.message}`;
      }
      const added = toolDeps.files.addData(data, media.name);
      if (!added.ok) return `Sorry, that file cannot be used: ${added.error}`;
      files.push(added.file);
    }
    const r = await operator.handle(`wa:${phone}`, text, { source: 'whatsapp', files });
    return r.ok ? r.reply : `Sorry, I could not do that: ${r.error}`;
  }

  return { groq, apis, operator, tools, view, test, saveKey, setMain, registerIpc, whatsappReply, writeEmail, writeWhatsApp, available: () => ai.configured() };
}

module.exports = { createAI };
