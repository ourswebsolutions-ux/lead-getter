'use strict';

// Settings > Automation, and Lead Finder as a background app: the tray icon,
// starting with the computer, and notifications.
//
// Background model: the Electron main process is the engine (searches,
// continuous searches, WhatsApp campaigns); the window is only its view.
// With "Keep running in the background" on, closing or minimising the window
// keeps the engine running, the tray icon reopens it, and only Quit (tray or
// Settings) stops it. A Windows service is not used: services run in a
// separate session (session 0) that cannot use the signed-in user's Chrome,
// desktop or keychain, which the searches and WhatsApp need. Instead Lead
// Finder starts when the user signs in (Windows and macOS login items, a
// Linux autostart entry), hidden in the tray, and resumes its work; with
// Windows automatic sign-in (windows-autologon.js) that needs nobody at the
// computer. A locked screen does not stop it: the session keeps running.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KEY = 'automation.settings';
const BACKGROUND_ARG = '--background';

const DEFAULTS = {
  startWithOS: false, // start when the user signs in, hidden in the tray
  background: false, // closing the window keeps the work running
  autoResume: false, // resume searches and campaigns at start, before the PIN
  notifications: true,
  chrome: {
    profile: 'everyday', // 'everyday' | 'automation' (Lead Finder's own folder)
    profileDir: '', // everyday Chrome: the profile started ('' = last used)
    autoLaunch: true, // start Chrome when a search needs it
    autoReconnect: true, // reconnect (and reopen) after Chrome closes or crashes
    autoRestart: false, // restart Chrome without asking, when recovery needs it
  },
  search: {
    resumeInterrupted: true, // continuous searches resume after a restart
  },
  captcha: {
    restartChrome: true, // one Chrome restart while blocked (never counts as solved)
  },
};

function readSettings(store) {
  const s = store.getState(KEY) || {};
  return { ...DEFAULTS, ...s, chrome: { ...DEFAULTS.chrome, ...s.chrome }, search: { ...DEFAULTS.search, ...s.search }, captcha: { ...DEFAULTS.captcha, ...s.captcha } };
}

// Only known keys, of the right type, are kept.
function validateSettings(raw, current) {
  const out = JSON.parse(JSON.stringify(current));
  const bool = (obj, key, src) => {
    if (src && typeof src[key] === 'boolean') obj[key] = src[key];
  };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of ['startWithOS', 'background', 'autoResume', 'notifications']) bool(out, k, raw);
  if (raw.chrome && typeof raw.chrome === 'object') {
    if (['everyday', 'automation'].includes(raw.chrome.profile)) out.chrome.profile = raw.chrome.profile;
    if (typeof raw.chrome.profileDir === 'string' && /^(|Default|Profile \d{1,3}|Guest Profile|[\w .-]{1,60})$/.test(raw.chrome.profileDir)) out.chrome.profileDir = raw.chrome.profileDir;
    for (const k of ['autoLaunch', 'autoReconnect', 'autoRestart']) bool(out.chrome, k, raw.chrome);
  }
  if (raw.search) bool(out.search, 'resumeInterrupted', raw.search);
  if (raw.captcha) bool(out.captcha, 'restartChrome', raw.captcha);
  // Starting with the computer only makes sense if the work keeps running.
  if (out.startWithOS) out.background = true;
  return out;
}

// --- starting with the computer -------------------------------------------------

function linuxAutostartFile(env = process.env) {
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'lead-finder.desktop');
}

// The command that starts this copy: an AppImage runs from its own file.
function launchCommand(app, env = process.env) {
  return env.APPIMAGE || app.getPath('exe');
}

// Turns starting at sign-in on or off. Returns { ok, supported, error }.
function setStartWithOS(app, on, { platform = process.platform, env = process.env } = {}) {
  if (!app.isPackaged && !env.LEAD_FINDER_TEST_AUTOSTART) return { ok: false, supported: false, error: 'Starting with the computer works in the installed app, not when run from source.' };
  try {
    if (platform === 'linux') {
      const file = env.LEAD_FINDER_TEST_AUTOSTART || linuxAutostartFile(env);
      if (!on) {
        fs.rmSync(file, { force: true });
        return { ok: true, supported: true };
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const exe = launchCommand(app, env).replace(/(["\\`$])/g, '\\$1');
      fs.writeFileSync(file, ['[Desktop Entry]', 'Type=Application', 'Name=Lead Finder', `Exec="${exe}" ${BACKGROUND_ARG}`, 'X-GNOME-Autostart-enabled=true', 'NoDisplay=false', 'Comment=Lead Finder background work', ''].join('\n'));
      return { ok: true, supported: true };
    }
    app.setLoginItemSettings({ openAtLogin: on, openAsHidden: on, args: on ? [BACKGROUND_ARG] : [] });
    return { ok: true, supported: true };
  } catch (err) {
    return { ok: false, supported: true, error: err.message };
  }
}

function startsWithOS(app, { platform = process.platform, env = process.env } = {}) {
  if (platform === 'linux') return fs.existsSync(env.LEAD_FINDER_TEST_AUTOSTART || linuxAutostartFile(env));
  try {
    return Boolean(app.getLoginItemSettings({ args: [BACKGROUND_ARG] }).openAtLogin);
  } catch {
    return false;
  }
}

// Started at sign-in (hidden), not by the user.
function startedInBackground(argv = process.argv) {
  return argv.includes(BACKGROUND_ARG);
}

// --- notifications ---------------------------------------------------------------

// The same kind of event is shown at most once in `gap` (new leads: once in
// 30 minutes, summed), so a long unattended run never floods the screen.
class Notifier {
  constructor({ show, enabled = () => true, now = () => Date.now(), log = () => {} }) {
    Object.assign(this, { show, enabled, now, log });
    this.last = new Map();
    this.pendingLeads = 0;
  }

  notify(kind, title, body) {
    this.log(`notice ${kind}: ${title}: ${body}`);
    if (!this.enabled()) return false;
    const gap = kind === 'leads' ? 30 * 60_000 : ['captcha', 'failed'].includes(kind) ? 60_000 : 10 * 60_000;
    const key = kind === 'leads' ? 'leads' : `${kind}:${title}`;
    if (kind === 'leads') this.pendingLeads += Number(/^(\d+)/.exec(body)?.[1] || 0);
    const at = this.last.get(key) || 0;
    if (this.now() - at < gap) return false;
    this.last.set(key, this.now());
    if (kind === 'leads') {
      const n = this.pendingLeads;
      this.pendingLeads = 0;
      if (!n) return false;
      body = `${n} new lead${n === 1 ? '' : 's'} saved.`;
    }
    try {
      this.show(title, body);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { DEFAULTS, readSettings, validateSettings, setStartWithOS, startsWithOS, startedInBackground, linuxAutostartFile, Notifier, BACKGROUND_ARG, KEY };
