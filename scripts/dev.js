'use strict';

// `npm run dev`: the whole app in one terminal.
//   1. licence server (server/, with server/.env), waited on until /health answers
//   2. Vite dev server for the UI
//   3. Electron, pointed at both
// A healthy licence server already on the port is reused (no duplicates);
// a crashed one is restarted with backoff; Ctrl+C or closing the app stops
// everything cleanly.
//
// `npm start` (--prod): Electron with the built UI (licence server as above).
// `npm run dev -- --production-licence`: no local licence server; the app
// talks to the production address, like an installed copy.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const prod = process.argv.includes('--prod');
const serverDir = path.join(root, 'server');
const envFile = path.join(serverDir, '.env');
const log = (tag, msg) => console.log(`\x1b[2m[${tag}]\x1b[0m ${msg}`);

const children = new Set();
let shuttingDown = false;

// One dev session at a time: a second one would fight over the ports and
// the app's single-instance lock.
const lockFile = path.join(os.tmpdir(), 'lead-finder-dev.pid');
function takeLock() {
  try {
    const pid = Number(fs.readFileSync(lockFile, 'utf8'));
    if (pid && pid !== process.pid) {
      process.kill(pid, 0);
      console.error(`Lead Finder is already running in dev mode (process ${pid}). Close it first.`);
      process.exit(1);
    }
  } catch {
    // no lock, or a stale one from a process that is gone
  }
  fs.writeFileSync(lockFile, String(process.pid));
  process.on('exit', () => {
    try {
      if (Number(fs.readFileSync(lockFile, 'utf8')) === process.pid) fs.unlinkSync(lockFile);
    } catch {}
  });
}

function readEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

function portBusy(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
}

async function healthy(url) {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok && (await r.json()).ok === true;
  } catch {
    return false;
  }
}

async function waitHealthy(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await healthy(url)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function run(tag, cmd, args, opts) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  children.add(child);
  const pipe = (stream) =>
    stream.on('data', (d) => {
      for (const line of String(d).split('\n')) if (line.trim()) log(tag, line);
    });
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', () => children.delete(child));
  return child;
}

// --- licence server ----------------------------------------------------------

async function startLicenseServer() {
  if (!fs.existsSync(envFile)) {
    log('server', 'server/.env not found: starting without the licence server (subscriptions and free searches will be unavailable). See server/README.md.');
    return null;
  }
  const env = readEnv(envFile);
  const port = Number(process.env.LICENSE_PORT || env.PORT || 8787);
  const url = `http://127.0.0.1:${port}`;
  if (await portBusy(port)) {
    if (await healthy(url)) {
      log('server', `reusing the licence server already running on ${url}`);
      return url;
    }
    throw new Error(`Port ${port} is used by another program. Stop it, or set LICENSE_PORT to a free port.`);
  }

  let restarts = 0;
  const launch = () =>
    new Promise((resolve, reject) => {
      const child = run('server', process.execPath, ['--env-file=.env', 'src/index.js'], {
        cwd: serverDir,
        env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PUBLIC_BASE_URL: env.PUBLIC_BASE_URL?.startsWith('https://') ? env.PUBLIC_BASE_URL : url },
      });
      let ready = false;
      child.on('exit', (code) => {
        if (shuttingDown) return;
        if (!ready) return reject(new Error(`licence server exited during startup (code ${code})`));
        if (restarts >= 5) {
          log('server', 'crashed too often; not restarting. The app keeps running without it.');
          return;
        }
        const wait = 1000 * 2 ** restarts++;
        log('server', `exited (code ${code}); restarting in ${wait / 1000}s`);
        setTimeout(() => launch().catch((e) => log('server', e.message)), wait);
      });
      waitHealthy(url, 60_000).then((ok) => {
        if (ok) {
          ready = true;
          resolve();
        } else if (!shuttingDown) reject(new Error('licence server did not become healthy within 60s'));
      });
    });
  await launch();
  log('server', `ready on ${url}`);
  return url;
}

// --- app -------------------------------------------------------------------------

function launchElectron(extraEnv) {
  const env = { ...process.env, ...extraEnv };
  // Set by VS Code's integrated terminal; it would make Electron run as Node.
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), ['.'], { cwd: root, stdio: 'inherit', env });
  children.add(child);
  return child;
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => {
    for (const c of children) c.kill('SIGKILL');
    process.exit(code);
  }, 4000).unref();
  const left = [...children].map((c) => new Promise((r) => c.once('exit', r)));
  await Promise.all(left);
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

(async () => {
  takeLock();
  // --production-licence: no local licence server; the app uses the address
  // installers use (src/main/license-config.json), exactly like an installed
  // copy. Useful to reproduce what customers see.
  const productionLicence = process.argv.includes('--production-licence');
  if (productionLicence) log('server', `using the production licence server from src/main/license-config.json (${require('../src/main/license-config.json').serverUrl})`);
  const licenseUrl = productionLicence
    ? null
    : await startLicenseServer().catch((err) => {
        log('server', `${err.message}. Continuing without it.`);
        return null;
      });
  const appEnv = licenseUrl ? { LEAD_FINDER_LICENSE_URL: licenseUrl } : {};

  let vite = null;
  if (!prod) {
    if (await portBusy(5199)) throw new Error('Port 5199 (the UI dev server) is used by another program. Stop it and run npm run dev again.');
    const { createServer } = await import('vite');
    vite = await createServer({ configFile: path.join(root, 'vite.config.mjs') });
    await vite.listen();
    appEnv.VITE_DEV_SERVER_URL = vite.resolvedUrls.local[0];
    log('ui', `Vite ready on ${appEnv.VITE_DEV_SERVER_URL}`);
  }
  log('app', 'starting Lead Finder');
  const electron = launchElectron(appEnv);
  electron.on('exit', async (code) => {
    if (vite) await vite.close().catch(() => {});
    shutdown(code ?? 0);
  });
})().catch((err) => {
  console.error(`\n${err.message}`);
  shutdown(1);
});
