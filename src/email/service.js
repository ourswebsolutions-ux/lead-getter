'use strict';

// Email campaigns in the app: the accounts, the campaign engine and the
// window's calls (IPC). The window gets account details without passwords;
// passwords go in once (add / edit) and stay in the main process.

const { EmailAccounts } = require('./accounts');
const { EmailCampaigns } = require('./campaigns');
const { ReplyWatcher, imapInbox } = require('./replies');
const { extractAccounts, providerFor } = require('./credentials');

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// A Leads-table filter from the window or the assistant, checked.
function leadFilter(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  if (f.category === 'none' || (f.category != null && f.category !== 'all' && Number.isInteger(Number(f.category)))) out.category = f.category === 'none' ? 'none' : Number(f.category);
  for (const k of ['date', 'from', 'to']) if (typeof f[k] === 'string' && DATE.test(f[k])) out[k] = f[k];
  if (typeof f.search === 'string' && f.search.trim()) out.search = f.search.trim().slice(0, 100);
  if (['with', 'without'].includes(f.website)) out.website = f.website;
  if (['maps', 'facebook', 'linkedin', 'podcast'].includes(f.source)) out.source = f.source;
  if (Array.isArray(f.ids)) out.ids = f.ids.map(Number).filter(Number.isInteger).slice(0, 1000);
  return out;
}

function createEmail({ store, vault, files, canSend, allowInsecure = false, log = () => {} }) {
  const accounts = new EmailAccounts({ store, vault, allowInsecure });
  const campaigns = new EmailCampaigns({
    db: store.db,
    accounts,
    files,
    leads: (filter) => {
      const f = leadFilter(filter);
      // More than 1000 ids: in chunks (the store's limit per query).
      return store.listLeads(f);
    },
    leadById: (id) => store.leadById(id),
    canSend,
  });
  campaigns.on('error', (err) => log(`email campaigns: ${err.message}`));
  // Replies and unsubscribes, from each account's own inbox.
  const replies = new ReplyWatcher({ accounts, campaigns, state: { get: (k) => store.getState(k), set: (k, v) => store.setState(k, v) }, openInbox: (login, since) => imapInbox(login, since, { allowInsecure }), log });
  // Accounts given as text (pasted, imported, or written to the assistant):
  // each is added (or its password updated), with its provider's settings,
  // and its login tested. The passwords never leave this function except
  // into the vault. Resolves { found, results, redacted }.
  async function addFromText(text, { test = true, resolveMx } = {}) {
    const { accounts: found, redacted } = extractAccounts(text);
    const results = [];
    for (const f of found.slice(0, 50)) {
      const existing = accounts.raw().find((a) => a.email === f.email);
      let r;
      let provider = null;
      if (existing) {
        const pub = accounts.public(existing);
        r = accounts.update(existing.id, { ...pub, senderName: f.name || pub.senderName, password: f.password });
      } else {
        provider = await providerFor(f.email, resolveMx ? { resolveMx } : undefined);
        // End-to-end tests only (plain SMTP allowed, never packaged): every provider is the local test server.
        const testPort = allowInsecure && Number(process.env.LEAD_FINDER_TEST_PROVIDER_PORT);
        if (provider && testPort) provider = { ...provider, host: '127.0.0.1', port: testPort, encryption: 'none', imapHost: '127.0.0.1' };
        if (!provider) {
          results.push({ email: f.email, ok: false, error: 'its email provider is not known: add it with its SMTP server in Outreach > Email > Accounts' });
          continue;
        }
        const local = f.email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\d+/g, '').trim();
        const sender = f.name || local.replace(/\b\w/g, (c) => c.toUpperCase()) || f.email;
        let name = f.email;
        for (let i = 2; accounts.raw().some((a) => a.name.toLowerCase() === name.toLowerCase()); i++) name = `${f.email} (${i})`;
        r = accounts.add({ name, senderName: sender, email: f.email, host: provider.host, port: provider.port, username: f.email, password: f.password, encryption: provider.encryption, imapOn: true, imapHost: provider.imapHost });
      }
      if (!r.ok) {
        results.push({ email: f.email, ok: false, error: r.error });
        continue;
      }
      const t = test ? await accounts.test(r.account.id) : { ok: true };
      const gmailHint = /gmail|google/i.test(provider?.name || r.account.host) && !t.ok && /login/.test(t.error || '') ? ' (Gmail needs an App Password, with 2-Step Verification on)' : '';
      results.push({ email: f.email, id: r.account.id, ok: t.ok, created: !existing, provider: provider?.name || null, error: t.ok ? null : `${String(t.error || '').replace(/^Connection failed: /, '').replace(/\.$/, '')}${gmailHint}` });
    }
    if (found.length) log(`email accounts from text: ${results.filter((x) => x.ok).length} of ${found.length} working`); // never the addresses' passwords
    return { found: found.length, results, redacted };
  }

  return { accounts, campaigns, replies, addFromText };
}

// IPC: handle(channel, fn) is main.js's ipcMain.handle wrapper.
function registerEmailIpc({ handle, email, requirePlan, pickFiles, send, listCategories = () => [] }) {
  const { accounts, campaigns } = email;
  const id = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const withCampaign = (fn) => (raw, ...rest) => {
    const cid = id(raw);
    if (!cid || !campaigns.row(cid)) return { ok: false, error: 'That email campaign no longer exists.' };
    return fn(cid, ...rest);
  };
  const str = (v) => (typeof v === 'string' ? v : '');
  const accountInput = (v) => (v && typeof v === 'object' ? { name: str(v.name), senderName: str(v.senderName), email: str(v.email), host: str(v.host), port: Number(v.port), username: str(v.username), password: str(v.password), encryption: str(v.encryption), imapOn: v.imapOn !== false, imapHost: str(v.imapHost), imapPort: Number(v.imapPort) || 993 } : {});

  campaigns.on('change', (e) => send('email:state', { id: e?.id ?? null }));

  handle('email:accounts', () => ({ ok: true, accounts: accounts.list(), persistent: accounts.vault.persistent }));
  // Account changes reach every open view of the accounts.
  const changed = (r) => (send('email:state', { id: null, accounts: true }), r);
  handle('email:accountAdd', (input) => changed(accounts.add(accountInput(input))));
  handle('email:accountUpdate', (aid, input) => changed(accounts.update(str(aid), accountInput(input))));
  handle('email:accountRemove', (aid) => {
    const used = campaigns.list().find((c) => c.accountIds.includes(str(aid)) && c.status === 'running');
    if (used && used.accountIds.length === 1) return { ok: false, error: `The campaign “${used.name}” is sending from this account. Pause or stop it first.` };
    return changed(accounts.remove(str(aid)));
  });
  handle('email:accountTest', async (aid) => changed(await accounts.test(str(aid))));
  // Several accounts at once: "email, app password[, sender name]" per line.
  handle('email:import', async (text) => {
    const r = await email.addFromText(str(text).slice(0, 100_000));
    changed(r);
    if (!r.found) return { ok: false, error: 'No account found. Write one per line: email, app password (optionally , sender name).' };
    return { ok: true, results: r.results };
  });
  // Reads the account's inbox for replies now (also done every 10 minutes).
  handle('email:checkReplies', async (aid) => {
    const r = await email.replies.check(str(aid));
    changed(r);
    if (r.skipped) return { ok: false, error: 'Nothing to check: reading replies is off for this account, or it has not sent campaign emails yet.' };
    return r.error ? { ok: false, error: `Replies not checked: ${r.error}.` } : { ok: true, replies: r.replies, unsubscribed: r.unsubscribed };
  });

  handle('email:campaigns', () => ({ ok: true, campaigns: campaigns.list(), optOuts: campaigns.optOuts().length }));
  // Category campaigns: every lead category with emails, like WhatsApp's.
  const categoryOf = (key) => {
    if (key === 'none') return { key: 'none', name: 'Uncategorized' };
    const cat = listCategories().find((c) => String(c.id) === String(key));
    return cat ? { key: String(cat.id), name: cat.name } : null;
  };
  handle('email:categories', () => ({ ok: true, categories: campaigns.categoryStats(listCategories()) }));
  handle('email:categoryCampaign', (key) => {
    const cat = categoryOf(str(key));
    return cat ? campaigns.categoryCampaign(cat.key, cat.name) : { ok: false, error: 'That category no longer exists.' };
  });
  handle('email:setCategory', async (key, on) => {
    const cat = categoryOf(str(key));
    if (!cat) return { ok: false, error: 'That category no longer exists.' };
    if (on) {
      const plan = requirePlan();
      if (!plan.ok) return plan;
    }
    return campaigns.setCategoryEnabled(cat.key, cat.name, on === true);
  });
  handle('email:campaign', withCampaign((cid) => ({ ok: true, campaign: campaigns.snapshot(cid) })));
  handle('email:create', (name) => campaigns.create({ name: str(name) }));
  handle('email:update', withCampaign((cid, patch) => {
    const p = patch && typeof patch === 'object' ? patch : {};
    const clean = {};
    for (const k of ['name', 'accountId', 'subject', 'body']) if (typeof p[k] === 'string') clean[k] = p[k];
    for (const k of ['delaySeconds', 'dailyLimit']) if (p[k] != null) clean[k] = Number(p[k]);
    if (typeof p.allowPrevious === 'boolean') clean.allowPrevious = p.allowPrevious;
    if (typeof p.aiWrite === 'boolean') clean.aiWrite = p.aiWrite;
    if (Array.isArray(p.accountIds)) clean.accountIds = p.accountIds.map(String).slice(0, 50);
    if (Array.isArray(p.attachments)) clean.attachments = p.attachments.map((a) => (typeof a === 'string' ? a : str(a?.id))).slice(0, 20);
    return campaigns.update(cid, clean);
  }));
  handle('email:delete', withCampaign((cid) => campaigns.remove(cid)));
  handle('email:preview', withCampaign((cid, filter) => campaigns.preview(cid, leadFilter(filter))));
  handle('email:addLeads', withCampaign((cid, filter) => campaigns.addLeads(cid, leadFilter(filter))));
  handle('email:removeRecipient', withCampaign((cid, address) => campaigns.removeRecipient(cid, str(address))));
  handle('email:clearQueue', withCampaign((cid) => campaigns.clearQueue(cid)));
  handle('email:start', withCampaign((cid) => {
    const plan = requirePlan();
    if (!plan.ok) return plan;
    return campaigns.start(cid);
  }));
  handle('email:pause', withCampaign((cid) => campaigns.pause(cid, 'user')));
  handle('email:resume', withCampaign((cid) => {
    const plan = requirePlan();
    if (!plan.ok) return plan;
    return campaigns.resume(cid);
  }));
  handle('email:stop', withCampaign((cid) => campaigns.stop(cid)));
  handle('email:retry', withCampaign((cid, includeUncertain) => campaigns.retryFailed(cid, { includeUncertain: includeUncertain === true })));
  handle('email:test', withCampaign((cid, to) => campaigns.sendTest(cid, str(to))));
  handle('email:render', withCampaign((cid, subject, body) => campaigns.render(cid, { subject: typeof subject === 'string' ? subject : undefined, body: typeof body === 'string' ? body : undefined })));
  handle('email:optOuts', () => ({ ok: true, optOuts: campaigns.optOuts() }));
  handle('email:optOut', (address) => campaigns.optOut(str(address)));
  handle('email:removeOptOut', (address) => campaigns.removeOptOut(str(address)));
  handle('email:attach', async () => pickFiles({ title: 'Attach files to the email' }));
}

module.exports = { createEmail, registerEmailIpc, leadFilter };
