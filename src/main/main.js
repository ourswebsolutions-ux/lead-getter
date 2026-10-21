'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } = require('electron');
const { LeadStore, DATE_RE, formatCategory } = require('../database/db');
const { E164 } = require('../database/phone');
const { leadsToCsv } = require('../export/csv');
const { ChromeConnection, ChromeError, ConnectCancelled } = require('../browser/chrome');
const { SearchSession, WEBSITE_FILTERS } = require('../browser/search-session');
const { AppLock } = require('./applock');
const { LicenseClient, readScreenshot } = require('./license');

const DEV_URL = process.env.VITE_DEV_SERVER_URL || '';
const RENDERER_FILE = path.join(__dirname, '..', '..', 'dist', 'renderer', 'index.html');

// Test runs point the app at throwaway data directories.
if (process.env.LEAD_FINDER_USER_DATA) app.setPath('userData', process.env.LEAD_FINDER_USER_DATA);

let win = null;
let store = null;
let search = null; // { controller, promise }
const chrome = new ChromeConnection({
  onStatus: (message) => sendStatus({ state: 'connecting', phase: 'connection', step: 'connecting', message }),
  // Chrome refuses chrome:// addresses from other programs, so the setup
  // address is put on the clipboard for the user to paste.
  onNeedsToggle: ({ url }) => clipboard.writeText(url),
  confirmRestart: async ({ profileName, reason }) => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Restart Chrome', 'Not now'],
      defaultId: 0,
      cancelId: 1,
      title: 'Restart Chrome?',
      message: `Lead Finder needs to restart Chrome${reason ? ` ${reason}` : ''}.`,
      detail:
        `Chrome closes normally and reopens with the same profile ("${profileName}"), and your tabs are restored. ` +
        'Your login, cookies, bookmarks and extensions are not changed. Unsaved text in open pages may be lost.',
    });
    return response === 0;
  },
});
const tabs = { main: null, check: null, detail: null };
let lastStatus = { state: 'idle', message: 'Ready' };
let interrupted = null; // last search, if the app ended while it was running

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function sendStatus(status) {
  lastStatus = { ...lastStatus, ...status };
  if (status.state && !('errorCode' in status)) lastStatus.errorCode = null;
  send('search:status', lastStatus);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 760,
    minHeight: 480,
    title: 'Lead Finder',
    autoHideMenuBar: true,
    backgroundColor: '#f7f7f5',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.setMenu(null);
  // The window only ever shows the bundled UI.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(RENDERER_FILE);
}

// IPC is only accepted from our own renderer document.
function trustedSender(event) {
  const url = event.senderFrame?.url || '';
  if (DEV_URL) return url.startsWith(DEV_URL);
  return url.startsWith('file://') && decodeURIComponent(new URL(url).pathname).endsWith('/dist/renderer/index.html');
}

// Until the PIN is entered, only the lock screen's own calls are answered;
// everything else is refused here in the main process, so reloading or
// manipulating the window cannot reach leads or features.
const LOCK_FREE = new Set(['lock:state', 'lock:setup', 'lock:unlock']);

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender');
    if (!LOCK_FREE.has(channel) && !appLock?.unlocked) throw new Error('Locked');
    return fn(...args);
  });
}

// --- subscription ------------------------------------------------------------

let appLock = null;
let license = null;
let pendingShot = null; // screenshot chosen in the file dialog, kept in the main process

// Installers carry release-config.json (written by `npm run release`, pointing
// at the hosted licence server); development uses license-config.json.
function licenseConfig() {
  let file = {};
  for (const name of app.isPackaged ? ['./release-config.json', './license-config.json'] : ['./license-config.json']) {
    try {
      file = require(name);
      break;
    } catch {}
  }
  return {
    serverUrl: process.env.LEAD_FINDER_LICENSE_URL || file.serverUrl,
    publicKey: process.env.LEAD_FINDER_LICENSE_PUBKEY || file.publicKey,
  };
}

// Asks the licence server (signed, fresh) whether paid features may be used.
async function requireSubscription() {
  const st = await license.status();
  sendSubscription(st);
  return st.allowed ? { ok: true } : { ok: false, subscription: st.reason, error: st.message };
}

// Searching: an active subscription, or free trial searches left.
async function requireSearchAccess() {
  const st = await license.status();
  sendSubscription(st);
  if (st.allowed) return { ok: true, trial: false };
  if (st.canSearch) return { ok: true, trial: true };
  return { ok: false, subscription: st.reason, error: st.message };
}

function sendSubscription(st) {
  send('subscription:status', publicStatus(st));
}

function publicStatus(st) {
  return st && { allowed: st.allowed, canSearch: st.canSearch, reason: st.reason, message: st.message, subscription: st.subscription, application: st.application, pendingApplications: st.pendingApplications, trial: st.trial, deviceId: st.deviceId, serverTime: st.serverTime };
}

async function pickScreenshot() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose the payment screenshot',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  if (canceled || !filePaths[0]) return { ok: false, canceled: true };
  const data = await fs.readFile(filePaths[0]);
  let type;
  try {
    type = readScreenshot(data);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  pendingShot = { type, data, name: path.basename(filePaths[0]) };
  return { ok: true, name: pendingShot.name, size: data.length, preview: `data:${type};base64,${data.toString('base64')}` };
}

async function applySubscription(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  const plan = typeof f.plan === 'string' ? f.plan : '';
  const message = typeof f.message === 'string' ? f.message.trim() : '';
  const email = typeof f.email === 'string' ? f.email.trim() : '';
  if (!plan) return { ok: false, error: 'Choose a subscription plan.' };
  if (!pendingShot) return { ok: false, error: 'Attach the payment screenshot.' };
  if (message.length > 1000) return { ok: false, error: 'The message is too long (1000 characters maximum).' };
  try {
    const res = await license.apply({ plan, message, email, screenshot: pendingShot });
    pendingShot = null;
    sendSubscription(await license.status());
    return { ok: true, applicationId: res.applicationId, status: res.status, emailVerificationSent: res.emailVerificationSent };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function validateKeyword(value) {
  if (typeof value !== 'string') return { error: 'Enter a search keyword.' };
  const keyword = value.replace(/\s+/g, ' ').trim();
  if (keyword.length < 2) return { error: 'Enter a search keyword (at least 2 characters).' };
  if (keyword.length > 120) return { error: 'The keyword is too long (120 characters maximum).' };
  if (/[\u0000-\u001f\u007f]/.test(keyword)) return { error: 'The keyword contains invalid characters.' };
  return { keyword };
}

function validateCategory(value) {
  if (typeof value !== 'string') return { error: 'Enter a category.' };
  const category = formatCategory(value);
  if (category.length < 2) return { error: 'Enter a category (at least 2 characters), e.g. Software House.' };
  if (category.length > 60) return { error: 'The category is too long (60 characters maximum).' };
  if (/[\u0000-\u001f\u007f]/.test(category)) return { error: 'The category contains invalid characters.' };
  return { category };
}

// Lead filters arrive from the renderer; only known, well-formed fields pass.
function validateFilter(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  if (f.category === 'none' || f.category === 'all') out.category = f.category;
  else if (Number.isInteger(f.category) && f.category > 0) out.category = f.category;
  else out.category = 'all';
  if (f.website === 'with' || f.website === 'without') out.website = f.website;
  if (f.whatsapp === 'available') out.whatsapp = 'available';
  for (const k of ['date', 'from', 'to', 'before']) {
    if (typeof f[k] === 'string' && DATE_RE.test(f[k])) out[k] = f[k];
  }
  return out;
}

// --- Chrome tabs -----------------------------------------------------------

async function tab(name) {
  const t = tabs[name];
  if (t && !t.isClosed()) return t;
  if (!chrome.connected) throw new Error('Target page, context or browser has been closed');
  tabs[name] = await chrome.context.newPage();
  return tabs[name];
}

// A tab opened during block recovery replaces the role's old tab.
async function adoptTab(name, page) {
  const old = tabs[name];
  tabs[name] = page;
  if (old && old !== page && !old.isClosed()) await old.close().catch(() => {});
}

function resetTabs(profile) {
  for (const k of Object.keys(tabs)) tabs[k] = null;
  // The tab that showed chrome://version becomes the visible Maps tab.
  tabs.main = profile.page;
}

async function connectChrome(signal) {
  const wasConnected = chrome.connected;
  sendStatus({ state: 'connecting', phase: 'connection', step: 'connecting', message: 'Connecting to Chrome' });
  const profile = await chrome.connect({ signal });
  if (!wasConnected) resetTabs(profile);
  // Only reported after a real, verified CDP connection.
  sendStatus({ state: 'connecting', phase: 'connection', step: 'connected', profile: profileLabel(profile), message: `Connected to Chrome profile "${profile.name}"` });
  return profile;
}

function profileLabel(profile) {
  return `${profile.name}${profile.account ? ` (${profile.account})` : ''}`;
}

// --- search ----------------------------------------------------------------

async function startSearch(rawKeyword, rawCategory, rawWebsite) {
  const { keyword, error } = validateKeyword(rawKeyword);
  if (error) return { ok: false, error };
  const cat = validateCategory(rawCategory);
  if (cat.error) return { ok: false, error: cat.error };
  const websiteFilter = WEBSITE_FILTERS.has(rawWebsite) ? rawWebsite : 'without';
  if (search) return { ok: false, error: 'A search is already running.' };
  const access = await requireSearchAccess();
  if (!access.ok) return access;
  if (search) return { ok: false, error: 'A search is already running.' };
  // Saved (or matched to an existing spelling) before the search starts.
  let category;
  try {
    category = store.ensureCategory(cat.category);
  } catch (err) {
    return { ok: false, error: `Could not save the category: ${err.message}` };
  }

  const controller = new AbortController();
  search = { controller };
  // Remembered so a search cut short by a crash can be resumed.
  store.setState('lastSearch', { keyword, category: category.name, state: 'running', startedAt: new Date().toISOString() });
  interrupted = null;
  let expectedProfilePath = null;
  const startedAt = new Date().toISOString();
  let stats = null;
  sendStatus({ state: 'connecting', phase: 'connection', step: 'connecting', keyword, category: category.name, processed: 0, leads: 0, newLeads: 0, skipped: 0, message: 'Connecting to Chrome' });

  search.promise = (async () => {
    try {
      expectedProfilePath = (await connectChrome(controller.signal)).path;
      // A free search is counted only once Chrome is ready, so a failed
      // connection does not use one up. The server refuses when none are left.
      if (access.trial) {
        try {
          const r = await license.consumeTrial();
          if (r.consumed) sendStatus({ message: `Free trial: ${r.trial.remaining} free search${r.trial.remaining === 1 ? '' : 'es'} left after this one` });
        } catch (err) {
          sendSubscription(await license.status());
          sendStatus({ state: 'error', phase: 'search', message: err.message });
          return;
        }
      }
      if (controller.signal.aborted) {
        sendStatus({ state: 'stopped', message: 'Search stopped' });
        return;
      }
      // Re-checked during long searches so an expiry takes effect.
      const recheck = setInterval(async () => {
        const st = await license.status().catch(() => null);
        sendSubscription(st);
        // A started free-trial search runs to the end; a subscription that
        // expires mid-search stops it.
        if (st && !access.trial && !st.allowed && st.reason !== 'offline') {
          sendStatus({ state: 'stopping', message: st.message });
          controller.abort();
        }
      }, 30 * 60 * 1000);
      controller.signal.addEventListener('abort', () => clearInterval(recheck), { once: true });
      const session = new SearchSession({
        keyword,
        categoryId: category.id,
        websiteFilter,
        store,
        signal: controller.signal,
        pages: {
          main: () => tab('main'),
          check: () => tab('check'),
          detail: () => tab('detail'),
          open: () => chrome.context.newPage(),
          adopt: (name, page) => adoptTab(name, page),
        },
        recovery: {
          // Chrome or the tab closed during the search: reopen/reconnect the
          // same profile (Chrome may ask the user to Allow), never another one.
          reconnect: async () => {
            if (chrome.connected) {
              for (const k of Object.keys(tabs)) tabs[k] = null; // only a tab was closed
              return;
            }
            const profile = await chrome.connect({ signal: controller.signal });
            if (expectedProfilePath && profile.path !== expectedProfilePath) {
              await chrome.disconnect();
              throw Object.assign(new Error(`Chrome reopened with a different profile ("${profile.name}"); Lead Finder will not switch accounts`), {
                code: 'wrong_profile',
              });
            }
            resetTabs(profile);
            sendStatus({ profile: profileLabel(profile) });
          },
          canRestart: () => chrome.canRestart(),
          restart: async () => {
            const profile = await chrome.restartAndAttach(controller.signal);
            resetTabs(profile);
            sendStatus({ profile: profileLabel(profile) });
            return true;
          },
        },
        emit: (event, payload) => {
          if (event !== 'lead') return sendStatus(payload);
          send('leads:added', payload);
          verifier?.poke(); // check the new number on WhatsApp in the background
        },
      });
      stats = await session.run();
      clearInterval(recheck);
    } catch (err) {
      if (err instanceof ConnectCancelled) {
        sendStatus({ state: 'stopped', message: 'Search stopped' });
      } else {
        const code = err instanceof ChromeError ? err.code : 'unknown';
        sendStatus({ state: 'error', phase: 'connection', errorCode: code, message: err.message || String(err) });
      }
    } finally {
      search = null;
      sendSummary({ keyword, category: category.name, startedAt, stats });
      try {
        store.setState('lastSearch', { keyword, category: category.name, state: lastStatus.state, endedAt: new Date().toISOString() });
      } catch {}
    }
  })();
  return { ok: true, keyword, category };
}

// End-of-search summary, from the database: leads that first became leads
// during this search. Sent only for finished or stopped searches; a failed
// search shows its error instead.
function sendSummary({ keyword, category, startedAt, stats }) {
  const outcome = lastStatus.state;
  if (outcome !== 'done' && outcome !== 'stopped') return;
  let newLeads = 0;
  try {
    newLeads = store.countNewLeadsSince(startedAt);
  } catch {
    return; // no summary rather than a wrong one
  }
  const qualifiedSeen = stats?.leads ?? 0;
  send('search:summary', {
    outcome,
    keyword,
    category,
    newLeads,
    processed: stats?.processed ?? 0,
    alreadySaved: Math.max(0, qualifiedSeen - newLeads),
    started: Boolean(stats),
  });
}

function stopSearch() {
  if (!search) return { ok: false };
  sendStatus({ state: 'stopping', message: 'Stopping after the current step' });
  search.controller.abort();
  return { ok: true };
}

// Human-readable description of a filter, for dialogs and file names.
function describeFilter(f) {
  const parts = [];
  if (f.category === 'none') parts.push('Uncategorized');
  else if (f.category !== 'all') {
    const c = store.listCategories().categories.find((x) => x.id === f.category);
    parts.push(c ? c.name : 'selected category');
  }
  if (f.date) parts.push(f.date);
  else if (f.from || f.to) parts.push(`${f.from || 'start'} to ${f.to || 'today'}`);
  else if (f.before) parts.push(`before ${f.before}`);
  return parts.join(', ');
}

function safeFilePart(text) {
  return text.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60);
}

// scope 'all' exports every lead; otherwise only leads matching the filter.
async function exportCsv(scope, rawFilter) {
  const sub = await requireSubscription();
  if (!sub.ok) return sub;
  const filter = scope === 'all' ? {} : validateFilter(rawFilter);
  const leads = store.listLeads(filter);
  if (!leads.length) return { ok: false, error: 'There are no leads matching this selection to export.' };
  const label = scope === 'all' ? 'all' : describeFilter(filter) || 'all';
  const stamp = new Date().toISOString().slice(0, 10);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: `Export leads (${label})`,
    defaultPath: path.join(app.getPath('documents'), `lead-finder-${safeFilePart(label) || 'leads'}-${stamp}.csv`),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  await fs.writeFile(filePath, leadsToCsv(leads), 'utf8');
  return { ok: true, count: leads.length, filePath };
}

// --- WhatsApp (Baileys, linked by QR) -------------------------------------------
// The user links their own WhatsApp account by scanning a QR code. The
// session is stored encrypted with the OS keychain and never reaches the
// renderer. Numbers are checked automatically in the background (green only
// on a positive answer from WhatsApp); messages are sent one at a time, only
// when the user clicks Send in the composer.

const SEND_MIN_INTERVAL = 8000; // ms between sends: no rapid-fire messaging
let wa = null;
let verifier = null;
let waInitError = null; // why WhatsApp support could not start, if it failed
let lastSendAt = 0;

// safeStorage uses the OS keychain (Keychain, DPAPI, libsecret/kwallet).
// Without a real keychain the session would be stored with a fixed key, so
// linking is refused instead.
function sessionCipher() {
  if (!safeStorage.isEncryptionAvailable()) return null;
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') return null;
  return { encrypt: (text) => safeStorage.encryptString(text), decrypt: (buf) => safeStorage.decryptString(buf) };
}

// OS-keychain encryption for the PIN record and the device key. Falls back to
// none (the PIN is still scrypt-hashed) when no keychain exists.
function keychainCipher() {
  return sessionCipher();
}

function waSnapshot() {
  const snap = wa ? wa.snapshot() : { state: 'unavailable', qr: null, account: null, error: waInitError };
  let progress = null;
  try {
    progress = store.whatsappProgress();
  } catch {}
  return { ...snap, progress, secure: Boolean(sessionCipher()) };
}

function sendWaState() {
  send('whatsapp:state', waSnapshot());
}

function initWhatsApp() {
  const cipher = sessionCipher();
  if (!cipher) {
    waInitError = 'No secure system keychain is available to protect the WhatsApp session, so linking is disabled on this computer.';
    return;
  }
  let WhatsAppClient;
  let WhatsAppVerifier;
  try {
    ({ WhatsAppClient } = require('../whatsapp/client'));
    ({ WhatsAppVerifier } = require('../whatsapp/verifier'));
  } catch (err) {
    waInitError = `WhatsApp support could not be loaded (${err.message.split('\n')[0]}).`;
    return;
  }
  wa = new WhatsAppClient({ dir: path.join(app.getPath('userData'), 'whatsapp-session'), cipher });
  verifier = new WhatsAppVerifier({
    client: wa,
    store,
    onResult: (phone) => {
      send('leads:whatsapp', { phone, leads: store.listLeads({}).filter((l) => l.phone === phone) });
      sendWaState();
    },
  });
  wa.on('state', (snap) => {
    if (snap.state === 'open') verifier.start();
    else verifier.stop();
    sendWaState();
  });
  // A device linked earlier reconnects automatically.
  wa.hasSession()
    .then(async (has) => has && (await license.status()).allowed && wa.connect())
    .catch(() => {});
}

async function waConnect() {
  const sub = await requireSubscription();
  if (!sub.ok) return sub;
  if (!wa) return { ok: false, error: waInitError || 'WhatsApp is not available.' };
  await wa.connect();
  return { ok: true };
}

async function waLogout() {
  if (!wa) return { ok: false };
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Unlink WhatsApp', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Unlink WhatsApp',
    message: 'Unlink Lead Finder from your WhatsApp account?',
    detail: 'The session is deleted from this computer. Saved leads and check results are kept. You can link again by scanning a new QR code.',
  });
  if (response !== 0) return { ok: false, canceled: true };
  await wa.logout();
  return { ok: true };
}

async function waRecheck(phone) {
  const sub = await requireSubscription();
  if (!sub.ok) return sub;
  if (!wa || typeof phone !== 'string' || !E164.test(phone)) return { ok: false, error: 'Invalid number.' };
  try {
    const status = await wa.check(phone);
    store.setWhatsAppResult(phone, status, 'baileys');
  } catch (err) {
    if (err.code === 'not_connected') return { ok: false, error: err.message };
    store.setWhatsAppResult(phone, 'failed', 'baileys', String(err.message).slice(0, 200));
  }
  sendWaState();
  return { ok: true, leads: store.listLeads({}).filter((l) => l.phone === phone) };
}

// One message to one lead, only after the user pressed Send.
async function waSend(leadId, rawText) {
  const sub = await requireSubscription();
  if (!sub.ok) return sub;
  if (!Number.isInteger(leadId) || leadId <= 0) return { ok: false, error: 'Invalid lead.' };
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (!text) return { ok: false, error: 'Write a message first.' };
  if (text.length > 4000) return { ok: false, error: 'The message is too long (4000 characters maximum).' };
  const lead = store.leadById(leadId);
  if (!lead) return { ok: false, error: 'That lead no longer exists.' };
  if (lead.phoneStatus !== 'valid' || lead.whatsapp !== 'available' || lead.whatsappMethod === 'manual') {
    return { ok: false, error: 'This number has not been confirmed on WhatsApp.' };
  }
  if (!wa || wa.state !== 'open') return { ok: false, error: 'WhatsApp is not connected. Link it first.' };
  const wait = SEND_MIN_INTERVAL - (Date.now() - lastSendAt);
  if (wait > 0) return { ok: false, error: `Please wait ${Math.ceil(wait / 1000)}s before sending another message.` };
  lastSendAt = Date.now();
  try {
    const waId = await wa.send(lead.phone, text);
    store.recordMessage({ businessId: lead.id, phone: lead.phone, body: text, waId, status: 'sent' });
    return { ok: true, waId, sentAt: new Date().toISOString() };
  } catch (err) {
    const error = String(err?.message || err).slice(0, 200);
    store.recordMessage({ businessId: lead.id, phone: lead.phone, body: text, status: 'failed', error });
    return { ok: false, error: `WhatsApp did not accept the message: ${error}` };
  }
}

function waLastMessage(leadId) {
  const lead = Number.isInteger(leadId) ? store.leadById(leadId) : null;
  return lead?.phone ? store.lastMessageTo(lead.phone) : null;
}

// --- categories ------------------------------------------------------------------

async function renameCategory(id, name) {
  if (!Number.isInteger(id) || id <= 0 || typeof name !== 'string') return { ok: false, error: 'Invalid category.' };
  let res = store.renameCategory(id, name);
  if (res.conflict) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Merge categories', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Merge categories',
      message: `"${res.conflict.name}" already exists. Merge into it?`,
      detail: 'All leads in this category move to the existing one, and this category is removed. No leads are deleted.',
    });
    if (response !== 0) return { ok: false, canceled: true };
    res = store.renameCategory(id, name, { merge: true });
  }
  return { ok: true, ...res };
}

async function deleteCategory(id) {
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'Invalid category.' };
  const cat = store.listCategories().categories.find((c) => c.id === id);
  if (!cat) return { ok: false, error: 'That category no longer exists.' };
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Delete category', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Delete category',
    message: `Delete the category "${cat.name}"?`,
    detail: cat.leadCount
      ? `Its ${cat.leadCount} lead${cat.leadCount === 1 ? '' : 's'} are kept and become Uncategorized.`
      : 'It has no leads.',
  });
  if (response !== 0) return { ok: false, canceled: true };
  return { ok: true, ...store.deleteCategory(id) };
}

async function confirmDelete(message, detail) {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Delete', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Delete leads',
    message,
    detail: `${detail}\n\nThis cannot be undone. Saved categories are kept, and deleted businesses are not added again by later searches.`,
  });
  return response === 0;
}

async function deleteLeads(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100_000) return { ok: false, error: 'Nothing selected.' };
  const clean = ids.filter((x) => Number.isInteger(x) && x > 0);
  if (!clean.length) return { ok: false, error: 'Nothing selected.' };
  const msg = clean.length === 1 ? 'Delete this lead?' : `Delete ${clean.length} selected leads?`;
  if (!(await confirmDelete(msg, clean.length === 1 ? 'The selected lead will be removed.' : 'The selected leads will be removed.'))) {
    return { ok: false, canceled: true };
  }
  return { ok: true, deleted: store.deleteLeads(clean) };
}

async function deleteFiltered(rawFilter) {
  const filter = validateFilter(rawFilter);
  const count = store.countLeads(filter);
  if (!count) return { ok: false, error: 'No leads match the current filters.' };
  const label = describeFilter(filter) || 'all dates and categories';
  if (!(await confirmDelete(`Delete all ${count} leads shown?`, `Every lead matching: ${label}.`))) {
    return { ok: false, canceled: true };
  }
  return { ok: true, deleted: store.deleteFiltered(filter) };
}

function openListing(url) {
  // Only Google Maps listing URLs are opened, in the user's default browser.
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return { ok: false };
  }
  if (u.protocol !== 'https:' || !/^(www\.)?google\.[a-z.]+$/.test(u.hostname) || !u.pathname.startsWith('/maps/')) {
    return { ok: false };
  }
  shell.openExternal(u.toString());
  return { ok: true };
}

// --- lifecycle ---------------------------------------------------------------

app.whenReady().then(() => {
  try {
    store = new LeadStore(path.join(app.getPath('userData'), 'leads.db'));
    appLock = new AppLock({ store, cipher: keychainCipher() });
    license = new LicenseClient({ store, cipher: keychainCipher(), config: licenseConfig() });
    const last = store.getState('lastSearch');
    if (last && ['running', 'connecting', 'paused', 'stopping'].includes(last.state)) interrupted = last;
  } catch (err) {
    dialog.showErrorBox('Lead Finder', `The local lead database could not be opened:\n${err.message}`);
    app.quit();
    return;
  }

  handle('lock:state', () => appLock.state());
  handle('lock:setup', (pin, confirm) => {
    try {
      const st = appLock.setup(String(pin ?? ''), String(confirm ?? ''));
      afterUnlock();
      return { ok: true, ...st };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  handle('lock:unlock', (pin) => {
    const r = appLock.unlock(String(pin ?? ''));
    if (r.ok) afterUnlock();
    return r;
  });
  handle('lock:change', (current, next, confirm) => {
    try {
      return appLock.change(String(current ?? ''), String(next ?? ''), String(confirm ?? ''));
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  handle('lock:lock', () => {
    appLock.lock();
    return { ok: true };
  });
  handle('subscription:status', async () => {
    const st = await license.status();
    sendSubscription(st); // keep the header in step with every check
    return publicStatus(st);
  });
  handle('subscription:plans', () => license.plans().catch((err) => ({ error: err.message })));
  handle('subscription:pickScreenshot', () => pickScreenshot());
  handle('subscription:apply', (form) => applySubscription(form));
  handle('leads:list', (filter) => store.listLeads(validateFilter(filter)));
  handle('leads:dates', (filter) => store.listDates(validateFilter(filter)));
  handle('leads:delete', (ids) => deleteLeads(ids));
  handle('leads:deleteFiltered', (filter) => deleteFiltered(filter));
  handle('categories:list', () => store.listCategories());
  handle('categories:rename', (id, name) => renameCategory(id, name));
  handle('categories:delete', (id) => deleteCategory(id));
  handle('whatsapp:state', () => waSnapshot());
  handle('whatsapp:connect', () => waConnect());
  handle('whatsapp:disconnect', async () => (wa ? (await wa.disconnect(), { ok: true }) : { ok: false }));
  handle('whatsapp:logout', () => waLogout());
  handle('whatsapp:recheck', (phone) => waRecheck(phone));
  handle('whatsapp:send', (leadId, text) => waSend(leadId, text));
  handle('whatsapp:lastMessage', (leadId) => waLastMessage(leadId));
  handle('search:interrupted', () => interrupted);
  handle('search:dismissInterrupted', () => {
    interrupted = null;
    store.setState('lastSearch', { state: 'dismissed' });
    return { ok: true };
  });
  handle('search:start', (keyword, category, website) => startSearch(keyword, category, website));
  handle('search:stop', () => stopSearch());
  handle('search:status', () => lastStatus);
  handle('export:csv', (scope, filter) => exportCsv(scope === 'all' ? 'all' : 'filtered', filter));
  handle('lead:open', (url) => openListing(url));

  createWindow();
  if (process.env.LEAD_FINDER_SMOKE_TEST) smokeTest(process.env.LEAD_FINDER_SMOKE_TEST);
});

// Release check (CI): the installed app must start on its own, show its UI
// and have its bundled modules. Writes a JSON report and quits.
function smokeTest(reportFile) {
  const report = { version: app.getVersion(), packaged: app.isPackaged };
  const finish = async (ok, error) => {
    await fs.writeFile(reportFile, JSON.stringify({ ok, error, ...report }, null, 2)).catch(() => {});
    app.exit(ok ? 0 : 1);
  };
  setTimeout(() => finish(false, 'timed out'), 60_000).unref();
  win.webContents.once('did-finish-load', async () => {
    try {
      await new Promise((r) => setTimeout(r, 1500));
      report.lockScreen = await win.webContents.executeJavaScript("!!document.querySelector('#root')?.textContent.includes('Lead Finder')");
      report.modules = {
        playwright: typeof require('playwright-core').chromium.connectOverCDP === 'function',
        baileys: typeof (await import('baileys')).default === 'function',
        sqlite: store.db != null,
      };
      report.licenseServer = licenseConfig().serverUrl;
      const ok = report.lockScreen && Object.values(report.modules).every(Boolean);
      finish(ok, ok ? undefined : 'checks failed');
    } catch (err) {
      finish(false, err.message);
    }
  });
}

// Work that should only happen once the user has unlocked the app.
let unlockedOnce = false;
function afterUnlock() {
  if (unlockedOnce) return;
  unlockedOnce = true;
  initWhatsApp();
}

app.on('window-all-closed', () => app.quit());

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  // Stop automation and detach from Chrome without closing it.
  search?.controller.abort();
  Promise.resolve(search?.promise)
    .catch(() => {})
    .then(() => chrome.disconnect())
    .then(() => wa?.disconnect()) // closes the connection; the linked session is kept
    .finally(() => {
      try {
        store?.close();
      } catch {}
      app.quit();
    });
});

module.exports = { validateKeyword };
