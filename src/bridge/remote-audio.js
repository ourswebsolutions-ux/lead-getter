'use strict';

// Call audio when the call goes through a bridge: the phone's voice arrives
// over the network and Lead Finder's window plays it (and records the
// microphone, with the browser engine's echo cancellation), so it works on
// any computer, Windows included. SwitchAudio gives the Dialer this or the
// local pactl audio (audio.js), whichever fits the phone link in use.

const { EventEmitter } = require('node:events');

const WINDOW = { name: 'window', description: 'This computer (system speaker and microphone)', bluetooth: false };

class RemoteAudio extends EventEmitter {
  constructor() {
    super();
    this.route = null;
  }
  async available() {
    return true;
  }
  async devices() {
    return { outputs: [WINDOW], inputs: [WINDOW], defaultOutput: WINDOW.name, defaultInput: WINDOW.name, remote: true };
  }
  async prepare({ echoCancel = true } = {}) {
    this.route = { modules: [], play: '', record: '', output: WINDOW.description, input: WINDOW.description, echoCancel: Boolean(echoCancel), remote: true };
    return this.route;
  }
  async release() {
    this.route = null;
  }
  watch() {}
  unwatch() {}
}

class SwitchAudio extends EventEmitter {
  constructor({ local, remote = new RemoteAudio(), isRemote }) {
    super();
    this.localAudio = local; // CallAudio, or null where pactl is not available
    this.remoteAudio = remote;
    this.isRemote = isRemote;
    local?.on('change', () => this.emit('change'));
  }
  get current() {
    return this.isRemote() || !this.localAudio ? this.remoteAudio : this.localAudio;
  }
  get route() {
    return this.current.route;
  }
  // Where there is no local audio routing (Windows, macOS), only bridges carry calls: the window plays them.
  async available() {
    return this.isRemote() || !this.localAudio || this.localAudio.available();
  }
  devices() {
    return this.current.devices();
  }
  prepare(prefs) {
    return this.current.prepare(prefs);
  }
  async release() {
    await this.remoteAudio.release();
    if (this.localAudio) await this.localAudio.release();
  }
  watch() {
    this.localAudio?.watch();
  }
  unwatch() {
    this.localAudio?.unwatch();
  }
}

module.exports = { RemoteAudio, SwitchAudio };
