'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } = require('electron');
const { LeadStore, DATE_RE, formatCategory } = require('../database/db');
const { E164, resolvePhoneCountry, phoneCountries } = require('../database/phone');
const { leadsToCsv } = require('../export/csv');
const { ChromeConnection, ChromeError, ConnectCancelled } = require('../browser/chrome');
const { SearchSession, WEBSITE_FILTERS } = require('../browser/search-session');
const { FacebookSession } = require('../browser/facebook-session');
const { LinkedInSession } = require('../browser/linkedin-session');
const { runSources } = require('../browser/search-sources');
const podcastLib = require('../browser/podcasts');
const { PodcastSearch } = require('../browser/podcast-search');
const { PLATFORMS, ADAPTERS, browserFindOf } = require('../browser/podcast-platforms');
const { robotsChecker } = require('../browser/robots');

// Requests from here (Apple Podcasts, feeds, websites) try IPv6 and IPv4
// side by side; Node gives each address only 250ms to connect, so a slow
// connection (or no IPv6 at all) fails at random. Each gets 2.5 seconds.
require('node:net').setDefaultAutoSelectFamilyAttemptTimeout(2500);
const { AppLock } = require('./applock');
const { Activation } = require('./activation');
const { Updater, fileLog } = require('./updater');

const DEV_URL = process.env.VITE_DEV_SERVER_URL || '';
const RENDERER_FILE = path.join(__dirname, '..', '..', 'dist', 'renderer', 'index.html');

// Test runs point the app at throwaway data directories.
if (process.env.LEAD_FINDER_USER_DATA) app.setPath('userData', process.env.LEAD_FINDER_USER_DATA);

// One running copy per data folder: two copies would also mean two outreach
// schedulers. A second launch just brings the existing window forward.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

let win = null;
let updater = null;
let chats = null; // ChatService
let outreach = null; // Outreach scheduler
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
const tabs = { main: null, check: null, detail: null, facebook: null, linkedin: null, spotify: null, amazon: null };
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
const LOCK_FREE = new Set(['lock:state', 'lock:setup', 'lock:unlock', 'update:status', 'update:openDownload']);

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender');
    if (!LOCK_FREE.has(channel) && !appLock?.unlocked) throw new Error('Locked');
    return fn(...args);
  });
}

// The 4-digit app lock.
let appLock = null;

// --- subscription (activation) ----------------------------------------------------
// Codes are made, emailed to the administrator and checked here in the main
// process (never in the window): see activation.js.

let activation = null;

// activation-config.json (contact numbers) is in the repository;
// activation-secret.json (secret, administrator email, SMTP) is not: it is
// made from tools/activation/.env when the app is built. Running from source
// (npm run dev) reads tools/activation/.env itself, so changes there apply
// on the next start without a build step.
function activationConfig() {
  const read = (f) => {
    try {
      return require(f);
    } catch {
      return {};
    }
  };
  let config = { ...read('./activation-config.json'), ...read('./activation-secret.json') };
  if (!app.isPackaged) {
    const { loadEnv, appSettings } = require('../../tools/activation/lib');
    const env = loadEnv();
    const { settings } = appSettings(env);
    if (settings.secret) config.secret = settings.secret;
    if (settings.adminEmail) config.adminEmail = settings.adminEmail;
    if (settings.smtp.host) config.smtp = settings.smtp;
    if (settings.fallbackPattern) config.fallbackPattern = settings.fallbackPattern;
    if (env.CONTACT_WHATSAPP || env.CONTACT_PHONE) config.contact = { whatsapp: (env.CONTACT_WHATSAPP || '').replace(/\D/g, ''), phone: (env.CONTACT_PHONE || '').replace(/[^\d+]/g, '') };
  }
  // Tests use their own settings (and a local mail server); never honoured
  // in a packaged app.
  if (process.env.LEAD_FINDER_ACTIVATION_CONFIG && !app.isPackaged) config = { ...config, ...JSON.parse(process.env.LEAD_FINDER_ACTIVATION_CONFIG) };
  return config;
}

function createActivation() {
  const config = activationConfig();
  const { createMailer, mailError } = require('./mailer');
  const mailer = config.smtp?.host ? createMailer(config.smtp, { allowInsecure: !app.isPackaged }) : null;
  return new Activation({ store, config, mailer, mailError });
}

function requirePlan() {
  const st = activation.status();
  if (st.state === 'active') return { ok: true };
  const error = st.state === 'expired' ? `Your ${st.planName} plan has ended. Renew it under Activate to continue.` : 'This needs an active plan. Click Activate at the top to choose a plan.';
  return { ok: false, subscription: st.state, error };
}

let lastActivationState = null;
function sendActivation() {
  const st = activation.status();
  // A plan that ended stops WhatsApp checks (the linked session is kept).
  if (lastActivationState === 'active' && st.state !== 'active') wa?.disconnect().catch(() => {});
  lastActivationState = st.state;
  send('activation:status', st);
  return st;
}

// The time from an HTTPS answer's Date header, so a computer clock set
// wrong doesn't change when a plan ends. Best effort; offline is fine.
async function syncNetworkTime() {
  if (process.env.LEAD_FINDER_NO_NETWORK_TIME === '1') return;
  try {
    const res = await fetch('https://www.google.com/generate_204', { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    const date = Date.parse(res.headers.get('date') || '');
    if (Number.isFinite(date)) activation.setNetworkTime(date);
  } catch {}
}

// A plan that ends while the app is open is noticed within a minute.
function watchActivation() {
  syncNetworkTime().finally(() => sendActivation());
  setInterval(() => {
    if (activation.status().state !== lastActivationState) sendActivation();
  }, 60_000).unref();
  setInterval(syncNetworkTime, 6 * 60 * 60 * 1000).unref();
}

async function requestActivation(plan) {
  if (typeof plan !== 'string') return { ok: false, error: 'Choose a plan first.' };
  const r = await activation.request(plan);
  return { ...r, status: sendActivation() };
}

async function verifyActivation(code, plan) {
  if (typeof code !== 'string' || code.length > 20 || typeof plan !== 'string') return { ok: false, error: 'Enter the 6-digit code.' };
  const r = await activation.verify(code, plan);
  const status = sendActivation();
  if (r.ok && wa) wa.hasSession().then((has) => has && wa.connect()).catch(() => {});
  return { ...r, status };
}

// The administrator's WhatsApp or phone, from activation-config.json only.
function openContact(kind, text) {
  const c = activation.config.contact || {};
  if (kind === 'whatsapp' && /^\d{8,15}$/.test(c.whatsapp || '')) {
    shell.openExternal(`https://wa.me/${c.whatsapp}?text=${encodeURIComponent(String(text || '').slice(0, 500))}`);
    return { ok: true };
  }
  if (kind === 'call' && /^\+?\d{8,15}$/.test(c.phone || '')) {
    shell.openExternal(`tel:${c.phone}`);
    return { ok: true };
  }
  return { ok: false };
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
  if (f.whatsapp === 'available' || f.whatsapp === 'unavailable') out.whatsapp = f.whatsapp;
  for (const k of ['date', 'from', 'to', 'before']) {
    if (typeof f[k] === 'string' && DATE_RE.test(f[k])) out[k] = f[k];
  }
  if (f.campaign === 'seen' || f.campaign === 'unseen') out.campaign = f.campaign;
  if (['maps', 'facebook', 'linkedin', 'podcast'].includes(f.source)) out.source = f.source;
  if (typeof f.search === 'string' && f.search.trim()) out.search = f.search.trim().slice(0, 100);
  return out;
}

// --- Chrome tabs -----------------------------------------------------------

// Google Maps works in the tabs of one window (main, check, detail);
// Facebook and LinkedIn each have a window of their own, and so does
// Spotify (only ever opened for the user to look at; never read). Each search worker
// only ever uses its own pages, so none navigates, hides or slows down
// another's page.
const MAPS_TABS = ['main', 'check', 'detail'];
const FACEBOOK_TABS = ['facebook'];
const LINKEDIN_TABS = ['linkedin'];

async function tab(name) {
  const t = tabs[name];
  if (t && !t.isClosed()) return t;
  if (!chrome.connected) throw new Error('Target page, context or browser has been closed');
  tabs[name] = ['facebook', 'linkedin', 'spotify', 'amazon'].includes(name) ? await chrome.newWindowPage() : await newMapsTab();
  return tabs[name];
}

// A new tab in the Google Maps window, next to an open Maps tab. With none
// left, a plain tab, or a window of its own while Facebook's window is open
// (a plain tab could land there).
async function newMapsTab() {
  const beside = MAPS_TABS.map((k) => tabs[k]).find((p) => p && !p.isClosed());
  if (beside) return chrome.newTabBeside(beside);
  if (['facebook', 'linkedin', 'spotify', 'amazon'].some((k) => tabs[k] && !tabs[k].isClosed())) return chrome.newWindowPage();
  return chrome.context.newPage();
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

// rawKeyword/rawCategory: the Google Maps and Facebook search; rawLinkedIn:
// LinkedIn's own search (its search bar). Only the sources switched on run.
async function startSearch(rawKeyword, rawCategory, rawWebsite, rawLinkedIn) {
  // The source switches above the Leads table, as they are now.
  const withMaps = mapsSearchOn();
  const withFacebook = facebookSearchOn();
  const withLinkedIn = linkedinSearchOn();
  if (!withMaps && !withFacebook && !withLinkedIn) return { ok: false, error: 'Turn on at least one source: Google Maps, Facebook or LinkedIn.' };
  let keyword = '';
  let cat = { category: '' };
  if (withMaps || withFacebook) {
    const k = validateKeyword(rawKeyword);
    if (k.error) return { ok: false, error: k.error };
    keyword = k.keyword;
    cat = validateCategory(rawCategory);
    if (cat.error) return { ok: false, error: cat.error };
  }
  let linkedinKeyword = '';
  if (withLinkedIn) {
    const k = validateKeyword(rawLinkedIn);
    if (k.error) return { ok: false, error: `LinkedIn search: ${k.error.replace(/^Enter a search keyword/, 'enter what to search for')}` };
    linkedinKeyword = k.keyword;
    // LinkedIn alone: its leads go to the category given, else one named after its search.
    if (!keyword) {
      keyword = linkedinKeyword;
      const given = validateCategory(rawCategory);
      cat = given.error ? validateCategory(linkedinKeyword) : given;
      if (cat.error) return { ok: false, error: cat.error };
    }
  }
  const websiteFilter = WEBSITE_FILTERS.has(rawWebsite) ? rawWebsite : 'without';
  if (search) return { ok: false, error: 'A search is already running.' };
  const plan = requirePlan();
  if (!plan.ok) return plan;
  // Saved (or matched to an existing spelling) before the search starts.
  let category;
  try {
    category = store.ensureCategory(cat.category);
  } catch (err) {
    return { ok: false, error: `Could not save the category: ${err.message}` };
  }

  const sources = [...(withMaps ? ['maps'] : []), ...(withFacebook ? ['facebook'] : []), ...(withLinkedIn ? ['linkedin'] : [])];
  const controller = new AbortController();
  search = { controller };
  // Remembered so a search cut short by a crash can be resumed.
  store.setState('lastSearch', { keyword, category: category.name, linkedinKeyword, sources, state: 'running', startedAt: new Date().toISOString() });
  interrupted = null;
  let expectedProfilePath = null;
  const startedAt = new Date().toISOString();
  let stats = null;
  sendStatus({ state: 'connecting', phase: 'connection', step: 'connecting', keyword, category: category.name, linkedinKeyword, sources, source: sources[0], facebook: null, linkedin: null, workers: null, processed: 0, leads: 0, newLeads: 0, skipped: 0, message: 'Connecting to Chrome' });

  search.promise = (async () => {
    try {
      expectedProfilePath = (await connectChrome(controller.signal)).path;
      if (controller.signal.aborted) {
        sendStatus({ state: 'stopped', message: 'Search stopped' });
        return;
      }
      const pages = {
        main: () => tab('main'),
        check: () => tab('check'),
        detail: () => tab('detail'),
        facebook: () => tab('facebook'),
        linkedin: () => tab('linkedin'),
        open: () => newMapsTab(),
        adopt: (name, page) => adoptTab(name, page),
      };
      // Both workers may lose Chrome at the same moment: one reconnect or
      // restart runs at a time, and the other worker waits for it.
      let chromeTask = null;
      const once = (fn) => (chromeTask ||= fn().finally(() => (chromeTask = null)));
      const recoveryFor = (own) => ({
        // Chrome or the tab closed during the search: reopen/reconnect the
        // same profile (Chrome may ask the user to Allow), never another one.
        reconnect: async () => {
          if (chromeTask) await chromeTask.catch(() => {});
          if (chrome.connected) {
            for (const k of own) tabs[k] = null; // only this worker's tab was closed
            return;
          }
          await once(async () => {
            const profile = await chrome.connect({ signal: controller.signal });
            if (expectedProfilePath && profile.path !== expectedProfilePath) {
              await chrome.disconnect();
              throw Object.assign(new Error(`Chrome reopened with a different profile ("${profile.name}"); Lead Finder will not switch accounts`), {
                code: 'wrong_profile',
              });
            }
            resetTabs(profile);
            sendStatus({ profile: profileLabel(profile) });
          });
        },
        canRestart: () => !chromeTask && chrome.canRestart(),
        restart: () =>
          once(async () => {
            const profile = await chrome.restartAndAttach(controller.signal);
            resetTabs(profile);
            sendStatus({ profile: profileLabel(profile) });
            return true;
          }),
      });
      // How local numbers are read (Facebook posts, LinkedIn pages, websites).
      const country = phoneCountry();
      const diagnose = searchDiagnostics(keyword);
      stats = await runSources({
        withMaps,
        withFacebook,
        withLinkedIn,
        signal: controller.signal,
        send: (event, payload) => {
          if (event === 'status') return sendStatus(payload);
          send('leads:added', payload);
          verifier?.poke(); // check the new number on WhatsApp in the background
        },
        createMaps: (emit) => new SearchSession({ keyword, categoryId: category.id, websiteFilter, store, signal: controller.signal, pages, recovery: recoveryFor(MAPS_TABS), emit }),
        createFacebook: (emit) =>
          new FacebookSession({
            keyword,
            categoryId: category.id,
            categoryName: category.name,
            country,
            store,
            signal: controller.signal,
            pages,
            recovery: recoveryFor(FACEBOOK_TABS),
            diagnose,
            emit,
          }),
        createLinkedIn: (emit) =>
          new LinkedInSession({
            keyword: linkedinKeyword,
            modes: linkedinModes(),
            categoryId: category.id,
            country,
            store,
            signal: controller.signal,
            pages,
            recovery: recoveryFor(LINKEDIN_TABS),
            diagnose,
            emit,
          }),
      });
    } catch (err) {
      if (err instanceof ConnectCancelled) {
        sendStatus({ state: 'stopped', message: 'Search stopped' });
      } else {
        const code = err instanceof ChromeError ? err.code : 'unknown';
        sendStatus({ state: 'error', phase: 'connection', errorCode: code, message: err.message || String(err) });
      }
    } finally {
      search = null;
      updater?.idle(); // an update waiting for the search can install now
      sendSummary({ keyword, category: category.name, startedAt, stats });
      try {
        store.setState('lastSearch', { keyword, category: category.name, linkedinKeyword, sources, state: lastStatus.state, endedAt: new Date().toISOString() });
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

// Google Maps is on unless switched off (it was the only source before).
function mapsSearchOn() {
  return store.getState('mapsSearch') !== false;
}

function setMapsSearch(on) {
  if (typeof on !== 'boolean') return { ok: false, error: 'Invalid value' };
  store.setState('mapsSearch', on);
  return { ok: true, on };
}

function facebookSearchOn() {
  return store.getState('facebookSearch') === true;
}

function setFacebookSearch(on) {
  if (typeof on !== 'boolean') return { ok: false, error: 'Invalid value' };
  store.setState('facebookSearch', on);
  return { ok: true, on };
}

function linkedinSearchOn() {
  return store.getState('linkedinSearch') === true;
}

function setLinkedInSearch(on) {
  if (typeof on !== 'boolean') return { ok: false, error: 'Invalid value' };
  store.setState('linkedinSearch', on);
  return { ok: true, on };
}

// LinkedIn discovery modes (Jobs, Posts, Companies).
function linkedinModes() {
  const m = store.getState('linkedinModes') || {};
  return { jobs: m.jobs !== false, posts: m.posts !== false, companies: m.companies !== false };
}

function linkedinSettings() {
  return { modes: linkedinModes() };
}

function setLinkedInSettings(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Invalid value' };
  if (raw.modes) {
    const m = { jobs: raw.modes.jobs === true, posts: raw.modes.posts === true, companies: raw.modes.companies === true };
    if (!m.jobs && !m.posts && !m.companies) return { ok: false, error: 'Keep at least one LinkedIn mode on.' };
    store.setState('linkedinModes', m);
  }
  return { ok: true, ...linkedinSettings() };
}

// The country local numbers are read with: the user's choice, else the
// country of most leads, else this computer's time zone, else its region.
function phoneCountry() {
  return resolvePhoneCountry({
    setting: store.getState('phoneCountry'),
    common: store.commonPhoneCountry(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: app.getLocaleCountryCode(),
  });
}

function phoneCountrySettings() {
  return { setting: store.getState('phoneCountry') || null, effective: phoneCountry(), countries: phoneCountries() };
}

function setPhoneCountry(code) {
  if (code !== null && !phoneCountries().some((c) => c.code === code)) return { ok: false, error: 'Unknown country' };
  store.setState('phoneCountry', code);
  return { ok: true, ...phoneCountrySettings() };
}

// Search diagnostics (userData/search-diagnostics.log): counts and reasons
// per Facebook query and LinkedIn company, to find out why posts or pages
// gave no numbers. No cookies, account details, post text or numbers.
let diagLog = null;
function searchDiagnostics(keyword) {
  diagLog ||= fileLog(path.join(app.getPath('userData'), 'search-diagnostics.log'));
  return (record) => diagLog({ keyword, ...record });
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
  const plan = requirePlan();
  if (!plan.ok) return plan;
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

// --- WhatsApp chats and outreach ------------------------------------------------

function initChatsAndOutreach(cipher) {
  const { ChatStore, OutreachStore } = require('../database/wa-store');
  const { ChatService } = require('../whatsapp/chats');
  const { Outreach } = require('../whatsapp/outreach');
  const { jidOfPhone } = require('../whatsapp/messages');
  const chatStore = new ChatStore(store.db, cipher);
  chats = new ChatService({ client: wa, store: chatStore });
  outreach = new Outreach({
    store: new OutreachStore(store.db),
    state: { get: (k) => store.getState(k), set: (k, v) => store.setState(k, v) },
    transport: { ready: () => wa.state === 'open', send: async (phone, text) => ({ id: await wa.send(phone, text) }) },
    details: (c) => ({ business: c.leadId ? store.leadById(c.leadId)?.name || null : null }),
    hasReplied: (phone, since) => Boolean(since) && chatStore.hasIncomingSince(jidOfPhone(phone), since),
    // Category campaigns fill their queues from the saved leads.
    leads: (filter = {}) => store.listLeads(filter),
    canSend: async () => activation.active,
    nameFor: (lead) => require('../whatsapp/templates').pickName({ contactName: chatStore.chat(jidOfPhone(lead.phone))?.name, businessName: lead.name }).name,
  });
  chats.on('incoming', (m) => outreach.onIncoming({ phone: m.phone, text: m.text }));
  chats.on('manual', ({ phone }) => phone && outreach.onManualMessage(phone));
  chats.on('status', (st) => outreach.onStatus(st.id, st.status));
  outreach.on('change', (e) => send('outreach:state', { id: e?.id ?? null }));
  outreach.on('replied', (e) => send('outreach:event', { type: e.optOut ? 'opted_out' : 'replied', phone: e.phone }));
  outreach.on('sent', (e) => send('outreach:event', { type: 'sent', campaignId: e.campaignId, phone: e.phone, stage: e.stage, test: e.test }));
  outreach.on('failed', (e) => send('outreach:event', { type: 'failed', campaignId: e.campaignId, phone: e.phone, stage: e.stage, error: e.error, paused: e.paused }));
  outreach.init();
}

const isPhone = (v) => typeof v === 'string' && /^\+\d{6,15}$/.test(v);
const unavailable = () => ({ ok: false, error: waInitError || 'WhatsApp is not available on this computer.' });

const campaignId = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

// Leads a campaign may message (verified on WhatsApp, after the user's
// category/date/search filters; previously contacted and opted-out numbers
// are listed separately). See whatsapp/eligibility.js.
function eligibleFor(id, rawFilters) {
  const { eligibleContacts } = require('../whatsapp/eligibility');
  const f = rawFilters && typeof rawFilters === 'object' ? rawFilters : {};
  const filters = {
    categories: Array.isArray(f.categories) ? f.categories.map(String).slice(0, 200) : [],
    from: typeof f.from === 'string' ? f.from : null,
    to: typeof f.to === 'string' ? f.to : null,
    search: typeof f.search === 'string' ? f.search.slice(0, 100) : '',
  };
  return eligibleContacts({ leads: store.listLeads({}), store: outreach.store, campaign: outreach.load(id), filters });
}

// Adds leads by id. The same rules are checked here again, whatever the
// window sent: verified only, no opt-outs, no previously contacted numbers
// unless the campaign allows them.
async function outreachAddLeads(id, ids) {
  if (!outreach) return unavailable();
  if (!outreach.load(id)) return { ok: false, error: 'That campaign no longer exists.' };
  const { pickName } = require('../whatsapp/templates');
  const { jidOfPhone } = require('../whatsapp/messages');
  const { eligible } = eligibleFor(id, {});
  const allowed = new Map(eligible.map((l) => [l.id, l]));
  const list = [];
  for (const leadId of Array.isArray(ids) ? ids.slice(0, 2000) : []) {
    const lead = allowed.get(Number(leadId));
    if (!lead) continue;
    const chat = chats.store.chat(jidOfPhone(lead.phone));
    list.push({ phone: lead.phone, leadId: lead.id, name: pickName({ contactName: chat?.name, businessName: lead.name }).name });
  }
  if (!list.length) return { ok: false, error: 'None of these leads can be added: only numbers confirmed on WhatsApp that weren’t contacted before (or opted out) can be added.' };
  return outreach.addLeads(id, list);
}

// A lead category as a campaign key: '<id>' or 'none' (uncategorized).
function categoryKey(raw) {
  if (raw === 'none') return { key: 'none', name: 'Uncategorized' };
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  const cat = store.listCategories().categories.find((c) => c.id === id);
  return cat ? { key: String(id), name: cat.name } : null;
}

// The ON/OFF switch of a category campaign. ON in live mode needs the
// user's acknowledgement once, like Start.
async function outreachSetCategory(raw, on, opts) {
  if (!outreach) return unavailable();
  const cat = categoryKey(raw);
  if (!cat) return { ok: false, error: 'That category no longer exists.' };
  if (on) {
    const existing = outreach.store.campaignForCategory(cat.key);
    const test = existing ? outreach.load(existing.id).config.test : true;
    if (!test) {
      const plan = requirePlan();
      if (!plan.ok) return plan;
    }
  }
  return outreach.setCategoryEnabled(cat.key, cat.name, Boolean(on), { acknowledge: Boolean(opts && opts.acknowledge === true) });
}

async function outreachStart(id, opts) {
  if (!outreach) return unavailable();
  const c = outreach.load(id);
  if (!c) return { ok: false, error: 'That campaign no longer exists.' };
  if (!c.config.test) {
    const plan = requirePlan();
    if (!plan.ok) return plan;
  }
  return outreach.start(id, { acknowledge: Boolean(opts && opts.acknowledge === true) });
}

async function outreachResume(id) {
  if (!outreach) return unavailable();
  const c = outreach.load(id);
  if (!c) return { ok: false, error: 'That campaign no longer exists.' };
  if (!c.config.test) {
    const plan = requirePlan();
    if (!plan.ok) return plan;
  }
  return outreach.resume(id);
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

// End-to-end tests only (never in a packaged app): a scripted stand-in for
// Baileys from test/, with a throwaway cipher, as Playwright's launch has no
// system keychain.
function testBaileys() {
  const file = process.env.LEAD_FINDER_TEST_BAILEYS;
  if (!file || app.isPackaged) return null;
  return { load: async () => require(file), cipher: { encrypt: (t) => Buffer.from(String(t), 'utf8').reverse(), decrypt: (b) => Buffer.from(b).reverse().toString('utf8') } };
}

function initWhatsApp() {
  const fake = testBaileys();
  const cipher = fake ? fake.cipher : sessionCipher();
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
  wa = new WhatsAppClient({ dir: path.join(app.getPath('userData'), 'whatsapp-session'), cipher, ...(fake ? { loadBaileys: fake.load } : {}) });
  initChatsAndOutreach(cipher);
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
  if (fake) return wa.connect();
  wa.hasSession()
    .then((has) => has && activation.active && wa.connect())
    .catch(() => {});
}

async function waConnect() {
  if (!wa) return { ok: false, error: waInitError || 'WhatsApp is not available.' };
  const plan = requirePlan();
  if (!plan.ok) return plan;
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
  if (!wa || typeof phone !== 'string' || !E164.test(phone)) return { ok: false, error: 'Invalid number.' };
  const plan = requirePlan();
  if (!plan.ok) return plan;
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
  if (!Number.isInteger(leadId) || leadId <= 0) return { ok: false, error: 'Invalid lead.' };
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (!text) return { ok: false, error: 'Write a message first.' };
  if (text.length > 4000) return { ok: false, error: 'The message is too long (4000 characters maximum).' };
  const plan = requirePlan();
  if (!plan.ok) return plan;
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

// Podcast leads: the selected ids, or all of them ({ all: true }). Only
// podcast leads are ever touched. Asks first (a dialog the window cannot
// answer for the user).
function podcastScope(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  if (r.all === true) return { all: true };
  const ids = Array.isArray(r.ids) ? r.ids.filter((x) => Number.isInteger(x) && x > 0).slice(0, 100_000) : [];
  return ids.length ? { ids } : null;
}

async function deletePodcasts(raw) {
  const scope = podcastScope(raw);
  if (!scope) return { ok: false, error: 'No podcast leads are selected.' };
  const count = scope.all ? store.podcastLeads({ pageSize: 1 }).counts.all : store.podcastLeadsForExport(scope).length;
  if (!count) return { ok: false, error: scope.all ? 'There are no podcast leads to delete.' : 'The selected podcast leads no longer exist.' };
  const msg = scope.all ? `Delete all ${count} podcast lead${count === 1 ? '' : 's'}?` : count === 1 ? 'Delete this podcast lead?' : `Delete ${count} selected podcast leads?`;
  const detail = scope.all ? 'Every podcast lead will be removed. Leads from Google Maps, Facebook and LinkedIn are not affected.' : `Only the ${count === 1 ? 'selected podcast lead' : `${count} selected podcast leads`} will be removed.`;
  if (!(await confirmDelete(msg, detail))) return { ok: false, canceled: true };
  return { ok: true, deleted: store.deletePodcastLeads(scope) };
}

async function exportPodcasts(raw) {
  const plan = requirePlan();
  if (!plan.ok) return plan;
  const scope = podcastScope(raw);
  if (!scope) return { ok: false, error: 'No podcast leads are selected.' };
  const leads = store.podcastLeadsForExport(scope);
  if (!leads.length) return { ok: false, error: scope.all ? 'There are no podcast leads to export.' : 'The selected podcast leads no longer exist.' };
  const stamp = new Date().toISOString().slice(0, 10);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: scope.all ? 'Export all podcast leads' : `Export ${leads.length} selected podcast leads`,
    defaultPath: path.join(app.getPath('documents'), `lead-finder-podcasts-${scope.all ? 'all' : 'selected'}-${stamp}.csv`),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  await fs.writeFile(filePath, leadsToCsv(leads), 'utf8');
  return { ok: true, count: leads.length, filePath };
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

// --- podcasts ------------------------------------------------------------------
// Podcast Lead Finder: the selected platforms are searched (or a pasted link
// looked up), and every podcast found is checked for public contact emails
// at once and saved to the leads (podcast-search.js). Plain requests only
// (no Chrome); it runs on its own, beside a lead search.

const PODCAST_PLATFORMS = Object.keys(PLATFORMS).filter((k) => !PLATFORMS[k].hidden);
const KEYED_PLATFORMS = Object.keys(PLATFORMS).filter((k) => PLATFORMS[k].keys.length);
const PODCAST_LIMITS = [25, 50, 100, 200];
const podcastFeeds = podcastLib.feedCacheOf();
const podcastLinks = new Set(); // addresses shown for podcasts (the only ones podcast:open opens)
let podcastRun = null; // { controller, promise }
let sessionKeys = null; // platform keys when there is no OS keychain (this session only)

function rememberLinks(...urls) {
  for (const u of urls.flat()) if (typeof u === 'string' && /^https?:\/\//i.test(u)) podcastLinks.add(u);
  if (podcastLinks.size > 20_000) podcastLinks.clear();
}

function podcastPlatformsOn() {
  const saved = store.getState('podcastPlatforms') || {};
  const on = Object.fromEntries(PODCAST_PLATFORMS.map((k) => [k, typeof saved[k] === 'boolean' ? saved[k] : k === 'apple']));
  // Only a removed platform was on (Podcast Index): Apple Podcasts again.
  if (!Object.values(on).some(Boolean)) on.apple = true;
  return on;
}

// Platform keys (Spotify, YouTube, Podcast Index): encrypted with the OS
// keychain; never sent to the window.
function podcastKeys() {
  if (sessionKeys) return sessionKeys;
  const saved = store.getState('podcastKeys');
  const cipher = keychainCipher();
  if (!saved?.enc || !cipher) return {};
  try {
    const all = JSON.parse(cipher.decrypt(Buffer.from(saved.enc, 'base64')));
    return Object.fromEntries(Object.entries(all).filter(([k]) => KEYED_PLATFORMS.includes(k)));
  } catch {
    return {};
  }
}
function savePodcastKeys(keys) {
  const cipher = keychainCipher();
  if (!cipher) {
    sessionKeys = keys;
    return false;
  }
  store.setState('podcastKeys', { enc: cipher.encrypt(JSON.stringify(keys)).toString('base64') });
  return true;
}

// Keys of platforms that no longer use them (Spotify, Podcast Index, from
// earlier versions) are deleted from this computer.
function dropUnusedPodcastKeys() {
  const saved = store.getState('podcastKeys');
  const cipher = keychainCipher();
  if (!saved?.enc || !cipher) return;
  try {
    const all = JSON.parse(cipher.decrypt(Buffer.from(saved.enc, 'base64')));
    if (Object.keys(all).some((k) => !KEYED_PLATFORMS.includes(k))) savePodcastKeys(podcastKeys());
  } catch {}
  const notes = store.getState('podcastKeyNotes');
  if (notes && Object.keys(notes).some((k) => !KEYED_PLATFORMS.includes(k))) store.setState('podcastKeyNotes', Object.fromEntries(Object.entries(notes).filter(([k]) => KEYED_PLATFORMS.includes(k))));
}

function podcastSettings() {
  const keys = podcastKeys();
  const limit = store.getState('podcastLimit');
  return {
    platforms: podcastPlatformsOn(),
    keys: Object.fromEntries(KEYED_PLATFORMS.map((k) => [k, Boolean(keys[k])])),
    // Keys saved but limited by the platform (what it said).
    keyNotes: Object.fromEntries(Object.entries(store.getState('podcastKeyNotes') || {}).filter(([k]) => keys[k])),
    limit: PODCAST_LIMITS.includes(limit) ? limit : 50,
    keychain: Boolean(keychainCipher()),
    running: Boolean(podcastRun),
  };
}

function setPodcastSettings(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Invalid value' };
  if (raw.platforms && typeof raw.platforms === 'object') {
    const next = Object.fromEntries(PODCAST_PLATFORMS.map((k) => [k, raw.platforms[k] === true]));
    if (!Object.values(next).some(Boolean)) return { ok: false, error: 'Keep at least one platform on.' };
    store.setState('podcastPlatforms', next);
  }
  if (raw.limit !== undefined) {
    if (!PODCAST_LIMITS.includes(raw.limit)) return { ok: false, error: 'Invalid number of results.' };
    store.setState('podcastLimit', raw.limit);
  }
  return { ok: true, ...podcastSettings() };
}

// A pasted key without what copying adds by accident: spaces, line breaks,
// invisible characters and quotes.
function cleanKey(v) {
  return typeof v === 'string' ? v.replace(/[\s​-‍⁠﻿]+/g, '').replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').slice(0, 300) : '';
}

// Checks the keys with the platform itself before saving them; empty values
// remove them. Keys the platform accepts but whose account it limits (e.g.
// Spotify without Premium) are saved with that note, so searches work as
// soon as the account allows them. Errors never include the keys.
async function setPodcastKeys(platform, raw) {
  const def = PLATFORMS[platform];
  if (!def || !def.keys.length) return { ok: false, error: 'This platform has no keys.' };
  const values = Object.fromEntries(def.keys.map((k) => [k, cleanKey(raw?.[k])]));
  const keys = { ...podcastKeys() };
  const notes = { ...(store.getState('podcastKeyNotes') || {}) };
  let warning = null;
  if (def.keys.every((k) => !values[k])) {
    delete keys[platform];
    delete notes[platform];
  } else {
    if (def.keys.some((k) => !values[k])) return { ok: false, error: 'Fill in every field.' };
    try {
      await ADAPTERS[platform].check(values, { signal: AbortSignal.timeout(30_000) });
      delete notes[platform];
    } catch (err) {
      if (err.code !== 'account') return { ok: false, error: err.message, code: err.code || 'failed' };
      warning = err.message;
      notes[platform] = err.message;
    }
    keys[platform] = values;
  }
  const stored = savePodcastKeys(keys);
  store.setState('podcastKeyNotes', notes);
  return { ok: true, stored, warning, ...podcastSettings() };
}

function startPodcastSearch(rawQuery, rawCategory) {
  if (podcastRun) return { ok: false, error: 'A podcast search is already running.' };
  const plan = requirePlan();
  if (!plan.ok) return plan;
  const query = typeof rawQuery === 'string' ? rawQuery.replace(/\s+/g, ' ').trim() : '';
  if (query.length < 2) return { ok: false, error: 'Enter a podcast name, a topic or a podcast link.' };
  if (query.length > 300 || /[\u0000-\u001f\u007f]/.test(query)) return { ok: false, error: 'The search is too long or contains invalid characters.' };
  const cat = validateCategory(rawCategory);
  if (cat.error) return { ok: false, error: cat.error };
  let category;
  try {
    category = store.ensureCategory(cat.category);
  } catch (err) {
    return { ok: false, error: `Could not save the category: ${err.message}` };
  }
  const settings = podcastSettings();
  const platforms = PODCAST_PLATFORMS.filter((k) => settings.platforms[k]);
  // Podcasts opened later from this search's Spotify / Amazon Music window
  // are saved under its keyword and category.
  if (platforms.some((k) => PLATFORMS[k].browser)) browserSearch = { keyword: query, categoryId: category.id };
  return { ok: true, category: category.name, platforms, runId: runPodcasts({ query, platforms, categoryId: category.id }) };
}

// Checks saved podcast leads again (Retry): ids of podcast leads.
function retryPodcasts(rawIds) {
  if (podcastRun) return { ok: false, error: 'A podcast search is running. Try again when it has finished.' };
  const plan = requirePlan();
  if (!plan.ok) return plan;
  const ids = (Array.isArray(rawIds) ? rawIds : []).map(Number).filter(Number.isInteger).slice(0, 500);
  const leads = ids.length ? store.podcastLeads({ ids, pageSize: 500 }).rows : [];
  if (!leads.length) return { ok: false, error: 'Choose podcasts to check again.' };
  const seed = leads.map((l) => ({
    leadId: l.id,
    title: l.name,
    host: l.podcastHost,
    description: '',
    appleId: /\/id(\d+)/.exec(l.podcastUrl || '')?.[1] || '',
    appleUrl: l.podcastUrl,
    feedUrl: l.rssUrl,
    feedFrom: l.rssUrl ? 'saved feed' : '',
    website: l.websiteUrl,
    links: l.podcastLinks,
    platforms: Object.keys(l.podcastLinks),
    platform: Object.keys(l.podcastLinks)[0] || 'website',
    url: Object.values(l.podcastLinks)[0] || l.websiteUrl,
    artwork: l.artworkUrl,
  }));
  return { ok: true, runId: runPodcasts({ query: 'retry', seed, categoryId: leads[0].categoryId }) };
}

function runPodcasts({ query, platforms = [], categoryId, seed = null, extraLinks = null, keyword }) {
  const controller = new AbortController();
  const settings = podcastSettings();
  const run = new PodcastSearch({
    openInBrowser: openPodcastPage,
    allow: robotsChecker({ signal: controller.signal }),
    query,
    keyword: keyword ?? query,
    platforms,
    seed,
    extraLinks,
    creds: podcastKeys(),
    store,
    categoryId,
    country: phoneCountry(),
    signal: controller.signal,
    feedCache: podcastFeeds,
    limit: settings.limit,
    emit: (event, payload) => {
      if (event === 'lead') return send('leads:added', payload);
      if (event === 'item') {
        rememberLinks(Object.values(payload.links || {}), payload.website);
        const r = payload.result;
        if (r) rememberLinks(r.rssUrl, r.website, r.socials || [], r.profiles || [], (r.emails || []).map((e) => e.url));
      }
      send(`podcast:${event}`, { ...payload, retry: Boolean(seed) });
    },
  });
  podcastRun = { controller, runId: run.runId };
  podcastRun.promise = run
    .run()
    .catch((err) => send('podcast:status', { runId: run.runId, state: 'failed', ...run.stats, message: `The podcast search failed: ${err.message}` }))
    .finally(() => {
      podcastRun = null;
      setImmediate(drainBrowserFinds);
    });
  return run.runId;
}

// --- podcasts opened in the browser (Spotify, Amazon Music) ------------------------
// Lead Finder never reads Spotify's or Amazon's pages. When the user opens a
// podcast there, only that page's address is used: an Amazon Music podcast
// page (its address names the podcast), or a podcast website opened from
// either window (read like a pasted website, where its robots.txt permits).

let browserSearch = { keyword: '', categoryId: null };
const browserSeen = new Set();
const browserQueue = [];

function watchBrowserWindow(page, platform) {
  if (page.__leadFinderWatched) return;
  page.__leadFinderWatched = true;
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    const found = browserFindOf(frame.url(), platform);
    if (found?.platform === 'amazon') browserFind(found.url, 'amazon', null);
  });
  const onNewTab = async (tabPage) => {
    if (tabPage.__leadFinderSeen) return;
    tabPage.__leadFinderSeen = true;
    const openerUrl = page.url();
    // The new tab's address once it has one (it starts blank).
    for (let i = 0; i < 40 && !/^https?:/.test(tabPage.url()); i++) await new Promise((r) => setTimeout(r, 250));
    const found = browserFindOf(tabPage.url(), platform, openerUrl);
    if (found) browserFind(found.url, found.platform, found.extraLinks || null);
  };
  page.on('popup', onNewTab);
  // Tabs opened from this window that the popup event misses (links a page
  // opens itself): any new tab whose opener is this window.
  page.context().on('page', async (tabPage) => {
    const opener = await tabPage.opener().catch(() => null);
    if (opener === page) onNewTab(tabPage);
  });
}

function browserFind(url, platform, extraLinks) {
  const key = url.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  if (browserSeen.has(key)) return;
  browserSeen.add(key);
  if (browserSeen.size > 2000) browserSeen.clear();
  browserQueue.push({ url, platform, extraLinks });
  send('podcast:browser', { url, platform, state: 'queued', from: extraLinks ? Object.keys(extraLinks)[0] : platform });
  drainBrowserFinds();
}

function drainBrowserFinds() {
  if (podcastRun || !browserQueue.length || !requirePlan().ok) return;
  const next = browserQueue.shift();
  send('podcast:browser', { url: next.url, platform: next.platform, state: 'checking' });
  runPodcasts({ query: next.url, extraLinks: next.extraLinks, keyword: browserSearch.keyword || next.url, categoryId: browserSearch.categoryId });
}

// A browser platform's page (Spotify) in the user's Chrome, in its own
// window, for the user to look through. Chrome is connected the same way as
// for a lead search (it may ask the user to Allow); the page is never read.
async function openPodcastPage(url, signal, platform = 'spotify') {
  if (!chrome.connected) {
    const profile = await chrome.connect({ signal });
    if (!search) resetTabs(profile);
    sendStatus({ profile: profileLabel(profile) });
  }
  const page = await tab(platform === 'amazon' ? 'amazon' : 'spotify');
  watchBrowserWindow(page, platform);
  const res = await page.goto(url, { waitUntil: 'commit', timeout: 30_000 });
  await page.bringToFront().catch(() => {});
  // Where Chrome actually is (only the address; nothing on the page is read).
  return { url: page.url(), status: res?.status() ?? null };
}

function stopPodcastSearch() {
  podcastRun?.controller.abort();
  return { ok: true };
}

// A podcast's platform page, feed, website, profile or the page an email
// was found on: only addresses Podcast Lead Finder showed.
function openPodcastLink(url) {
  // An email address: the user's mail app.
  const mail = /^mailto:([^@\s?&/]+@[^@\s?&/]+\.[a-z]{2,24})$/i.exec(String(url));
  if (mail) {
    shell.openExternal(`mailto:${mail[1]}`);
    return { ok: true };
  }
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return { ok: false };
  }
  const apple = u.protocol === 'https:' && u.hostname === 'podcasts.apple.com';
  if (!apple && !(/^https?:$/.test(u.protocol) && podcastLinks.has(String(url)))) return { ok: false };
  shell.openExternal(u.toString());
  return { ok: true };
}

function openListing(url) {
  // Only Google Maps listings, Facebook posts or pages and LinkedIn company,
  // job or post pages are opened, in the user's default browser.
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return { ok: false };
  }
  const maps = /^(www\.)?google\.[a-z.]+$/.test(u.hostname) && u.pathname.startsWith('/maps/');
  const facebook = /^(www|m|web)\.facebook\.com$/.test(u.hostname);
  const linkedin = /^([a-z]{2,3}\.|www\.)?linkedin\.com$/.test(u.hostname) && /^\/(company|jobs\/view|feed\/update|posts)\//.test(u.pathname);
  // A podcast's page on Apple Podcasts, Spotify, YouTube or Amazon Music.
  const podcast =
    (u.hostname === 'podcasts.apple.com' && /\/id\d+/.test(u.pathname)) ||
    (u.hostname === 'open.spotify.com' && /^\/show\//.test(u.pathname)) ||
    (/^(www\.)?youtube\.com$/.test(u.hostname) && /^\/(playlist|channel\/|@)/.test(u.pathname)) ||
    (/^music\.amazon\.[a-z.]+$/.test(u.hostname) && /^\/podcasts\//.test(u.pathname));
  if (u.protocol !== 'https:' || !(maps || facebook || linkedin || podcast)) {
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
    dropUnusedPodcastKeys();
    activation = createActivation();
    // The subscription system's request log, from earlier versions.
    require('node:fs').rmSync(path.join(app.getPath('userData'), 'licence.log'), { force: true });
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
  handle('leads:list', (filter) => store.listLeads(validateFilter(filter)));
  // Which of these leads match the table's filter (same rules as leads:list).
  handle('leads:match', (filter, ids) => {
    const list = Array.isArray(ids) ? [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))].slice(0, 1000) : [];
    return list.length ? store.listLeads({ ...validateFilter(filter), ids: list }) : [];
  });
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
  // Chats (WhatsApp Web-style view)
  // Outreach campaign
  const withCampaign = (fn) => (id, ...args) => {
    if (!outreach) return unavailable();
    const cid = campaignId(id);
    if (!cid || !outreach.load(cid)) return { ok: false, error: 'That campaign no longer exists.' };
    return fn(cid, ...args);
  };
  handle('outreach:overview', () => (outreach ? { ok: true, ...outreach.overview() } : unavailable()));
  handle('outreach:categoryCampaign', (raw) => {
    if (!outreach) return unavailable();
    const cat = categoryKey(raw);
    return cat ? { ok: true, id: outreach.categoryCampaign(cat.key, cat.name) } : { ok: false, error: 'That category no longer exists.' };
  });
  handle('outreach:setCategory', (raw, on, opts) => outreachSetCategory(raw, on, opts));
  handle('outreach:create', (name) => (outreach ? outreach.create(typeof name === 'string' ? name : '') : unavailable()));
  handle('outreach:delete', (ids) => (outreach ? outreach.remove(Array.isArray(ids) ? ids : []) : unavailable()));
  handle('outreach:reset', (ids) => (outreach ? outreach.reset(Array.isArray(ids) ? ids : []) : unavailable()));
  handle('outreach:state', withCampaign((id) => ({ ok: true, ...outreach.snapshot(id) })));
  handle('outreach:eligible', withCampaign((id, filters) => ({ ok: true, ...eligibleFor(id, filters) })));
  handle('outreach:history', () => (outreach ? { ok: true, history: outreach.store.history() } : unavailable()));
  handle('outreach:configure', withCampaign((id, cfg) => (cfg && typeof cfg === 'object' ? outreach.configure(id, cfg) : { ok: false, error: 'Invalid settings.' })));
  handle('outreach:addLeads', withCampaign((id, ids) => outreachAddLeads(id, ids)));
  handle('outreach:start', withCampaign((id, opts) => outreachStart(id, opts)));
  handle('outreach:pause', withCampaign((id) => outreach.pause(id, 'user')));
  handle('outreach:resume', withCampaign((id) => outreachResume(id)));
  handle('outreach:stop', withCampaign((id) => outreach.stop(id)));
  for (const action of ['exclude', 'include', 'removeContact']) {
    handle(`outreach:${action}`, withCampaign((id, phone) => (isPhone(phone) ? outreach[action](id, phone) : { ok: false, error: 'Invalid number.' })));
  }
  handle('outreach:optOut', (phone) => (!outreach ? unavailable() : isPhone(phone) ? outreach.optOut(phone) : { ok: false, error: 'Invalid number.' }));
  handle('outreach:setName', withCampaign((id, phone, name) => (isPhone(phone) ? outreach.setName(id, phone, typeof name === 'string' ? name : null) : { ok: false, error: 'Invalid number.' })));
  // Preview of (possibly unsaved) templates for one contact of the campaign.
  handle('outreach:render', withCampaign((id, templates, phone) => {
    if (!Array.isArray(templates) || templates.length !== 3) return { ok: false };
    const c = isPhone(phone) ? outreach.store.contact(id, phone) : null;
    const clean = templates.map((t) => ({ text: String(t?.text ?? '').slice(0, 1000), fallback: String(t?.fallback ?? '').slice(0, 1000) }));
    return { ok: true, values: c ? outreach.values(c) : { name: null, business: null }, messages: outreach.preview(c || { name: null }, clean) };
  }));
  handle('search:interrupted', () => interrupted);
  handle('search:dismissInterrupted', () => {
    interrupted = null;
    store.setState('lastSearch', { state: 'dismissed' });
    return { ok: true };
  });
  handle('search:start', (keyword, category, website, linkedin) => startSearch(keyword, category, website, linkedin));
  handle('search:stop', () => stopSearch());
  handle('maps:get', () => ({ on: mapsSearchOn() }));
  handle('maps:set', (on) => setMapsSearch(on));
  handle('facebook:get', () => ({ on: facebookSearchOn() }));
  handle('facebook:set', (on) => setFacebookSearch(on));
  handle('linkedin:get', () => ({ on: linkedinSearchOn() }));
  handle('linkedin:set', (on) => setLinkedInSearch(on));
  handle('linkedin:settings', () => linkedinSettings());
  handle('linkedin:setSettings', (raw) => setLinkedInSettings(raw));
  handle('phoneCountry:get', () => phoneCountrySettings());
  handle('phoneCountry:set', (code) => setPhoneCountry(code === null ? null : String(code || '').toUpperCase()));
  handle('search:status', () => lastStatus);
  handle('podcast:settings', () => podcastSettings());
  handle('podcast:setSettings', (raw) => setPodcastSettings(raw));
  handle('podcast:setKeys', (platform, values) => setPodcastKeys(String(platform), values));
  handle('podcast:search', (q, category) => startPodcastSearch(q, category));
  handle('podcast:stop', () => stopPodcastSearch());
  handle('podcast:retry', (ids) => retryPodcasts(ids));
  handle('podcast:leads', (raw) => {
    const f = raw && typeof raw === 'object' ? raw : {};
    const out = store.podcastLeads({
      status: ['all', 'found', 'none', 'pending'].includes(f.status) ? f.status : 'all',
      searchId: Number.isInteger(f.searchId) ? f.searchId : undefined,
      platform: typeof f.platform === 'string' ? f.platform : undefined,
      search: typeof f.search === 'string' ? f.search : '',
      sort: ['found', 'name', 'status', 'rank'].includes(f.sort) ? f.sort : 'found',
      dir: f.dir === 'asc' ? 'asc' : 'desc',
      page: Number.isInteger(f.page) ? f.page : 1,
      pageSize: [12, 24, 25, 48, 50, 100].includes(f.pageSize) ? f.pageSize : 24,
      ids: Array.isArray(f.ids) ? f.ids.filter(Number.isInteger) : undefined,
    });
    for (const l of out.rows) rememberLinks(Object.values(l.podcastLinks || {}), l.websiteUrl, l.rssUrl, (l.emails || []).map((e) => e.url), l.hits.map((h) => h.sourceUrl));
    return out;
  });
  handle('podcast:searches', () => store.podcastSearches(30));
  handle('podcast:ids', (raw) => {
    const f = raw && typeof raw === 'object' ? raw : {};
    return store.podcastLeadIds({
      status: ['all', 'found', 'none', 'pending'].includes(f.status) ? f.status : 'all',
      searchId: Number.isInteger(f.searchId) ? f.searchId : undefined,
      platform: typeof f.platform === 'string' ? f.platform : undefined,
      search: typeof f.search === 'string' ? f.search : '',
    });
  });
  handle('podcast:delete', (scope) => deletePodcasts(scope));
  handle('podcast:export', (scope) => exportPodcasts(scope));
  handle('podcast:open', (url) => openPodcastLink(url));
  handle('export:csv', (scope, filter) => exportCsv(scope === 'all' ? 'all' : 'filtered', filter));
  handle('lead:open', (url) => openListing(url));
  handle('activation:status', () => sendActivation());
  handle('activation:request', (plan) => requestActivation(plan));
  handle('activation:verify', (code, plan) => verifyActivation(code, plan));
  handle('activation:contact', (kind, text) => openContact(kind, text));

  createWindow();
  if (process.env.LEAD_FINDER_SMOKE_TEST) return smokeTest(process.env.LEAD_FINDER_SMOKE_TEST);

  updater = new Updater({ app, shell, isBusy: () => Boolean(search) || Boolean(outreach?.busy), send: (st) => send('update:status', st), log: fileLog(process.env.LEAD_FINDER_UPDATE_LOG || path.join(app.getPath('userData'), 'update.log')) });
  handle('update:status', () => updater.status);
  handle('update:openDownload', () => updater.openDownload());
  if (process.env.LEAD_FINDER_NO_UPDATES !== '1') updater.start();
});

// Release check (CI): the installed app must start on its own, show its UI
// and have its bundled modules. Writes a JSON report and quits.
function smokeTest(reportFile) {
  const report = { version: app.getVersion(), packaged: app.isPackaged };
  const finish = async (ok, error) => {
    await fs.writeFile(reportFile, JSON.stringify({ ok, error, ...report }, null, 2)).catch(() => {});
    app.exit(ok ? 0 : 1);
  };
  setTimeout(() => finish(false, 'timed out'), 90_000).unref();
  win.webContents.once('did-finish-load', async () => {
    try {
      await new Promise((r) => setTimeout(r, 1500));
      report.lockScreen = await win.webContents.executeJavaScript("!!document.querySelector('#root')?.textContent.includes('Lead Finder')");
      report.modules = {
        playwright: typeof require('playwright-core').chromium.connectOverCDP === 'function',
        baileys: typeof (await import('baileys')).default === 'function',
        sqlite: store.db != null,
      };
      // The app must carry its activation settings (secret, email), or no plan could be activated.
      report.activation = activation.status().configured;
      const ok = report.lockScreen && report.activation && Object.values(report.modules).every(Boolean);
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
  watchActivation();
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
  podcastRun?.controller.abort();
  Promise.all([search?.promise, podcastRun?.promise].map((p) => Promise.resolve(p).catch(() => {})))
    .then(() => outreach?.dispose())
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
