'use strict';

// This computer's side of call audio (Linux, PipeWire or PulseAudio, through
// pactl): which speaker/headphones and microphone the call uses, and WebRTC
// echo cancellation between them. bt-helper.py plays the phone's call audio
// (SCO) on `play` and sends `record` back; nothing is recorded or stored.
//
// Events: 'change' (audio devices were added or removed).

const { execFile, spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

function pactl(args, { timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('pactl', args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

const EC_SPEAKER = 'leadfinder_call_speaker';
const EC_MIC = 'leadfinder_call_mic';

class CallAudio extends EventEmitter {
  constructor({ run = pactl, spawnImpl = spawn } = {}) {
    super();
    this.run = run;
    this.spawnImpl = spawnImpl;
    this.route = null; // { modules, play, record, output, input, echoCancel }
    this.watcher = null;
  }

  async list(kind) {
    return JSON.parse(await this.run(['-f', 'json', 'list', kind]));
  }

  async available() {
    try {
      await this.run(['info']);
      return true;
    } catch {
      return false;
    }
  }

  // Speakers/headphones and microphones (not monitors, not Lead Finder's own echo-cancelled ones).
  async devices() {
    const [sinks, sources] = await Promise.all([this.list('sinks'), this.list('sources')]);
    let defOut = '';
    let defIn = '';
    try {
      defOut = (await this.run(['get-default-sink'])).trim();
      defIn = (await this.run(['get-default-source'])).trim();
    } catch {}
    const item = (o) => ({ name: o.name, description: o.description || o.name, bluetooth: o.properties?.['device.api'] === 'bluez5' });
    const ours = (o) => o.name === EC_SPEAKER || o.name === EC_MIC || o.name?.startsWith(`${EC_SPEAKER}.`) || o.name?.startsWith(`${EC_MIC}.`);
    return {
      outputs: sinks.filter((s) => !ours(s)).map(item),
      inputs: sources.filter((s) => !s.monitor_source && s.properties?.['device.class'] !== 'monitor' && !ours(s)).map(item),
      defaultOutput: ours({ name: defOut }) ? '' : defOut,
      defaultInput: ours({ name: defIn }) ? '' : defIn,
    };
  }

  // The devices for a call: { play, record } for the helper (with echo
  // cancellation, Lead Finder's echo-cancelled pair in between).
  async prepare({ output = '', input = '', echoCancel = true } = {}) {
    await this.release();
    const devs = await this.devices();
    const out = devs.outputs.some((d) => d.name === output) ? output : devs.defaultOutput;
    const mic = devs.inputs.some((d) => d.name === input) ? input : devs.defaultInput;
    const route = { modules: [], play: out, record: mic, output: out, input: mic, echoCancel: false };
    if (echoCancel && out && mic) {
      try {
        const id = Number((await this.run(['load-module', 'module-echo-cancel', 'aec_method=webrtc', `source_master=${mic}`, `sink_master=${out}`, `source_name=${EC_MIC}`, `sink_name=${EC_SPEAKER}`, 'use_master_format=1'])).trim());
        if (Number.isInteger(id)) {
          route.modules.push(id);
          route.play = EC_SPEAKER;
          route.record = EC_MIC;
          route.echoCancel = true;
        }
      } catch {}
    }
    this.route = route;
    return route;
  }

  async release() {
    const r = this.route;
    this.route = null;
    if (!r) return;
    for (const id of r.modules) await this.run(['unload-module', String(id)]).catch(() => {});
  }

  // Audio devices added or removed (headphones plugged in, a headset connected).
  watch() {
    if (this.watcher) return;
    let timer = null;
    const child = this.spawnImpl('pactl', ['subscribe'], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.watcher = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (!/Event '(new|remove)' on (sink|source) #/.test(chunk)) return;
      clearTimeout(timer);
      timer = setTimeout(() => this.emit('change'), 300);
    });
    child.on('error', () => {});
    child.on('exit', () => {
      if (this.watcher === child) this.watcher = null;
    });
  }

  unwatch() {
    this.watcher?.kill();
    this.watcher = null;
  }
}

module.exports = { CallAudio, pactl, EC_SPEAKER, EC_MIC };
