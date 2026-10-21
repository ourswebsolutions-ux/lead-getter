'use strict';

// WhatsApp connection through Baileys (WhatsApp Web protocol), running in
// the main process. The user links their own account by scanning a QR
// code; the session stays on this computer, encrypted.
//
// States: 'disconnected' | 'connecting' | 'qr' | 'qr_expired' | 'open' |
//         'reconnecting' | 'logged_out' | 'error'

const { EventEmitter } = require('node:events');
const QRCode = require('qrcode');
const { useEncryptedAuthState, hasSession, wipeSession } = require('./auth-state');

const RECONNECT_DELAYS = [2000, 5000, 15_000, 30_000, 60_000];

// Silent logger: Baileys logs protocol details that may include message
// content or keys, so nothing is written anywhere.
const silentLogger = {
  level: 'silent',
  child() {
    return silentLogger;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
};

class WhatsAppClient extends EventEmitter {
  // dir: session folder; cipher: { encrypt, decrypt };
  // loadBaileys: () => Promise<module> (injected for tests).
  constructor({ dir, cipher, loadBaileys = () => import('baileys'), delays = RECONNECT_DELAYS }) {
    super();
    this.dir = dir;
    this.cipher = cipher;
    this.loadBaileys = loadBaileys;
    this.delays = delays;
    this.sock = null;
    this.state = 'disconnected';
    this.qr = null; // data: URL of the current QR image
    this.account = null; // { id, name }
    this.error = null;
    this.attempt = 0;
    this.timer = null;
    this.wanted = false; // the user asked to be connected
  }

  snapshot() {
    return { state: this.state, qr: this.state === 'qr' ? this.qr : null, account: this.account, error: this.error };
  }

  set(state, extra = {}) {
    Object.assign(this, extra);
    this.state = state;
    this.emit('state', this.snapshot());
  }

  async hasSession() {
    return hasSession(this.dir);
  }

  async connect() {
    this.wanted = true;
    clearTimeout(this.timer);
    if (this.sock && (this.state === 'open' || this.state === 'connecting' || this.state === 'qr')) return;
    this.set(this.attempt ? 'reconnecting' : 'connecting', { error: null });
    let baileys;
    try {
      baileys = await this.loadBaileys();
    } catch (err) {
      this.set('error', { error: `WhatsApp library could not be loaded (${err.message}).` });
      return;
    }
    const { default: makeWASocket, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, DisconnectReason, Browsers } = baileys;
    const auth = await useEncryptedAuthState(this.dir, this.cipher, baileys);
    // Use WhatsApp Web's current version when it can be fetched. The key is
    // left out otherwise: an explicit `version: undefined` would override
    // Baileys' built-in default and break the connection.
    const versionOpt = {};
    try {
      const { version } = await fetchLatestBaileysVersion();
      if (Array.isArray(version)) versionOpt.version = version;
    } catch {}
    const sock = makeWASocket({
      ...versionOpt,
      auth: { creds: auth.state.creds, keys: makeCacheableSignalKeyStore(auth.state.keys, silentLogger) },
      logger: silentLogger,
      browser: Browsers.appropriate('Lead Finder'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
    });
    this.sock = sock;
    this.reasons = DisconnectReason;
    sock.ev.on('creds.update', () => auth.saveCreds().catch(() => {}));
    sock.ev.on('messages.update', (updates) => this.emit('messages.update', updates));
    sock.ev.on('connection.update', (u) => this.onUpdate(sock, u, auth).catch(() => {}));
  }

  async onUpdate(sock, u, auth) {
    if (sock !== this.sock) return; // an old socket
    if (u.qr) {
      this.qrCount = (this.qrCount || 0) + 1;
      const qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 264, errorCorrectionLevel: 'M' });
      this.set('qr', { qr });
    }
    if (u.connection === 'open') {
      this.attempt = 0;
      this.qrCount = 0;
      const me = sock.user || {};
      this.set('open', { qr: null, account: { id: String(me.id || '').split(':')[0].split('@')[0], name: me.name || me.verifiedName || '' } });
      return;
    }
    if (u.connection !== 'close') return;
    const code = u.lastDisconnect?.error?.output?.statusCode;
    const R = this.reasons;
    this.sock = null;
    if (code === R.loggedOut || code === R.forbidden || code === R.badSession) {
      // Unlinked from the phone (or the session is unusable): remove it.
      await wipeSession(this.dir).catch(() => {});
      this.wanted = false;
      this.attempt = 0;
      this.set('logged_out', { account: null, qr: null, error: code === R.loggedOut ? null : 'WhatsApp ended this session. Link the device again.' });
      return;
    }
    if (code === R.connectionReplaced) {
      this.wanted = false;
      this.set('error', { qr: null, error: 'This WhatsApp session was opened somewhere else. Reconnect to use it here.' });
      return;
    }
    if (!auth.isRegistered() && this.state === 'qr') {
      // The QR codes ran out without being scanned.
      this.wanted = false;
      this.set('qr_expired', { qr: null });
      return;
    }
    if (code === R.restartRequired) {
      // Normal right after pairing: reconnect at once.
      this.connect();
      return;
    }
    if (!this.wanted) {
      this.set('disconnected', { qr: null });
      return;
    }
    if (this.attempt >= this.delays.length) {
      this.attempt = 0;
      this.wanted = false;
      this.set('error', { qr: null, error: 'Could not reconnect to WhatsApp. Check the internet connection and try again.' });
      return;
    }
    const wait = this.delays[this.attempt++];
    this.set('reconnecting', { qr: null, error: `Connection lost. Retrying in ${Math.round(wait / 1000)}s.` });
    this.timer = setTimeout(() => this.wanted && this.connect(), wait);
  }

  // Close the connection; the linked session is kept for next time.
  async disconnect() {
    this.wanted = false;
    clearTimeout(this.timer);
    const s = this.sock;
    this.sock = null;
    if (s) await s.end(undefined).catch(() => {});
    this.set('disconnected', { qr: null });
  }

  // Unlink this device from the WhatsApp account and delete the session.
  async logout() {
    this.wanted = false;
    clearTimeout(this.timer);
    const s = this.sock;
    this.sock = null;
    if (s) await s.logout().catch(() => {});
    await wipeSession(this.dir);
    this.set('logged_out', { account: null, qr: null, error: null });
  }

  requireOpen() {
    if (this.state !== 'open' || !this.sock) {
      const e = new Error('WhatsApp is not connected.');
      e.code = 'not_connected';
      throw e;
    }
  }

  // One number per query: Baileys only returns numbers that are on
  // WhatsApp, so a missing entry is "unavailable" only when the query itself
  // succeeded. Returns 'available' | 'unavailable'; throws on failure.
  async check(e164) {
    this.requireOpen();
    const digits = String(e164).replace(/^\+/, '');
    const res = await withTimeout(this.sock.onWhatsApp(digits), 20_000, 'WhatsApp did not answer in time');
    if (!Array.isArray(res)) throw new Error('WhatsApp returned no answer');
    const hit = res.find((r) => String(r.jid || '').split('@')[0].split(':')[0] === digits);
    return hit && hit.exists ? 'available' : 'unavailable';
  }

  // Sends one text message; resolves with the WhatsApp message id once the
  // message has been handed to WhatsApp's servers.
  async send(e164, text) {
    this.requireOpen();
    const jid = `${String(e164).replace(/^\+/, '')}@s.whatsapp.net`;
    const msg = await withTimeout(this.sock.sendMessage(jid, { text }), 30_000, 'Sending timed out');
    const id = msg?.key?.id;
    if (!id) throw new Error('WhatsApp did not confirm the message');
    return id;
  }
}

function withTimeout(p, ms, text) {
  let t;
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error(text)), ms)))]).finally(() => clearTimeout(t));
}

module.exports = { WhatsAppClient, silentLogger };
