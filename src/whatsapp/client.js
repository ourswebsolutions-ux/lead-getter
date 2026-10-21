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
const { normalizeMessage, normalizeStatus, isPersonJid, phoneOfJid, jidOfPhone, toMs } = require('./messages');

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
      // Recent chats when a device is linked, and older messages of a chat
      // when asked for (fetchHistory); never the full archive.
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });
    this.sock = sock;
    this.reasons = DisconnectReason;
    sock.ev.on('creds.update', () => auth.saveCreds().catch(() => {}));
    sock.ev.on('connection.update', (u) => this.onUpdate(sock, u, auth).catch(() => {}));
    // Chats: normalized, one-to-one only, LIDs resolved to phone numbers.
    const own = (fn) => (data) => sock === this.sock && fn(data).catch((err) => this.emit('sync-error', err));
    sock.ev.on('messages.upsert', own(async ({ messages, type }) => this.emitMessages(sock, messages, { live: type === 'notify' })));
    sock.ev.on('messaging-history.set', own(async ({ chats, contacts, messages }) => {
      await this.emitMeta(sock, [...(contacts || []).map(contactMeta), ...(chats || []).map(chatMeta)]);
      await this.emitMessages(sock, messages || [], { live: false });
    }));
    sock.ev.on('chats.upsert', own(async (chats) => this.emitMeta(sock, chats.map(chatMeta))));
    sock.ev.on('chats.update', own(async (chats) => this.emitMeta(sock, chats.map(chatMeta))));
    sock.ev.on('contacts.upsert', own(async (contacts) => this.emitMeta(sock, contacts.map(contactMeta))));
    sock.ev.on('contacts.update', own(async (contacts) => this.emitMeta(sock, contacts.map(contactMeta))));
    sock.ev.on('messages.update', own(async (updates) => {
      const list = [];
      for (const u of updates) {
        const st = normalizeStatus(u);
        if (st) list.push({ ...st, jid: await this.canonical(sock, st.jid) });
      }
      if (list.length) this.emit('chat-status', list);
    }));
  }

  // A phone-number JID when the phone is known, so a contact who writes
  // from a privacy ID (LID) stays in the same chat.
  async canonical(sock, jid, alt = null) {
    let phone = phoneOfJid(jid) || phoneOfJid(alt);
    if (!phone && String(jid).endsWith('@lid')) {
      try {
        phone = phoneOfJid(await sock.signalRepository?.lidMapping?.getPNForLID?.(jid));
      } catch {}
    }
    return phone ? jidOfPhone(phone) : jid;
  }

  async emitMessages(sock, raw, { live }) {
    const list = [];
    for (const m of raw) {
      const n = normalizeMessage(m);
      if (!n) continue;
      const jid = await this.canonical(sock, n.jid, m.key?.remoteJidAlt || m.key?.senderPn);
      list.push({ ...n, jid, phone: n.phone || phoneOfJid(jid) });
    }
    if (list.length) this.emit('chat-messages', list, { live });
  }

  async emitMeta(sock, items) {
    const list = [];
    for (const it of items) {
      if (!it || !isPersonJid(it.jid)) continue;
      const jid = await this.canonical(sock, it.jid, it.alt);
      list.push({ ...it, jid, phone: phoneOfJid(jid) });
    }
    if (list.length) this.emit('chat-meta', list);
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

// --- chat view -----------------------------------------------------------------

Object.assign(WhatsAppClient.prototype, {
  // Sends a text to a chat (phone or LID JID). Resolves with the message id.
  async sendToChat(jid, text) {
    this.requireOpen();
    if (!isPersonJid(jid)) throw new Error('Only one-to-one chats are supported.');
    const msg = await withTimeout(this.sock.sendMessage(jid, { text }), 30_000, 'Sending timed out');
    const id = msg?.key?.id;
    if (!id) throw new Error('WhatsApp did not confirm the message');
    return { id, ts: toMs(msg.messageTimestamp) || Date.now() };
  },

  // Read receipts for messages the user has now seen (as WhatsApp Web does).
  async markRead(jid, ids) {
    this.requireOpen();
    if (!ids.length) return;
    await withTimeout(this.sock.readMessages(ids.map((id) => ({ remoteJid: jid, id, fromMe: false }))), 15_000, 'WhatsApp did not answer in time');
  },

  // The contact's profile picture as a data: URL (the window only shows
  // local images), or null when they don't share one.
  async avatar(jid) {
    this.requireOpen();
    let url;
    try {
      url = await this.sock.profilePictureUrl(jid, 'preview', 15_000);
    } catch {
      return null; // not set, or hidden by the contact's privacy settings
    }
    if (!url || !/^https:\/\/[^/]*\.whatsapp\.net\//.test(url)) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !/^image\/(jpeg|png|webp)/.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 200_000) return null;
    return `data:${type.split(';')[0]};base64,${buf.toString('base64')}`;
  },

  // Asks the phone for older messages of a chat; they arrive later as
  // 'chat-messages' (WhatsApp decides how many, if any).
  async fetchHistory(jid, oldest, count = 50) {
    this.requireOpen();
    await withTimeout(this.sock.fetchMessageHistory(count, { remoteJid: jid, id: oldest.id, fromMe: oldest.fromMe }, Math.floor(oldest.ts / 1000)), 20_000, 'WhatsApp did not answer in time');
  },
});

function chatMeta(c) {
  return { jid: c.id, alt: c.pnJid || c.phoneNumber || null, name: c.name || null, unread: Number.isInteger(c.unreadCount) ? Math.max(0, c.unreadCount) : null, lastTs: toMs(c.conversationTimestamp) };
}

function contactMeta(c) {
  // name: as saved in the phone's address book; notify: the contact's own WhatsApp name.
  return { jid: c.id, alt: c.phoneNumber || c.jid || null, name: c.name || c.notify || c.verifiedName || null, savedName: c.name || null, pushName: c.notify || null };
}

function withTimeout(p, ms, text) {
  let t;
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error(text)), ms)))]).finally(() => clearTimeout(t));
}

module.exports = { WhatsAppClient, silentLogger };
