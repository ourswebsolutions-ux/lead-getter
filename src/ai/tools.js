'use strict';

// The assistant's tools: what the AI may do in Lead Finder, each one a call
// to the app's own functions (the same ones the window uses), with its
// arguments checked here. The AI never gets database, shell or file-system
// access, nor any password or key.
//
// kind:
//   'read'    runs at once (status, leads, campaigns, settings);
//   'config'  runs at once, changes nothing outside the app and can be
//             undone (drafts, messages, recipients, pausing);
//   'confirm' sends something, deletes something or changes settings: it is
//             only described to the user, and runs when the user answers
//             with an explicit yes (operator.js; never on the AI's word).
//
// Every tool returns a plain object: { ok: true, ... } or { ok: false, error }.

const { isVerified } = require('../whatsapp/eligibility');
const { emailOf, dayOf } = require('../email/campaigns');
const { normalizeTemplates, validateTemplates, DEFAULT_TEMPLATES } = require('../whatsapp/templates');

const CHANNEL = { type: 'string', enum: ['whatsapp', 'email'], description: 'whatsapp or email' };
const CAMPAIGN_ID = { type: 'integer', description: 'The campaign id (from list_campaigns or the tool that created it)' };
const FILTER_PROPS = {
  category: { type: 'string', description: 'Lead category name (as listed by list_categories), or "none" for leads without a category' },
  today: { type: 'boolean', description: 'Only leads found today' },
  date: { type: 'string', description: 'Only leads found on this day (YYYY-MM-DD)' },
  from: { type: 'string', description: 'Found on or after this day (YYYY-MM-DD)' },
  to: { type: 'string', description: 'Found on or before this day (YYYY-MM-DD)' },
  search: { type: 'string', description: 'Text in the business, contact or company name, email or phone' },
  website: { type: 'string', enum: ['with', 'without'], description: 'Leads with or without a website' },
  source: { type: 'string', enum: ['maps', 'facebook', 'linkedin', 'podcast'], description: 'Where the lead was found' },
  lead_ids: { type: 'array', items: { type: 'integer' }, description: 'Only these leads (ids from find_leads)' },
};
const FILTER_CHANNEL_PROPS = {
  ...FILTER_PROPS,
  has_email: { type: 'boolean', description: 'Only leads with a valid email address' },
  has_whatsapp: { type: 'boolean', description: 'Only leads whose number is confirmed on WhatsApp' },
};
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const trimText = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const STATUS_WORDS = { draft: 'not started', running: 'running', paused: 'paused', stopped: 'stopped', completed: 'completed', off: 'off' };

function buildTools(d) {
  const today = () => dayOf(Date.now());

  // --- lead filters --------------------------------------------------------------

  function categoryOf(name) {
    if (name == null || name === '') return { ok: true, id: null };
    const raw = String(name).trim();
    if (/^none|uncategori[sz]ed$/i.test(raw)) return { ok: true, id: 'none', name: 'Uncategorized' };
    const cats = d.store.listCategories().categories;
    const low = raw.toLowerCase();
    const hit = cats.find((c) => String(c.id) === raw) || cats.find((c) => c.name.toLowerCase() === low) || cats.find((c) => c.name.toLowerCase().includes(low) || low.includes(c.name.toLowerCase()));
    if (!hit) return { ok: false, error: `There is no lead category called “${raw}”. Categories: ${cats.map((c) => c.name).join(', ') || 'none yet'}.` };
    return { ok: true, id: hit.id, name: hit.name };
  }

  function storeFilter(a = {}) {
    const cat = categoryOf(a.category);
    if (!cat.ok) return cat;
    const f = {};
    if (cat.id != null) f.category = cat.id;
    if (a.today) f.date = today();
    for (const k of ['date', 'from', 'to']) if (typeof a[k] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a[k])) f[k] = a[k];
    if (typeof a.search === 'string' && a.search.trim()) f.search = a.search.trim().slice(0, 100);
    if (['with', 'without'].includes(a.website)) f.website = a.website;
    if (['maps', 'facebook', 'linkedin', 'podcast'].includes(a.source)) f.source = a.source;
    if (Array.isArray(a.lead_ids)) f.ids = a.lead_ids.map(Number).filter(Number.isInteger).slice(0, 1000);
    return { ok: true, filter: f, category: cat };
  }

  function leadsFor(a = {}) {
    const sf = storeFilter(a);
    if (!sf.ok) return sf;
    let leads = d.store.listLeads(sf.filter);
    if (a.has_email) leads = leads.filter((l) => emailOf(l));
    if (a.has_whatsapp) leads = leads.filter(isVerified);
    return { ok: true, leads, filter: sf.filter, category: sf.category };
  }

  const leadRow = (l) => ({ id: l.id, name: l.name, category: l.category || null, phone: l.phone || null, whatsapp: l.whatsapp === 'available' ? 'yes' : l.whatsapp === 'not_on_whatsapp' ? 'no' : 'not checked', email: emailOf(l) || null, website: l.websiteUrl || (l.websiteKind === 'with' ? 'yes' : 'no'), found: l.discoveredDate, source: l.source, contacted_on_whatsapp: l.campaign === 'seen' });

  // --- campaigns -----------------------------------------------------------------

  const out = () => d.outreach();
  function waCampaign(id) {
    const o = out();
    if (!o) return { ok: false, error: 'WhatsApp is not available on this computer right now.' };
    const c = o.load(Number(id));
    if (!c) return { ok: false, error: `There is no WhatsApp campaign with id ${id}.` };
    return { ok: true, c, o };
  }
  function emCampaign(id) {
    const c = d.email.campaigns.row(Number(id));
    if (!c) return { ok: false, error: `There is no email campaign with id ${id}.` };
    return { ok: true, c };
  }
  const waAccountName = (id) => d.waAccounts().find((a) => a.id === id)?.label || id;

  function waView(c, o) {
    const s = o.summary(c);
    const cfg = c.config;
    return {
      channel: 'whatsapp',
      id: c.id,
      name: c.name,
      status: c.status === 'running' ? 'running' : c.status === 'stopped' && !c.pauseReason && !o.store.sends({ campaignId: c.id, test: false, limit: 1 }).length ? 'not started' : STATUS_WORDS[c.status] || c.status,
      paused_because: c.pauseReason || null,
      waiting_for: s.waiting || null,
      live: !cfg.test,
      account: { id: cfg.accountId, name: waAccountName(cfg.accountId) },
      ai_writes_each_message: cfg.aiWrite || undefined,
      ai_prompt: cfg.aiWrite ? cfg.aiPrompt : undefined,
      messages: cfg.aiWrite ? 'written by the AI for each contact (one message)' : cfg.templates.map((t, i) => ({ number: i + 1, text: t.variations?.[0]?.text ?? t.text })),
      voice_files: cfg.voices.map((v) => v.name),
      files: (cfg.media || []).map((m) => ({ id: m.id, name: m.name, kind: m.kind })),
      minutes_between_contacts: cfg.interval,
      daily_limit: cfg.dailyCap,
      quiet_hours: `${cfg.quietStart}:00-${cfg.quietEnd}:00 recipient time`,
      recipients: s.contacts,
      by_state: s.counts,
      sent_today: o.store.recipientsOn(dayOf(Date.now()), cfg.test, [c.id]),
    };
  }

  function emView(c) {
    const s = d.email.campaigns.summary(c.id);
    return {
      channel: 'email',
      id: c.id,
      name: c.name,
      status: STATUS_WORDS[c.status] || c.status,
      paused_because: s.pauseText,
      waiting_for: s.waiting,
      account: c.accountId ? { id: c.accountId, name: s.accountName } : null,
      sending_accounts: s.senders.map((x) => ({ id: x.id, name: x.name, email: x.email, sent_today: x.sentToday, failing: x.down || undefined })),
      category_campaign: c.category ? true : undefined,
      ai_writes_each_email: Boolean(c.config.aiWrite),
      subject: c.subject || null,
      body: c.body ? c.body.slice(0, 1500) : null,
      attachments: (c.config.attachments || []).map((a) => ({ id: a.id, name: a.name })),
      minutes_between_emails: Math.round((c.config.delaySeconds / 60) * 10) / 10,
      daily_limit: c.config.dailyLimit,
      recipients: s.counts.total,
      sent: s.counts.sent,
      failed: s.counts.failed,
      uncertain: s.counts.uncertain,
      skipped: s.counts.skipped,
      remaining: s.counts.remaining,
      replies: s.replies,
      link_clicks: s.tracking || s.clicks ? s.clicks : 'click tracking is off (Outreach > Email > Click tracking)',
      clicked_by: s.clicks ? d.email.campaigns.clickers(c.id, 20) : undefined,
      sent_today: s.sentToday,
      not_ready: d.email.campaigns.problems(c),
    };
  }

  function waTemplates(c, texts) {
    const templates = texts.map((t) => ({ text: t, fallback: /\{\s*name\s*\}/i.test(t) ? t.replace(/\s*\{\s*name\s*\}/gi, '').replace(/\s+([.,!?])/g, '$1').trim() : '' }));
    const norm = normalizeTemplates(templates);
    const errors = validateTemplates(norm);
    if (errors.length) return { ok: false, error: errors.join(' ') };
    return { ok: true, templates: norm };
  }
  const waTexts = (c) => c.config.templates.map((t) => t.variations?.[0]?.text ?? t.text);
  // The default first message of a new campaign (never sent as is).
  const isPlaceholder = (c) => c.config.templates.length === 1 && Boolean(c.config._aiFresh) && waTexts(c)[0] === DEFAULT_TEMPLATES[0].text;

  function waConfigure(id, patch) {
    const r = out().configure(id, patch);
    if (!r.ok) return r;
    return { ok: true, campaign: waView(out().load(id), out()) };
  }

  // --- the tools ---------------------------------------------------------------------

  const tools = [
    // ---------------- read ----------------
    {
      name: 'get_status',
      kind: 'read',
      description: 'Lead Finder at a glance: leads (total and today), lead searches, WhatsApp and email accounts, campaigns and their progress, the subscription. Use it for any question about the current state.',
      parameters: obj({}),
      run: () => {
        const total = d.store.countLeads({});
        const todayN = d.store.countLeads({ date: today() });
        const wa = d.waAccounts();
        const em = d.email.accounts.list();
        const waC = out() ? out().store.campaigns().map((c) => waView(out().load(c.id), out())) : [];
        const emC = d.email.campaigns.list();
        return {
          ok: true,
          leads: { total, found_today: todayN },
          lead_search: d.search.status(),
          whatsapp_accounts: { total: wa.length, connected: wa.filter((a) => a.state === 'open').length },
          email_accounts: { total: em.length, working: em.filter((a) => a.status === 'ok').length, failed: em.filter((a) => a.status === 'failed').length },
          whatsapp_campaigns: waC.filter((c) => ['running', 'paused'].includes(c.status)).map((c) => ({ id: c.id, name: c.name, status: c.status, live: c.live, recipients: c.recipients, by_state: c.by_state })),
          email_campaigns: emC.filter((c) => ['running', 'paused'].includes(c.status)).map((c) => ({ id: c.id, name: c.name, status: c.status, sent: c.counts.sent, failed: c.counts.failed, remaining: c.counts.remaining })),
          subscription: d.plan(),
          app_version: d.version,
        };
      },
    },
    {
      name: 'get_subscription',
      kind: 'read',
      description: 'The subscription / plan: its state, when it expires, days left, the daily lead limit.',
      parameters: obj({}),
      run: () => ({ ok: true, ...d.plan() }),
    },
    {
      name: 'count_leads',
      kind: 'read',
      description: 'How many leads match a filter (category, day, text, website, source, with email, with WhatsApp).',
      parameters: obj(FILTER_CHANNEL_PROPS),
      run: (a) => {
        const r = leadsFor(a);
        if (!r.ok) return r;
        return { ok: true, count: r.leads.length, with_email: r.leads.filter((l) => emailOf(l)).length, on_whatsapp: r.leads.filter(isVerified).length, category: r.category?.name || 'all' };
      },
    },
    {
      name: 'find_leads',
      kind: 'read',
      description: 'Lists leads matching a filter (at most 25, newest first) with their ids, contacts and status.',
      parameters: obj({ ...FILTER_CHANNEL_PROPS, limit: { type: 'integer', description: '1-25, default 10' } }),
      run: (a) => {
        const r = leadsFor(a);
        if (!r.ok) return r;
        const n = Math.min(25, Math.max(1, Number(a.limit) || 10));
        return { ok: true, total: r.leads.length, shown: Math.min(n, r.leads.length), leads: r.leads.slice(0, n).map(leadRow) };
      },
    },
    {
      name: 'list_categories',
      kind: 'read',
      description: 'The lead categories with their number of leads.',
      parameters: obj({}),
      run: () => {
        const c = d.store.listCategories();
        return { ok: true, categories: c.categories.map((x) => ({ id: x.id, name: x.name, leads: x.leadCount ?? null })), uncategorized: c.uncategorized };
      },
    },
    {
      name: 'list_whatsapp_accounts',
      kind: 'read',
      description: 'WhatsApp accounts linked to Lead Finder, with their connection state.',
      parameters: obj({}),
      run: () => ({ ok: true, accounts: d.waAccounts().map((a) => ({ id: a.id, name: a.label, number: a.number || null, connected: a.state === 'open', state: a.state })) }),
    },
    {
      name: 'list_email_accounts',
      kind: 'read',
      description: 'Email (SMTP) accounts set up for email campaigns, with their connection status (never passwords).',
      parameters: obj({}),
      run: () => ({ ok: true, accounts: d.email.accounts.list().map((a) => ({ id: a.id, name: a.name, sender: `${a.senderName} <${a.email}>`, server: `${a.host}:${a.port}`, status: a.status, detail: a.statusDetail || null, password_saved: a.hasPassword })) }),
    },
    {
      name: 'list_campaigns',
      kind: 'read',
      description: 'WhatsApp and/or email campaigns with their status and progress.',
      parameters: obj({ channel: { ...CHANNEL, description: 'whatsapp, email, or leave out for both' } }),
      run: (a) => {
        const res = { ok: true };
        if (a.channel !== 'email') res.whatsapp = out() ? out().store.campaigns().map((c) => {
          const v = waView(out().load(c.id), out());
          return { id: v.id, name: v.name, status: v.status, live: v.live, account: v.account.name, recipients: v.recipients, by_state: v.by_state, messages: v.messages.length };
        }) : [];
        if (a.channel !== 'whatsapp') res.email = d.email.campaigns.list().map((c) => ({ id: c.id, name: c.name, status: STATUS_WORDS[c.status] || c.status, account: c.accountName, recipients: c.counts.total, sent: c.counts.sent, failed: c.counts.failed, remaining: c.counts.remaining }));
        return res;
      },
    },
    {
      name: 'get_campaign',
      kind: 'read',
      description: 'One campaign in detail: messages or subject/body, attachments, account, recipients, sent, failed, remaining, why it waits, recent failures.',
      parameters: obj({ channel: CHANNEL, campaign_id: CAMPAIGN_ID }, ['channel', 'campaign_id']),
      run: (a) => {
        if (a.channel === 'whatsapp') {
          const r = waCampaign(a.campaign_id);
          if (!r.ok) return r;
          const failed = r.o.store.contacts(r.c.id).filter((x) => ['failed', 'uncertain'].includes(x.state)).slice(0, 20).map((x) => ({ phone: x.phone, state: x.state, note: x.note }));
          return { ok: true, campaign: waView(r.c, r.o), failed };
        }
        const r = emCampaign(a.campaign_id);
        if (!r.ok) return r;
        return { ok: true, campaign: emView(r.c), failed: d.email.campaigns.failedRecipients(r.c.id, 20), recent_log: d.email.campaigns.snapshot(r.c.id).log.slice(0, 10).map((l) => l.text) };
      },
    },
    {
      name: 'get_search_status',
      kind: 'read',
      description: 'The lead search now running (Google Maps, Facebook, LinkedIn), its progress, and the searches waiting in the pool.',
      parameters: obj({}),
      run: () => ({ ok: true, ...d.search.status(), pool: d.search.pool() }),
    },
    {
      name: 'get_settings',
      kind: 'read',
      description: 'Lead Finder settings: background work, continuous search and its countries, Chrome, notifications.',
      parameters: obj({}),
      run: () => ({ ok: true, settings: d.settings.get() }),
    },
    {
      name: 'list_files',
      kind: 'read',
      description: 'Files the user attached (images, documents, audio) that can be added to campaigns, newest first.',
      parameters: obj({}),
      run: () => ({ ok: true, files: d.files.list().slice(0, 20) }),
    },
    {
      name: 'list_email_optouts',
      kind: 'read',
      description: 'Email addresses that unsubscribed (they are never emailed).',
      parameters: obj({}),
      run: () => ({ ok: true, optouts: d.email.campaigns.optOuts().slice(0, 50) }),
    },
    {
      name: 'list_replies',
      kind: 'read',
      description: 'The Inbox: leads who replied to a campaign (email or WhatsApp), latest first, with their last message and the conversation id (#).',
      parameters: obj({ channel: { ...CHANNEL, description: 'whatsapp, email, or leave out for both' } }),
      run: (a) => {
        if (!d.inbox) return { ok: false, error: 'The Inbox is not available.' };
        const list = d.inbox.threads().filter((t) => !a.channel || t.channel === a.channel).slice(0, 30);
        return { ok: true, conversations: list.map((t) => ({ id: t.id, channel: t.channel, name: t.name, address: t.address, campaign: t.campaignName, unread: t.unread, last: t.last ? { from: t.last.direction === 'in' ? 'lead' : 'us', text: t.last.text.slice(0, 300) } : null })) };
      },
    },
    {
      name: 'read_conversation',
      kind: 'read',
      description: 'One Inbox conversation: every message between us and the lead.',
      parameters: obj({ conversation_id: { type: 'integer' } }, ['conversation_id']),
      run: (a) => {
        const t = d.inbox?.thread(a.conversation_id);
        if (!t) return { ok: false, error: `There is no conversation #${a.conversation_id}.` };
        return { ok: true, conversation: { id: t.id, channel: t.channel, name: t.name, address: t.address, campaign: t.campaignName }, messages: d.inbox.messages(t.id).slice(-30).map((m) => ({ from: m.direction === 'in' ? 'lead' : 'us', text: m.text.slice(0, 1500) })) };
      },
    },
    {
      name: 'preview_email',
      kind: 'read',
      description: 'The email of a campaign as its first recipient will get it (subject and text).',
      parameters: obj({ campaign_id: CAMPAIGN_ID }, ['campaign_id']),
      run: (a) => {
        const r = d.email.campaigns.render(Number(a.campaign_id));
        return r.ok ? { ok: true, to: r.to, subject: r.subject, text: r.text.slice(0, 2000) } : r;
      },
    },

    // ---------------- config (immediate, reversible) ----------------
    {
      name: 'show_leads_in_table',
      kind: 'config',
      description: 'Opens the Leads tab filtered by category and/or day, for the user to see.',
      parameters: obj({ category: FILTER_PROPS.category, today: FILTER_PROPS.today, date: FILTER_PROPS.date, search: FILTER_PROPS.search }),
      run: (a) => {
        const sf = storeFilter(a);
        if (!sf.ok) return sf;
        d.showLeads({ category: sf.filter.category ?? 'all', date: sf.filter.date || null, search: sf.filter.search || '' });
        return { ok: true, shown: true, count: d.store.countLeads(sf.filter) };
      },
    },
    {
      name: 'create_whatsapp_campaign',
      kind: 'config',
      description: 'Creates a new WhatsApp campaign (not started; nothing is sent). Then set its account, recipients and messages.',
      parameters: obj({ name: { type: 'string' }, account_id: { type: 'string', description: 'WhatsApp account id (list_whatsapp_accounts)' } }),
      run: (a) => {
        const o = out();
        if (!o) return { ok: false, error: 'WhatsApp is not available on this computer right now.' };
        if (a.account_id && !d.waAccounts().some((x) => x.id === a.account_id)) return { ok: false, error: 'That WhatsApp account does not exist.' };
        const r = o.create(trimText(a.name, 60) || `WhatsApp campaign ${o.store.campaigns().length + 1}`);
        if (!r.ok) return r;
        const id = r.id;
        // Starts with no message of its own: the user's messages replace the default one.
        const st = o.load(id);
        o.save({ ...st, config: { ...st.config, _aiFresh: true, ...(a.account_id ? { accountId: a.account_id } : {}) } });
        return { ok: true, campaign: waView(o.load(id), o), note: 'No message yet: add the user’s messages with add_whatsapp_message.' };
      },
    },
    {
      name: 'update_whatsapp_campaign',
      kind: 'config',
      description: 'Changes a WhatsApp campaign that is not running: name, account, minutes between contacts, daily limit, quiet hours, and AI writing (ai_write on: the AI writes one personal message per contact from ai_prompt and the business’s details, instead of the fixed messages).',
      parameters: obj({ campaign_id: CAMPAIGN_ID, ai_write: { type: 'boolean' }, ai_prompt: { type: 'string', description: 'The user’s instructions for the AI: offer, tone, language' }, name: { type: 'string' }, account_id: { type: 'string' }, minutes_between_contacts: { type: 'integer' }, daily_limit: { type: 'integer' }, quiet_start_hour: { type: 'integer' }, quiet_end_hour: { type: 'integer' } }, ['campaign_id']),
      run: (a) => {
        const r = waCampaign(a.campaign_id);
        if (!r.ok) return r;
        const patch = {};
        if (a.name) patch.name = trimText(a.name, 60);
        if (a.account_id) {
          if (!d.waAccounts().some((x) => x.id === a.account_id)) return { ok: false, error: 'That WhatsApp account does not exist.' };
          patch.accountId = a.account_id;
        }
        if (a.minutes_between_contacts != null) patch.interval = Number(a.minutes_between_contacts);
        if (a.daily_limit != null) patch.dailyCap = Number(a.daily_limit);
        if (a.quiet_start_hour != null) patch.quietStart = Number(a.quiet_start_hour);
        if (a.quiet_end_hour != null) patch.quietEnd = Number(a.quiet_end_hour);
        if (typeof a.ai_write === 'boolean') patch.aiWrite = a.ai_write;
        if (typeof a.ai_prompt === 'string') patch.aiPrompt = a.ai_prompt.slice(0, 4000);
        // Turned on with no message of its own: the default first message stays as the (unused) fallback.
        if (patch.aiWrite && r.c.config._aiFresh) {
          const st = r.o.load(r.c.id);
          delete st.config._aiFresh;
          r.o.save(st);
        }
        return waConfigure(r.c.id, patch);
      },
    },
    {
      name: 'add_whatsapp_message',
      kind: 'config',
      description: 'Adds a text message to a WhatsApp campaign (sent in order, 30-60 s apart, to each contact). Placeholders: {name}, {business}.',
      parameters: obj({ campaign_id: CAMPAIGN_ID, text: { type: 'string' }, position: { type: 'integer', description: 'Message number to insert at (default: last)' } }, ['campaign_id', 'text']),
      run: (a) => {
        const r = waCampaign(a.campaign_id);
        if (!r.ok) return r;
        const text = trimText(a.text, 2000);
        if (!text) return { ok: false, error: 'The message is empty.' };
        if (/\{\s*email\s*\}/i.test(text)) return { ok: false, error: 'WhatsApp messages can use {name} and {business}, not {email}.' };
        const texts = isPlaceholder(r.c) ? [] : waTexts(r.c);
        const at = Number.isInteger(a.position) ? Math.min(Math.max(a.position, 1), texts.length + 1) - 1 : texts.length;
        texts.splice(at, 0, text);
        if (texts.length > 10) return { ok: false, error: 'Up to 10 messages per campaign.' };
        const t = waTemplates(r.c, texts);
        if (!t.ok) return t;
        // Links and files that went with the last message stay with the (new) last one.
        const wasLast = !r.c.config.attachStep || r.c.config.attachStep >= (isPlaceholder(r.c) ? 1 : waTexts(r.c).length);
        const res = waConfigure(r.c.id, { templates: t.templates, ...(wasLast ? { attachStep: texts.length } : {}) });
        if (res.ok && r.c.config._aiFresh) {
          const st = r.o.load(r.c.id);
          delete st.config._aiFresh;
          r.o.save(st);
        }
        return res;
      },
    },
    {
      name: 'edit_whatsapp_message',
      kind: 'config',
      description: 'Replaces the text of one message of a WhatsApp campaign.',
      parameters: obj({ campaign_id: CAMPAIGN_ID, number: { type: 'integer', description: 'Message number (1 = first)' }, text: { type: 'string' } }, ['campaign_id', 'number', 'text']),
      run: (a) => {
        const r = waCampaign(a.campaign_id);
        if (!r.ok) return r;
        const texts = waTexts(r.c);
        if (isPlaceholder(r.c) || a.number < 1 || a.number > texts.length) return { ok: false, error: `There is no message ${a.number}.` };
        texts[a.number - 1] = trimText(a.text, 2000);
        const t = waTemplates(r.c, texts);
        return t.ok ? waConfigure(r.c.id, { templates: t.templates }) : t;
      },
    },
    {
      name: 'remove_whatsapp_message',
      kind: 'config',
      description: 'Removes one message from a WhatsApp campaign (at least one must remain).',
      parameters: obj({ campaign_id: CAMPAIGN_ID, number: { type: 'integer' } }, ['campaign_id', 'number']),
      run: (a) => {
        const r = waCampaign(a.campaign_id);
        if (!r.ok) return r;
        const texts = waTexts(r.c);
        if (a.number < 1 || a.number > texts.length) return { ok: false, error: `There is no message ${a.number}.` };
        if (texts.length === 1) return { ok: false, error: 'A campaign needs at least one message.' };
        texts.splice(a.number - 1, 1);
        const t = waTemplates(r.c, texts);
        return t.ok ? waConfigure(r.c.id, { templates: t.templates }) : t;
      },
    },
    {
      name: 'add_whatsapp_attachment',
      kind: 'config',
      description: 'Adds an attached file (file_id from list_files) to a WhatsApp campaign: audio is sent as a voice/audio message, images and documents as files, right after the last message.',
      parameters: obj({ campaign_id: CAMPAIGN_ID, file_id: { type: 'string' } }, ['campaign_id', 'file_id']),
      run: (a) => {
        const r = waCampaign(a.campaign_id);
        if (!r.ok) return r;
        const f = d.files.info(a.file_id);
        if (!f) return { ok: false, error: 'That file is not available. Ask the user to attach it with the paperclip.' };
        if (f.kind === 'audio') {
          const v = d.audioAdd(d.files.pathOf(f.id), f.name);
          if (!v.ok) return { ok: false, error: v.error };
          return waConfigure(r.c.id, { voices: [...r.c.config.voices.map((x) => x.id), v.voice.id], attachStep: r.c.config.templates.length });
        }
        return waConfigure(r.c.id, { media: [...(r.c.config.media || []).map((x) => x.id), f.id], attachStep: r.c.config.templates.length });
      },
    },
    {
      name: 'remove_whatsapp_attachment',
      kind: 'config',
      description: 'Removes a voice file, image or document from a WhatsApp campaign, by its name.',
      parameters: obj({ campaign_id: CAMPAIGN_ID, name: { type: 'string' } }, ['campaign_id', 'name']),
      run: (a) => {
        const r = waCampaign(a.campaign_id);
        if (!r.ok) return r;
        const n = String(a.name || '').toLowerCase();
        const voices = r.c.config.voices.filter((v) => v.name.toLowerCase() !== n);
        const media = (r.c.config.media || []).filter((m) => m.name.toLowerCase() !== n && m.id !== a.name);
        if (voices.length === r.c.config.voices.length && media.length === (r.c.config.media || []).length) return { ok: false, error: `No attachment called “${a.name}”.` };
        return waConfigure(r.c.id, { voices: voices.map((v) => v.id), media: media.map((m) => m.id) });
      },
    },
    {
      name: 'add_whatsapp_recipients',
      kind: 'config',
      description: 'Adds leads to a WhatsApp campaign by filter (category, day, text, lead ids). Only numbers confirmed on WhatsApp that were never messaged and did not opt out are added. Nothing is sent.',
      parameters: obj({ campaign_id: CAMPAIGN_ID, ...FILTER_PROPS }, ['campaign_id']),
      run: async (a) => {
        const r = waCampaign(a.campaign_id);
        if (!r.ok) return r;
        const sf = storeFilter(a);
        if (!sf.ok) return sf;
        const wanted = new Set(d.store.listLeads(sf.filter).map((l) => l.id));
        const el = d.waEligible(r.c.id, {});
        const ids = el.eligible.filter((l) => wanted.has(l.id)).map((l) => l.id);
        const previous = (el.previous || []).filter((l) => wanted.has(l.id)).length;
        if (!ids.length) return { ok: false, error: `None of these ${wanted.size} leads can be added: only numbers confirmed on WhatsApp that weren’t messaged before (or opted out) can be added.`, matching_leads: wanted.size, previously_contacted: previous };
        const added = await d.waAddLeads(r.c.id, ids);
        if (!added.ok) return added;
        return { ok: true, added: added.added ?? ids.length, matching_leads: wanted.size, previously_contacted: previous, campaign: waView(r.o.load(r.c.id), r.o) };
      },
    },
    {
      name: 'create_email_campaign',
      kind: 'config',
      description: 'Creates a new email campaign (not started; nothing is sent). Optionally with its account, subject and body.',
      parameters: obj({ name: { type: 'string' }, account_id: { type: 'string', description: 'Email account id (list_email_accounts)' }, subject: { type: 'string' }, body: { type: 'string' } }),
      run: (a) => {
        const r = d.email.campaigns.create({ name: trimText(a.name, 80), accountId: a.account_id || null, subject: a.subject || '', body: a.body || '' });
        if (!r.ok) return r;
        return { ok: true, campaign: emView(d.email.campaigns.row(r.id)) };
      },
    },
    {
      name: 'update_email_campaign',
      kind: 'config',
      description: 'Changes an email campaign that is not running: name, account, subject, body (plain text or HTML; placeholders {name}, {business}, {email}), seconds between emails, daily limit.',
      parameters: obj({ campaign_id: CAMPAIGN_ID, ai_write: { type: 'boolean', description: 'On: the AI writes each email from the body (used as the instructions/prompt) and the business’s details' }, name: { type: 'string' }, account_id: { type: 'string' }, account_ids: { type: 'array', items: { type: 'string' }, description: 'All the accounts it sends from, in turn (replaces the list)' }, subject: { type: 'string' }, body: { type: 'string' }, seconds_between_emails: { type: 'integer' }, minutes_between_emails: { type: 'number' }, daily_limit: { type: 'integer', description: 'Emails per day per sending account' } }, ['campaign_id']),
      run: (a) => {
        const patch = {};
        if (Array.isArray(a.account_ids)) patch.accountIds = a.account_ids;
        if (typeof a.ai_write === 'boolean') patch.aiWrite = a.ai_write;
        if (a.name != null) patch.name = a.name;
        if (a.account_id != null) patch.accountId = a.account_id;
        if (a.subject != null) patch.subject = a.subject;
        if (a.body != null) patch.body = a.body;
        if (a.seconds_between_emails != null) patch.delaySeconds = a.seconds_between_emails;
        if (a.minutes_between_emails != null) patch.delaySeconds = Math.round(Number(a.minutes_between_emails) * 60);
        if (a.daily_limit != null) patch.dailyLimit = a.daily_limit;
        const r = d.email.campaigns.update(Number(a.campaign_id), patch);
        return r.ok ? { ok: true, campaign: emView(d.email.campaigns.row(Number(a.campaign_id))) } : r;
      },
    },
    {
      name: 'email_category_campaign',
      kind: 'config',
      description: 'The email campaign of a lead category (every category with emails has one, like WhatsApp’s): opens it (created the first time) so its accounts, subject, body or AI prompt can be set with update_email_campaign. Its recipients are the category’s leads with an email, added automatically.',
      parameters: obj({ category: FILTER_PROPS.category }, ['category']),
      run: (a) => {
        const cat = categoryOf(a.category);
        if (!cat.ok || cat.id == null) return cat.ok ? { ok: false, error: 'Say which category.' } : cat;
        const r = d.email.campaigns.categoryCampaign(String(cat.id), cat.name);
        return r.ok ? { ok: true, campaign: emView(d.email.campaigns.row(r.id)) } : r;
      },
    },
    {
      name: 'list_email_category_campaigns',
      kind: 'read',
      description: 'Lead categories with emails, how many can still be emailed, and their email campaign (on/off, sent).',
      parameters: obj({}),
      run: () => ({ ok: true, categories: d.email.campaigns.categoryStats(d.store.listCategories().categories).map((c) => ({ category: c.name, with_email: c.withEmail, not_emailed_yet: c.notEmailed, campaign: c.campaign ? { id: c.campaign.id, status: STATUS_WORDS[c.campaign.status] || c.campaign.status, sent: c.campaign.counts.sent, ai: c.campaign.aiWrite } : null })) }),
    },
    {
      name: 'add_email_sender',
      kind: 'config',
      description: 'Adds one or more email accounts to the accounts a campaign sends from (also while it is running): emails then go out from each in turn.',
      parameters: obj({ campaign_id: CAMPAIGN_ID, account_ids: { type: 'array', items: { type: 'string' } } }, ['campaign_id', 'account_ids']),
      run: (a) => {
        const r = emCampaign(a.campaign_id);
        if (!r.ok) return r;
        const ids = [...new Set([...d.email.campaigns.senders(r.c), ...(a.account_ids || []).map(String)])];
        const u = d.email.campaigns.update(r.c.id, { accountIds: ids });
        return u.ok ? { ok: true, campaign: emView(d.email.campaigns.row(r.c.id)) } : u;
      },
    },
    {
      name: 'remove_email_sender',
      kind: 'config',
      description: 'Removes an email account from the accounts a campaign sends from (at least one must stay).',
      parameters: obj({ campaign_id: CAMPAIGN_ID, account_id: { type: 'string' } }, ['campaign_id', 'account_id']),
      run: (a) => {
        const r = emCampaign(a.campaign_id);
        if (!r.ok) return r;
        const ids = d.email.campaigns.senders(r.c).filter((x) => x !== a.account_id);
        const u = d.email.campaigns.update(r.c.id, { accountIds: ids });
        return u.ok ? { ok: true, campaign: emView(d.email.campaigns.row(r.c.id)) } : u;
      },
    },
    {
      name: 'add_email_attachment',
      kind: 'config',
      description: 'Attaches a file (file_id from list_files) to an email campaign.',
      parameters: obj({ campaign_id: CAMPAIGN_ID, file_id: { type: 'string' } }, ['campaign_id', 'file_id']),
      run: (a) => {
        const r = emCampaign(a.campaign_id);
        if (!r.ok) return r;
        const u = d.email.campaigns.update(r.c.id, { attachments: [...(r.c.config.attachments || []).map((x) => x.id), a.file_id] });
        return u.ok ? { ok: true, campaign: emView(d.email.campaigns.row(r.c.id)) } : u;
      },
    },
    {
      name: 'remove_email_attachment',
      kind: 'config',
      description: 'Removes an attachment from an email campaign, by its name or file id.',
      parameters: obj({ campaign_id: CAMPAIGN_ID, name: { type: 'string' } }, ['campaign_id', 'name']),
      run: (a) => {
        const r = emCampaign(a.campaign_id);
        if (!r.ok) return r;
        const keep = (r.c.config.attachments || []).filter((x) => x.id !== a.name && x.name.toLowerCase() !== String(a.name).toLowerCase());
        const u = d.email.campaigns.update(r.c.id, { attachments: keep.map((x) => x.id) });
        return u.ok ? { ok: true, campaign: emView(d.email.campaigns.row(r.c.id)) } : u;
      },
    },
    {
      name: 'preview_email_recipients',
      kind: 'read',
      description: 'How many leads of a filter would be emailed by a campaign (valid email, not unsubscribed, not emailed before), without adding them.',
      parameters: obj({ campaign_id: CAMPAIGN_ID, ...FILTER_PROPS }, ['campaign_id']),
      run: (a) => {
        const sf = storeFilter(a);
        if (!sf.ok) return sf;
        const r = d.email.campaigns.preview(Number(a.campaign_id), sf.filter);
        return r.ok ? { ok: true, can_be_emailed: r.ready, without_email: r.noEmail, unsubscribed: r.optedOut, emailed_before: r.previous, already_in_campaign: r.already, sample: r.sample } : r;
      },
    },
    {
      name: 'add_email_recipients',
      kind: 'config',
      description: 'Adds leads to an email campaign by filter (category, day, text, lead ids): only valid addresses, never unsubscribed ones, no duplicates. Nothing is sent.',
      parameters: obj({ campaign_id: CAMPAIGN_ID, ...FILTER_PROPS }, ['campaign_id']),
      run: (a) => {
        const sf = storeFilter(a);
        if (!sf.ok) return sf;
        const r = d.email.campaigns.addLeads(Number(a.campaign_id), sf.filter);
        return r.ok ? { ok: true, added: r.added, without_email: r.noEmail, unsubscribed: r.optedOut, emailed_before: r.previous, already_in_campaign: r.already, campaign: emView(d.email.campaigns.row(Number(a.campaign_id))) } : r;
      },
    },
    {
      name: 'pause_campaign',
      kind: 'config',
      description: 'Pauses a running campaign at once (nothing more is sent until it is resumed).',
      parameters: obj({ channel: CHANNEL, campaign_id: CAMPAIGN_ID }, ['channel', 'campaign_id']),
      run: (a) => {
        if (a.channel === 'whatsapp') {
          const r = waCampaign(a.campaign_id);
          if (!r.ok) return r;
          const p = r.o.pause(r.c.id, 'user');
          return p.ok ? { ok: true, campaign: waView(r.o.load(r.c.id), r.o) } : p;
        }
        const p = d.email.campaigns.pause(Number(a.campaign_id), 'user');
        return p.ok ? { ok: true, campaign: emView(d.email.campaigns.row(Number(a.campaign_id))) } : p;
      },
    },
    {
      name: 'stop_search',
      kind: 'config',
      description: 'Stops the lead search that is running now (and the continuous search).',
      parameters: obj({}),
      run: () => d.search.stop(),
    },
    {
      name: 'email_opt_out',
      kind: 'config',
      description: 'Marks an email address as unsubscribed: it is never emailed again by any campaign.',
      parameters: obj({ email: { type: 'string' } }, ['email']),
      run: (a) => d.email.campaigns.optOut(a.email, 'Unsubscribed (assistant)'),
    },
    {
      name: 'check_email_replies',
      kind: 'config',
      description: 'Reads the inboxes of the email accounts now for replies to campaigns; people asking to unsubscribe are opted out. (Also done by itself: new replies are read within seconds.)',
      parameters: obj({}),
      run: async () => {
        const r = await d.email.replies.checkAll();
        return { ok: true, accounts_checked: r.checked, new_replies: r.replies, unsubscribed: r.unsubscribed };
      },
    },
    {
      name: 'test_email_account',
      kind: 'config',
      description: 'Checks that an email account can connect and log in to its SMTP server (sends nothing).',
      parameters: obj({ account_id: { type: 'string' } }, ['account_id']),
      run: async (a) => {
        const r = await d.email.accounts.test(String(a.account_id));
        return r.ok ? { ok: true, status: 'connected' } : { ok: false, error: r.error };
      },
    },

    // ---------------- confirm (only after the user's explicit yes) ----------------
    {
      name: 'reply_to_lead',
      kind: 'confirm',
      description: 'Sends a message to a lead who replied (an Inbox conversation), on the channel they used (email or WhatsApp). Write the message as the user wants it sent to the client. Needs the user’s confirmation.',
      parameters: obj({ conversation_id: { type: 'integer' }, text: { type: 'string' } }, ['conversation_id', 'text']),
      describe: (a) => {
        const t = d.inbox?.thread(a.conversation_id);
        if (!t) return { ok: false, error: `There is no conversation #${a.conversation_id}.` };
        if (!String(a.text || '').trim()) return { ok: false, error: 'Write the message first.' };
        return { ok: true, summary: `Send to ${t.name || t.address} (${t.channel === 'email' ? 'email' : 'WhatsApp'}): “${String(a.text).trim().slice(0, 300)}”` };
      },
      run: (a) => d.inboxReply(Number(a.conversation_id), String(a.text || '')),
    },
    {
      name: 'start_campaign',
      kind: 'confirm',
      description: 'Starts sending a campaign for real (WhatsApp messages or emails to its recipients). Needs the user’s confirmation.',
      parameters: obj({ channel: CHANNEL, campaign_id: CAMPAIGN_ID }, ['channel', 'campaign_id']),
      describe: (a) => {
        if (a.channel === 'whatsapp') {
          const r = waCampaign(a.campaign_id);
          if (!r.ok) return r;
          const v = waView(r.c, r.o);
          if (isPlaceholder(r.c) && !r.c.config.aiWrite) return { ok: false, error: 'This campaign has no message yet.' };
          if (r.c.config.aiWrite && !String(r.c.config.aiPrompt || '').trim()) return { ok: false, error: 'Write the prompt for the AI first.' };
          const acc = d.waAccounts().find((x) => x.id === r.c.config.accountId);
          if (!acc) return { ok: false, error: 'Choose a WhatsApp account for this campaign first.' };
          const queued = (v.by_state.queued || 0) + (v.by_state.active || 0);
          if (!queued) return { ok: false, error: 'This campaign has no recipients waiting: add recipients first.' };
          return { ok: true, summary: `Start the WhatsApp campaign “${v.name}” from ${acc.label}${acc.state === 'open' ? '' : ' (not connected now: it will wait for it)'}: ${queued} recipient${queued === 1 ? '' : 's'}, ${r.c.config.aiWrite ? 'one message per contact written by the AI' : `${v.messages.length} message${v.messages.length === 1 ? '' : 's'}`}${v.voice_files.length ? `, ${v.voice_files.length} voice file${v.voice_files.length === 1 ? '' : 's'}` : ''}${v.files.length ? `, ${v.files.length} file${v.files.length === 1 ? '' : 's'}` : ''}; one contact every ${v.minutes_between_contacts} minutes, at most ${v.daily_limit} a day. Confirming also accepts WhatsApp’s rules on automated messages.` };
        }
        const r = emCampaign(a.campaign_id);
        if (!r.ok) return r;
        const v = emView(r.c);
        if (v.not_ready.length) return { ok: false, error: v.not_ready.join(' ') };
        if (!v.remaining && !r.c.category) return { ok: false, error: 'This campaign has nobody left to email: add recipients first.' };
        return { ok: true, summary: `Start the email campaign “${v.name}” from ${v.sending_accounts.map((x) => x.email).join(', ')}: ${v.remaining} recipient${v.remaining === 1 ? '' : 's'}, subject “${v.subject}”${v.attachments.length ? `, ${v.attachments.length} attachment${v.attachments.length === 1 ? '' : 's'}` : ''}; one email every ${v.minutes_between_emails} minute${v.minutes_between_emails === 1 ? '' : 's'}${v.sending_accounts.length > 1 ? ' per account' : ''}, at most ${v.daily_limit} a day${v.sending_accounts.length > 1 ? ' per account' : ''}.` };
      },
      run: async (a) => {
        if (a.channel === 'whatsapp') {
          const r = waCampaign(a.campaign_id);
          if (!r.ok) return r;
          if (r.c.config.test) {
            const live = r.o.configure(r.c.id, { test: false });
            if (!live.ok) return live;
          }
          const s = await d.waStart(r.c.id, { acknowledge: true });
          return s.ok ? { ok: true, started: true, campaign: waView(r.o.load(r.c.id), r.o) } : s;
        }
        const plan = d.requirePlan();
        if (!plan.ok) return plan;
        const s = await d.email.campaigns.start(Number(a.campaign_id));
        return s.ok ? { ok: true, started: true, campaign: emView(d.email.campaigns.row(Number(a.campaign_id))) } : s;
      },
    },
    {
      name: 'resume_campaign',
      kind: 'confirm',
      description: 'Resumes a paused campaign (sending starts again). Needs the user’s confirmation.',
      parameters: obj({ channel: CHANNEL, campaign_id: CAMPAIGN_ID }, ['channel', 'campaign_id']),
      describe: (a) => {
        if (a.channel === 'whatsapp') {
          const r = waCampaign(a.campaign_id);
          if (!r.ok) return r;
          if (r.c.status !== 'paused') return { ok: false, error: 'That campaign is not paused.' };
          return { ok: true, summary: `Resume the WhatsApp campaign “${r.c.name}” (sending starts again).` };
        }
        const r = emCampaign(a.campaign_id);
        if (!r.ok) return r;
        if (r.c.status !== 'paused') return { ok: false, error: 'That campaign is not paused.' };
        return { ok: true, summary: `Resume the email campaign “${r.c.name}”: ${d.email.campaigns.counts(r.c.id).remaining} emails left to send.` };
      },
      run: async (a) => {
        if (a.channel === 'whatsapp') {
          const s = await d.waResume(Number(a.campaign_id));
          return s.ok ? { ok: true, resumed: true } : s;
        }
        const plan = d.requirePlan();
        if (!plan.ok) return plan;
        const s = await d.email.campaigns.resume(Number(a.campaign_id));
        return s.ok ? { ok: true, resumed: true, campaign: emView(d.email.campaigns.row(Number(a.campaign_id))) } : s;
      },
    },
    {
      name: 'stop_campaign',
      kind: 'confirm',
      description: 'Stops a campaign (it sends nothing more). Needs the user’s confirmation.',
      parameters: obj({ channel: CHANNEL, campaign_id: CAMPAIGN_ID }, ['channel', 'campaign_id']),
      describe: (a) => {
        const r = a.channel === 'whatsapp' ? waCampaign(a.campaign_id) : emCampaign(a.campaign_id);
        if (!r.ok) return r;
        return { ok: true, summary: `Stop the ${a.channel === 'whatsapp' ? 'WhatsApp' : 'email'} campaign “${r.c.name}”.` };
      },
      run: (a) => {
        if (a.channel === 'whatsapp') {
          const r = waCampaign(a.campaign_id);
          return r.ok ? r.o.stop(r.c.id) : r;
        }
        return d.email.campaigns.stop(Number(a.campaign_id));
      },
    },
    {
      name: 'retry_failed',
      kind: 'confirm',
      description: 'Sends again to the recipients a campaign failed to reach. Needs the user’s confirmation.',
      parameters: obj({ channel: CHANNEL, campaign_id: CAMPAIGN_ID }, ['channel', 'campaign_id']),
      describe: (a) => {
        if (a.channel === 'whatsapp') {
          const r = waCampaign(a.campaign_id);
          if (!r.ok) return r;
          const n = r.o.store.contacts(r.c.id).filter((x) => x.state === 'failed').length;
          if (!n) return { ok: false, error: 'This campaign has no failed recipients.' };
          return { ok: true, summary: `Retry the ${n} failed recipient${n === 1 ? '' : 's'} of the WhatsApp campaign “${r.c.name}”.` };
        }
        const r = emCampaign(a.campaign_id);
        if (!r.ok) return r;
        const n = d.email.campaigns.counts(r.c.id).failed;
        if (!n) return { ok: false, error: 'This campaign has no failed recipients.' };
        return { ok: true, summary: `Email again the ${n} failed recipient${n === 1 ? '' : 's'} of “${r.c.name}”${r.c.status === 'running' ? '' : ' (when the campaign runs)'}.` };
      },
      run: (a) => {
        if (a.channel === 'whatsapp') {
          const r = waCampaign(a.campaign_id);
          if (!r.ok) return r;
          let n = 0;
          for (const x of r.o.store.contacts(r.c.id).filter((c) => c.state === 'failed')) {
            r.o.store.setContact(r.c.id, x.phone, { state: x.stage > 0 ? 'active' : 'queued', attempts: 0, retryAt: null, note: null }, Date.now());
            n++;
          }
          r.o.emit('change', { id: r.c.id });
          r.o.kick();
          return { ok: true, requeued: n };
        }
        return d.email.campaigns.retryFailed(Number(a.campaign_id));
      },
    },
    {
      name: 'send_test_email',
      kind: 'confirm',
      description: 'Sends one test email of a campaign to an address (default: the sending account itself).',
      parameters: obj({ campaign_id: CAMPAIGN_ID, to: { type: 'string' } }, ['campaign_id']),
      describe: (a) => {
        const r = emCampaign(a.campaign_id);
        if (!r.ok) return r;
        const errs = d.email.campaigns.problems(r.c);
        if (errs.length) return { ok: false, error: errs.join(' ') };
        return { ok: true, summary: `Send a test email of “${r.c.name}” to ${a.to || d.email.accounts.get(r.c.accountId).email}.` };
      },
      run: (a) => d.email.campaigns.sendTest(Number(a.campaign_id), a.to),
    },
    {
      name: 'start_lead_search',
      kind: 'confirm',
      description: 'Starts a lead search with the Leads tab’s engine: Google Maps and/or Facebook (a business type, in a country or city) and/or LinkedIn in one of its modes: "connections" (the user’s own LinkedIn connections and their Contact info, no search words needed), "link" (a LinkedIn page the user gives, e.g. search results, with the pages to read), "people", "jobs", "posts", "companies" (with LinkedIn search words). Google Maps alone in several countries runs one country after another. Needs the user’s confirmation.',
      parameters: obj({
        sources: { type: 'array', items: { type: 'string', enum: ['maps', 'facebook', 'linkedin'] }, description: 'Where to search' },
        business: { type: 'string', description: 'Google Maps / Facebook: the kind of business, e.g. "real estate agency"' },
        countries: { type: 'array', items: { type: 'string' }, description: 'Google Maps / Facebook: country or city (several: Google Maps only, one after another)' },
        linkedin_mode: { type: 'string', enum: ['connections', 'link', 'people', 'jobs', 'posts', 'companies'] },
        linkedin_search: { type: 'string', description: 'LinkedIn people/jobs/posts/companies: the search words, e.g. "SEO"' },
        location: { type: 'string', description: 'LinkedIn people: where (e.g. "USA")' },
        link: { type: 'string', description: 'LinkedIn link mode: the page address' },
        from_page: { type: 'integer', description: 'LinkedIn link mode: first page (default 1)' },
        to_page: { type: 'integer', description: 'LinkedIn link mode: last page (default = from_page)' },
        category: { type: 'string', description: 'Lead category to save the leads in (optional)' },
        website: { type: 'string', enum: ['without', 'with', 'all'], description: 'Google Maps: businesses without a website (default), with one, or all' },
      }, ['sources']),
      describe: (a) => {
        const src = (a.sources || []).filter((x) => ['maps', 'facebook', 'linkedin'].includes(x));
        if (!src.length) return { ok: false, error: 'Say where to search: Google Maps, Facebook or LinkedIn.' };
        const status = d.search.status();
        if (status.running) return { ok: false, error: `A search is already running (“${status.keyword || 'a search'}”). Stop it first, or wait for it to finish.` };
        const parts = [];
        const where = (a.countries || []).filter(Boolean);
        if (src.includes('maps') || src.includes('facebook')) {
          if (trimText(a.business, 80).length < 2) return { ok: false, error: 'Say what kind of business to search for on Google Maps / Facebook.' };
          parts.push(`${[src.includes('maps') && 'Google Maps', src.includes('facebook') && 'Facebook'].filter(Boolean).join(' and ')} for “${trimText(a.business, 80)}”${where.length ? ` in ${where.join(', ')}` : ''}`);
        }
        if (src.includes('linkedin')) {
          const mode = a.linkedin_mode || 'people';
          if (mode === 'connections') parts.push('LinkedIn: your connections (each profile and its Contact info)');
          else if (mode === 'link') {
            if (!/linkedin\.com\//i.test(String(a.link || ''))) return { ok: false, error: 'Give the address of the LinkedIn page to read.' };
            const from = Math.max(1, Number(a.from_page) || 1);
            const to = Math.max(from, Number(a.to_page) || from);
            parts.push(`LinkedIn page ${String(a.link).slice(0, 120)}, page${to > from ? `s ${from}-${to}` : ` ${from}`}`);
          } else {
            if (trimText(a.linkedin_search || a.business, 80).length < 2) return { ok: false, error: 'Say what to search for on LinkedIn.' };
            parts.push(`LinkedIn ${mode} for “${trimText(a.linkedin_search || a.business, 80)}”${mode === 'people' && a.location ? ` in ${a.location}` : ''}`);
          }
        }
        return { ok: true, summary: `Start a lead search: ${parts.join('; ')}${a.category ? `, leads saved in “${a.category}”` : ''}.` };
      },
      run: (a) =>
        d.search.run({
          sources: a.sources,
          business: trimText(a.business, 80),
          countries: (a.countries || []).map((c) => trimText(c, 40)).filter(Boolean).slice(0, 20),
          linkedinMode: a.linkedin_mode,
          linkedinSearch: trimText(a.linkedin_search, 120),
          location: trimText(a.location, 80),
          link: trimText(a.link, 2000),
          fromPage: a.from_page,
          toPage: a.to_page,
          category: trimText(a.category, 60),
          website: a.website,
        }),
    },
    {
      name: 'delete_campaign',
      kind: 'confirm',
      description: 'Deletes a campaign that is not running, with its history. Needs the user’s confirmation.',
      parameters: obj({ channel: CHANNEL, campaign_id: CAMPAIGN_ID }, ['channel', 'campaign_id']),
      describe: (a) => {
        const r = a.channel === 'whatsapp' ? waCampaign(a.campaign_id) : emCampaign(a.campaign_id);
        if (!r.ok) return r;
        if (r.c.status === 'running') return { ok: false, error: 'Pause or stop the campaign before deleting it.' };
        return { ok: true, summary: `Delete the ${a.channel === 'whatsapp' ? 'WhatsApp' : 'email'} campaign “${r.c.name}” and its history.` };
      },
      run: (a) => {
        if (a.channel === 'whatsapp') {
          const r = waCampaign(a.campaign_id);
          return r.ok ? r.o.remove([r.c.id]) : r;
        }
        return d.email.campaigns.remove(Number(a.campaign_id));
      },
    },
    {
      name: 'delete_leads',
      kind: 'confirm',
      description: 'Deletes leads (by ids, or all leads of a filter). Needs the user’s confirmation.',
      parameters: obj(FILTER_PROPS),
      describe: (a) => {
        const sf = storeFilter(a);
        if (!sf.ok) return sf;
        if (!Object.keys(sf.filter).length) return { ok: false, error: 'Say which leads to delete (a category, a day or lead ids); all leads are never deleted this way.' };
        const n = d.store.countLeads(sf.filter);
        if (!n) return { ok: false, error: 'No leads match.' };
        return { ok: true, summary: `Delete ${n} lead${n === 1 ? '' : 's'}${sf.category?.name ? ` of “${sf.category.name}”` : ''}. This cannot be undone.` };
      },
      run: (a) => {
        const sf = storeFilter(a);
        if (!sf.ok || !Object.keys(sf.filter).length) return { ok: false, error: 'Nothing deleted.' };
        return { ok: true, deleted: d.store.deleteFiltered(sf.filter) };
      },
    },
    {
      name: 'update_settings',
      kind: 'confirm',
      description: 'Changes settings: continuous search on/off and its countries, notifications, background engine. Needs the user’s confirmation.',
      parameters: obj({ continuous_search: { type: 'boolean' }, countries: { type: 'array', items: { type: 'string' } }, notifications: { type: 'boolean' }, background: { type: 'boolean' } }),
      describe: (a) => {
        const parts = [];
        if (a.continuous_search != null) parts.push(`continuous search ${a.continuous_search ? 'on' : 'off'}`);
        if (Array.isArray(a.countries)) parts.push(`countries: ${a.countries.join(', ') || 'none'}`);
        if (a.notifications != null) parts.push(`notifications ${a.notifications ? 'on' : 'off'}`);
        if (a.background != null) parts.push(`background engine ${a.background ? 'on' : 'off'}`);
        if (!parts.length) return { ok: false, error: 'Nothing to change.' };
        return { ok: true, summary: `Change settings: ${parts.join('; ')}.` };
      },
      run: (a) => {
        const patch = {};
        if (a.notifications != null) patch.notifications = Boolean(a.notifications);
        if (a.background != null) patch.background = Boolean(a.background);
        if (a.continuous_search != null || Array.isArray(a.countries)) patch.search = { ...(a.continuous_search != null ? { continuous: Boolean(a.continuous_search) } : {}), ...(Array.isArray(a.countries) ? { countries: a.countries } : {}) };
        return d.settings.set(patch);
      },
    },
  ];
  return tools;
}

// The tools as Groq expects them.
function toolSpecs(tools) {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.kind === 'confirm' ? `${t.description} (The app asks the user to confirm; call it once everything is ready.)` : t.description, parameters: t.parameters } }));
}

module.exports = { buildTools, toolSpecs };
