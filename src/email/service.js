'use strict';

// Email campaigns in the app: the accounts, the campaign engine and the
// window's calls (IPC). The window gets account details without passwords;
// passwords go in once (add / edit) and stay in the main process.

const { EmailAccounts } = require('./accounts');
const { EmailCampaigns } = require('./campaigns');
const { ReplyWatcher, imapInbox, watchInbox } = require('./replies');
const { EmailVerification } = require('./verification');
const { extractAccounts, providerFor } = require('./credentials');
const { ClickTracker } = require('./tracking');
const { parseRecipients, tableToLines } = require('./recipients-import');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// The tracking file for the user's website, and the Cloudflare Worker.
const TRACKER_FILES = { php: path.join(__dirname, '..', '..', 'server', 'click-tracker', 'index.php'), worker: path.join(__dirname, '..', '..', 'server', 'click-tracker', 'worker.js') };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// A Leads-table filter from the window or the assistant, checked.
function leadFilter(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  if (f.category === 'none' || (f.category != null && f.category !== 'all' && Number.isInteger(Number(f.category)))) out.category = f.category === 'none' ? 'none' : Number(f.category);
  for (const k of ['date', 'from', 'to']) if (typeof f[k] === 'string' && DATE.test(f[k])) out[k] = f[k];
  if (typeof f.search === 'string' && f.search.trim()) out.search = f.search.trim().slice(0, 100);
  if (['with', 'without'].includes(f.website)) out.website = f.website;
  if (['maps', 'facebook', 'linkedin', 'podcast', 'import'].includes(f.source)) out.source = f.source;
  if (Array.isArray(f.ids)) out.ids = f.ids.map(Number).filter(Number.isInteger).slice(0, 1000);
  if (['valid', 'invalid', 'risky', 'unknown', 'catch_all', 'checking'].includes(f.verify)) out.verify = f.verify;
  return out;
}

// makeVerifyEngine(opts) -> EmailVerifier (tests: one asking a local mail server).
function createEmail({ store, vault, files, canSend, allowInsecure = false, log = () => {}, fetch = globalThis.fetch, makeVerifyEngine = undefined }) {
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
  // Every address is verified before any campaign email goes to it.
  const verification = new EmailVerification({
    db: store.db,
    state: { get: (k) => store.getState(k), set: (k, v) => store.setState(k, v) },
    vault,
    ...(makeVerifyEngine ? { makeEngine: makeVerifyEngine } : {}),
    // Saved leads' emails never checked (new leads): checked in the background.
    newEmails: (limit) =>
      store.db
        .prepare("SELECT DISTINCT lower(trim(b.email)) AS e FROM businesses b WHERE b.email LIKE '%_@_%._%' AND NOT EXISTS (SELECT 1 FROM email_verifications v WHERE v.email = lower(trim(b.email))) LIMIT ?")
        .all(limit)
        .map((r) => r.e),
    sender: () => accounts.list()[0]?.email || '',
    log,
  });
  campaigns.verification = verification;
  verification.on('verified', (list) => campaigns.applyVerification(list.map((x) => x.email)));
  verification.on('policy', () => {
    campaigns.applyVerification(null);
    campaigns.kick();
  });
  // Link clicks, fetched from the user's tracking address.
  const tracker = new ClickTracker({ state: { get: (k) => store.getState(k), set: (k, v) => store.setState(k, v) }, vault, fetch, allowInsecure, log });
  tracker.onClick = (c) => campaigns.recordClick(c);
  campaigns.tracker = tracker;
  // Replies and unsubscribes, from each account's own inbox.
  const replies = new ReplyWatcher({ accounts, campaigns, state: { get: (k) => store.getState(k), set: (k, v) => store.setState(k, v) }, openInbox: (login, since) => imapInbox(login, since, { allowInsecure }), openWatch: (login, on) => watchInbox(login, on, { allowInsecure }), log });
  // An account's first campaign (or test) email: its inbox is watched from then on.
  let liveSync = null;
  campaigns.on('change', () => {
    if (liveSync) return;
    liveSync = setTimeout(() => {
      liveSync = null;
      replies.syncLive();
    }, 3_000);
    liveSync.unref?.();
  });
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

  // People to email, given as text (one or many, in Lead Finder or not):
  // each address not saved yet becomes a lead (source "Imported", so
  // replies, the Inbox and AI writing work for them too), then all of them
  // are added to the campaign: target { id } or { name } (a new campaign).
  function importRecipients(text, target = {}) {
    const { list, invalid } = parseRecipients(text);
    if (!list.length) return { ok: false, error: invalid ? 'Those email addresses are not valid.' : 'No email address found. Write one per line: email, name, business (name and business are optional).' };
    let cid = Number(target.id) || null;
    if (cid) {
      const c = campaigns.row(cid);
      if (!c) return { ok: false, error: 'That email campaign no longer exists.' };
    } else {
      const name = String(target.name || '').trim();
      if (name.length < 2) return { ok: false, error: 'Give the new campaign a name.' };
      const r = campaigns.create({ name });
      if (!r.ok) return r;
      cid = r.id;
    }
    // Leads already saved with that address are used as they are.
    const byEmail = new Map();
    for (const l of store.listLeads({})) for (const e of [l.email, ...(l.emails || []).map((x) => (typeof x === 'string' ? x : x?.email))]) if (e && !byEmail.has(String(e).toLowerCase())) byEmail.set(String(e).toLowerCase(), l.id);
    const ids = [];
    let newLeads = 0;
    for (const r of list) {
      let id = byEmail.get(r.email);
      if (!id) {
        const key = crypto.createHash('sha1').update(`email|${r.email}`).digest('hex').slice(0, 24);
        const saved = store.importLead({ placeKey: `im:${key}`, name: (r.business || r.name || r.email).slice(0, 200), contactName: r.name || '', email: r.email, categoryId: null, keyword: 'Imported emails' });
        if (!saved?.lead) continue;
        id = saved.lead.id;
        if (saved.isNewLead) newLeads++;
        byEmail.set(r.email, id);
      }
      ids.push(id);
    }
    const out = { added: 0, already: 0, optedOut: 0, previous: 0, unverified: 0, overLimit: 0 };
    for (let i = 0; i < ids.length; i += 1000) {
      // Also into a running campaign (category ones too): these people were
      // chosen one by one, so they go to the top of the waiting list.
      const r = campaigns.addLeads(cid, { ids: ids.slice(i, i + 1000) }, { internal: true, first: true });
      if (!r.ok) return r;
      for (const k of Object.keys(out)) out[k] += r[k] || 0;
    }
    // Already waiting in this campaign: moved to the top too.
    out.movedUp = campaigns.putFirst(cid, list.map((r) => r.email));
    out.already -= out.movedUp;
    log(`email recipients imported: ${out.added} added to campaign ${cid}, ${newLeads} new leads`); // never the addresses
    return { ok: true, campaignId: cid, found: list.length, invalid, newLeads, ...out, campaign: campaigns.summary(cid) };
  }

  return { accounts, campaigns, replies, tracker, verification, addFromText, importRecipients };
}

// IPC: handle(channel, fn) is main.js's ipcMain.handle wrapper.
function registerEmailIpc({ handle, email, requirePlan, pickFiles, send, listCategories = () => [], saveFile = null, pickTable = null }) {
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
  // Reads the account's inbox for replies now (also live, and every 3 minutes).
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
    if (typeof p.trackClicks === 'boolean') clean.trackClicks = p.trackClicks;
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
  // People to email: pasted / typed, or read from a CSV or Excel file first.
  handle('email:recipientsFile', async () => {
    if (!pickTable) return { ok: false, error: 'Opening files is not available.' };
    const t = await pickTable({ title: 'Import people to email' });
    if (!t.ok) return t;
    const r = tableToLines(t.columns, t.rows);
    return r.ok ? { ok: true, file: t.file, text: r.lines.join('\n'), count: r.lines.length } : r;
  });
  handle('email:importRecipients', (text, target) => {
    const tg = target && typeof target === 'object' ? { id: id(target.id), name: str(target.name).slice(0, 80) } : {};
    return email.importRecipients(str(text).slice(0, 2_000_000), tg);
  });

  // Click tracking: the tracking address, its files, clicks now.
  const { tracker } = email;
  // Email verification: its status (counts, progress, settings; never the Reacher secret).
  const { verification } = email;
  let verifySend = null;
  verification.on('change', () => {
    if (verifySend) return;
    verifySend = setTimeout(() => {
      verifySend = null;
      send('email:verify', verification.status());
    }, 500);
    verifySend.unref?.();
  });
  handle('email:verifyStatus', () => ({ ok: true, status: verification.status(), log: verification.logs(60) }));
  handle('email:verifySave', (patch) => {
    const p = patch && typeof patch === 'object' ? patch : {};
    const allow = p.allow && typeof p.allow === 'object' ? { risky: p.allow.risky === true, unknown: p.allow.unknown === true, catch_all: p.allow.catch_all === true } : undefined;
    const r = verification.save({ engine: str(p.engine) || undefined, reacherUrl: typeof p.reacherUrl === 'string' ? p.reacherUrl.slice(0, 500) : undefined, secret: typeof p.secret === 'string' ? p.secret : undefined, allow, roleRisky: typeof p.roleRisky === 'boolean' ? p.roleRisky : undefined });
    if (r.ok) send('email:state', { id: null });
    return r.ok ? { ok: true, status: verification.status() } : r;
  });
  // Checked again now: these statuses (or all).
  handle('email:verifyRecheck', (statuses) => ({ ok: true, queued: verification.recheck(Array.isArray(statuses) ? statuses.map(str) : null) }));
  // One address checked now (the settings' "Test an address").
  handle('email:verifyCheck', async (raw) => {
    const e = str(raw).trim().toLowerCase().slice(0, 254);
    if (!e.includes('@')) return { ok: false, error: 'Enter an email address.' };
    verification.enqueue([e], { priority: 9, force: true });
    const r = await verification.ensure([e], { timeout: 120_000 });
    return { ok: true, email: e, result: r.get(e) || null, allowed: verification.allows(e) };
  });
  handle('email:verifyLookup', (list) => {
    const emails = Array.isArray(list) ? list.slice(0, 5000).map(str) : [];
    return { ok: true, results: Object.fromEntries(verification.lookup(emails)) };
  });
  tracker.on('change', () => send('email:tracking', tracker.status()));
  handle('email:tracking', () => ({ ok: true, status: tracker.status() }));
  handle('email:trackingConnect', async (base) => {
    const r = await tracker.connect(str(base).slice(0, 500));
    if (r.ok) send('email:state', { id: null });
    return r;
  });
  handle('email:trackingDisconnect', () => {
    const r = tracker.disconnect();
    send('email:state', { id: null });
    return r;
  });
  handle('email:trackingCheck', async () => {
    const r = await tracker.poll();
    if (r.skipped) return { ok: false, error: 'Click tracking is not connected.' };
    return r.ok ? { ok: true, clicks: r.clicks } : { ok: false, error: `Clicks not checked: ${r.error}.` };
  });
  // kind 'php': saved where the user chooses (to upload); 'worker': its code (to paste).
  handle('email:trackingFile', async (kind) => {
    if (kind === 'worker') return { ok: true, code: fs.readFileSync(TRACKER_FILES.worker, 'utf8') };
    if (!saveFile) return { ok: false, error: 'Saving files is not available.' };
    return saveFile({ title: 'Save the click tracking file', defaultName: 'index.php', data: fs.readFileSync(TRACKER_FILES.php) });
  });
  handle('email:clicks', withCampaign((cid, address) => ({ ok: true, clicks: campaigns.clicksOf(cid, str(address).toLowerCase()) })));
}

module.exports = { createEmail, registerEmailIpc, leadFilter };
