'use strict';
// A scripted stand-in for the Baileys module, for end-to-end tests only.
// Loaded by the app when LEAD_FINDER_TEST_BAILEYS points here (never in a
// packaged build). It "links" at once, syncs a little test history, answers
// number checks, and records every message the app sends in
// LEAD_FINDER_TEST_BAILEYS_LOG so tests can count real send attempts.
// Tests drive it from the main process through globalThis.__fakeWA.

const fs = require('node:fs');
const { EventEmitter } = require('node:events');

const LOG = process.env.LEAD_FINDER_TEST_BAILEYS_LOG;
const ON_WHATSAPP = new Set((process.env.LEAD_FINDER_TEST_BAILEYS_NUMBERS || '').split(',').filter(Boolean));
const HISTORY = process.env.LEAD_FINDER_TEST_BAILEYS_HISTORY === '1';
let seq = 0;

function logSend(entry) {
  if (!LOG) return;
  fs.appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
}

const secs = (ms) => Math.floor(ms / 1000);

function makeSocket(opts) {
  const ev = new EventEmitter();
  const sock = { ev, opts, user: null };
  sock.end = async () => {};
  sock.logout = async () => {};
  sock.onWhatsApp = async (n) => (ON_WHATSAPP.has(n) ? [{ jid: `${n}@s.whatsapp.net`, exists: true }] : []);
  sock.sendMessage = async (jid, content) => {
    const id = `OUT${Date.now()}${++seq}`;
    logSend({ jid, text: content.text, id, at: Date.now() });
    const msg = { key: { remoteJid: jid, id, fromMe: true }, messageTimestamp: secs(Date.now()), status: 2, message: { conversation: content.text } };
    setTimeout(() => ev.emit('messages.upsert', { type: 'append', messages: [msg] }), 10);
    return msg;
  };
  sock.readMessages = async (keys) => logSend({ read: keys.map((k) => k.id) });
  sock.profilePictureUrl = async () => undefined;
  sock.fetchMessageHistory = async () => 'req';
  sock.signalRepository = { lidMapping: { getPNForLID: async () => null } };
  setTimeout(() => {
    sock.user = { id: '923000000001:7@s.whatsapp.net', name: 'Test Account' };
    ev.emit('connection.update', { connection: 'open' });
    if (HISTORY) {
      const t = Date.now() - 3 * 3600_000;
      ev.emit('messaging-history.set', {
        syncType: 1,
        chats: [{ id: '923005556667@s.whatsapp.net', name: 'History Contact', unreadCount: 1, conversationTimestamp: secs(t + 60_000) }],
        contacts: [{ id: '923005556667@s.whatsapp.net', name: 'History Contact', notify: 'Hist' }],
        messages: [
          { key: { remoteJid: '923005556667@s.whatsapp.net', id: 'H1', fromMe: false }, messageTimestamp: secs(t), pushName: 'Hist', message: { conversation: 'Plot ka rate kya hai?' } },
          { key: { remoteJid: '923005556667@s.whatsapp.net', id: 'H2', fromMe: true }, messageTimestamp: secs(t + 30_000), status: 4, message: { conversation: 'Kal batata hoon.' } },
          { key: { remoteJid: '923005556667@s.whatsapp.net', id: 'H3', fromMe: false }, messageTimestamp: secs(t + 60_000), pushName: 'Hist', message: { conversation: 'Theek hai' } },
        ],
      });
    }
  }, 50);
  globalThis.__fakeWA = {
    sock,
    // A message from a contact, as WhatsApp would deliver it.
    incoming(phoneDigits, text, pushName = null) {
      ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: `${phoneDigits}@s.whatsapp.net`, id: `IN${Date.now()}${++seq}`, fromMe: false }, messageTimestamp: secs(Date.now()), pushName, message: { conversation: text } }] });
    },
    // A delivery/read receipt for one of the app's messages.
    receipt(jid, id, status) {
      ev.emit('messages.update', [{ key: { remoteJid: jid, id, fromMe: true }, update: { status } }]);
    },
  };
  return sock;
}

module.exports = {
  default: makeSocket,
  initAuthCreds: () => ({ noiseKey: { private: 'test' }, registered: true }),
  BufferJSON: { replacer: undefined, reviver: undefined },
  proto: { Message: { AppStateSyncKeyData: { fromObject: (o) => o } } },
  DisconnectReason: { connectionClosed: 428, connectionLost: 408, connectionReplaced: 440, timedOut: 408, loggedOut: 401, badSession: 500, restartRequired: 515, forbidden: 403 },
  Browsers: { appropriate: (b) => ['Linux', b, '1'] },
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
  makeCacheableSignalKeyStore: (k) => k,
};
