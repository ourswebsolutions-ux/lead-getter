'use strict';

// Claude Desktop on this computer: is it installed, where its MCP settings
// file is (claude_desktop_config.json), Lead Finder's entry in it, a real
// start of the MCP server the way Claude starts it, and restarting Claude.
//
// The settings file is never replaced: it is read, only the "lead-finder"
// entry under mcpServers is added, updated or removed (other servers and
// settings are kept as they are), a copy of the previous file is kept next
// to it, and the new file is written in one step. A file that is not valid
// JSON is left untouched.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { BRIDGE_FILE } = require('./link');

const NAME = 'lead-finder';
const CONFIG = 'claude_desktop_config.json';
const DOWNLOAD_URL = 'https://claude.ai/download';

const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};
const list = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

// Where Claude Desktop keeps its settings, and where its program may be.
// Windows: the classic install reads %APPDATA%\Claude; the Microsoft Store /
// MSIX install reads its own copy under %LOCALAPPDATA%\Packages\Claude_…\
// LocalCache\Roaming\Claude, so both are written when the package exists.
function locations({ platform = process.platform, env = process.env, home = require('node:os').homedir() } = {}) {
  const configs = [];
  const apps = [];
  const logs = [];
  if (platform === 'darwin') {
    logs.push(path.join(home, 'Library', 'Logs', 'Claude'));
    configs.push(path.join(home, 'Library', 'Application Support', 'Claude', CONFIG));
    apps.push('/Applications/Claude.app', path.join(home, 'Applications', 'Claude.app'));
  } else if (platform === 'win32') {
    const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    configs.push(path.join(roaming, 'Claude', CONFIG));
    logs.push(path.join(roaming, 'Claude', 'logs'));
    for (const pkg of list(path.join(local, 'Packages'))) {
      if (!/^(Claude|AnthropicPBC\.Claude|Anthropic\.Claude)_/i.test(pkg)) continue;
      configs.push(path.join(local, 'Packages', pkg, 'LocalCache', 'Roaming', 'Claude', CONFIG));
      logs.push(path.join(local, 'Packages', pkg, 'LocalCache', 'Roaming', 'Claude', 'logs'));
      apps.push(path.join(local, 'Packages', pkg));
    }
    apps.push(path.join(local, 'AnthropicClaude', 'claude.exe'), path.join(local, 'Programs', 'Claude', 'Claude.exe'), path.join(env.ProgramFiles || 'C:\\Program Files', 'Claude', 'Claude.exe'));
  } else {
    configs.push(path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude', CONFIG));
    logs.push(path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude', 'logs'));
    apps.push('/usr/bin/claude-desktop', '/usr/local/bin/claude-desktop', '/opt/Claude/claude-desktop', '/opt/claude-desktop/claude-desktop', '/usr/lib/claude-desktop', '/snap/bin/claude-desktop', path.join(home, '.local', 'bin', 'claude-desktop'), '/usr/share/applications/claude-desktop.desktop', path.join(home, '.local', 'share', 'applications', 'claude-desktop.desktop'));
    for (const dir of [path.join(home, 'Applications'), path.join(home, 'Downloads')]) for (const f of list(dir)) if (/^claude.*\.appimage$/i.test(f)) apps.push(path.join(dir, f));
  }
  return { configs, apps, logs };
}

function detect(opts = {}) {
  const { configs, apps, logs } = locations(opts);
  const app = apps.find(exists) || null;
  const used = configs.filter((f) => exists(path.dirname(f)));
  // Claude makes its settings folder the first time it runs.
  return { installed: Boolean(app || used.length), app, configs, used, logs, downloadUrl: DOWNLOAD_URL };
}

// What Claude Desktop last wrote about starting Lead Finder (its own log,
// mcp-server-lead-finder.log): when, and the last lines. Shown while
// Claude has not connected, so a failure can be seen and fixed.
function serverLog(found) {
  let best = null;
  for (const dir of found.logs || []) {
    const file = path.join(dir, `mcp-server-${NAME}.log`);
    try {
      const st = fs.statSync(file);
      if (!best || st.mtimeMs > best.at) best = { file, at: st.mtimeMs, size: st.size };
    } catch {}
  }
  if (!best) return null;
  try {
    const fd = fs.openSync(best.file, 'r');
    const len = Math.min(best.size, 16_384);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, best.size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim());
    const tail = lines.slice(-14).map((l) => l.slice(0, 400));
    // The most telling line: an actual error before a plain "disconnected".
    const last = (re) => [...lines].reverse().find((l) => re.test(l));
    const error = last(/error|fail|exited|exiting early|unexpectedly|ENOENT|EACCES|not found|cannot|refused|bad option/i) || last(/disconnected/i) || null;
    return { file: best.file, at: best.at, tail, error: error && error.slice(0, 400) };
  } catch {
    return null;
  }
}

// --- the settings file -------------------------------------------------------------

function readConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, exists: false, data: {} };
    return { ok: false, error: `Claude’s settings file could not be read (${err.code || err.message}).` };
  }
  if (!text.trim()) return { ok: true, exists: true, data: {} };
  try {
    const data = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    if (data.mcpServers != null && (typeof data.mcpServers !== 'object' || Array.isArray(data.mcpServers))) throw new Error('mcpServers is not an object');
    return { ok: true, exists: true, data };
  } catch {
    return { ok: false, invalid: true, error: `Claude’s settings file has a mistake in it, so Lead Finder did not change it: ${file}. Fix or remove it (Claude: Settings > Developer > Edit Config), then click Reconnect.` };
  }
}

// An entry that runs Lead Finder's MCP server (under any name).
const isOurs = (v) => Boolean(v && typeof v === 'object' && Array.isArray(v.args) && v.args.some((a) => typeof a === 'string' && a.endsWith(BRIDGE_FILE)));

function withEntry(data, entry) {
  const servers = {};
  for (const [k, v] of Object.entries(data.mcpServers || {})) if (k !== NAME && !isOurs(v)) servers[k] = v; // no duplicates
  servers[NAME] = entry;
  return { ...data, mcpServers: servers };
}

function withoutEntry(data) {
  const servers = {};
  for (const [k, v] of Object.entries(data.mcpServers || {})) if (k !== NAME && !isOurs(v)) servers[k] = v;
  return { ...data, mcpServers: servers };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function writeConfig(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (exists(file)) fs.copyFileSync(file, `${file}.lead-finder-backup`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// Adds or updates the entry in each file. Returns per file { file, ok, changed, error }.
function install(files, entry) {
  return files.map((file) => {
    const r = readConfig(file);
    if (!r.ok) return { file, ok: false, error: r.error };
    const cur = r.data.mcpServers?.[NAME];
    const others = Object.entries(r.data.mcpServers || {}).filter(([k, v]) => k !== NAME && isOurs(v));
    if (same(cur, entry) && !others.length) return { file, ok: true, changed: false };
    try {
      writeConfig(file, withEntry(r.data, entry));
      return { file, ok: true, changed: true };
    } catch (err) {
      return { file, ok: false, error: `Claude’s settings file could not be saved (${err.code || err.message}).` };
    }
  });
}

function uninstall(files) {
  return files.map((file) => {
    const r = readConfig(file);
    if (!r.ok) return { file, ok: false, error: r.error };
    if (!r.exists || !Object.entries(r.data.mcpServers || {}).some(([k, v]) => k === NAME || isOurs(v))) return { file, ok: true, changed: false };
    try {
      writeConfig(file, withoutEntry(r.data));
      return { file, ok: true, changed: true };
    } catch (err) {
      return { file, ok: false, error: `Claude’s settings file could not be saved (${err.code || err.message}).` };
    }
  });
}

// The entry in each file: 'current', 'outdated' (another path or version), or 'missing'.
function inspect(files, entry) {
  return files.map((file) => {
    const r = readConfig(file);
    if (!r.ok) return { file, state: 'unreadable', error: r.error };
    const cur = r.data.mcpServers?.[NAME];
    return { file, state: !cur ? 'missing' : same(cur, entry) ? 'current' : 'outdated' };
  });
}

// --- a real start of the server ------------------------------------------------------

// Starts the MCP server exactly as Claude Desktop will (same program,
// arguments and environment), speaks MCP to it over stdio (initialize,
// tools/list, one read-only tool call) and stops it.
function selfTest(entry, { clientName, version = '0', timeout = 25_000, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(entry.command, entry.args, { env: { ...env, ...entry.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: `Lead Finder’s connector could not start: ${err.message}` });
      return;
    }
    let out = '';
    let errText = '';
    let done = false;
    const result = { ok: false };
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {}
      setTimeout(() => child.kill(), 200);
      resolve({ ...result, ...r, ...(r.ok ? {} : { log: errText.trim().split('\n').slice(-5).join('\n') || undefined }) });
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'Lead Finder’s connector did not answer in time.' }), timeout);
    const send = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    child.on('error', (err) => finish({ ok: false, error: `Lead Finder’s connector could not start: ${err.message}` }));
    child.on('exit', (code) => finish({ ok: false, error: `Lead Finder’s connector stopped (exit code ${code}).` }));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      errText = (errText + d).slice(-4000);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
      let i;
      while ((i = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, i).trim();
        out = out.slice(i + 1);
        if (!line) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          return finish({ ok: false, error: 'Lead Finder’s connector wrote something that is not MCP.' });
        }
        if (m.error) return finish({ ok: false, error: `Lead Finder’s connector answered with an error: ${m.error.message}` });
        if (m.id === 1) {
          result.server = m.result?.serverInfo;
          send({ method: 'notifications/initialized' });
          send({ id: 2, method: 'tools/list', params: {} });
        } else if (m.id === 2) {
          result.tools = (m.result?.tools || []).length;
          send({ id: 3, method: 'tools/call', params: { name: 'get_status', arguments: {} } });
        } else if (m.id === 3) {
          let body = null;
          try {
            body = JSON.parse(m.result?.content?.[0]?.text || 'null');
          } catch {}
          if (m.result?.isError || !body) return finish({ ok: false, error: body?.error || 'Lead Finder’s connector could not reach Lead Finder.' });
          return finish({ ok: true });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: clientName, version } } });
  });
}

// --- restarting Claude ---------------------------------------------------------------

const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000, windowsHide: true, ...opts }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err }));
  });

// Claude Desktop reads its MCP servers when it starts. Only Claude Desktop
// itself is closed (never Claude Code or other programs called "claude").
async function restartClaude({ platform = process.platform } = {}) {
  if (platform === 'darwin') {
    await run('osascript', ['-e', 'if application "Claude" is running then tell application "Claude" to quit']);
    for (let i = 0; i < 20; i++) {
      const r = await run('pgrep', ['-x', 'Claude']);
      if (!r.ok) break;
      await new Promise((res) => setTimeout(res, 500));
    }
    const o = await run('open', ['-a', 'Claude']);
    return o.ok ? { ok: true } : { ok: false, error: 'Claude could not be opened again. Open Claude yourself.' };
  }
  if (platform === 'win32') {
    const ps = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$p = Get-Process -Name claude | Where-Object { $_.Path -and ($_.Path -like '*\\AnthropicClaude\\*' -or $_.Path -like '*\\WindowsApps\\*Claude*' -or $_.Path -like '*\\Programs\\Claude\\*' -or $_.Path -like '*\\Program Files\\Claude\\*') }",
      '$exe = ($p | Select-Object -First 1).Path',
      '$p | Stop-Process -Force',
      'Start-Sleep -Seconds 2',
      "$pkg = Get-AppxPackage | Where-Object { $_.Name -like '*Claude*' -and $_.Publisher -like '*Anthropic*' } | Select-Object -First 1",
      'if ($pkg) { $id = ((Get-AppxPackageManifest $pkg).Package.Applications.Application | Select-Object -First 1).Id; Start-Process "shell:AppsFolder\\$($pkg.PackageFamilyName)!$id"; exit 0 }',
      "$stub = Join-Path $env:LOCALAPPDATA 'AnthropicClaude\\claude.exe'",
      'if (Test-Path $stub) { Start-Process $stub; exit 0 }',
      'if ($exe) { Start-Process $exe; exit 0 }',
      'exit 3',
    ].join('; ');
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps]);
    return r.ok ? { ok: true } : { ok: false, error: 'Claude could not be opened again. Open Claude yourself.' };
  }
  return { ok: false, manual: true, error: 'Close Claude completely and open it again.' };
}

module.exports = { NAME, CONFIG, DOWNLOAD_URL, locations, detect, serverLog, readConfig, install, uninstall, inspect, withEntry, withoutEntry, isOurs, selfTest, restartClaude };
