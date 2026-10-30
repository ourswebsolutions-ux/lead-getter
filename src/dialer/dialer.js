'use strict';

// The Dialer: real cellular calls on the user's Android phone, from this
// computer, over native Bluetooth Hands-Free (HFP) only — no app on the phone.
//
//   Lead Finder (HFP Hands-Free unit) ══RFCOMM: AT commands══> phone (Audio Gateway)
//                                      <══SCO: the call's voice══>
//
// This computer is the phone's hands-free unit, like a car kit: it dials
// (ATD), answers (ATA), ends (AT+CHUP) and follows the call through the
// phone's indicators (callsetup: incoming / dialing / ringing at the other
// end; call: answered). The call's audio comes over SCO and bt-helper.py
// plays it on the chosen speaker and sends the chosen microphone back.
// Calls are only placed when the user presses Call. Every call is saved
// (number, lead, direction, outcome, talk time; never audio).
//
// HFP has no SIM choice: the phone uses its default SIM for calls.
//
// Events: 'state' (the snapshot changed), 'incoming' (a call is ringing),
// 'ended', 'seen' (a lead became Call Seen).

const { EventEmitter } = require('node:events');
const { Hfp } = require('./hfp');

const RECONNECT_MS = [5_000, 15_000, 30_000, 60_000];

// Digits with an optional leading +, and * # for service codes.
function dialable(raw) {
  const s = String(raw ?? '').trim().replace(/[\s\-().]/g, '');
  return /^\+?[0-9*#]{3,20}$/.test(s) ? s : null;
}

// Why a call ended, in words, from what the phone reported. HFP does not
// say why an unanswered call ended (no answer, rejected, unreachable and
// switched off all look the same), so those are not told apart.
function endReason(call) {
  switch (call.status) {
    case 'answered':
      return `Answered; ended${call.endedBy === 'user' ? ' by you' : ''} after ${call.duration}s`;
    case 'cancelled':
      return 'Ended by you before it was answered';
    case 'no_answer':
      return call.endedBy === 'auto' ? 'Not answered; the Auto Dialer ended it after ringing' : 'Not answered (no answer, rejected or unreachable)';
    case 'busy':
      return 'The number was busy';
    case 'missed':
      return 'Missed';
    case 'rejected':
      return 'Rejected';
    default:
      return null;
  }
}

// Phones first, then other paired devices, then by signal.
function sortDevices(list) {
  const phone = (d) => d.icon === 'phone' || ((d.deviceClass >> 8) & 0x1f) === 2;
  return [...list].sort((a, b) => phone(b) - phone(a) || b.paired - a.paired || (b.rssi ?? -999) - (a.rssi ?? -999) || a.name.localeCompare(b.name));
}

class Dialer extends EventEmitter {
  constructor({ bluetooth, audio, store, handover = null, supported = true, now = () => Date.now(), timers = { setTimeout, clearTimeout } }) {
    super();
    this.bt = bluetooth;
    this.audio = audio;
    this.store = store;
    this.handover = handover; // { takeOver(), giveBack(), handedOver() } (pipewire-hfp.js)
    this.now = now;
    this.timers = timers;
    this.reconnectTimer = null;
    this.reconnectStep = 0;
    this.hfp = null;
    this.s = {
      supported,
      error: supported ? null : 'Bluetooth calling is available on Linux for now (it needs BlueZ). Windows support is planned.',
      hfRole: null, // null | 'ok' | 'pipewire' (PipeWire has the Hands-Free role) | 'error'
      hfError: null,
      adapter: null,
      devices: [],
      pairing: null, // { address, passkey }
      saved: store.getState('dialerDevice') || null, // { address, name }
      link: 'idle', // idle | connecting | ready | error
      linkError: null,
      phone: null, // { operator, number, signal, battery, service, roam, features, canReject }
      call: null,
      audioPrefs: { output: '', input: '', echoCancel: true, ...(store.getState('dialerAudio') || {}) },
      audioDevices: { outputs: [], inputs: [], defaultOutput: '', defaultInput: '' },
      audioAvailable: null,
    };
  }

  state() {
    return { ...this.s, devices: sortDevices(this.s.devices), call: this.s.call ? { ...this.s.call } : null };
  }

  changed() {
    this.emit('state', this.state());
  }

  // --- life cycle -------------------------------------------------------------

  async start() {
    if (!this.s.supported || this.started) return;
    this.started = true;
    const on = (e, fn) => this.bt.on(e, fn);
    on('ready', (m) => this.onSnapshot(m.state));
    on('hf_profile', (m) => {
      this.s.hfRole = m.ok ? 'ok' : m.busy ? 'pipewire' : 'error';
      this.s.hfError = m.ok ? null : m.error;
      this.changed();
      if (m.ok) this.scheduleReconnect(500);
    });
    on('adapter', (m) => {
      this.s.adapter = m.adapter;
      this.changed();
      if (m.adapter?.powered) this.scheduleReconnect(0);
    });
    on('device', (m) => this.onDevice(m.device));
    on('device_removed', (m) => {
      this.s.devices = this.s.devices.filter((d) => d.path !== m.path);
      this.changed();
    });
    on('confirm', (m) => {
      this.s.pairing = { address: m.address, passkey: m.passkey };
      this.changed();
    });
    on('passkey', (m) => {
      this.s.pairing = { address: m.address, passkey: m.passkey, display: true };
      this.changed();
    });
    on('confirm_cancelled', () => {
      this.s.pairing = null;
      this.changed();
    });
    on('link_up', (m) => this.onLinkUp(m.address));
    // The phone link moved (another bridge, or this computer): the old one is let go.
    on('switched', ({ reason }) => this.onSwitched(reason));
    on('link_down', (m) => this.onLinkDown(m.address, m.reason));
    on('data', (m) => m.address === this.s.saved?.address && this.hfp?.onLine(m.line));
    on('sco_up', (m) => this.onVoice(m.address, true));
    on('sco_down', (m) => this.onVoice(m.address, false, m.reason));
    on('audio_error', (m) => {
      if (this.s.call) this.s.call.audio = { ...this.s.call.audio, state: this.s.call.audio?.state === 'connecting' ? 'phone' : this.s.call.audio?.state, error: m.error };
      else this.s.audioError = m.error;
      this.changed();
    });
    on('exit', ({ error }) => {
      if (this.stopped) return;
      this.s.error = error || 'Bluetooth stopped.';
      this.s.link = 'idle';
      this.hfp?.reset();
      this.changed();
      // The Bluetooth service restarted, for example: start the helper again, less often each time.
      this.helperRestarts = (this.helperRestarts || 0) + 1;
      if (this.helperRestarts <= 5) this.timers.setTimeout(() => !this.stopped && this.bt.start(), 5_000 * this.helperRestarts);
    });
    this.audio.on('change', () => this.refreshAudio());
    this.audio.watch();
    this.s.audioAvailable = await this.audio.available();
    if (!this.s.audioAvailable) this.s.audioError = 'No PipeWire/PulseAudio sound server was found (pactl), so call audio cannot be played on this computer.';
    this.bt.start();
    await this.refreshAudio();
  }

  stop() {
    this.stopped = true;
    this.timers.clearTimeout(this.reconnectTimer);
    this.audio.release().catch(() => {});
    this.audio.unwatch();
    this.bt.stop();
  }

  async refreshAudio() {
    if (!this.s.audioAvailable) return;
    try {
      this.s.audioDevices = await this.audio.devices();
    } catch {}
    this.changed();
    // The device the call was using went away: carry on with the default.
    const r = this.audio.route;
    if (r && this.s.call?.audio?.state === 'computer') {
      const { outputs, inputs } = this.s.audioDevices;
      if (!outputs.some((d) => d.name === r.output) || !inputs.some((d) => d.name === r.input)) await this.applyAudio();
    }
  }

  onSwitched(reason) {
    this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.hfp?.reset(reason || 'The phone link moved.');
    this.hfp = null;
    // A call going on stays on, on the phone (the bridge moves its audio there).
    if (this.s.call && this.s.call.state !== 'ended') this.finish({ detail: `${reason || 'The phone link moved'}: the call went on on the phone.`, lost: true });
    this.s.link = 'idle';
    this.s.phone = null;
    this.s.hfRole = null;
    this.s.adapter = null;
    this.s.devices = [];
    this.changed();
    // The audio devices are those of the new link (this computer's, or the window's for a bridge).
    this.audio.available().then((ok) => {
      this.s.audioAvailable = ok;
      this.refreshAudio();
    });
  }

  onSnapshot(st) {
    this.s.error = null;
    this.helperRestarts = 0;
    this.s.adapter = st.adapter;
    this.s.devices = st.devices;
    if (!st.adapter) this.s.error = st.message || 'No Bluetooth adapter was found on this computer.';
    this.changed();
    this.scheduleReconnect(0);
  }

  onDevice(d) {
    const i = this.s.devices.findIndex((x) => x.address === d.address);
    if (i >= 0) this.s.devices[i] = d;
    else this.s.devices.push(d);
    if (this.s.saved?.address === d.address) {
      if (d.name && d.name !== this.s.saved.name) this.saveDevice({ address: d.address, name: d.name });
      if (d.connected && this.s.link === 'idle') this.scheduleReconnect(1_000);
    }
    this.changed();
  }

  saveDevice(dev) {
    this.s.saved = dev;
    this.store.setState('dialerDevice', dev);
  }

  // PipeWire had the Hands-Free role: give it to Lead Finder (the user asked).
  async takeHandsFree() {
    if (!this.handover) return { ok: false, error: 'Not available here.' };
    try {
      await this.handover.takeOver();
    } catch (err) {
      return { ok: false, error: `WirePlumber could not be restarted: ${err.message}` };
    }
    // WirePlumber needs a moment to let go of the role.
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => this.timers.setTimeout(r, 700));
      const ok = await this.bt.request('register_hf').catch(() => false);
      if (ok) return { ok: true };
    }
    return { ok: false, error: this.s.hfError || 'The Hands-Free role is still in use.' };
  }

  // --- pairing and connecting ---------------------------------------------------

  async scan(on) {
    await this.bt.request('scan', { on: Boolean(on) });
    return { ok: true };
  }

  async visible(on) {
    await this.bt.request('visible', { on: Boolean(on) });
    return { ok: true };
  }

  async power(on) {
    await this.bt.request('power', { on: Boolean(on) });
    return { ok: true };
  }

  async confirmPairing(accept) {
    this.s.pairing = null;
    this.changed();
    await this.bt.request('confirm', { accept: Boolean(accept) });
    return { ok: true };
  }

  // Pairs (when needed) and connects the phone as this computer's Hands-Free phone; it is remembered.
  async connect(address) {
    const d = this.s.devices.find((x) => x.address === address);
    if (!d) return { ok: false, error: 'That device is not in the list: scan again.' };
    if (this.s.hfRole !== 'ok') return { ok: false, error: this.s.hfError || 'The Hands-Free role is not available yet.' };
    if (this.s.saved?.address && this.s.saved.address !== address) await this.disconnect({ keep: false });
    this.saveDevice({ address, name: d.name });
    this.manualOff = false;
    this.reconnectStep = 0;
    this.s.link = 'connecting';
    this.s.linkError = null;
    this.changed();
    try {
      await this.bt.request('scan', { on: false }).catch(() => {});
      if (!d.paired) await this.bt.request('pair', { address });
      await this.bt.request('link', { address });
      return { ok: true };
    } catch (err) {
      if (this.s.link === 'ready') return { ok: true };
      this.s.link = 'error';
      this.s.linkError = err.message;
      this.changed();
      this.scheduleReconnect();
      return { ok: false, error: err.message };
    }
  }

  // Disconnects Hands-Free; keep: false also forgets the phone.
  async disconnect({ keep = true } = {}) {
    const address = this.s.saved?.address;
    this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (keep) this.manualOff = true;
    else {
      this.s.saved = null;
      this.store.setState('dialerDevice', null);
    }
    this.hfp?.reset();
    this.hfp = null;
    this.s.link = 'idle';
    this.s.phone = null;
    this.changed();
    if (address) await this.bt.request('unlink', { address }).catch(() => {});
    return { ok: true };
  }

  async forget(address) {
    if (this.s.saved?.address === address) await this.disconnect({ keep: false });
    await this.bt.request('remove', { address }).catch(() => {});
    return { ok: true };
  }

  scheduleReconnect(delay) {
    if (!this.s.saved || this.manualOff || !this.bt.running || this.s.hfRole !== 'ok') return;
    if (['ready', 'connecting'].includes(this.s.link)) return;
    this.timers.clearTimeout(this.reconnectTimer);
    const ms = delay ?? RECONNECT_MS[Math.min(this.reconnectStep, RECONNECT_MS.length - 1)];
    this.reconnectTimer = this.timers.setTimeout(() => this.reconnect(), ms);
  }

  async reconnect() {
    this.reconnectTimer = null;
    const address = this.s.saved?.address;
    if (!address || ['ready', 'connecting'].includes(this.s.link) || !this.s.adapter?.powered) return;
    const d = this.s.devices.find((x) => x.address === address);
    if (!d?.paired) {
      this.s.link = 'error';
      this.s.linkError = 'The phone is no longer paired with this computer: connect it again.';
      this.changed();
      return;
    }
    this.s.link = 'connecting';
    this.changed();
    try {
      await this.bt.request('link', { address });
      this.reconnectStep = 0;
    } catch (err) {
      if (this.s.link === 'ready') return;
      this.s.link = 'error';
      this.s.linkError = err.message;
      this.reconnectStep++;
      this.changed();
      this.scheduleReconnect();
    }
  }

  async reconnectNow() {
    this.manualOff = false;
    this.reconnectStep = 0;
    await this.reconnect();
    return { ok: this.s.link !== 'error', error: this.s.link === 'error' ? this.s.linkError : null };
  }

  // --- the Hands-Free connection -------------------------------------------------

  onLinkUp(address) {
    if (address !== this.s.saved?.address) {
      // Only the chosen phone is this computer's Hands-Free phone.
      this.bt.request('unlink', { address }).catch(() => {});
      return;
    }
    this.manualOff = false;
    this.s.link = 'connecting';
    this.changed();
    const hfp = new Hfp({ send: (line) => this.bt.request('send', { address, line }), timers: this.timers });
    this.hfp = hfp;
    hfp.on('indicator', (e) => this.onIndicator(e));
    hfp.on('clip', ({ number }) => this.onCallerId(number));
    hfp.on('ring', () => this.onRing());
    hfp.on('result', (r) => {
      if (this.s.call && r === 'BUSY') this.s.call.busy = true;
    });
    hfp
      .start()
      .then((info) => {
        if (this.hfp !== hfp) return;
        this.s.link = 'ready';
        this.s.linkError = null;
        this.s.phone = { operator: info.operator, number: info.number, numbers: info.numbers, features: info.features, canReject: info.canReject, ...this.phoneIndicators(info.indicators) };
        this.changed();
        // A call already going on when the phone connected.
        const ind = info.indicators;
        if (ind.call || ind.callsetup) this.adoptCall(ind);
      })
      .catch((err) => {
        if (this.hfp !== hfp) return;
        this.s.link = 'error';
        this.s.linkError = err.message;
        this.changed();
        this.bt.request('unlink', { address }).catch(() => {});
      });
  }

  onLinkDown(address, reason) {
    if (address !== this.s.saved?.address) return;
    this.hfp?.reset();
    this.hfp = null;
    this.s.link = 'idle';
    this.s.phone = null;
    this.s.linkError = reason && !/closed by Lead Finder/.test(reason) ? `Disconnected: ${reason}` : null;
    if (this.s.call && this.s.call.state !== 'ended') this.finish({ lost: true });
    this.changed();
    this.scheduleReconnect();
  }

  phoneIndicators(ind) {
    return { signal: ind.signal ?? null, battery: ind.battchg != null ? ind.battchg * 20 : null, service: ind.service !== 0, roam: Boolean(ind.roam) };
  }

  // --- calls ------------------------------------------------------------------------

  leadFor(number, leadId, numberId) {
    if (numberId) {
      const n = this.store.numberById?.(numberId);
      if (n) return { leadId: null, numberId: n.id, name: n.name || n.business || null, business: n.business || null };
    }
    const lead = leadId ? this.store.leadById(leadId) : number ? this.store.findLeadByPhone?.(number) : null;
    if (!lead) {
      const c = number && !leadId ? this.store.contactByPhone?.(number) : null;
      if (c?.kind === 'number') return { leadId: null, numberId: c.id, name: c.name, business: c.business };
      return { leadId: null, name: null, business: null };
    }
    const person = lead.kind === 'person';
    return { leadId: lead.id, name: person ? lead.name : lead.contactName || lead.name, business: person ? lead.companyName || null : lead.name };
  }

  newCall({ number = '', direction, state, leadId = null, numberId = null }) {
    const who = this.leadFor(number, leadId, numberId);
    const startedAt = this.now();
    const recordId = this.store.addCall({ ...who, number, direction, status: direction === 'incoming' ? 'ringing' : 'dialing', startedAt, sim: this.s.phone?.operator || null, device: this.s.saved?.name || null });
    this.s.call = { recordId, number, ...who, direction, state, startedAt, answeredAt: null, muted: false, operator: this.s.phone?.operator || null, audio: { state: 'phone' }, error: null };
    return this.s.call;
  }

  // Reads again which SIM (network) the phone calls with: it follows the
  // phone's own default SIM for calls, which HFP cannot change.
  async refreshSim() {
    if (this.s.link !== 'ready' || !this.hfp) return { ok: false, error: 'Connect your phone first.' };
    const { operator, numbers } = await this.hfp.sim();
    if (this.s.phone) Object.assign(this.s.phone, { operator, numbers, number: numbers[0] || null });
    this.changed();
    return { ok: true, operator, numbers };
  }

  // Places a call: on the user's press of Call, or by the Auto Dialer the
  // user turned on (auto: true).
  async call(rawNumber, { leadId = null, numberId = null, auto = false } = {}) {
    const number = dialable(rawNumber);
    if (!number) return { ok: false, error: 'Enter a phone number (digits, with + for the country code).' };
    if (this.s.link !== 'ready') return { ok: false, error: 'Connect your phone first.' };
    if (this.s.call && this.s.call.state !== 'ended') return { ok: false, error: 'A call is already in progress.' };
    if (this.dialing) return { ok: false, error: 'A call is already being placed.' };
    if (this.s.phone && !this.s.phone.service) return { ok: false, error: 'The phone has no network service.' };
    this.dialing = true;
    try {
      await this.refreshSim().catch(() => {});
    } finally {
      this.dialing = false;
    }
    if (this.s.link !== 'ready') return { ok: false, error: 'Connect your phone first.' };
    if (this.s.call && this.s.call.state !== 'ended') return { ok: false, error: 'A call is already in progress.' };
    const call = this.newCall({ number, direction: 'outgoing', state: 'requesting', leadId, numberId });
    call.auto = auto;
    this.prepareAudio();
    this.changed();
    const r = await this.hfp.dial(number);
    if (!r.ok) {
      if (this.s.call === call && call.state !== 'ended') this.finish({ status: r.error === 'The number is busy.' ? 'busy' : 'failed', detail: r.error });
      return { ok: false, error: r.error };
    }
    // The call started: the lead is Call Seen from now on.
    if (call.leadId) {
      this.store.markCallSeen(call.leadId, this.now());
      this.emit('seen', call.leadId);
    }
    if (call.numberId) {
      this.store.markNumberCallSeen(call.numberId, this.now());
      this.emit('numberSeen', call.numberId);
    }
    if (this.s.call === call && call.state === 'requesting') {
      call.state = 'dialing';
      this.changed();
    }
    return { ok: true, id: call.recordId };
  }

  // by: 'user' (End call pressed) or 'auto' (the Auto Dialer gave up waiting for an answer).
  async hangup({ by = 'user' } = {}) {
    const call = this.s.call;
    if (!call || call.state === 'ended' || !this.hfp) return { ok: false, error: 'No call is in progress.' };
    if (call.state === 'ringing') call.rejected = true;
    call.endedBy = by;
    const r = await this.hfp.hangup();
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  async answer() {
    if (this.s.call?.state !== 'ringing' || !this.hfp) return { ok: false, error: 'No call is ringing.' };
    this.prepareAudio();
    const r = await this.hfp.answer();
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  async reject() {
    if (this.s.call?.state !== 'ringing' || !this.hfp) return { ok: false, error: 'No call is ringing.' };
    if (!this.s.phone?.canReject) return { ok: false, error: 'This phone does not let a hands-free device reject calls.' };
    this.s.call.rejected = true;
    const r = await this.hfp.hangup();
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  // Keypad tones during a call (menus, extensions).
  async dtmf(key) {
    if (this.s.call?.state !== 'active' || !this.hfp) return { ok: false, error: 'No call is in progress.' };
    if (!/^[0-9*#]$/.test(String(key))) return { ok: false, error: 'Not a keypad key.' };
    const r = await this.hfp.dtmf(key);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  async mute(on) {
    const call = this.s.call;
    if (!call || call.state === 'ended') return { ok: false, error: 'No call is in progress.' };
    if (call.audio?.state !== 'computer') return { ok: false, error: 'The call audio is on the phone, so there is no microphone to mute here.' };
    call.muted = Boolean(on);
    await this.sendAudio();
    this.changed();
    return { ok: true };
  }

  // Moves the call's audio to this computer or back to the phone.
  async audioTo(where) {
    const call = this.s.call;
    const address = this.s.saved?.address;
    if (!call || call.state === 'ended' || !address) return { ok: false, error: 'No call is in progress.' };
    if (where === 'phone') {
      await this.bt.request('sco_disconnect', { address });
      return { ok: true };
    }
    await this.prepareAudio();
    call.audio = { ...call.audio, state: 'connecting', error: null };
    this.changed();
    await this.bt.request('sco_connect', { address });
    return { ok: true };
  }

  async setAudio(prefs) {
    const p = this.s.audioPrefs;
    if (typeof prefs.output === 'string') p.output = prefs.output;
    if (typeof prefs.input === 'string') p.input = prefs.input;
    if (typeof prefs.echoCancel === 'boolean') p.echoCancel = prefs.echoCancel;
    this.store.setState('dialerAudio', p);
    this.changed();
    if (this.s.call && this.s.call.state !== 'ended') await this.applyAudio();
    return { ok: true };
  }

  // The devices (and echo cancellation) for the call, given to the helper
  // before the phone sends audio.
  prepareAudio() {
    if (!this.s.audioAvailable) return Promise.resolve();
    this.audioReady ||= this.applyAudio().finally(() => (this.audioReady = null));
    return this.audioReady;
  }

  async applyAudio() {
    try {
      await this.audio.prepare(this.s.audioPrefs);
    } catch {}
    await this.sendAudio();
    const call = this.s.call;
    const r = this.audio.route;
    if (call?.audio?.state === 'computer' && r) Object.assign(call.audio, { output: r.output, input: r.input, echoCancel: r.echoCancel });
  }

  sendAudio() {
    const r = this.audio.route;
    return this.bt.request('audio', { play: r?.play || '', record: r?.record || '', muted: Boolean(this.s.call?.muted), remote: Boolean(r?.remote) }).catch(() => {});
  }

  onVoice(address, up, reason) {
    if (address !== this.s.saved?.address) return;
    const call = this.s.call;
    if (!call || call.state === 'ended') return;
    const r = this.audio.route;
    call.audio = up ? { state: 'computer', output: r?.output || '', input: r?.input || '', echoCancel: Boolean(r?.echoCancel) } : { state: 'phone', reason };
    if (!up) call.muted = false;
    this.changed();
  }

  // HFP indicators: callsetup 1 incoming, 2 dialing, 3 ringing at the other
  // end, 0 none; call 1 while a call is connected (answered).
  onIndicator({ name, value, indicators }) {
    if (['signal', 'battchg', 'service', 'roam'].includes(name)) {
      if (this.s.phone) Object.assign(this.s.phone, this.phoneIndicators(indicators));
      this.changed();
      return;
    }
    const call = this.s.call;
    const live = call && call.state !== 'ended';
    if (name === 'callsetup') {
      if (value === 1 && !live) {
        this.newCall({ direction: 'incoming', state: 'ringing' });
        this.prepareAudio();
        // The caller's number comes with +CLIP; tell the user once it is known (or soon anyway).
        this.incomingTimer = this.timers.setTimeout(() => this.announceIncoming(), 1500);
      } else if ((value === 2 || value === 3) && !live) {
        // Dialled on the phone itself.
        this.newCall({ direction: 'outgoing', state: value === 3 ? 'alerting' : 'dialing' });
        this.prepareAudio();
        this.fillNumberFromPhone();
      } else if (value === 2 && live && call.direction === 'outgoing' && call.state !== 'active') {
        call.state = 'dialing';
      } else if (value === 3 && live && call.direction === 'outgoing' && call.state !== 'active') {
        call.state = 'alerting';
      } else if (value === 0 && live && !indicators.call && call.state !== 'active') {
        this.finish({});
        return;
      }
    } else if (name === 'call') {
      if (value === 1) {
        if (!live) {
          this.newCall({ direction: 'outgoing', state: 'active' });
          this.fillNumberFromPhone();
        }
        const c = this.s.call;
        if (c.state !== 'active') {
          c.state = 'active';
          c.answeredAt = this.now();
        }
      } else if (value === 0 && live) {
        this.finish({});
        return;
      }
    }
    this.changed();
  }

  adoptCall(ind) {
    if (ind.call) this.onIndicator({ name: 'call', value: 1, indicators: ind });
    else this.onIndicator({ name: 'callsetup', value: ind.callsetup, indicators: ind });
  }

  async fillNumberFromPhone() {
    const call = this.s.call;
    const list = await this.hfp?.calls().catch(() => []);
    const c = list?.find((x) => x.number);
    if (c && this.s.call === call && !call.number) {
      Object.assign(call, { number: c.number, ...this.leadFor(c.number) });
      // Dialled on the phone itself to a lead's number: that lead was called too.
      if (call.direction === 'outgoing' && call.leadId) {
        this.store.markCallSeen(call.leadId, this.now());
        this.emit('seen', call.leadId);
      }
      this.store.updateCall(call.recordId, { status: call.direction === 'incoming' ? 'ringing' : 'dialing', number: c.number, leadId: call.leadId, name: call.name, business: call.business });
      this.changed();
    }
  }

  onCallerId(number) {
    const call = this.s.call;
    if (!call || call.state !== 'ringing' || call.number) return;
    const n = dialable(number) || number || '';
    if (!n) return;
    Object.assign(call, { number: n, ...this.leadFor(n) });
    this.store.updateCall(call.recordId, { status: 'ringing', number: n, leadId: call.leadId, name: call.name, business: call.business });
    this.announceIncoming();
  }

  onRing() {
    if (this.s.call?.state === 'ringing' && !this.s.call.number && !this.s.call.clccAsked) {
      this.s.call.clccAsked = true;
      this.fillNumberFromPhone();
    }
  }

  announceIncoming() {
    this.timers.clearTimeout(this.incomingTimer);
    const call = this.s.call;
    if (!call || call.state !== 'ringing' || call.announced) return;
    call.announced = true;
    this.changed();
    this.emit('incoming', { ...call });
  }

  // The call is over: its outcome from what the phone reported.
  finish({ status, detail = null, lost = false }) {
    const call = this.s.call;
    if (!call || call.state === 'ended') return;
    this.timers.clearTimeout(this.incomingTimer);
    const endedAt = this.now();
    const duration = call.answeredAt ? Math.round((endedAt - call.answeredAt) / 1000) : 0;
    let outcome = status;
    if (!outcome) {
      if (call.answeredAt) outcome = 'answered';
      else if (call.direction === 'incoming') outcome = call.rejected ? 'rejected' : 'missed';
      else if (call.endedBy === 'user') outcome = 'cancelled';
      else outcome = call.busy ? 'busy' : 'no_answer';
    }
    call.state = 'ended';
    call.status = outcome;
    call.duration = duration;
    call.error = outcome === 'failed' ? detail : null;
    call.reason = detail || (lost ? 'The phone disconnected during the call.' : endReason(call));
    this.store.updateCall(call.recordId, { status: outcome, duration, detail: call.reason, endedAt, number: call.number, leadId: call.leadId, name: call.name, business: call.business });
    this.audio.release().catch(() => {});
    this.changed();
    this.emit('ended', { ...call });
    this.timers.setTimeout(() => {
      if (this.s.call === call) {
        this.s.call = null;
        this.changed();
      }
    }, 6_000);
  }

  history(filter) {
    return this.store.listCalls(filter);
  }
}

module.exports = { Dialer, sortDevices, dialable };
