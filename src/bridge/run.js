'use strict';

// Starts Lead Finder Bridge on this computer (Linux: BlueZ).
//   node src/bridge/run.js [--name "Office laptop"]       (from the source)
//   lead-finder --bridge [--name "Office laptop"]         (installed app)
// It keeps running in the background; pairing a new Lead Finder needs a "y"
// here (or a confirmation window when it runs without a terminal).

const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { execFile } = require('node:child_process');
const { BridgeServer } = require('./server');
const { Bluetooth, supported } = require('../dialer/bluetooth');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};

// The user's answer on this computer: a terminal question, or a window (zenity).
function confirmHere(peer, code) {
  const question = `Allow Lead Finder on "${peer.name}" to use this computer's Bluetooth and phone? It must show the code ${code}.`;
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(`\n${question} [y/N] `, (a) => (rl.close(), resolve(/^y(es)?$/i.test(a.trim())))));
  }
  return new Promise((resolve) => execFile('zenity', ['--question', '--title=Lead Finder Bridge', `--text=${question}`, '--timeout=120'], (err) => resolve(!err)));
}

async function runBridge({ dir, name, script, confirm = confirmHere, log = (m) => console.log(`[bridge] ${m}`) } = {}) {
  if (!supported() && !script) throw new Error('Lead Finder Bridge needs Linux (BlueZ). Windows and macOS do not let an application be a phone’s hands-free device.');
  const server = new BridgeServer({
    bluetooth: new Bluetooth(script ? { script } : {}),
    dir: dir || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'lead-finder-bridge'),
    name: name || os.hostname(),
    confirm,
    log,
    port: Number(arg('--port')) || 0,
  });
  await server.start();
  const stop = () => {
    server.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return server;
}

function runInElectron() {
  const { app } = require('electron');
  app.on('window-all-closed', () => {}); // no window: keep running
  app.whenReady().then(() =>
    runBridge({ name: arg('--name') }).catch((err) => {
      console.error(`[bridge] ${err.message}`);
      app.exit(1);
    }),
  );
}

if (require.main === module) {
  runBridge({ name: arg('--name'), script: process.env.LEAD_FINDER_BT_HELPER || undefined }).catch((err) => {
    console.error(`[bridge] ${err.message}`);
    process.exit(1);
  });
}

module.exports = { runBridge, runInElectron };
