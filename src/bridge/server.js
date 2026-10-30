'use strict';

// Lead Finder Bridge: lets Lead Finder on another computer use THIS
// computer's Bluetooth (Linux, BlueZ) and the phone connected to it, over
// the local network.
//
// It runs the same Bluetooth helper as the Dialer (bt-helper.py: Hands-Free
// calls, SMS over MAP) and relays it, encrypted, to one paired Lead Finder:
// its commands go to the helper, the helper's events come back, and the
// call's voice travels both ways as audio frames (the helper's remote mode).
// It announces itself on the local network (discovery.js) with a short
// status; a Lead Finder it has never seen must be paired first: both screens
// show the same 6-digit code and the user confirms on both.
//
// When the Lead Finder in control goes away during a call, the call's audio
// is moved back to the phone (the call goes on there; it is never hung up).

const net = require('node:net');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { Identity, handshake } = require('./secure');
const { Beacon } = require('./discovery');

// The helper commands a paired Lead Finder may use.
const ALLOWED = new Set(['state', 'power', 'visible', 'scan', 'pair', 'confirm', 'link', 'unlink', 'disconnect', 'remove', 'send', 'audio', 'sco_connect', 'sco_disconnect', 'register_hf', 'map_connect', 'map_disconnect', 'map_list', 'map_get', 'map_push', 'map_read']);
const PHONE_CLASS = 2;

class BridgeServer extends EventEmitter {
  // bluetooth: a Bluetooth (bluetooth.js); confirm(peer, code) -> Promise<boolean>: the user's answer on this computer.
  constructor({ bluetooth, dir, name = os.hostname(), confirm, port = 0, host = '0.0.0.0', beacon = true, discoveryPort, log = () => {} }) {
    super();
    this.bt = bluetooth;
    this.identity = new Identity(dir, name);
    this.confirm = confirm;
    this.port = port;
    this.host = host;
    this.useBeacon = beacon;
    this.discoveryPort = discoveryPort;
    this.log = log;
    this.controller = null; // the channel in control
    this.snap = { adapter: null, devices: [], hfRole: null, voiceIn: false, voiceOut: false, audioVerified: false };
  }

  // A short status: in the announcement and sent to Lead Finder.
  status() {
    const s = this.snap;
    const phones = s.devices.filter((d) => d.paired && d.connected && (d.icon === 'phone' || ((d.deviceClass >> 8) & 0x1f) === PHONE_CLASS));
    return {
      type: 'linux',
      bluetooth: Boolean(s.adapter?.powered),
      adapter: Boolean(s.adapter),
      hfRole: s.hfRole,
      phone: phones[0] ? { name: phones[0].name, address: phones[0].address } : null,
      audio: s.hfRole === 'ok' ? (s.audioVerified ? 'verified' : 'supported') : 'unavailable',
      busy: Boolean(this.controller),
    };
  }

  async start() {
    const b = this.bt;
    b.on('ready', (m) => {
      this.snap.adapter = m.state.adapter;
      this.snap.devices = m.state.devices;
      this.changed();
    });
    b.on('adapter', (m) => ((this.snap.adapter = m.adapter), this.changed()));
    b.on('device', (m) => {
      const i = this.snap.devices.findIndex((d) => d.address === m.device.address);
      if (i >= 0) this.snap.devices[i] = m.device;
      else this.snap.devices.push(m.device);
      this.changed();
    });
    b.on('device_removed', (m) => ((this.snap.devices = this.snap.devices.filter((d) => d.path !== m.path)), this.changed()));
    b.on('hf_profile', (m) => ((this.snap.hfRole = m.ok ? 'ok' : m.busy ? 'pipewire' : 'error'), this.changed()));
    // Every helper event goes to the Lead Finder in control; the voice as audio frames.
    for (const ev of ['ready', 'adapter', 'device', 'device_removed', 'confirm', 'passkey', 'confirm_cancelled', 'link_up', 'link_down', 'data', 'sco_up', 'sco_down', 'audio_error', 'hf_profile', 'sms_message', 'sms_status', 'exit']) {
      b.on(ev, (m) => this.controller?.send({ t: 'ev', event: ev, ...m }));
    }
    b.on('voice', (m) => {
      this.snap.voiceIn = true;
      this.verify();
      this.controller?.sendAudio(Buffer.from(m.data, 'base64'));
    });
    b.on('sco_down', () => {
      this.snap.voiceIn = false;
      this.snap.voiceOut = false;
    });
    b.start();
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise((resolve) => this.server.listen(this.port, this.host, resolve));
    this.port = this.server.address().port;
    if (this.useBeacon) {
      this.beacon = new Beacon({ fingerprint: this.identity.fingerprint, name: this.identity.name, port: this.port, status: () => this.status(), ...(this.discoveryPort ? { udpPort: this.discoveryPort } : {}) });
      this.beacon.start();
    }
    this.log(`Lead Finder Bridge "${this.identity.name}" (${this.identity.fingerprint}) on port ${this.port}`);
    return this.port;
  }

  changed() {
    this.controller?.send({ t: 'status', status: this.status() });
    this.emit('status', this.status());
  }

  // Two-way voice actually carried during a call: the audio is verified.
  verify() {
    if (!this.snap.audioVerified && this.snap.voiceIn && this.snap.voiceOut) {
      this.snap.audioVerified = true;
      this.changed();
    }
  }

  async accept(socket) {
    socket.setTimeout(30_000, () => !ch && socket.destroy());
    let ch;
    try {
      ch = await handshake(socket, this.identity, 'bridge');
    } catch (err) {
      this.log(`Refused a connection: ${err.message}`);
      socket.destroy();
      return;
    }
    socket.setTimeout(0);
    const peer = ch.peer;
    if (!this.identity.isTrusted(peer.id)) {
      // First time: the same code on both screens, confirmed on both.
      ch.send({ t: 'pair', code: ch.sas, name: this.identity.name });
      this.log(`"${peer.name}" (${peer.fingerprint}) asks to pair. Code: ${ch.sas}`);
      const theirs = new Promise((resolve) => {
        ch.on('message', (m) => m.t === 'pair-ok' && resolve(true));
        ch.on('message', (m) => m.t === 'pair-no' && resolve(false));
        ch.on('close', () => resolve(false));
      });
      const ours = Promise.resolve(this.confirm ? this.confirm(peer, ch.sas) : false).catch(() => false);
      const [a, b] = await Promise.all([ours, theirs]);
      if (!a || !b) {
        ch.send({ t: 'denied', reason: a ? 'Pairing was cancelled on Lead Finder.' : 'Pairing was not allowed on the bridge.' });
        this.log(`Pairing with "${peer.name}" ${a ? 'cancelled on Lead Finder' : 'refused here'}.`);
        return setTimeout(() => ch.close('denied'), 200);
      }
      this.identity.trust(peer.id, { name: peer.name });
      this.log(`Paired with "${peer.name}".`);
    }
    if (this.controller) {
      ch.send({ t: 'busy', by: this.controller.peer.name });
      return setTimeout(() => ch.close('busy'), 200);
    }
    this.take(ch);
  }

  take(ch) {
    this.controller = ch;
    this.log(`"${ch.peer.name}" is using this computer's Bluetooth.`);
    ch.send({ t: 'welcome', name: this.identity.name, status: this.status() });
    ch.on('message', (m) => this.onMessage(ch, m));
    ch.on('audio', (buf) => {
      this.snap.voiceOut = true;
      this.verify();
      this.bt.notify('voice_out', { data: buf.toString('base64') });
    });
    ch.on('close', ({ reason }) => {
      if (this.controller !== ch) return;
      this.controller = null;
      this.log(`"${ch.peer.name}" disconnected (${reason}).`);
      // A call going on stays on: its audio goes back to the phone.
      for (const d of this.snap.devices.filter((x) => x.connected)) this.bt.request('sco_disconnect', { address: d.address }).catch(() => {});
      this.bt.request('audio', { play: '', record: '', muted: false, remote: false }).catch(() => {});
      this.changed();
    });
    this.changed();
  }

  async onMessage(ch, m) {
    if (m.t === 'ping') return ch.send({ t: 'pong', at: m.at });
    if (m.t !== 'req') return;
    const reply = (r) => ch.send({ t: 'res', id: m.id, ...r });
    if (!ALLOWED.has(m.cmd)) return reply({ ok: false, error: 'Not allowed.' });
    const args = m.args && typeof m.args === 'object' ? m.args : {};
    // The call's audio is always for the Lead Finder in control (sent over the network).
    if (m.cmd === 'audio') Object.assign(args, { play: '', record: '', remote: true });
    try {
      reply({ ok: true, result: await this.bt.request(m.cmd, args) });
    } catch (err) {
      reply({ ok: false, error: err.message });
    }
  }

  forget(fingerprintOrId) {
    for (const [id, info] of Object.entries(this.identity.trusted())) if (id === fingerprintOrId || info.fingerprint === fingerprintOrId) this.identity.forget(id);
  }

  stop() {
    this.beacon?.stop();
    this.controller?.close('the bridge stopped');
    this.server?.close();
    this.bt.stop();
  }
}

module.exports = { BridgeServer, ALLOWED };
