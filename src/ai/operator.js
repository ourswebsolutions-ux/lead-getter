'use strict';

// The AI operator: understands what the user asks (English, Urdu, Roman
// Urdu) with Groq, and does it with the app's own tools (tools.js).
//
// - Each conversation (the app's Assistant tab, or the admin's WhatsApp
//   chat) keeps its history and its task context (the campaigns being set
//   up), saved in app_state, so it survives restarts and the user never has
//   to repeat what they said.
// - Tools that read or prepare run at once. Tools that send, delete or
//   change settings are never run on the AI's word: the operator keeps them
//   as "awaiting confirmation" and runs them only when the user's next
//   message is an explicit yes (checked here, by rules, not by the AI).
//   Anything else drops them.
// - Every result the AI reports comes from a tool's actual return value.

const { toolSpecs } = require('./tools');

const KEY = 'ai.conversations';
const MAX_MESSAGES = 60; // kept per conversation (sent to Groq: the last ones)
const SEND_MESSAGES = 36;
const MAX_ROUNDS = 8;
const PENDING_TTL = 30 * 60_000;
const RESULT_MAX = 7000;

// An explicit yes (English, Roman Urdu, Urdu). "Maybe", "hmm", "later" or
// anything longer is not a yes.
const YES = /^\s*(y|yes|yes please|yeah|yep|yup|sure|ok|okay|ok go|go|go ahead|confirm|confirmed|do it|start|start it|send|send it|run|run it|haan|han|haa|ha|haan ji|han ji|ji|jee|ji haan|jee haan|g|theek|thik|theek hai|thik hai|tik hai|kar do|kr do|krdo|kardo|haan kar do|han kar do|start kar do|start kr do|start karo|chalao|chala do|bhej do|bhejo|send kar do|run kar do|run kr do|ہاں|جی|جی ہاں|ٹھیک ہے|کر دو|✅|👍)[\s.!]*$/i;
const NO = /^\s*(n|no|nope|nah|cancel|stop|don'?t|do not|not now|later|nahi|nahin|nai|na|mat|mat karo|rehne do|rehnay do|chhoro|chodo|cancel karo|نہیں|مت|رہنے دو|❌|👎)[\s.!]*$/i;

const SYSTEM = `You are Lead Finder's built-in operator. Lead Finder finds business leads (Google Maps, Facebook, LinkedIn, podcasts) and contacts them with WhatsApp and email campaigns. You operate the software for the user through the tools you have; you are not a general chatbot.

How you work:
- Understand English, Urdu and Roman Urdu, informal writing and spelling mistakes. Answer in the user's language and style (Roman Urdu if they write Roman Urdu). Keep answers short and clear.
- Use tools for every fact and every action. Never invent numbers, names, statuses or results; if a tool failed, say so plainly with its reason. Never say something was done unless a tool result says it was.
- Do the work step by step. Ask for ONE missing piece at a time, and never ask for something the user already gave or that a tool can tell you. Remember everything said in this conversation (accounts, categories, messages, campaigns) and use it.
- When several choices exist (accounts, categories) and the user has not chosen, list them briefly and ask. With only one possible choice, use it and say so.
- Campaign set-up: create the campaign as a draft as soon as you know the channel, then fill it in as the user answers (account, recipients, messages, subject/body, attachments). Show the user what will be sent before starting. After each step, say what is ready and offer the next step.
- Sending, deleting and settings changes need confirmation: call the tool when everything is ready; the app then asks the user to confirm and runs it only if they say yes. Tell the user what will happen and ask them to confirm. Do not claim it started before the result says so.
- Placeholders: WhatsApp messages can use {name} and {business}; emails {name}, {business} and {email}. Keep the user's text as they wrote it.
- Replies: leads who answered a campaign are in the Inbox (list_replies, read_conversation). When the user asks to answer a lead ("isko reply kar do ke ..."), find the conversation (the latest one if they mean the last reply) and use reply_to_lead with the message written for the client, in the client's language.
- AI writing: WhatsApp and email campaigns can have each message written by the AI from the user's prompt and each business's details (ai_write + ai_prompt for WhatsApp; ai_write + body as the prompt for email). When the user wants this, ask for the prompt (offer, tone, language) instead of a fixed message. Email category campaigns (email_category_campaign) and their AI writing can be set up the same way.
- Files: the user attaches images, documents and audio with the paperclip in Lead Finder's Assistant tab, or sends them on WhatsApp; attached files appear in the conversation with their file_id. If they want a voice message, ask them to attach the recording (MP3, M4A, AAC, Ogg/Opus, AMR). You cannot record or generate voice; say so if asked.
- Email accounts: the user can write their email address and app password in this chat (for Gmail: an App Password); the app adds and tests the account itself and tells you the result in a note — you never see passwords and never write one. Adding accounts in this chat IS supported: never say otherwise. If the user clearly tried to add an account but no note from the app came with the message, say the app could not read it and ask them to send it again as: email app-password (for example: name@gmail.com xxxx xxxx xxxx xxxx). Several accounts can be imported in Outreach > Email > Accounts > Import. A campaign can send from several accounts in turn (account_ids); accounts can be added to a running campaign. WhatsApp accounts are linked by QR code in Outreach.
- Respect unsubscribes and opt-outs; never try to message people who opted out.
- You cannot run programs, read files on the computer or access anything outside these tools.`;

const trimJson = (v) => {
  const s = JSON.stringify(v);
  return s.length > RESULT_MAX ? `${s.slice(0, RESULT_MAX)}…(truncated)` : s;
};

class Operator {
  // groq: Groq; tools: buildTools() list; state: { get, set } (app_state);
  // context(): a short live summary of the app (for the system message);
  // onEvent({ channel, type, ... }): progress for the window.
  // credentials(text): email accounts written in the message are added by
  // the app itself; resolves { found, results, redacted } (the text without
  // the passwords, which is all the AI and the history ever get).
  // redact(text): the text without email passwords, applied to the saved
  // history too (nothing typed before a fix stays there or reaches the AI again).
  constructor({ groq, tools, state, context = () => '', now = () => Date.now(), log = () => {}, onEvent = () => {}, credentials = null, redact = (t) => t }) {
    Object.assign(this, { groq, state, context, now, log, onEvent, credentials, redact });
    this.tools = new Map(tools.map((t) => [t.name, t]));
    this.specs = toolSpecs(tools);
    this.queues = new Map(); // channel -> promise (one message at a time per conversation)
  }

  all() {
    const v = this.state.get(KEY);
    return v && typeof v === 'object' ? v : {};
  }

  conversation(channel) {
    const c = this.all()[channel] || {};
    const clean = (m) => (m && m.role === 'user' && typeof (m.content ?? m.text) === 'string' ? { ...m, ...(m.content != null ? { content: this.redact(m.content) } : {}), ...(m.text != null ? { text: this.redact(m.text) } : {}) } : m);
    if (Array.isArray(c.messages)) c.messages = c.messages.map(clean);
    if (Array.isArray(c.display)) c.display = c.display.map(clean);
    return { messages: Array.isArray(c.messages) ? c.messages : [], display: Array.isArray(c.display) ? c.display : [], pending: c.pending || null, focus: c.focus || {}, files: Array.isArray(c.files) ? c.files : [], updatedAt: c.updatedAt || null };
  }

  save(channel, conv) {
    const all = this.all();
    // History kept short, cut only at a user message (never between a tool call and its result).
    let msgs = conv.messages;
    if (msgs.length > MAX_MESSAGES) {
      let cut = msgs.length - MAX_MESSAGES;
      while (cut < msgs.length && msgs[cut].role !== 'user') cut++;
      msgs = msgs.slice(cut);
    }
    all[channel] = { ...conv, messages: msgs, display: conv.display.slice(-200), files: conv.files.slice(-30), updatedAt: this.now() };
    this.state.set(KEY, all);
  }

  clear(channel) {
    const all = this.all();
    delete all[channel];
    this.state.set(KEY, all);
    return { ok: true };
  }

  // For the window: what was said, the actions run, an open confirmation.
  view(channel) {
    const c = this.conversation(channel);
    const pending = c.pending && this.now() - c.pending.at < PENDING_TTL ? { summary: c.pending.summary, tool: c.pending.tool } : null;
    return { display: c.display, pending };
  }

  // One user message, in order per conversation. Resolves { ok, reply, actions, pending } or { ok: false, error }.
  handle(channel, text, opts = {}) {
    const prev = this.queues.get(channel) || Promise.resolve();
    const run = prev.then(() => this.turn(channel, String(text || ''), opts));
    this.queues.set(channel, run.catch(() => {}));
    return run;
  }

  async turn(channel, text, { files = [], source = 'app' } = {}) {
    const conv = this.conversation(channel);
    const actions = [];
    let clean = text.replace(/\s+$/g, '').slice(0, 4000);
    if (!clean.trim() && !files.length) return { ok: false, error: 'Write a message first.' };
    if (!this.groq.configured()) return { ok: false, error: 'Add a Groq or OpenRouter API key in Settings > AI to use the assistant.' };
    // Email accounts with their passwords: added here, before anything is
    // stored or sent to Groq; the message goes on without the passwords.
    let accountNote = '';
    if (this.credentials && /@/.test(clean)) {
      const found = await this.credentials(clean).catch((err) => {
        this.log(`assistant: accounts not added: ${err.message}`);
        return null;
      });
      if (found?.found) {
        clean = found.redacted;
        for (const r of found.results) actions.push({ tool: 'email_account', ok: r.ok, kind: 'config', label: r.ok ? `Email account ${r.email} ${r.created ? 'added' : 'updated'} and connected` : `Email account ${r.email}`, error: r.ok ? null : `${r.email}: ${r.error}` });
        accountNote = `\n[The app itself handled the email account(s) in this message; passwords are never shown to you: ${found.results.map((r) => `${r.email}: ${r.ok ? `${r.created ? 'added' : 'password updated'}, connected (account id ${r.id})` : `not added/working — ${r.error}`}`).join('; ')}. Tell the user the result.]`;
      }
    }

    const at = this.now();
    const fileNote = files.length ? `\n[Attached: ${files.map((f) => `${f.name} (file_id ${f.id}, ${f.kind})`).join('; ')}]` : '';
    conv.display.push({ role: 'user', text: clean, files: files.map((f) => ({ id: f.id, name: f.name, kind: f.kind })), at });
    for (const f of files) if (!conv.files.some((x) => x.id === f.id)) conv.files.push({ id: f.id, name: f.name, kind: f.kind });

    // An action waiting for the user's answer.
    let pending = conv.pending && this.now() - conv.pending.at < PENDING_TTL ? conv.pending : null;
    conv.pending = null;
    if (pending && YES.test(clean) && !files.length) {
      conv.messages.push({ role: 'user', content: clean });
      this.onEvent({ channel, type: 'tool', tool: pending.tool, label: pending.summary });
      const result = await this.exec(pending.tool, pending.args, { confirmed: true });
      actions.push({ tool: pending.tool, ok: result.ok !== false, label: pending.summary, error: result.ok === false ? result.error : null, kind: 'confirm', confirmed: true });
      this.focus(conv, pending.args, result);
      const callId = `confirmed_${at}`;
      conv.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name: pending.tool, arguments: JSON.stringify(pending.args) } }] });
      conv.messages.push({ role: 'tool', tool_call_id: callId, content: trimJson({ ...result, confirmed_by_user: true }) });
      pending = null;
    } else if (pending && NO.test(clean) && !files.length) {
      conv.messages.push({ role: 'user', content: `${clean}\n[The user did not confirm. Not done: ${pending.summary}]` });
      actions.push({ tool: pending.tool, ok: true, label: `Cancelled: ${pending.summary}`, kind: 'cancelled' });
      pending = null;
    } else if (pending) {
      conv.messages.push({ role: 'user', content: `${clean}${fileNote}${accountNote}\n[This is not a confirmation, so this was NOT done: ${pending.summary}. Call the tool again only if the user still wants it.]` });
      pending = null;
    } else {
      conv.messages.push({ role: 'user', content: `${clean}${fileNote}${accountNote}` });
    }

    let reply = '';
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        this.onEvent({ channel, type: 'thinking' });
        const { message } = await this.groq.chat(this.prompt(conv, source), this.specs);
        const calls = Array.isArray(message.tool_calls) ? message.tool_calls.slice(0, 6) : [];
        if (!calls.length) {
          reply = String(message.content || '').trim();
          conv.messages.push({ role: 'assistant', content: reply });
          break;
        }
        conv.messages.push({ role: 'assistant', content: message.content || null, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.function?.name, arguments: c.function?.arguments || '{}' } })) });
        for (const call of calls) {
          const name = call.function?.name;
          let args = {};
          try {
            args = JSON.parse(call.function?.arguments || '{}') || {};
          } catch {
            args = null;
          }
          const tool = this.tools.get(name);
          let result;
          if (!tool) result = { ok: false, error: `There is no tool called ${name}.` };
          else if (!args || typeof args !== 'object' || Array.isArray(args)) result = { ok: false, error: 'The arguments were not valid JSON.' };
          else if (tool.kind === 'confirm') {
            const desc = await this.safe(() => tool.describe(args));
            if (desc.ok === false) result = desc;
            else {
              conv.pending = { tool: name, args, summary: desc.summary, at: this.now() };
              result = { ok: true, status: 'awaiting_user_confirmation', will_do: desc.summary, instruction: 'Not done yet. Tell the user exactly this and ask them to confirm (yes / no). It runs only if they reply yes.' };
              actions.push({ tool: name, ok: true, label: desc.summary, kind: 'pending' });
            }
          } else {
            this.onEvent({ channel, type: 'tool', tool: name });
            result = await this.exec(name, args);
            if (tool.kind !== 'read' || result.ok === false) actions.push({ tool: name, ok: result.ok !== false, label: this.label(name, result), error: result.ok === false ? result.error : null, kind: tool.kind });
            this.focus(conv, args, result);
          }
          conv.messages.push({ role: 'tool', tool_call_id: call.id, content: trimJson(result) });
        }
        if (round === MAX_ROUNDS - 1) reply = 'I could not finish this in one go. Tell me what to do next.';
      }
    } catch (err) {
      this.log(`assistant: ${err.message}`);
      const msg = err.code ? err.message : 'Something went wrong while talking to the AI.';
      // The user's message stays in the history; the failed turn adds nothing else.
      conv.display.push({ role: 'error', text: msg, at: this.now(), actions });
      this.save(channel, conv);
      return { ok: false, error: msg, actions };
    }
    if (!reply) reply = conv.pending ? `Please confirm: ${conv.pending.summary} (yes / no)` : 'Done.';
    // A confirmation the AI forgot to mention is always shown.
    if (conv.pending && !/confirm|yes|haan|ہاں|تصدیق/i.test(reply)) reply = `${reply}\n\n${conv.pending.summary} Confirm? (yes / no)`;
    conv.display.push({ role: 'assistant', text: reply, at: this.now(), actions, pending: conv.pending ? { summary: conv.pending.summary } : null });
    this.save(channel, conv);
    this.onEvent({ channel, type: 'done' });
    return { ok: true, reply, actions, pending: conv.pending ? { summary: conv.pending.summary, tool: conv.pending.tool } : null };
  }

  async safe(fn) {
    try {
      const r = await fn();
      return r && typeof r === 'object' ? r : { ok: false, error: 'No result.' };
    } catch (err) {
      return { ok: false, error: String(err?.message || err).slice(0, 300) };
    }
  }

  // Runs a tool. A confirm tool only with confirmed: true (after the user's yes).
  async exec(name, args, { confirmed = false } = {}) {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: `Unknown action ${name}.` };
    if (tool.kind === 'confirm' && !confirmed) return { ok: false, error: 'This needs the user’s confirmation.' };
    const r = await this.safe(() => tool.run(args));
    this.log(`assistant: ${name} ${r.ok === false ? `failed: ${String(r.error).slice(0, 160)}` : 'done'}`);
    return r;
  }

  // The campaign a conversation is working on, per channel.
  focus(conv, args, result) {
    const camp = result?.campaign;
    const id = camp?.id ?? args?.campaign_id;
    const channel = camp?.channel || args?.channel || null;
    if (id && channel) conv.focus[channel] = { id, name: camp?.name || conv.focus[channel]?.name || null };
  }

  label(name, r) {
    if (r.ok === false) return `${name.replace(/_/g, ' ')}: ${r.error}`;
    const c = r.campaign;
    const n = c ? ` “${c.name}”` : '';
    return {
      create_whatsapp_campaign: `WhatsApp campaign${n} created (draft)`,
      create_email_campaign: `Email campaign${n} created (draft)`,
      add_whatsapp_message: `Message added to${n}`,
      edit_whatsapp_message: `Message changed in${n}`,
      remove_whatsapp_message: `Message removed from${n}`,
      add_whatsapp_attachment: `File added to${n}`,
      remove_whatsapp_attachment: `File removed from${n}`,
      add_whatsapp_recipients: `${r.added ?? 0} recipients added to${n}`,
      add_email_recipients: `${r.added ?? 0} recipients added to${n}`,
      update_email_campaign: `Email campaign${n} updated`,
      update_whatsapp_campaign: `WhatsApp campaign${n} updated`,
      add_email_attachment: `Attachment added to${n}`,
      add_email_sender: `Sending accounts of${n}: ${(c?.sending_accounts || []).map((x) => x.email).join(', ')}`,
      remove_email_sender: `Sending account removed from${n}`,
      check_email_replies: `Replies checked: ${r.new_replies ?? 0} new, ${r.unsubscribed ?? 0} unsubscribed`,
      remove_email_attachment: `Attachment removed from${n}`,
      pause_campaign: `Campaign${n} paused`,
      stop_search: 'Lead search stopped',
      email_opt_out: 'Address unsubscribed',
      test_email_account: 'Email account connected',
      show_leads_in_table: `Leads tab: ${r.count ?? 0} leads shown`,
    }[name] || name.replace(/_/g, ' ');
  }

  prompt(conv, source) {
    const focus = Object.entries(conv.focus).map(([ch, f]) => `${ch} campaign being worked on: id ${f.id}${f.name ? ` (“${f.name}”)` : ''}`);
    const files = conv.files.length ? `Files attached in this conversation: ${conv.files.map((f) => `${f.name} (file_id ${f.id}, ${f.kind})`).join('; ')}` : '';
    const ctx = [
      `Now: ${new Date(this.now()).toString()}`,
      source === 'whatsapp' ? 'The user is writing from their WhatsApp (the admin number): plain text only, keep replies short. Photos, voice notes and documents they send on WhatsApp arrive here as attached files.' : 'The user is in Lead Finder’s Assistant tab.',
      this.safeContext(),
      ...focus,
      files,
    ].filter(Boolean).join('\n');
    const history = conv.messages.slice(-SEND_MESSAGES);
    // Never start the history with tool results whose call was cut off.
    while (history.length && history[0].role !== 'user') history.shift();
    return [{ role: 'system', content: SYSTEM }, { role: 'system', content: `Current state:\n${ctx}` }, ...history];
  }

  safeContext() {
    try {
      return String(this.context() || '');
    } catch {
      return '';
    }
  }
}

module.exports = { Operator, YES, NO, SYSTEM };
