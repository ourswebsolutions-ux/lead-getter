'use strict';

// The AI assistant in the app: Groq and/or OpenRouter (the main one, the
// other as a stand-in), their keys (in the vault) and status, the operator
// and the window's calls. The window only ever learns whether a key is
// saved and whether it works, never the key.

const { Groq, OpenRouter, Providers } = require('./groq');
const { buildTools } = require('./tools');
const { Operator } = require('./operator');
const crypto = require('node:crypto');
const { extractAccounts } = require('../email/credentials');
const { RULES_SYSTEM, sanitizeRules, fallbackRules, mergeRules, firstName, expectedGreeting, setGreeting, setSignoff, problems } = require('./email-rules');

// Per provider: where its status is kept and its key's name in the vault.
const PROVIDERS = {
  groq: { Class: Groq, statusKey: 'ai.settings', vaultName: 'groq', hint: 'it starts with gsk_' },
  openrouter: { Class: OpenRouter, statusKey: 'ai.openrouter', vaultName: 'openrouter', hint: 'it starts with sk-or-' },
};
const MAIN_KEY = 'ai.main';
// The rules read from email prompts (per prompt).
const RULES_KEY = 'ai.emailRules';

// The JSON object in an answer (even inside a code block), or null.
function parseJson(content) {
  const text = String(content || '');
  try {
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
}

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

  // The checkable rules of a prompt (sign-off, greeting, required lines,
  // bullets, questions, length; see email-rules.js), read once by the AI and
  // kept per prompt.
  const rulesSeen = new Map();
  async function emailRules(prompt) {
    const p = String(prompt || '').trim();
    if (!p) return {};
    const key = crypto.createHash('sha256').update(p).digest('hex').slice(0, 32);
    if (rulesSeen.has(key)) return rulesSeen.get(key);
    const kept = store.getState(RULES_KEY) || {};
    if (kept[key]) {
      rulesSeen.set(key, kept[key].rules);
      return kept[key].rules;
    }
    let read = null;
    try {
      const { message } = await ai.chat([{ role: 'system', content: RULES_SYSTEM }, { role: 'user', content: p }], [], { maxTokens: 1500 });
      read = parseJson(message?.content);
    } catch (err) {
      if (['no_key', 'invalid_key', 'credits'].includes(err.code)) throw err;
    }
    const rules = mergeRules(fallbackRules(p), read ? sanitizeRules(read, p) : {});
    if (read) {
      // Read again next time if the AI could not be asked now.
      rulesSeen.set(key, rules);
      const next = Object.fromEntries(Object.entries({ ...kept, [key]: { rules, at: Date.now() } }).sort((a, b) => b[1].at - a[1].at).slice(0, 30));
      store.setState(RULES_KEY, next);
    }
    return rules;
  }

  // One personalised email (or a follow-up) from the sender's prompt and the
  // business's facts. Resolves { subject, body, problems } (plain text; the
  // app adds the unsubscribe line).
  //   The prompt is the system message, first and whole: it decides the
  //   offer, wording, structure, greeting, length, call to action and
  //   sign-off. The app's notes after it only add what it leaves open and
  //   never compete with it (no sender name when the prompt has a sign-off).
  //   The user message has only the facts of this business (and, for a
  //   follow-up, the earlier emails).
  //   What comes back is checked against the prompt's rules: the greeting
  //   and sign-off are set exactly by the app (whatever the AI signed with);
  //   anything else that is wrong is sent back to the AI to rewrite, at most
  //   twice; the best answer is used and what it still misses is in `problems`.
  // followup: { step, note, earlier: [text] } for a follow-up in the thread.
  async function writeEmail({ instructions, subject = '', sender = {}, business = {}, followup = null }) {
    // Windows line endings (a prompt pasted from a file) read like any other.
    const brief = String(instructions || '').replace(/\r\n?/g, '\n').slice(0, 30_000).trim();
    const rules = await emailRules(brief);
    const kind = followup ? 'followup' : 'email';
    const first = firstName(business);
    const greeting = expectedGreeting(rules, first);
    const has = (k) => rules[k] != null;
    const notes = [
      followup
        ? `You write follow-up ${followup.step} for the sender, to one business that has not replied to the earlier email${followup.earlier?.length > 1 ? 's' : ''} (in the user message). Use the brief’s language, tone, offer, greeting and sign-off, but not its first-email structure, list or length: a short, polite follow-up (40 to 110 words unless the brief says how long follow-ups are) that refers back to the earlier email naturally, adds one new helpful point or one simple question, and does not repeat it.${followup.note ? ` For this follow-up: ${String(followup.note).slice(0, 1000)}` : ''}`
        : 'You write ONE email from the sender to the one business in the user message. Follow every rule of the brief above exactly: its structure, greeting, required wording, services, length, call to action, subject and sign-off. If it has a template or an example email, keep its structure and wording and only personalise it for this business. Replace every placeholder with the real value from the facts, or rephrase the sentence if the value is unknown.',
      'The user message has only facts about this business. Personalise with them. Never invent anything that is not in the facts or the brief: no compliments, reviews, ratings, numbers, results, people or details about their website (its content was not read: say only what the facts say about it).',
      greeting ? `Greeting: exactly “${greeting}” on its own line.` : first ? `Greeting: by the first name, ${first}.` : 'Greeting: no person’s name is known; never greet the business’s name as if it were a person.',
      rules.signoff ? `Sign-off: end with exactly these lines, and nothing after them (no other name, title, company, email address or phone):\n${rules.signoff}` : followup ? 'Sign-off: the same as the earlier email’s.' : 'Sign-off: as the brief says; if it says nothing, the sender_name in the user message.',
      ...(followup
        ? []
        : [
            ...(rules.required_lines || []).map((l) => `Include this line word for word: ${l}`),
            has('bullets') ? `Bullet points: ${rules.bullets.min === rules.bullets.max ? rules.bullets.min : `${rules.bullets.min} to ${rules.bullets.max}`}, one item each, each on its own line starting with "- ".` : '',
            has('questions') ? `Questions: ${rules.questions.min === rules.questions.max ? `exactly ${rules.questions.min}` : `${rules.questions.min} to ${rules.questions.max}`} in the whole email (the call to action).` : '',
            has('words') ? `Length: ${rules.words.min} to ${rules.words.max} words in the body (aim for about ${Math.round((rules.words.min + rules.words.max) / 2)}; count them before you answer).` : 'Length: as the brief says; if it says nothing, about 80 to 180 words.',
          ]),
      'Language: the brief’s (Roman Urdu stays Roman Urdu), unless it says otherwise.',
      'Plain text only: no markdown, no ** or #, no placeholders left, no subject line inside the body, no unsubscribe line (the app adds one).',
      subject ? `Subject: exactly this, filling {name} / {business} from the facts (drop a placeholder whose value is unknown): ${subject}` : 'Subject: as the brief says; otherwise short and specific to this business (at most 9 words), no clickbait, no ALL CAPS.',
      'Reply with JSON only, nothing before or after it: {"subject": "...", "body": "..."}',
    ].filter(Boolean);
    const system = [
      '=== THE SENDER’S BRIEF (follow it exactly; it overrides everything below) ===',
      brief || (followup ? '(none: write as the earlier email does: same language, tone, offer and sign-off)' : '(none: write a short, friendly introduction of the sender’s services)'),
      '=== END OF THE BRIEF ===',
      '',
      'Notes from the app (they never change the brief):',
      ...notes.map((n) => `- ${n}`),
    ].join('\n');
    const facts = { ...business, ...(first ? { first_name: first } : {}) };
    delete facts.email;
    const user = JSON.stringify({
      business: facts,
      first_name: first || null,
      ...(greeting ? { greeting } : {}),
      ...(rules.signoff ? {} : { sender_name: sender.name || '' }),
      ...(followup ? { earlier_emails: (followup.earlier || []).map((t) => String(t).slice(0, 2500)) } : {}),
    });
    const read = (message) => {
      const out = parseJson(message?.content);
      return out && typeof out.body === 'string' && out.body.trim() ? out : null;
    };
    // Placeholders the AI left: filled from the facts.
    const fill = (t) =>
      String(t || '')
        .replace(/\{\s*(business(?:[ _]name)?|company)\s*\}|\[\s*(business|company)(?: name)?\s*\]/gi, business.business_name || business.company || '')
        .replace(/\{\s*(name|first[ _]name|contact)\s*\}|\[\s*(name|first name|contact(?: name)?)\s*\]/gi, first || '')
        .replace(/\{\s*(sender|your name)\s*\}|\[\s*(your name|sender(?: name)?)\s*\]/gi, sender.name || '');
    // The greeting and sign-off set by the app; then what is still wrong.
    const finish = (out) => {
      let body = fill(out.body).replace(/\r\n/g, '\n').replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#+\s*/gm, '').trim();
      body = setGreeting(body, greeting);
      body = setSignoff(body, rules.signoff, [sender.name, business.contact_name]);
      const email = { subject: fill(String(out.subject || subject || '')).replace(/\s+/g, ' ').trim(), body };
      return { ...email, problems: problems(email, rules, business, { kind }) };
    };
    const opts = { maxTokens: 4000, reasoning: 'medium' };
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
    let best = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const out = read((await ai.chat(messages, [], opts)).message);
      const got = out ? finish(out) : null;
      if (got && (!best || got.problems.length < best.problems.length)) best = got;
      if (best && !best.problems.length) break;
      messages.push({ role: 'assistant', content: out ? JSON.stringify(out) : '(no usable answer)' });
      messages.push({ role: 'user', content: got ? `This email does not follow the brief yet:\n${got.problems.map((p) => `- ${p}`).join('\n')}\nRewrite it so it follows every rule of the brief and the notes, for the same business, and answer with the JSON only.` : 'Answer with the JSON only: {"subject": "...", "body": "..."}, following the brief.' });
    }
    if (!best) throw Object.assign(new Error('the AI did not answer in the expected form'), { code: 'ai_empty' });
    return best;
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
