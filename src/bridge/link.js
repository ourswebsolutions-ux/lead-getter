'use strict';

// Where the Dialer's Bluetooth comes from: this computer's own (Linux,
// bt-helper.py) or a bridge on the local network (another Linux computer
// running Lead Finder Bridge, found automatically). PhoneLink looks to the
// Dialer, SMS and campaigns exactly like the local helper (request, events,
// running) and forwards to the best available one:
//
//   1. a phone connected to it (ready for calls)      +100
//   2. Hands-Free role available                       +40
//   3. Bluetooth on                                     +30
//   4. two-way call audio verified (else supported)     +20 / +10
//   5. the one in use (stability) +15, the last chosen +5, faster round trip
//
// Paired bridges found on the network are connected by themselves; a new
// bridge must be paired once (the same code on both screens). When the one in
// use goes away it switches to the next best (and back when it returns),
// but never during a call.
//
// Events: the helper's events (from the one in use), 'voice' (Buffer),
// 'switched' ({ from, to }), 'link' (state for the window).

const { EventEmitter } = require('node:events');
const { BridgeConnection } = require('./client');

const HELPER_EVENTS = ['ready', 'adapter', 'device', 'device_removed', 'confirm', 'passkey', 'confirm_cancelled', 'link_up', 'link_down', 'data', 'sco_up', 'sco_down', 'audio_error', 'hf_profile', 'sms_message', 'sms_status', 'exit'];
const RETRY_MS = [3_000, 10_000, 30_000];
const PHONE_CLASS = 2;

const isPhone = (d) => d.paired && d.connected && (d.icon === 'phone' || ((d.deviceClass >> 8) & 0x1f) === PHONE_CLASS);

class PhoneLink extends EventEmitter {
  constructor({ local = null, identity, listener = null, state = { get: () => null, set: () => {} }, callLive = () => false, connect = (opts) => new BridgeConnection(opts), platform = process.platform }) {
    super();
    this.local = local; // Bluetooth (bluetooth.js) or null where it does not work (Windows, macOS)
    this.identity = identity;
    this.listener = listener;
    this.store = state;
    this.callLive = callLive;
    this.makeConnection = connect;
    this.platform = platform;
    this.discovery = state.get('bridgeDiscovery') !== false;
    this.preferred = state.get('bridgePreferred') || null;
    this.active = null; // 'local' | bridge fingerprint
    this.localState = { snapshot: null, hfRole: null, running: false };
    this.bridges = new Map(); // fingerprint -> { info, conn, state, error, retry, retryTimer }
    this.pairing = null; // { fingerprint, code, name }
    this.reconnect = { state: 'idle', since: null };
  }

  get running() {
    return this.active === 'local' ? Boolean(this.local?.running) : Boolean(this.bridges.get(this.active)?.conn?.running);
  }

  get remote() {
    return Boolean(this.active && this.active !== 'local');
  }

  transport() {
    if (this.active === 'local') return this.local;
    return this.bridges.get(this.active)?.conn || null;
  }

  // --- start -------------------------------------------------------------------

  start() {
    if (this.started) return;
    this.started = true;
    if (this.local) {
      for (const ev of HELPER_EVENTS) this.local.on(ev, (m) => this.fromLocal(ev, m));
      this.local.on('voice', (m) => this.active === 'local' && this.emit('voice', Buffer.from(m.data, 'base64')));
      this.local.start();
      this.localState.running = true;
    }
    if (this.discovery) this.startDiscovery();
    // Nothing found (no Bluetooth here, no bridge yet): the Dialer still gets a state.
    setTimeout(() => {
      if (!this.active) this.select(true);
      if (!this.active) this.emit('ready', { state: { adapter: null, devices: [], links: [], message: this.noLinkMessage() } });
    }, this.local ? 0 : 2_500);
  }

  noLinkMessage() {
    if (!this.discovery) return 'This computer has no Bluetooth for calls. Turn on automatic device discovery to use a bridge.';
    return 'Looking for a bridge: run Lead Finder Bridge on a Linux laptop on this network (its Bluetooth and your phone are then used from here).';
  }

  fromLocal(ev, m) {
    if (ev === 'ready') this.localState.snapshot = m.state;
    if (ev === 'hf_profile') this.localState.hfRole = m.ok ? 'ok' : m.busy ? 'pipewire' : 'error';
    if (ev === 'adapter' && this.localState.snapshot) this.localState.snapshot.adapter = m.adapter;
    if (ev === 'device' && this.localState.snapshot) {
      const list = this.localState.snapshot.devices;
      const i = list.findIndex((d) => d.address === m.device.address);
      if (i >= 0) list[i] = m.device;
      else list.push(m.device);
    }
    if (ev === 'exit') this.localState.running = false;
    if (this.active === 'local') this.emit(ev, m);
    else if (!this.active && ev === 'ready') this.select(true);
    else if (['ready', 'hf_profile', 'device', 'adapter'].includes(ev)) this.select();
    this.changed();
  }

  startDiscovery() {
    if (!this.listener) return;
    this.listenerStarted = true;
    this.listener.on('found', (b) => this.onFound(b));
    this.listener.on('update', (b) => this.onFound(b));
    this.listener.on('lost', (b) => {
      const e = this.bridges.get(b.fingerprint);
      if (e && e.state !== 'ready') {
        clearTimeout(e.retryTimer);
        this.bridges.delete(b.fingerprint);
        this.changed();
      }
    });
    this.listener.start();
  }

  setDiscovery(on) {
    this.discovery = Boolean(on);
    this.store.set('bridgeDiscovery', this.discovery);
    if (this.discovery) {
      if (!this.listenerStarted) this.startDiscovery();
      this.listenerStarted = true;
    } else {
      this.listener?.stop();
      this.listener?.removeAllListeners();
      this.listenerStarted = false;
      // Bridges not in use are let go; the one in use stays (a call may be going on).
      for (const [fp, e] of this.bridges) {
        if (fp === this.active) continue;
        clearTimeout(e.retryTimer);
        e.conn?.close();
        this.bridges.delete(fp);
      }
    }
    this.changed();
    return { ok: true };
  }

  trustedFingerprints() {
    return new Set(Object.values(this.identity.trusted()).map((t) => t.fingerprint));
  }

  onFound(b) {
    let e = this.bridges.get(b.fingerprint);
    if (!e) {
      e = { info: b, conn: null, state: 'found', error: null, retry: 0, retryTimer: null };
      this.bridges.set(b.fingerprint, e);
    }
    e.info = b;
    if (e.conn?.running) e.status = e.conn.status;
    else e.status = b.status;
    // A paired bridge: connected by itself.
    if (this.trustedFingerprints().has(b.fingerprint) && !e.conn && !e.retryTimer && e.state !== 'busy-wait') this.connectBridge(b.fingerprint);
    this.changed();
  }

  // Connects to a bridge (pairing it when it is new: the user confirms the code).
  async connectBridge(fp, { pair = false } = {}) {
    const e = this.bridges.get(fp);
    if (!e || e.conn) return { ok: false, error: e ? 'Already connecting.' : 'That bridge is no longer on the network.' };
    if (!pair && !this.trustedFingerprints().has(fp)) return { ok: false, error: 'Pair this bridge first.' };
    const conn = this.makeConnection({ identity: this.identity, host: e.info.host, port: e.info.port, fingerprint: fp, name: e.info.name });
    e.conn = conn;
    e.state = 'connecting';
    e.error = null;
    this.changed();
    conn.on('pairing', ({ code, name }) => {
      e.state = 'pairing';
      this.pairing = { fingerprint: fp, code, name };
      this.changed();
    });
    conn.on('status', (s) => {
      e.status = s;
      this.select();
      this.changed();
    });
    conn.on('rtt', (ms) => {
      e.rtt = ms;
      this.changed();
    });
    for (const ev of HELPER_EVENTS) conn.on(ev, (m) => this.active === fp && this.emit(ev, m));
    conn.on('voice', (buf) => this.active === fp && this.emit('voice', buf));
    conn.on('closed', ({ reason, denied, busy }) => this.onBridgeClosed(fp, conn, { reason, denied, busy }));
    const ok = await conn.connect();
    if (this.pairing?.fingerprint === fp) this.pairing = null;
    if (!ok) return { ok: false, error: e.error || 'The bridge could not be connected.' };
    e.state = 'ready';
    e.retry = 0;
    e.status = conn.status;
    this.select();
    this.changed();
    return { ok: true };
  }

  confirmPairing(fp, ok) {
    const e = this.bridges.get(fp);
    if (!e?.conn || this.pairing?.fingerprint !== fp) return { ok: false, error: 'Nothing is waiting to be paired.' };
    e.conn.confirmPairing(Boolean(ok));
    if (!ok) this.pairing = null;
    this.changed();
    return { ok: true };
  }

  onBridgeClosed(fp, conn, { reason, denied, busy }) {
    const e = this.bridges.get(fp);
    if (!e || e.conn !== conn) return;
    e.conn = null;
    e.state = denied ? 'denied' : busy ? 'busy' : 'lost';
    e.error = reason;
    if (this.pairing?.fingerprint === fp) this.pairing = null;
    const wasActive = this.active === fp;
    if (wasActive) {
      this.reconnect = { state: 'reconnecting', since: Date.now() };
      this.switchTo(null, `${e.info.name} disconnected`);
      this.select(true);
    }
    // Paired: tried again by itself while it is on the network.
    if (!denied && this.discovery && this.trustedFingerprints().has(fp)) {
      const wait = busy ? 30_000 : RETRY_MS[Math.min(e.retry++, RETRY_MS.length - 1)];
      e.retryTimer = setTimeout(() => {
        e.retryTimer = null;
        if (this.bridges.get(fp) === e && !e.conn) this.connectBridge(fp);
      }, wait);
    }
    this.changed();
  }

  forget(fp) {
    const e = this.bridges.get(fp);
    if (fp === this.active && this.callLive()) return { ok: false, error: 'A call is going on through this bridge.' };
    for (const [id, info] of Object.entries(this.identity.trusted())) if (info.fingerprint === fp) this.identity.forget(id);
    if (e) {
      clearTimeout(e.retryTimer);
      e.conn?.close();
      e.state = 'found';
    }
    this.changed();
    return { ok: true };
  }

  // --- choosing ------------------------------------------------------------------

  candidates() {
    const out = [];
    if (this.local && this.localState.running && this.localState.snapshot) {
      const snap = this.localState.snapshot;
      out.push({ key: 'local', bluetooth: Boolean(snap.adapter?.powered), hfRole: this.localState.hfRole, phone: snap.devices.some(isPhone), audio: this.localState.hfRole === 'ok' ? 'supported' : 'unavailable', rtt: 0 });
    }
    for (const [fp, e] of this.bridges) {
      if (e.state !== 'ready' || !e.conn?.running) continue;
      const s = e.status || {};
      out.push({ key: fp, bluetooth: Boolean(s.bluetooth), hfRole: s.hfRole, phone: Boolean(s.phone), audio: s.audio, rtt: e.rtt ?? 50 });
    }
    return out;
  }

  score(c) {
    return (c.phone ? 100 : 0) + (c.hfRole === 'ok' ? 40 : 0) + (c.bluetooth ? 30 : 0) + (c.audio === 'verified' ? 20 : c.audio === 'supported' ? 10 : 0) + (c.key === this.active ? 15 : 0) + (c.key === this.preferred ? 5 : 0) - Math.min(c.rtt || 0, 300) / 30;
  }

  // Uses the best one (not during a call, unless the one in use is gone).
  select(force = false) {
    if (!force && this.active && this.callLive()) return;
    const list = this.candidates().sort((a, b) => this.score(b) - this.score(a));
    const best = list[0]?.key || null;
    if (best && best !== this.active) this.switchTo(best);
  }

  // Chosen by the user (a bridge or this computer).
  choose(key) {
    if (this.callLive()) return { ok: false, error: 'Not during a call.' };
    if (!this.candidates().some((c) => c.key === key)) return { ok: false, error: 'That one is not ready.' };
    this.preferred = key;
    this.store.set('bridgePreferred', key);
    this.switchTo(key);
    return { ok: true };
  }

  async switchTo(key, reason) {
    const from = this.active;
    if (from === key) return;
    this.active = key;
    if (key && key !== 'local') {
      this.preferred = key;
      this.store.set('bridgePreferred', key);
    }
    // The Dialer lets go of the phone link it had, then gets the new one's state.
    this.emit('switched', { from, to: key, reason });
    this.changed();
    if (!key) return;
    this.reconnect = { state: 'idle', since: null };
    const t = this.transport();
    if (key === 'local') {
      if (this.localState.snapshot) this.emit('ready', { state: this.localState.snapshot });
      if (this.localState.hfRole) this.emit('hf_profile', this.localState.hfRole === 'ok' ? { ok: true } : { ok: false, busy: this.localState.hfRole === 'pipewire', error: this.localState.hfRole === 'pipewire' ? "The sound server (PipeWire) is using this computer's Hands-Free role." : 'Hands-Free is not available.' });
      return;
    }
    try {
      const state = await t.request('state');
      if (this.active !== key) return;
      this.emit('ready', { state });
      const s = this.bridges.get(key)?.status || {};
      this.emit('hf_profile', s.hfRole === 'ok' ? { ok: true } : { ok: false, busy: s.hfRole === 'pipewire', error: s.hfRole === 'pipewire' ? "The bridge's sound server (PipeWire) has the Hands-Free role: open Lead Finder's Dialer on the bridge once and choose “Use this computer for calls”." : 'Hands-Free is not available on the bridge.' });
    } catch {}
  }

  // --- the helper's interface (for the Dialer, SMS and campaigns) -------------------------

  request(cmd, args) {
    const t = this.transport();
    if (!t) return Promise.reject(new Error(this.discovery ? 'No Bluetooth for calls yet: looking for a bridge on the network.' : 'This computer has no Bluetooth for calls.'));
    // A bridge plays and records the call here, through Lead Finder's window.
    if (cmd === 'audio' && this.remote) return t.request('audio', { ...args, play: '', record: '', remote: true });
    return t.request(cmd, args);
  }

  notify(cmd, args) {
    if (this.active === 'local') this.local.notify(cmd, args);
  }

  sendVoice(buf) {
    if (this.remote) this.bridges.get(this.active)?.conn?.sendVoice(buf);
    else if (this.active === 'local') this.local.notify('voice_out', { data: Buffer.from(buf).toString('base64') });
  }

  stop() {
    this.listener?.stop();
    for (const e of this.bridges.values()) {
      clearTimeout(e.retryTimer);
      e.conn?.close();
    }
    this.local?.stop();
  }

  // --- for the window ----------------------------------------------------------------

  quality(rtt) {
    if (rtt == null) return null;
    return rtt < 40 ? 'excellent' : rtt < 100 ? 'good' : rtt < 250 ? 'fair' : 'poor';
  }

  state() {
    const trusted = this.trustedFingerprints();
    const activeEntry = this.active && this.active !== 'local' ? this.bridges.get(this.active) : null;
    const loc = this.localState.snapshot;
    const active = !this.active
      ? null
      : this.active === 'local'
        ? { key: 'local', name: loc?.adapter?.name || 'This computer', deviceType: 'This computer (Linux)', bluetooth: Boolean(loc?.adapter?.powered), hfRole: this.localState.hfRole, phone: loc?.devices.find(isPhone)?.name || null, audio: this.localState.hfRole === 'ok' ? 'supported' : 'unavailable', rtt: 0, quality: 'local' }
        : { key: this.active, name: activeEntry.info.name, host: activeEntry.info.host, deviceType: 'Linux laptop (bridge)', bluetooth: Boolean(activeEntry.status?.bluetooth), hfRole: activeEntry.status?.hfRole, phone: activeEntry.status?.phone?.name || null, audio: activeEntry.status?.audio || 'unavailable', rtt: activeEntry.rtt ?? null, quality: this.quality(activeEntry.rtt) };
    return {
      discovery: this.discovery,
      localAvailable: Boolean(this.local),
      active,
      pairing: this.pairing,
      reconnect: this.reconnect,
      bridges: [...this.bridges.entries()].map(([fp, e]) => ({ fingerprint: fp, name: e.info.name, host: e.info.host, state: e.state, error: e.error, trusted: trusted.has(fp), active: fp === this.active, status: e.status || {}, rtt: e.rtt ?? null, quality: this.quality(e.rtt) })),
    };
  }

  changed() {
    this.emit('link', this.state());
  }
}

module.exports = { PhoneLink, HELPER_EVENTS };
