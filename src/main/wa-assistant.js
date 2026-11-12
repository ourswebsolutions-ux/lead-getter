'use strict';

// The WhatsApp assistant: the administrator manages Lead Finder by WhatsApp,
// from their own number, through any of the WhatsApp accounts connected to
// Lead Finder. Messages from any other number are never treated as commands.
//
// It watches the connected accounts and their campaigns. When an account is
// connected but has no campaign, it asks the administrator what to do with
// it: first a lead category that has never had a campaign, then a new
// search. Nothing is sent to leads until the administrator has answered
// every question and confirmed the summary, which includes WhatsApp's rules
// on automated messages. The existing campaign engine then does the sending
// with its own safety rules (one contact at a time, daily limit, delays,
// quiet hours, no one messaged twice, opt-outs respected).
//
// It has no screen of its own: the admin number is set in Settings, and
// everything else is done by WhatsApp ("suggestions on/off", "computer
// shutdown on/off" change its settings; "admin off" removes the number).
//
// Commands (any time): status, campaigns, accounts, pause, resume, power off,
// help, cancel. Answers: yes / no / cancel / skip and the usual ways of
// saying them. It understands replies by rules (no paid AI service): yes and
// no in English and Roman Urdu, country names, account numbers or names.
// An unclear reply is asked again; nothing starts on a guess.
//
// One conversation at a time per administrator; it lasts 30 minutes without
// a reply, and is kept in the database, so a restart does not lose it.
//
// deps (main.js):
//   send(accountId, phone, text)          a WhatsApp message to the admin
//   accounts()                            [{ id, label, number, ready }]
//   campaigns()                           [{ id, name, status, accountId, live, category, sentToday, queued }]
//   unusedCategories()                    [{ key, name, ready }] never in a campaign, with leads to message
//   categoryMessage(key)                  the saved message 1 of its campaign, or ''
//   startSearch({ keyword, countries })   continuous search, resolves { ok, category: { key, name }, error }
//   startCampaign({ category, accountId, message })  live category campaign, resolves { ok, error }
//   pauseAll() / resumeAll()              resolves { count }
//   status()                              short text
//   powerOff()                            pauses, saves and quits (and shuts down if allowed)
//   settings()                            { admins: ['923001234567'], suggestions, shutdownComputer }
//   setSettings(patch)                    saves them

const KEY = 'assistant.state';
const TIMEOUT = 30 * 60_000;
const ASK_AGAIN = { category: 24 * 3600_000, idle: 6 * 3600_000 };

const COUNTRY_NAMES = {
  pakistan: 'Pakistan', pk: 'Pakistan', uae: 'UAE', 'united arab emirates': 'UAE', emirates: 'UAE', dubai: 'UAE', usa: 'USA', us: 'USA', america: 'USA', 'united states': 'USA',
  uk: 'UK', 'united kingdom': 'UK', england: 'UK', britain: 'UK', oman: 'Oman', qatar: 'Qatar', 'saudi arabia': 'Saudi Arabia', saudi: 'Saudi Arabia', ksa: 'Saudi Arabia',
  canada: 'Canada', australia: 'Australia', germany: 'Germany', france: 'France', kuwait: 'Kuwait', bahrain: 'Bahrain', india: 'India', bangladesh: 'Bangladesh',
  turkey: 'Turkey', malaysia: 'Malaysia', singapore: 'Singapore', ireland: 'Ireland', netherlands: 'Netherlands', italy: 'Italy', spain: 'Spain',
  'new zealand': 'New Zealand', 'south africa': 'South Africa', egypt: 'Egypt', nigeria: 'Nigeria', kenya: 'Kenya',
};

const YES = /^(y|yes|yeah|yep|yup|ok|okay|sure|go|go ahead|start|confirm|confirmed|ji|jee|g|haan|han|haa|ha|hn|theek|thik|theek hai|thik hai|kar do|kr do|krdo|kardo|chalo|done|✅|👍)[.!\s]*$/i;
const NO = /^(n|no|nope|nah|nahi|nahin|nai|na|mat|mat karo|not now|later|❌|👎)[.!\s]*$/i;
const CANCEL = /^(cancel|stop setup|exit|quit|band karo|band kro|chhoro|chodo|rehne do|rehnay do)[.!\s]*$/i;
const SKIP = /^(skip|next|agla|aglay|agle)[.!\s]*$/i;
const COMMANDS = [
  ['help', /^(help|menu|commands|\?)$/i],
  ['status', /^(status|haal|hal)$/i],
  ['campaigns', /^(campaigns?)$/i],
  ['accounts', /^(accounts?|whatsapp accounts?)$/i],
  ['pause', /^(pause|pause all|ruko|roko)$/i],
  ['resume', /^(resume|resume all|continue|chalao)$/i],
  ['power', /^(power ?off|shut ?down|turn off|band|close lead finder)$/i],
  ['suggest-on', /^suggestions? on$/i],
  ['suggest-off', /^suggestions? off$/i],
  ['pc-on', /^(computer|pc) shut ?down on$/i],
  ['pc-off', /^(computer|pc) shut ?down off$/i],
  ['admin-off', /^admin off$/i],
];

const HELP = [
  'Lead Finder commands:',
  '• status: what is running',
  '• campaigns: running campaigns',
  '• accounts: WhatsApp accounts',
  '• pause / resume: all campaigns',
  '• power off: close Lead Finder (asks first)',
  '• cancel: stop the current question',
  '• suggestions on / off: offers for idle accounts',
  '• computer shutdown on / off: power off also shuts down the computer',
  '• admin off: this number stops being the admin',
].join('\n');

const digits = (s) => String(s || '').replace(/\D/g, '');
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Countries named in a reply ("Pakistan, Qatar and UAE"), in order; null if a
// part is not a known country.
function parseCountries(text) {
  const parts = clean(text).toLowerCase().replace(/\band\b|&|\/|;|\+/g, ',').split(',').map((s) => s.trim().replace(/\.$/, '')).filter(Boolean);
  const out = [];
  const unknown = [];
  for (const p of parts) {
    const hit = COUNTRY_NAMES[p] || Object.values(COUNTRY_NAMES).find((n) => n.toLowerCase() === p);
    if (hit) {
      if (!out.includes(hit)) out.push(hit);
    } else unknown.push(p);
  }
  return { countries: out, unknown };
}

class Assistant {
  constructor(deps) {
    this.d = deps;
    this.now = deps.now || (() => Date.now());
    this.log = deps.log || (() => {});
    this.busy = Promise.resolve();
  }

  state() {
    const s = this.d.store.getState(KEY) || {};
    return { convo: s.convo || {}, asked: s.asked || {}, last: s.last || null };
  }

  save(s) {
    this.d.store.setState(KEY, s);
    this.d.onChange?.(this.view());
  }

  // For the Settings page: what the assistant is doing.
  view() {
    const s = this.state();
    const open = Object.entries(s.convo).filter(([, c]) => this.now() - c.at < TIMEOUT);
    return { pending: open.map(([phone, c]) => ({ phone, flow: c.flow, step: c.step, data: c.data })), last: s.last };
  }

  isAdmin(phone) {
    const p = digits(phone);
    return Boolean(p) && (this.d.settings().admins || []).some((a) => digits(a) === p);
  }

  idleAccounts() {
    const busy = new Set(this.d.campaigns().filter((c) => c.live && ['running', 'paused'].includes(c.status)).map((c) => c.accountId));
    return this.d.accounts().filter((a) => a.ready && !busy.has(a.id));
  }

  // The account that talks to the admin: the one they wrote to, else the
  // first connected one.
  replyAccount(preferred) {
    const ready = this.d.accounts().filter((a) => a.ready);
    return ready.find((a) => a.id === preferred) || ready[0] || null;
  }

  async say(phone, text, accountId) {
    const acc = this.replyAccount(accountId);
    if (!acc) return false;
    try {
      await this.d.send(acc.id, phone, text);
      return true;
    } catch (err) {
      this.log(`assistant: message not sent: ${err.message}`);
      return false;
    }
  }

  // --- incoming ------------------------------------------------------------------

  // Every incoming WhatsApp message; true when it was the admin's (handled here).
  onMessage({ accountId, phone, text }) {
    if (typeof text !== 'string' || !text.trim()) return false;
    if (!this.isAdmin(phone)) return false;
    this.busy = this.busy.then(() => this.handle({ accountId, phone: digits(phone), text: clean(text) })).catch((err) => this.log(`assistant: ${err.message}`));
    return true;
  }

  async handle({ accountId, phone, text }) {
    const s = this.state();
    s.last = { at: this.now(), text: text.slice(0, 120) };
    this.log(`assistant: from admin: ${text.slice(0, 120)}`);
    let c = s.convo[phone];
    if (c && this.now() - c.at >= TIMEOUT) {
      delete s.convo[phone];
      c = null;
      this.save(s);
      await this.say(phone, 'The earlier question timed out, so nothing was started.', accountId);
    }
    if (c) c.accountId = accountId || c.accountId;
    const cmd = COMMANDS.find(([, re]) => re.test(text))?.[0];
    if (CANCEL.test(text)) {
      if (c) {
        delete s.convo[phone];
        this.save(s);
        return this.say(phone, 'Cancelled. Nothing was started.', accountId);
      }
      this.save(s);
      return this.say(phone, 'There is nothing to cancel. Send "help" for the commands.', accountId);
    }
    // A command, unless a step is waiting for free text that happens to be one.
    if (cmd && !(c && ['keyword', 'message'].includes(c.step))) {
      this.save(s);
      return this.command(cmd, phone, accountId);
    }
    if (!c) {
      this.save(s);
      return this.say(phone, `I did not understand "${text.slice(0, 60)}".\n\n${HELP}`, accountId);
    }
    c.at = this.now();
    s.convo[phone] = c;
    this.save(s);
    return this.step(phone, c, text);
  }

  setConvo(phone, c) {
    const s = this.state();
    if (c) s.convo[phone] = { ...c, at: this.now() };
    else delete s.convo[phone];
    this.save(s);
  }

  async ask(phone, c, text) {
    this.setConvo(phone, c);
    return this.say(phone, text, c.accountId);
  }

  // --- commands -------------------------------------------------------------------

  async command(cmd, phone, accountId) {
    if (cmd === 'help') return this.say(phone, HELP, accountId);
    if (cmd === 'suggest-on' || cmd === 'suggest-off') {
      this.d.setSettings({ suggestions: cmd === 'suggest-on' });
      return this.say(phone, cmd === 'suggest-on' ? 'Suggestions are on: I will tell you when a WhatsApp account is free.' : 'Suggestions are off. Send "suggestions on" to turn them back on.', accountId);
    }
    if (cmd === 'pc-on' || cmd === 'pc-off') {
      this.d.setSettings({ shutdownComputer: cmd === 'pc-on' });
      return this.say(phone, cmd === 'pc-on' ? '"power off" will now also shut down the computer.' : '"power off" will only close Lead Finder.', accountId);
    }
    if (cmd === 'admin-off') {
      this.d.setSettings({ admins: (this.d.settings().admins || []).filter((a) => digits(a) !== phone) });
      return this.say(phone, 'This number is no longer the Lead Finder admin.', accountId);
    }
    if (cmd === 'status') return this.say(phone, this.d.status(), accountId);
    if (cmd === 'accounts') {
      const idle = new Set(this.idleAccounts().map((a) => a.id));
      const list = this.d.accounts().map((a) => `• ${a.label}${a.number ? ` (${a.number})` : ''}: ${!a.ready ? 'not connected' : idle.has(a.id) ? 'connected, idle' : 'connected, running a campaign'}`);
      return this.say(phone, list.length ? `WhatsApp accounts:\n${list.join('\n')}` : 'No WhatsApp accounts are connected.', accountId);
    }
    if (cmd === 'campaigns') {
      const live = this.d.campaigns().filter((c) => c.live && ['running', 'paused'].includes(c.status));
      const acc = Object.fromEntries(this.d.accounts().map((a) => [a.id, a.label]));
      return this.say(phone, live.length ? `Campaigns:\n${live.map((c) => `• ${c.name} (${acc[c.accountId] || c.accountId}): ${c.status}, ${c.sentToday} sent today, ${c.queued} waiting`).join('\n')}` : 'No campaigns are running.', accountId);
    }
    if (cmd === 'pause') {
      const r = await this.d.pauseAll();
      return this.say(phone, r.count ? `Paused ${r.count} campaign${r.count === 1 ? '' : 's'}. Send "resume" to continue.` : 'No campaign was running.', accountId);
    }
    if (cmd === 'resume') {
      const r = await this.d.resumeAll();
      return this.say(phone, r.count ? `Resumed ${r.count} campaign${r.count === 1 ? '' : 's'}.` : r.error || 'No paused campaign to resume.', accountId);
    }
    if (cmd === 'power') {
      const shutdown = this.d.settings().shutdownComputer;
      return this.ask(phone, { flow: 'power', step: 'confirm', data: {}, accountId }, `Are you sure you want to shut down Lead Finder${shutdown ? ' and this computer' : ''}? All active campaigns will be paused and continue when it starts again.\n\nReply YES to shut down or NO to keep it running.`);
    }
    return null;
  }

  // --- conversations --------------------------------------------------------------

  async step(phone, c, text) {
    const yes = YES.test(text);
    const no = NO.test(text);
    const unclear = (q) => this.say(phone, `Please reply YES or NO.${q ? `\n\n${q}` : ''}`, c.accountId);

    if (c.flow === 'power') {
      if (yes) {
        this.setConvo(phone, null);
        await this.say(phone, `Shutting down Lead Finder${this.d.settings().shutdownComputer ? ' and the computer' : ''}. Campaigns are paused and saved.`, c.accountId);
        await this.d.powerOff();
        return;
      }
      if (no) {
        this.setConvo(phone, null);
        return this.say(phone, 'OK, Lead Finder keeps running.', c.accountId);
      }
      return unclear();
    }

    // A new search for an idle account.
    if (c.flow === 'new') {
      if (c.step === 'confirm') {
        if (no || SKIP.test(text)) {
          this.setConvo(phone, null);
          return this.say(phone, 'OK. I will not ask about this account again for a few hours.', c.accountId);
        }
        if (!yes) return unclear();
        return this.ask(phone, { ...c, step: 'keyword' }, 'Which business keyword should I search for? (for example: shoes shop)');
      }
      if (c.step === 'keyword') {
        if (text.length < 2 || text.length > 120) return this.say(phone, 'Please send a keyword of 2 to 120 characters.', c.accountId);
        return this.ask(phone, { ...c, step: 'countries', data: { ...c.data, keyword: text } }, `Keyword: ${text}\n\nWhich countries should I target? (for example: Pakistan, Qatar, UAE)`);
      }
      if (c.step === 'countries') {
        const { countries, unknown } = parseCountries(text);
        if (!countries.length || unknown.length) return this.say(phone, `${unknown.length ? `I don't know: ${unknown.join(', ')}. ` : ''}Please list the countries, separated by commas (for example: Pakistan, Qatar, UAE).`, c.accountId);
        return this.ask(phone, { ...c, step: 'message', data: { ...c.data, countries } }, `Countries: ${countries.join(', ')}\n\nWhat message should the campaign send? Send the text of message 1. You can use {name} and {business name}.`);
      }
    }

    // An unused category.
    if (c.flow === 'category') {
      if (c.step === 'confirm') {
        if (no || SKIP.test(text)) {
          this.markAsked(`category:${c.data.category.key}`);
          this.setConvo(phone, null);
          // The next unused category, if any.
          return this.suggest({ only: 'category', reply: c.accountId, skipIntro: true });
        }
        if (!yes) return unclear();
        const idle = this.idleAccounts();
        if (!idle.length) {
          this.setConvo(phone, null);
          return this.say(phone, 'No WhatsApp account is free right now. I will ask again when one is.', c.accountId);
        }
        if (idle.length === 1) return this.ask(phone, { ...c, step: 'account1', data: { ...c.data, account: idle[0].id } }, `Use ${idle[0].label}${idle[0].number ? ` (${idle[0].number})` : ''} for this campaign? Reply YES, or NO to cancel.`);
        return this.ask(phone, { ...c, step: 'account', data: { ...c.data, choices: idle.map((a) => a.id) } }, `Which WhatsApp account should handle this campaign?\n${idle.map((a, i) => `${i + 1}. ${a.label}${a.number ? ` (${a.number})` : ''}`).join('\n')}\n\nReply with the number.`);
      }
      if (c.step === 'account1') {
        if (no) {
          this.setConvo(phone, null);
          return this.say(phone, 'Cancelled. Nothing was started.', c.accountId);
        }
        if (!yes) return unclear();
        return this.messageStep(phone, c);
      }
      if (c.step === 'account') {
        const accs = this.d.accounts();
        const n = Number(text.replace(/\D/g, ''));
        const byNumber = Number.isInteger(n) && n >= 1 && n <= c.data.choices.length ? c.data.choices[n - 1] : null;
        const byName = c.data.choices.find((id) => accs.find((a) => a.id === id)?.label.toLowerCase() === text.toLowerCase());
        const id = byNumber || byName;
        if (!id) return this.say(phone, `Please reply with a number from 1 to ${c.data.choices.length}.`, c.accountId);
        return this.messageStep(phone, { ...c, data: { ...c.data, account: id } });
      }
      if (c.step === 'saved') {
        if (yes) return this.ask(phone, { ...c, step: 'final', data: { ...c.data, message: c.data.saved } }, this.summary({ ...c.data, message: c.data.saved }));
        if (no) return this.ask(phone, { ...c, step: 'message' }, 'Send the text of message 1. You can use {name} and {business name}.');
        return unclear();
      }
    }

    if (c.step === 'message') {
      if (text.length < 2 || text.length > 1000) return this.say(phone, 'Please send a message of 2 to 1000 characters.', c.accountId);
      const data = { ...c.data, message: text };
      return this.ask(phone, { ...c, step: 'final', data }, this.summary(data));
    }

    if (c.step === 'final') {
      if (no) {
        this.setConvo(phone, null);
        return this.say(phone, 'Cancelled. Nothing was started.', c.accountId);
      }
      if (!yes) return unclear('Reply YES to start, or NO to cancel.');
      this.setConvo(phone, null);
      return this.launch(phone, c);
    }
    return unclear();
  }

  async messageStep(phone, c) {
    const saved = this.d.categoryMessage(c.data.category.key);
    if (saved) return this.ask(phone, { ...c, step: 'saved', data: { ...c.data, saved } }, `This category already has a campaign message:\n\n"${saved}"\n\nUse it? Reply YES, or NO to send a new one.`);
    return this.ask(phone, { ...c, step: 'message' }, 'What message should the campaign send? Send the text of message 1. You can use {name} and {business name}.');
  }

  summary(d) {
    const acc = this.d.accounts().find((a) => a.id === d.account);
    return [
      'Please confirm:',
      d.category ? `• Leads: ${d.category.name}` : `• Search: ${d.keyword} in ${d.countries.join(', ')} (country after country, until you stop it)`,
      `• WhatsApp: ${acc ? acc.label : d.account}`,
      `• Message: "${d.message}"`,
      '',
      'Messages are sent one contact at a time, with the campaign’s delays and daily limit, never twice to anyone, and never to people who opted out.',
      'By replying YES you confirm that you follow WhatsApp’s rules on automated messages.',
      '',
      'Reply YES to start, or NO to cancel.',
    ].join('\n');
  }

  async launch(phone, c) {
    const d = c.data;
    let category = d.category;
    if (!category) {
      const r = await this.d.startSearch({ keyword: d.keyword, countries: d.countries });
      if (!r.ok) return this.say(phone, `The search could not start: ${r.error}`, c.accountId);
      category = r.category;
    }
    const r = await this.d.startCampaign({ category, accountId: d.account, message: d.message });
    if (!r.ok) return this.say(phone, `The campaign could not start: ${r.error}`, c.accountId);
    this.log(`assistant: campaign started for ${category.name} on ${d.account}`);
    return this.say(phone, d.category ? `Started. "${category.name}" is being messaged from the chosen account. Send "campaigns" for progress.` : `Started. Lead Finder is searching "${d.keyword}" in ${d.countries.join(', ')}; new leads confirmed on WhatsApp join the campaign as they are found. Send "status" for progress.`, c.accountId);
  }

  // --- suggestions ---------------------------------------------------------------

  markAsked(key) {
    const s = this.state();
    s.asked[key] = this.now();
    this.save(s);
  }

  recentlyAsked(key, gap) {
    const at = this.state().asked[key];
    return typeof at === 'number' && this.now() - at < gap;
  }

  // Looks for an idle account and offers work for it: an unused category
  // first, then a new search. One question at a time.
  async suggest({ only = null, reply = null, skipIntro = false } = {}) {
    const st = this.d.settings();
    const admin = (st.admins || [])[0];
    if (!admin || (!st.suggestions && !only)) return null;
    const phone = digits(admin);
    const open = this.state().convo[phone];
    if (open && this.now() - open.at < TIMEOUT) return null;
    const idle = this.idleAccounts();
    if (!idle.length) return null;
    const cat = this.d.unusedCategories().find((x) => x.ready > 0 && !this.recentlyAsked(`category:${x.key}`, ASK_AGAIN.category));
    if (cat) {
      this.markAsked(`category:${cat.key}`);
      return this.ask(phone, { flow: 'category', step: 'confirm', data: { category: { key: cat.key, name: cat.name } }, accountId: reply || idle[0].id }, `I found ${cat.ready} lead${cat.ready === 1 ? '' : 's'} in "${cat.name}" that can be messaged on WhatsApp. This category has not been used in a campaign yet. Would you like me to run this campaign? (YES / NO)`);
    }
    if (only === 'category') return skipIntro ? this.say(phone, 'There are no other unused categories.', reply) : null;
    const acc = idle.find((a) => !this.recentlyAsked(`idle:${a.id}`, ASK_AGAIN.idle));
    if (!acc) return null;
    this.markAsked(`idle:${acc.id}`);
    return this.ask(phone, { flow: 'new', step: 'confirm', data: { account: acc.id }, accountId: acc.id }, `Your WhatsApp account ${acc.label}${acc.number ? ` (${acc.number})` : ''} is currently available. Would you like me to start a new lead generation campaign? (YES / NO)`);
  }
}

module.exports = { Assistant, parseCountries, YES, NO, TIMEOUT };
