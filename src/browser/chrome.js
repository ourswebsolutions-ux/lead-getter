'use strict';

// Discovery of the user's installed Google Chrome and attachment to the
// already-running session over the Chrome DevTools Protocol.
//
// How Chrome allows this (verified against Chrome's own documentation):
//  * Default user data directory (the normal Chrome profile folder): since
//    Chrome 136 the --remote-debugging-port/pipe switches are ignored there,
//    on purpose, to stop cookie-stealing malware. Restarting Chrome with a
//    flag therefore cannot reach the user's real profile. The only supported
//    route is the "Allow remote debugging for this browser instance" switch
//    at chrome://inspect/#remote-debugging (Chrome 144+), which the user has
//    to turn on in Chrome, plus an Allow prompt Chrome shows on connect.
//    Lead Finder opens that page automatically and continues the moment the
//    switch is on. It does not edit Chrome's files or fake the click.
//  * Non-default user data directory (Chrome started with --user-data-dir):
//    debugging switches still work, so Lead Finder can close that Chrome
//    gracefully and relaunch it with the same directory and profile plus
//    debugging enabled, then reconnect automatically.
//
// Nothing here creates or copies a profile, reads cookies, or force-kills
// Chrome.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { execFile, spawn } = require('node:child_process');
const { chromium } = require('playwright-core');

const SETUP_URL = 'chrome://inspect/#remote-debugging';
const LEGACY_PORT = 9222;
const TOGGLE_MIN_VERSION = 144;
const DEFAULT_DIR_FLAG_BLOCKED_FROM = 136;

class ChromeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class ConnectCancelled extends Error {
  constructor() {
    super('Connection cancelled');
    this.code = 'cancelled';
  }
}

// --- installation -------------------------------------------------------------

function chromeExecutableCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter(Boolean);
    return roots.map((r) => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  if (platform === 'darwin') {
    const app = path.join('Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome');
    return [path.join('/Applications', app), path.join(os.homedir(), 'Applications', app)];
  }
  return ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/opt/google/chrome/chrome'];
}

function defaultUserDataDir(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data') : null;
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  }
  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'google-chrome');
}

function findChromeExecutable() {
  // Test hook: LEAD_FINDER_CHROME_EXE simulates another install location.
  const candidates = process.env.LEAD_FINDER_CHROME_EXE ? [process.env.LEAD_FINDER_CHROME_EXE] : chromeExecutableCandidates();
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, stdout: String(stdout || '') });
    });
  });
}

// Installed Chrome major version, without starting a browser.
async function chromeMajorVersion(exe) {
  if (!exe) return null;
  if (process.platform === 'win32') {
    // Chrome keeps a folder named after its version next to chrome.exe.
    try {
      const v = fs.readdirSync(path.dirname(exe)).filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d)).sort().pop();
      return v ? Number(v.split('.')[0]) : null;
    } catch {
      return null;
    }
  }
  const r = await run(exe, ['--version']);
  const m = r.stdout.match(/(\d+)\.\d+\.\d+\.\d+/);
  return m ? Number(m[1]) : null;
}

// --- running sessions ---------------------------------------------------------

// Value of a --switch in an argv array or a single command-line string.
function switchValue(args, name) {
  if (Array.isArray(args)) {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3).replace(/^"(.*)"$/, '$1') : null;
  }
  const m = String(args).match(new RegExp(`--${name}=(?:"([^"]+)"|(.+?))(?= --|"?$)`));
  return m ? (m[1] || m[2]).trim() : null;
}

function hasSwitch(args, name) {
  return Array.isArray(args) ? args.some((a) => a === `--${name}` || a.startsWith(`--${name}=`)) : String(args).includes(`--${name}`);
}

function describeProcess(pid, args) {
  return {
    pid,
    userDataDir: switchValue(args, 'user-data-dir'),
    profileDirectory: switchValue(args, 'profile-directory'),
    debugPort: switchValue(args, 'remote-debugging-port'),
  };
}

// Browser (non-helper) Chrome processes and the switches they started with.
async function listChromeSessions() {
  const exes = chromeExecutableCandidates();
  const sessions = [];
  if (process.platform === 'linux') {
    // The launchers are wrapper scripts; the browser runs as "chrome" next to them.
    const real = new Set(['/opt/google/chrome/chrome']);
    for (const p of exes.filter((e) => fs.existsSync(e))) {
      const r = fs.realpathSync(p);
      real.add(r);
      real.add(path.join(path.dirname(r), 'chrome'));
    }
    for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
      let cmd;
      try {
        cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      } catch {
        continue;
      }
      // Chrome rewrites its process title, so the arguments usually arrive as
      // one space-joined string rather than NUL-separated.
      const args = cmd.split('\0').filter(Boolean);
      const line = args.length > 1 ? null : args[0] || '';
      const exe = line === null ? args[0] : [...real].find((r) => line === r || line.startsWith(`${r} `));
      if (!exe || !real.has(exe) || cmd.includes('--type=')) continue;
      sessions.push(describeProcess(Number(pid), line === null ? args : line));
    }
  } else if (process.platform === 'darwin') {
    const r = await run('ps', ['-axww', '-o', 'pid=,command=']);
    for (const line of r.stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!m || !m[2].includes('Google Chrome.app/Contents/MacOS/Google Chrome') || m[2].includes('--type=')) continue;
      sessions.push(describeProcess(Number(m[1]), m[2]));
    }
  } else if (process.platform === 'win32') {
    const r = await run('powershell.exe', [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }",
    ], 15_000);
    for (const line of r.stdout.split(/\r?\n/)) {
      const [pid, cmd = ''] = line.split('\t');
      if (!/^\d+$/.test(pid) || cmd.includes('--type=')) continue;
      sessions.push(describeProcess(Number(pid), cmd));
    }
  }
  const def = defaultUserDataDir();
  for (const s of sessions) {
    s.userDataDir = s.userDataDir ? path.resolve(s.userDataDir) : def;
    s.isDefaultDir = samePath(s.userDataDir, def);
  }
  return sessions;
}

function readLocalState(userDataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf8'));
  } catch {
    return null;
  }
}

function describeProfile(userDataDir, profileDir) {
  const info = readLocalState(userDataDir)?.profile?.info_cache?.[profileDir] || {};
  return { dir: profileDir, name: info.name || profileDir, account: info.user_name || '' };
}

// Picks the profile the running session is using, without asking the user:
// an explicit --profile-directory, else the most recently used profile among
// those with open windows, else the most recently used one.
function selectProfile(userDataDir, session) {
  if (session?.profileDirectory) return { ...describeProfile(userDataDir, session.profileDirectory), reason: 'command line' };
  const p = readLocalState(userDataDir)?.profile || {};
  const open = Array.isArray(p.last_active_profiles) ? p.last_active_profiles : [];
  let dir = null;
  let reason = '';
  if (p.last_used && (open.length === 0 || open.includes(p.last_used))) {
    dir = p.last_used;
    reason = 'most recently used';
  } else if (open.length) {
    dir = open[0];
    reason = 'open profile';
  } else {
    dir = 'Default';
    reason = 'Chrome default';
  }
  return { ...describeProfile(userDataDir, dir), reason, openProfiles: open };
}

// --- debugging endpoint -------------------------------------------------------

function portIsOpen(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

// DevToolsActivePort: line 1 = port, line 2 = browser target path.
function parseDevToolsActivePort(text) {
  const [portLine, pathLine] = String(text).split(/\r?\n/);
  const port = Number.parseInt(portLine, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (!pathLine || !pathLine.startsWith('/devtools/browser/')) return null;
  return { port, wsPath: pathLine.trim() };
}

function fetchJson(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(body) : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

// Returns { endpoint, diagnostics }; endpoint is { wsEndpoint, via } or null.
// diagnostics records what was checked, for a precise error message.
async function findDebugEndpoint(userDataDir, extraPorts = []) {
  const diagnostics = [];
  if (userDataDir) {
    const file = path.join(userDataDir, 'DevToolsActivePort');
    let parsed = null;
    try {
      parsed = parseDevToolsActivePort(fs.readFileSync(file, 'utf8'));
      if (!parsed) diagnostics.push(`${file} is unreadable`);
    } catch {
      diagnostics.push(`no DevToolsActivePort file in ${userDataDir}`);
    }
    if (parsed) {
      // The file can be stale after Chrome exits, so the port must answer.
      if (await portIsOpen(parsed.port)) {
        return { endpoint: { wsEndpoint: `ws://127.0.0.1:${parsed.port}${parsed.wsPath}`, via: 'port-file' }, diagnostics };
      }
      diagnostics.push(`DevToolsActivePort names port ${parsed.port}, which is closed (stale file)`);
    }
  }
  for (const port of new Set([...extraPorts, LEGACY_PORT].map(Number).filter(Boolean))) {
    const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    if (version?.webSocketDebuggerUrl) {
      return { endpoint: { wsEndpoint: version.webSocketDebuggerUrl, via: 'port' }, diagnostics };
    }
    diagnostics.push((await portIsOpen(port)) ? `port ${port} is open but is not a Chrome debugging endpoint` : `port ${port} is closed`);
  }
  return { endpoint: null, diagnostics };
}

// --- launching / closing ------------------------------------------------------

function launchChrome(exe, args) {
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
}

// Whether the user has turned on Chrome's "Allow remote debugging for this
// browser instance" switch. Chrome remembers it in Local State and then
// starts its debugging server by itself on every launch (verified on Chrome
// 154). Read-only: Lead Finder never writes Chrome's files.
function toggleRemembered(userDataDir) {
  return readLocalState(userDataDir)?.devtools?.remote_debugging?.['user-enabled'] === true;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Asks Chrome to quit the way closing its windows would, so it saves the
// session and profile normally. Never force-kills.
async function requestGracefulQuit(session) {
  if (process.platform === 'darwin') {
    await run('osascript', ['-e', 'tell application "Google Chrome" to quit']);
  } else if (process.platform === 'win32') {
    await run('taskkill', ['/PID', String(session.pid)]); // no /F: WM_CLOSE, like clicking X
  } else {
    process.kill(session.pid, 'SIGTERM'); // Chrome treats SIGTERM as a normal shutdown
  }
}

// --- connection -----------------------------------------------------------------

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ConnectCancelled());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new ConnectCancelled());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const TIMINGS = {
  toggleWait: 300_000, // how long to wait for the user to turn on Chrome's switch
  poll: 1500,
  quitWait: 30_000,
  relaunchWait: 30_000,
  settle: 3000, // tabs unchanged this long = session restore finished
};

// Holds the single CDP connection for the app session. Chrome asks the user
// to Allow every new connection, so the connection is kept and reused.
class ChromeConnection {
  // onNeedsToggle({ url }) is called once when the user has to turn on
  // Chrome's switch; the app uses it to put the address on the clipboard
  // (Chrome refuses chrome:// URLs from other programs, so it cannot be opened
  // for the user).
  // confirmRestart({ profileName, reason }) must resolve true before Chrome is
  // closed and reopened; the app asks the user.
  constructor({ onStatus, onNeedsToggle, confirmRestart, timings } = {}) {
    this.browser = null;
    this.context = null;
    this.profile = null;
    this.session = null;
    this.onStatus = onStatus || (() => {});
    this.onNeedsToggle = onNeedsToggle || (() => {});
    this.confirmRestart = confirmRestart || (async () => true);
    this.timings = { ...TIMINGS, ...timings };
  }

  get connected() {
    return Boolean(this.browser && this.browser.isConnected());
  }

  // Finds the user's Chrome session and attaches to it, enabling debugging
  // automatically where Chrome permits it. Resolves to the verified profile
  // only after a real CDP connection.
  async connect({ signal } = {}) {
    if (this.connected) return this.profile;

    const exe = findChromeExecutable();
    if (!exe) throw new ChromeError('not_installed', 'Google Chrome is not installed or could not be located.');
    const major = await chromeMajorVersion(exe);

    this.onStatus('Looking for your Chrome session');
    let session = await this.findSession();
    const expectedDir = session?.userDataDir || process.env.LEAD_FINDER_CHROME_USER_DATA || defaultUserDataDir();
    const profile = selectProfile(expectedDir, session);

    let justLaunched = false;
    if (!session) {
      // Chrome is closed: start it normally with the user's last profile. If
      // the debugging switch was turned on before, Chrome serves it at once.
      this.onStatus(`Starting Chrome with your profile "${profile.name}"`);
      launchChrome(exe, this.launchArgs(expectedDir, profile, { debugFlag: !samePath(expectedDir, defaultUserDataDir()) }));
      session = await this.waitFor(() => this.findSession(), this.timings.relaunchWait, signal);
      if (!session) throw new ChromeError('launch_failed', 'Chrome did not start. Open Chrome yourself and try again.');
      justLaunched = true;
    }
    this.session = { ...session, exe, profile };

    // A Chrome that just started writes its port file a few seconds later.
    let { endpoint, diagnostics } = await this.waitForEndpoint(session, justLaunched || !session.isDefaultDir ? 10_000 : 0, signal);
    if (!endpoint) {
      if (!session.isDefaultDir) {
        // Custom profile folder: debugging switches are honoured there.
        endpoint = await this.restart(signal, 'so Lead Finder can connect');
      } else if (toggleRemembered(session.userDataDir)) {
        // Switch already on, but this Chrome started without its server
        // (e.g. it was running before the switch was saved): a normal
        // restart of the same profile starts it.
        endpoint = await this.restart(signal, 'to apply your remote-debugging setting');
      } else {
        endpoint = await this.waitForToggle(session, major, diagnostics, signal);
      }
    }

    await this.attach(endpoint, session.userDataDir, signal);
    return this.profile;
  }

  launchArgs(userDataDir, profile, { debugFlag }) {
    const args = [];
    // Never pass --user-data-dir for the normal folder: Chrome would treat
    // it as the same folder anyway, and debugging flags are ignored there.
    if (debugFlag) args.push(`--user-data-dir=${userDataDir}`);
    args.push(`--profile-directory=${profile.dir}`);
    if (debugFlag) args.push('--remote-debugging-port=0');
    return args;
  }

  async findSession() {
    const sessions = await listChromeSessions();
    const wanted = process.env.LEAD_FINDER_CHROME_USER_DATA;
    if (wanted) return sessions.find((s) => samePath(s.userDataDir, wanted)) || null;
    // The user's everyday Chrome (default folder) first, then any other.
    return sessions.find((s) => s.isDefaultDir) || sessions[0] || null;
  }

  async waitFor(probe, timeout, signal) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const v = await probe();
      if (v || Date.now() > deadline) return v || null;
      await wait(this.timings.poll, signal);
    }
  }

  // Polls for the endpoint a little while (Chrome writes its port file a
  // moment after it starts).
  async waitForEndpoint(session, timeout, signal) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const r = await findDebugEndpoint(session.userDataDir, [session.debugPort]);
      if (r.endpoint || Date.now() >= deadline) return r;
      await wait(this.timings.poll, signal);
    }
  }

  // Normal Chrome folder, switch never turned on: only the user can turn it
  // on (Chrome 136+ ignores debugging flags there by design). Give exact
  // directions, put the address on the clipboard, and continue on our own the
  // moment Chrome starts its server. This is needed once; Chrome remembers it.
  async waitForToggle(session, major, diagnostics, signal) {
    if (major && major < TOGGLE_MIN_VERSION) {
      throw new ChromeError(
        'chrome_too_old',
        `Your Chrome (version ${major}) cannot share its main profile with other apps. ` +
          (major >= DEFAULT_DIR_FLAG_BLOCKED_FROM
            ? `Chrome ${DEFAULT_DIR_FLAG_BLOCKED_FROM}+ blocks restart-based debugging for the main profile, and the permitted switch needs Chrome ${TOGGLE_MIN_VERSION}+. `
            : '') +
          'Update Chrome (Settings > About Chrome) and try again.',
      );
    }
    this.onNeedsToggle({ url: SETUP_URL });
    const deadline = Date.now() + this.timings.toggleWait;
    for (;;) {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      this.onStatus(
        `One-time Chrome setup needed. In Chrome, paste ${SETUP_URL} into the address bar (it is on your clipboard), ` +
          `turn on "Allow remote debugging for this browser instance", then click Allow when Chrome asks. ` +
          `Lead Finder continues by itself (${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left).`,
      );
      const r = await findDebugEndpoint(session.userDataDir, [session.debugPort]);
      if (r.endpoint) return r.endpoint;
      diagnostics = r.diagnostics;
      if (Date.now() > deadline) break;
      await wait(this.timings.poll, signal);
    }
    throw new ChromeError(
      'debugging_blocked',
      `Chrome connection not allowed yet. Your Chrome (${session.userDataDir}, process ${session.pid}) has not turned on ` +
        `"Allow remote debugging for this browser instance" at ${SETUP_URL}. Chrome ${DEFAULT_DIR_FLAG_BLOCKED_FROM}+ only lets other ` +
        `apps use your main profile through that switch, and only you can turn it on. Checked: ${diagnostics.join('; ')}.`,
    );
  }

  // Graceful restart of the same Chrome folder and profile, tabs restored.
  // Supported for a custom profile folder (relaunched with a debugging port)
  // and for the normal folder once the user's switch is remembered (Chrome
  // then starts its own server). Returns the new endpoint.
  canRestart() {
    const s = this.session;
    return Boolean(s && (!s.isDefaultDir || toggleRemembered(s.userDataDir)));
  }

  async restart(signal, why = '') {
    const s = this.session;
    if (!this.canRestart()) {
      throw new ChromeError('restart_unsupported', 'Chrome cannot be restarted with debugging for this profile.');
    }
    const approved = await this.confirmRestart({ profileName: s.profile.name, reason: why });
    if (!approved) {
      throw new ChromeError(
        'restart_declined',
        'Chrome was not restarted. Lead Finder can only connect after Chrome restarts with your remote-debugging setting; start the search again when it is convenient.',
      );
    }
    await this.disconnect();
    this.onStatus(`Restarting Chrome with your profile "${s.profile.name}"${why ? ` ${why}` : ''}`);
    await requestGracefulQuit(s);
    const closed = await this.waitFor(async () => !pidAlive(s.pid), this.timings.quitWait, signal);
    if (!closed) {
      throw new ChromeError(
        'restart_blocked',
        'Chrome did not close (it may be showing a "leave site?" or download prompt). Lead Finder never force-closes Chrome; close it yourself or answer the prompt, then try again.',
      );
    }
    // Only accept the endpoint written by the new process.
    const portFile = path.join(s.userDataDir, 'DevToolsActivePort');
    const before = fs.existsSync(portFile) ? fs.statSync(portFile).mtimeMs : 0;
    launchChrome(s.exe, [...this.launchArgs(s.userDataDir, s.profile, { debugFlag: !s.isDefaultDir }), '--restore-last-session']);
    this.onStatus('Reconnecting to Chrome');
    const endpoint = await this.waitFor(
      async () => {
        if (!fs.existsSync(portFile) || fs.statSync(portFile).mtimeMs <= before) return null;
        return (await findDebugEndpoint(s.userDataDir)).endpoint;
      },
      this.timings.relaunchWait,
      signal,
    );
    if (!endpoint) {
      throw new ChromeError('restart_failed', 'Chrome restarted but did not open a debugging connection. Try again.');
    }
    const fresh = (await this.findSession()) || s;
    this.session = { ...s, pid: fresh.pid };
    this.onStatus('Waiting for Chrome to restore your tabs');
    await this.waitForTabsToSettle(new URL(endpoint.wsEndpoint).port, signal);
    return endpoint;
  }

  // Restart and attach again; used to recover from a persistent block
  // during a search. Returns the verified profile.
  async restartAndAttach(signal) {
    const endpoint = await this.restart(signal);
    await this.attach(endpoint, this.session.userDataDir, signal);
    return this.profile;
  }

  // Session restore replaces Chrome's startup window, so attaching (and
  // opening our tab) before it finishes would lose the tab. Wait until the
  // set of open tabs stops changing. The switch-started server does not
  // offer /json/list; then a fixed pause is used instead.
  async waitForTabsToSettle(port, signal) {
    const deadline = Date.now() + this.timings.relaunchWait;
    let last = null;
    let stableSince = Date.now();
    let misses = 0;
    while (Date.now() < deadline) {
      const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      if (!list && ++misses >= 3) {
        await wait(this.timings.settle * 2, signal);
        return;
      }
      const key = JSON.stringify((list || []).filter((t) => t.type === 'page').map((t) => t.id).sort());
      if (key !== last) {
        last = key;
        stableSince = Date.now();
      } else if (list && Date.now() - stableSince >= this.timings.settle) {
        return;
      }
      await wait(500, signal);
    }
  }

  async attach(endpoint, expectedUserDataDir, signal) {
    if (endpoint.via === 'port-file') this.onStatus('Connecting to Chrome. If Chrome asks to allow remote debugging, click Allow');
    let browser;
    try {
      browser = await Promise.race([
        chromium.connectOverCDP(endpoint.wsEndpoint, { timeout: 90_000 }),
        new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new ConnectCancelled()), { once: true })),
      ]);
    } catch (err) {
      if (err instanceof ConnectCancelled) throw err;
      throw new ChromeError(
        'attach_failed',
        `Chrome refused the connection (${shortError(err)}). If Chrome asked whether to allow remote debugging, choose Allow.`,
      );
    }
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close().catch(() => {});
      throw new ChromeError('attach_failed', 'Connected to Chrome, but it exposed no browser profile.');
    }
    this.browser = browser;
    this.context = context;
    browser.on('disconnected', () => {
      // A replaced connection's late event must not clear the current one.
      if (this.browser !== browser) return;
      this.browser = null;
      this.context = null;
      this.profile = null;
    });
    try {
      this.profile = await this.identifyProfile(expectedUserDataDir);
    } catch (err) {
      await this.disconnect();
      throw err;
    }
    this.profile.via = endpoint.via;
  }

  // Verifies, visibly, which profile we are attached to by opening
  // chrome://version in a new tab of the connected profile.
  async identifyProfile(expectedUserDataDir) {
    const page = await this.context.newPage();
    try {
      await page.goto('chrome://version', { timeout: 15_000 });
      const profilePath = (await page.locator('#profile_path').textContent({ timeout: 5000 }))?.trim();
      const version = (await page.locator('#version').textContent({ timeout: 5000 }).catch(() => ''))?.trim();
      if (!profilePath) throw new Error('profile path missing');
      const userDataDir = path.dirname(profilePath);
      if (!samePath(userDataDir, expectedUserDataDir)) {
        throw new ChromeError(
          'wrong_profile',
          `The Chrome that answered uses ${userDataDir}, not your Chrome folder ${expectedUserDataDir}. Lead Finder did not use it.`,
        );
      }
      const profile = describeProfile(userDataDir, path.basename(profilePath));
      const open = readLocalState(userDataDir)?.profile?.last_active_profiles || [];
      return {
        ...profile,
        path: profilePath,
        userDataDir,
        otherOpenProfiles: open.filter((d) => d !== profile.dir).map((d) => describeProfile(userDataDir, d).name),
        chromeVersion: version.split(/\s/)[0] || '',
        page,
      };
    } catch (err) {
      await page.close().catch(() => {});
      if (err instanceof ChromeError) throw err;
      throw new ChromeError('profile_unknown', `Connected to Chrome but could not verify the profile (${shortError(err)}).`);
    }
  }

  // A page in a new window of the same Chrome session, for work that runs
  // alongside the search tabs: Chrome shows one tab per window, so a tab
  // in the search tabs' window would be hidden (and slowed down) whenever
  // the search switches tabs. The page is also kept active for Chrome while
  // its window is behind others. Falls back to a new tab if Chrome does not
  // open the window.
  async newWindowPage() {
    const before = new Set(this.context.pages());
    let page = null;
    try {
      const cdp = await this.browser.newBrowserCDPSession();
      try {
        const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
        page = await this.pageForTarget(targetId, before);
      } finally {
        await cdp.detach().catch(() => {});
      }
    } catch {
      page = null;
    }
    if (!page) page = await this.context.newPage();
    await keepActive(this.context, page);
    return page;
  }

  // A new tab in the same window as `page`. Chrome puts tabs opened over
  // DevTools into whichever window was used last (which may be the other
  // worker's window), so the tab is opened from `page` itself, without a
  // link back to it (noopener). Falls back to a plain new tab.
  async newTabBeside(page) {
    if (page && !page.isClosed()) {
      try {
        const popup = page.waitForEvent('popup', { timeout: 10_000 });
        popup.catch(() => {});
        await page.evaluate(() => {
          window.open('about:blank', '_blank', 'noopener');
        });
        return await popup;
      } catch {
        // page busy navigating, or the tab did not open: use a plain tab
      }
    }
    return this.context.newPage();
  }

  async pageForTarget(targetId, before, timeout = 10_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const p of this.context.pages()) {
        if (!before.has(p) && (await targetIdOf(this.context, p)) === targetId) return p;
      }
      await wait(100);
    }
    return null;
  }

  // Detaches Lead Finder from Chrome. For a CDP-attached browser Playwright
  // only disconnects; Chrome and the user's tabs stay open.
  async disconnect() {
    const b = this.browser;
    this.browser = null;
    this.context = null;
    this.profile = null;
    if (b) await b.close().catch(() => {});
  }
}

async function targetIdOf(context, page) {
  let cdp;
  try {
    cdp = await context.newCDPSession(page);
    return (await cdp.send('Target.getTargetInfo')).targetInfo.targetId;
  } catch {
    return null;
  } finally {
    await cdp?.detach().catch(() => {});
  }
}

// Focus emulation and the "active" lifecycle state keep a page's timers and
// loading running while another window is in front. They last as long as
// the DevTools session that set them, so the session stays open (Chrome ends
// it when the page closes).
const activeSessions = new WeakMap();
async function keepActive(context, page) {
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await cdp.send('Page.enable').catch(() => {});
    await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
    activeSessions.set(page, cdp);
  } catch {
    // best effort: the page still works, only more slowly in the background
  }
}

function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'linux' ? norm(a) === norm(b) : norm(a).toLowerCase() === norm(b).toLowerCase();
}

function shortError(err) {
  return String(err?.message || err).split('\n')[0].slice(0, 200);
}

module.exports = {
  ChromeConnection,
  ChromeError,
  ConnectCancelled,
  SETUP_URL,
  chromeExecutableCandidates,
  chromeMajorVersion,
  defaultUserDataDir,
  describeProfile,
  findChromeExecutable,
  findDebugEndpoint,
  listChromeSessions,
  toggleRemembered,
  parseDevToolsActivePort,
  selectProfile,
  switchValue,
};
