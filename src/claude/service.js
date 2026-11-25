'use strict';

// Settings > AI Integrations > Claude: Lead Finder used from Claude Desktop
// with the user's own Claude account (Pro or any plan). No API key: Claude
// Desktop talks to Claude; Lead Finder only gives it tools on this computer.
//
// Auto Setup & Connect:
//   1. finds Claude Desktop and its settings file(s);
//   2. puts the MCP server (one bundled file) in Lead Finder's data folder,
//      where it stays the same across updates and install types;
//   3. opens the private line (host.js) and adds Lead Finder's entry to
//      Claude's settings, keeping everything else in them;
//   4. starts the server exactly as Claude will and checks it reaches
//      Lead Finder (desktop.selfTest);
//   5. "Connected" only once Claude itself has connected (its MCP server
//      reached Lead Finder), never just because a file was written.

const fs = require('node:fs');
const path = require('node:path');
const link = require('./link');
const desktop = require('./desktop');
const { ClaudeHost, TEST_CLIENT } = require('./host');

const KEY = 'claude.integration';

function createClaude({ app, state, tools, isLocked, onLocked, confirm, log = () => {}, send = () => {}, platform = process.platform, env = process.env, detectOpts = {} }) {
  const dataDir = app.getPath('userData');
  const host = new ClaudeHost({ dataDir, tools, isLocked, onLocked, confirm, state, log, platform });
  let busy = null; // 'setup' | 'test' | 'restart' | 'disconnect'

  const settings = () => ({ enabled: false, ...(state.get(KEY) || {}) });
  const save = (patch) => state.set(KEY, { ...settings(), ...patch });

  // The program Claude starts: Lead Finder's own (as Node, so nothing else
  // is needed). An AppImage or a portable .exe unpacks to a new folder at
  // each start, so their own file is used instead.
  function program() {
    if (!app.isPackaged) return { command: process.execPath, launch: null };
    const own = env.APPIMAGE || env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    return { command: own, launch: own };
  }

  const bridgeSource = () => path.join(app.getAppPath(), 'dist', 'claude', link.BRIDGE_FILE);
  const bridgeTarget = () => path.join(link.dirOf(dataDir), link.BRIDGE_FILE);

  // The server file in the data folder, refreshed when Lead Finder updates.
  function installBridge() {
    const code = fs.readFileSync(bridgeSource());
    const target = bridgeTarget();
    let cur = null;
    try {
      cur = fs.readFileSync(target);
    } catch {}
    if (!cur || !cur.equals(code)) {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(`${target}.tmp`, code);
      fs.renameSync(`${target}.tmp`, target);
    }
    return target;
  }

  function entry() {
    const p = program();
    // An AppImage's launcher adds --no-sandbox in front of the arguments
    // where the system restricts sandboxes (Ubuntu 24.04), which Node
    // refuses; given at the end, the launcher adds nothing and Node passes
    // it to the server, which ignores it.
    const tail = env.APPIMAGE && app.isPackaged ? ['--no-sandbox'] : [];
    return { command: p.command, args: [bridgeTarget(), '--data', dataDir, ...(p.launch ? ['--app', p.launch] : []), ...tail], env: { ELECTRON_RUN_AS_NODE: '1' } };
  }

  // Files to write: each settings folder Claude uses; the first known
  // place when Claude has not made one yet.
  function targets(found) {
    return found.used.length ? found.used : found.configs.slice(0, 1);
  }

  function emit() {
    send('claude:status', status());
  }
  host.on('change', emit);

  async function check() {
    const r = await desktop.selfTest(entry(), { clientName: TEST_CLIENT, version: app.getVersion() });
    const result = { ok: r.ok, at: Date.now(), tools: r.tools ?? null, error: r.ok ? null : r.error };
    if (!r.ok && r.log) log(`claude: check failed: ${r.error} | ${r.log.replace(/\s+/g, ' ').slice(0, 300)}`);
    save({ check: result });
    return result;
  }

  function status() {
    const s = settings();
    const found = desktop.detect({ platform, env, ...detectOpts });
    const files = s.enabled ? desktop.inspect(targets(found), entry()) : [];
    const inClaude = files.some((f) => f.state === 'current');
    const unreadable = files.find((f) => f.state === 'unreadable');
    const conn = host.status();
    const seenSince = conn.lastSeen && s.configuredAt && conn.lastSeen.at >= s.configuredAt;
    let st = 'not_connected';
    let detail = '';
    if (busy === 'setup') st = 'connecting';
    else if (!s.enabled) detail = found.installed ? 'Click Auto Setup & Connect.' : 'Install Claude Desktop first.';
    else if (unreadable) detail = unreadable.error;
    else if (!inClaude) detail = 'Claude’s settings no longer include Lead Finder. Click Reconnect.';
    else if (!host.listening) detail = 'Lead Finder’s connection is not running. Click Reconnect.';
    else if (s.check && !s.check.ok) detail = s.check.error;
    else if (conn.live.length) {
      st = 'connected';
      detail = `${conn.live.map((c) => c.client).join(' and ')} ${conn.live.length > 1 ? 'are' : 'is'} connected now.`;
    } else if (seenSince) {
      st = 'connected';
      detail = `Ready. Last used by ${conn.lastSeen.client}; open Claude to use it.`;
    } else {
      st = 'connecting';
      detail = 'Set up and checked. Restart Claude Desktop so it loads Lead Finder.';
    }
    const kinds = { read: [], config: [], confirm: [] };
    for (const t of host.specs()) (kinds[t.kind] || kinds.read).push(t.title);
    return {
      state: st,
      detail,
      busy,
      platform,
      enabled: s.enabled,
      configuredAt: s.configuredAt || null,
      claude: { installed: found.installed, app: found.app, downloadUrl: found.downloadUrl, files: s.enabled ? files : targets(found).map((file) => ({ file, state: 'missing' })) },
      server: { listening: host.listening, check: s.check || null },
      connection: conn,
      tools: kinds,
      canRestart: platform === 'darwin' || platform === 'win32',
    };
  }

  async function guarded(what, fn) {
    if (busy) return { ok: false, error: 'Please wait: Lead Finder is still working on the last step.', status: status() };
    busy = what;
    emit();
    try {
      return await fn();
    } catch (err) {
      log(`claude: ${what} failed: ${err.message}`);
      return { ok: false, error: err.message };
    } finally {
      busy = null;
      emit();
    }
  }

  // Auto Setup & Connect (and Reconnect: the same steps, safe to repeat).
  function setup() {
    return guarded('setup', async () => {
      const found = desktop.detect({ platform, env, ...detectOpts });
      if (!found.installed) return { ok: false, code: 'no_claude', error: 'Claude Desktop is not installed on this computer. Download it, sign in with your Claude account, then click Auto Setup & Connect.' };
      try {
        installBridge();
      } catch (err) {
        return { ok: false, error: `Lead Finder’s connector is missing from this installation (${err.code || err.message}). Reinstall Lead Finder.` };
      }
      // A Claude already connected stays connected (Reconnect keeps the line).
      if (!host.listening) await host.start();
      else host.saveSpecs();
      const written = desktop.install(targets(found), entry());
      const failed = written.filter((w) => !w.ok);
      if (failed.length === written.length) {
        save({ enabled: true, configuredAt: Date.now() });
        return { ok: false, error: failed[0].error };
      }
      const changed = written.some((w) => w.changed);
      save({ enabled: true, ...(changed || !settings().configuredAt ? { configuredAt: Date.now() } : {}), files: written.map((w) => w.file) });
      log(`claude: set up in ${written.filter((w) => w.ok).length} Claude settings file(s)${changed ? '' : ' (no change needed)'}`);
      const c = await check();
      if (!c.ok) return { ok: false, error: c.error };
      return { ok: true, changed, restartNeeded: changed || !host.status().live.length };
    }).then((r) => ({ ...r, status: status() }));
  }

  function test() {
    return guarded('test', () => check()).then((r) => ({ ...r, status: status() }));
  }

  function disconnect() {
    return guarded('disconnect', async () => {
      const found = desktop.detect({ platform, env, ...detectOpts });
      const files = [...new Set([...(settings().files || []), ...targets(found)])];
      const removed = desktop.uninstall(files);
      await host.stop();
      save({ enabled: false, check: null });
      const failed = removed.find((r) => !r.ok);
      log('claude: disconnected');
      return failed ? { ok: false, error: failed.error } : { ok: true };
    }).then((r) => ({ ...r, status: status() }));
  }

  function restart() {
    return guarded('restart', () => desktop.restartClaude({ platform })).then((r) => ({ ...r, status: status() }));
  }

  // At start: when set up, the line opens, the server file is refreshed and
  // an entry pointing at an old place (moved AppImage, other install
  // folder) is corrected. A removed entry is not added back on its own.
  async function init() {
    const s = settings();
    if (!s.enabled) return;
    try {
      installBridge();
      await host.start();
      const found = desktop.detect({ platform, env, ...detectOpts });
      const outdated = desktop.inspect(targets(found), entry()).filter((f) => f.state === 'outdated').map((f) => f.file);
      if (outdated.length) {
        desktop.install(outdated, entry());
        log('claude: Claude’s settings updated to this Lead Finder');
      }
    } catch (err) {
      log(`claude: not started: ${err.message}`);
    }
  }

  // Release check (CI): the installed program runs the MCP server the way
  // Claude Desktop will, and it reaches this Lead Finder (locked at that
  // point, which is an answer too). Claude's settings are not touched.
  async function smoke() {
    // An AppImage unpacked without FUSE prints its own lines where MCP
    // talks; Claude Desktop runs AppImages with FUSE, like their users do.
    if (env.APPIMAGE && env.APPIMAGE_EXTRACT_AND_RUN != null) return { ok: true, skipped: 'AppImage started without FUSE' };
    installBridge();
    const was = host.listening;
    if (!was) await host.start();
    const r = await desktop.selfTest(entry(), { clientName: TEST_CLIENT, version: app.getVersion() });
    if (!was) await host.stop();
    const reached = r.ok || /locked with its PIN/.test(r.error || '');
    return { ok: reached, tools: r.tools ?? null, command: entry().command, error: reached ? undefined : r.error, log: reached ? undefined : r.log };
  }

  return { init, setup, test, disconnect, restart, status, smoke, host, entry, stop: () => host.stop(), downloadUrl: desktop.DOWNLOAD_URL };
}

module.exports = { createClaude };
