'use strict';

// Bluetooth for the Dialer: runs bt-helper.py (BlueZ over D-Bus; Linux) and
// speaks JSON lines with it. Events: 'ready', 'adapter', 'device',
// 'device_removed', 'confirm', 'passkey', 'confirm_cancelled', 'link_up',
// 'link_down', 'data' ({ address, line }), 'exit' ({ error }).

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');

// Inside a packaged app the helper is unpacked next to app.asar.
function helperPath() {
  return path.join(__dirname, 'bt-helper.py').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

function supported(platform = process.platform) {
  return platform === 'linux';
}

class Bluetooth extends EventEmitter {
  constructor({ python = process.env.LEAD_FINDER_PYTHON || 'python3', script = helperPath(), spawnImpl = spawn } = {}) {
    super();
    this.python = python;
    this.script = script;
    this.spawnImpl = spawnImpl;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    this.stderr = '';
  }

  get running() {
    return Boolean(this.child);
  }

  start() {
    if (this.child) return;
    this.stderr = '';
    const child = this.spawnImpl(this.python, [this.script], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => (this.stderr = (this.stderr + chunk).slice(-4000)));
    child.on('error', (err) => this.onExit(err.code === 'ENOENT' ? 'Python 3 is needed for Bluetooth calling (install python3 and python3-dbus).' : err.message));
    child.on('exit', (code) => this.onExit(code ? this.helperError() : null));
  }

  helperError() {
    const s = this.stderr;
    if (/No module named '?dbus/.test(s)) return 'Bluetooth calling needs python3-dbus (sudo apt install python3-dbus python3-gi).';
    if (/No module named '?gi/.test(s)) return 'Bluetooth calling needs python3-gi (sudo apt install python3-gi).';
    if (/org\.freedesktop\.DBus\.Error\.ServiceUnknown|org\.bluez/.test(s)) return 'The Bluetooth service (BlueZ) is not running on this computer.';
    const last = s.trim().split('\n').pop();
    return last ? `Bluetooth helper stopped: ${last}` : 'Bluetooth helper stopped.';
  }

  onExit(error) {
    if (!this.child) return;
    this.child = null;
    for (const { reject } of this.pending.values()) reject(new Error(error || 'Bluetooth helper stopped.'));
    this.pending.clear();
    this.emit('exit', { error });
  }

  onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.ok) resolve(msg.result);
        else reject(new Error(msg.error || 'Bluetooth error'));
      } else if (msg.event) {
        if (msg.event === 'fatal') this.stderr += `\n${msg.error}`;
        this.emit(msg.event, msg);
      }
    }
  }

  request(cmd, args = {}) {
    if (!this.child) return Promise.reject(new Error('Bluetooth is not available.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
  }

  stop() {
    const child = this.child;
    if (!child) return;
    this.onExit(null);
    child.stdin.end();
    child.kill();
  }
}

module.exports = { Bluetooth, supported, helperPath };
