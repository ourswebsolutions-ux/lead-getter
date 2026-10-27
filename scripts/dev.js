'use strict';

// `npm run dev`: the whole app in one terminal.
//   1. Vite dev server for the UI
//   2. Electron, pointed at it
// Ctrl+C or closing the app stops everything cleanly.
//
// `npm start` (--prod): Electron with the built UI.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const prod = process.argv.includes('--prod');
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

function portBusy(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
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
  const appEnv = {};

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
