'use strict';
// WhatsApp chats: message normalization, encrypted storage, the chat service,
// event handling in the WhatsApp client (with a scripted Baileys), and the
// database migration that adds the chat and outreach tables.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { LeadStore } = require('../src/database/db');
const { ChatStore } = require('../src/database/wa-store');
const { ChatService } = require('../src/whatsapp/chats');
const { WhatsAppClient } = require('../src/whatsapp/client');
const { normalizeMessage, normalizeStatus, laterStatus, phoneOfJid } = require('../src/whatsapp/messages');

const cipher = { encrypt: (t) => Buffer.from(`enc:${Buffer.from(t, 'utf8').toString('base64')}`), decrypt: (b) => Buffer.from(String(b).slice(4), 'base64').toString('utf8') };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lf-chats-'));
const msg = (over = {}) => ({ key: { remoteJid: '923001234567@s.whatsapp.net', id: 'A1', fromMe: false }, messageTimestamp: 1792560000, pushName: 'Zahid', message: { conversation: 'Walaikum assalam' }, ...over });

test('normalizes one-to-one messages; skips groups, broadcasts, reactions and protocol messages', () => {
  const n = normalizeMessage(msg());
  assert.deepEqual(n, { jid: '923001234567@s.whatsapp.net', id: 'A1', fromMe: false, phone: '+923001234567', pushName: 'Zahid', ts: 1792560000000, kind: 'text', text: 'Walaikum assalam', status: null });
  assert.equal(normalizeMessage(msg({ message: { extendedTextMessage: { text: 'link https://x' } } })).text, 'link https://x');
  assert.equal(normalizeMessage(msg({ message: { ephemeralMessage: { message: { conversation: 'disappearing' } } } })).text, 'disappearing');
  assert.deepEqual(normalizeMessage(msg({ message: { imageMessage: { caption: 'plot map' } } })).text, 'Photo: plot map');
  assert.equal(normalizeMessage(msg({ message: { audioMessage: {} } })).kind, 'audio');
  assert.equal(normalizeMessage(msg({ key: { remoteJid: '1203630@g.us', id: 'G', fromMe: false } })), null, 'groups are not shown');
  assert.equal(normalizeMessage(msg({ key: { remoteJid: 'status@broadcast', id: 'S', fromMe: false } })), null);
  assert.equal(normalizeMessage(msg({ message: { reactionMessage: { text: '👍' } } })), null);
  assert.equal(normalizeMessage(msg({ message: { protocolMessage: { type: 0 } } })), null);
  const own = normalizeMessage(msg({ key: { remoteJid: '923001234567@s.whatsapp.net', id: 'B', fromMe: true }, status: 3 }));
  assert.equal(own.status, 'delivered');
  assert.equal(own.pushName, null);
  const lid = normalizeMessage(msg({ key: { remoteJid: '123456789012345@lid', remoteJidAlt: '923009998887@s.whatsapp.net', id: 'L', fromMe: false } }));
  assert.equal(lid.phone, '+923009998887');
  assert.equal(phoneOfJid('123@lid'), null);
  assert.deepEqual(normalizeStatus({ key: { remoteJid: '923001234567@s.whatsapp.net', id: 'B', fromMe: true }, update: { status: 4 } }), { jid: '923001234567@s.whatsapp.net', id: 'B', status: 'read' });
  assert.equal(normalizeStatus({ key: { remoteJid: '923001234567@s.whatsapp.net', id: 'B', fromMe: false }, update: { status: 4 } }), null);
  assert.equal(laterStatus('read', 'delivered'), 'read');
  assert.equal(laterStatus('sent', 'failed'), 'sent');
  assert.equal(laterStatus('pending', 'failed'), 'failed');
});

function stores() {
  const dir = tmp();
  const leads = new LeadStore(path.join(dir, 'leads.db'));
  return { leads, chats: new ChatStore(leads.db, cipher), dir };
}

test('chat store: encrypted at rest, de-duplicated, unread counts, lead mapping, search', () => {
  const { leads, chats } = stores();
  const cat = leads.ensureCategory('Real Estate');
  leads.save({ placeKey: '0x1:0x1', mapsUrl: 'https://www.google.com/maps/place/A', name: 'Zahid Properties', phoneRaw: '03001234567', address: 'Lahore, Pakistan', websiteStatus: 'no_website', categoryId: cat.id });
  const a = normalizeMessage(msg());
  const b = normalizeMessage(msg({ key: { remoteJid: '923001234567@s.whatsapp.net', id: 'A2', fromMe: true }, messageTimestamp: 1792560100, message: { conversation: 'Ji, real estate' } }));
  assert.deepEqual(chats.addMessages([a, b], { unreadIncrement: true }), ['923001234567@s.whatsapp.net']);
  assert.deepEqual(chats.addMessages([a], { unreadIncrement: true }), [], 'a duplicate event changes nothing');
  const raw = leads.db.prepare('SELECT body FROM wa_chat_messages').all().map((r) => Buffer.from(r.body).toString('utf8'));
  assert.ok(raw.every((r) => r.startsWith('enc:') && !r.includes('Walaikum')), 'message text is stored encrypted');
  const [c] = chats.listChats();
  assert.equal(c.unread, 1, 'only the incoming message is unread');
  assert.equal(c.lastText, 'Ji, real estate');
  assert.equal(c.lastFromMe, true);
  assert.equal(c.name, 'Zahid');
  assert.equal(c.leadName, 'Zahid Properties');
  assert.deepEqual(chats.messages(c.jid).map((m) => m.text), ['Walaikum assalam', 'Ji, real estate']);
  assert.equal(chats.listChats({ search: 'zahid' }).length, 1);
  assert.equal(chats.listChats({ search: '1234567' }).length, 1);
  assert.equal(chats.listChats({ search: 'nobody' }).length, 0);
  // History sync: not unread, older messages keep the newer preview.
  chats.addMessages([normalizeMessage(msg({ key: { remoteJid: '923001234567@s.whatsapp.net', id: 'OLD', fromMe: false }, messageTimestamp: 1792000000, message: { conversation: 'older' } }))]);
  assert.equal(chats.listChats()[0].lastText, 'Ji, real estate');
  assert.equal(chats.listChats()[0].unread, 1);
  assert.deepEqual(chats.oldestMessage(c.jid), { id: 'OLD', fromMe: false, ts: 1792000000000 });
  assert.ok(chats.setStatus(c.jid, 'A2', 'read'));
  assert.ok(!chats.setStatus(c.jid, 'A2', 'delivered'), 'status never goes backwards');
  chats.markRead(c.jid);
  assert.equal(chats.listChats()[0].unread, 0);
  assert.ok(chats.hasIncomingSince(c.jid, 1792559000000));
  assert.ok(!chats.hasIncomingSince(c.jid, 1792560050000));
  // Metadata alone (a contact) does not create a listed chat.
  chats.upsertChat({ jid: '923007777777@s.whatsapp.net', phone: '+923007777777', name: 'Someone' });
  assert.equal(chats.listChats().length, 1);
  // A database from another computer: text can't be read, nothing crashes.
  const other = new ChatStore(leads.db, { encrypt: cipher.encrypt, decrypt: () => { throw new Error('wrong key'); } });
  assert.equal(other.messages(c.jid)[0].text, null);
});

function fakeClient() {
  const c = new EventEmitter();
  c.state = 'open';
  c.sent = [];
  c.reads = [];
  c.sendToChat = async (jid, text) => (c.sent.push({ jid, text }), { id: `S${c.sent.length}`, ts: 1792560500000 });
  c.markRead = async (jid, ids) => c.reads.push({ jid, ids });
  c.avatar = async () => 'data:image/jpeg;base64,AAAA';
  c.fetchHistory = async (jid, oldest) => (c.history = { jid, oldest });
  return c;
}

test('chat service: live messages, read receipts, sending, older history, avatars', async () => {
  const { chats } = stores();
  const client = fakeClient();
  const svc = new ChatService({ client, store: chats });
  const updates = [];
  const incoming = [];
  const manual = [];
  svc.on('update', (u) => updates.push(u));
  svc.on('incoming', (m) => incoming.push(m));
  svc.on('manual', (m) => manual.push(m));
  client.emit('chat-messages', [normalizeMessage(msg())], { live: true });
  client.emit('chat-messages', [normalizeMessage(msg({ key: { remoteJid: '923001234567@s.whatsapp.net', id: 'H', fromMe: false }, messageTimestamp: 1790000000 }))], { live: false });
  assert.equal(incoming.length, 1, 'history is not treated as new replies');
  assert.equal(updates.length, 2);
  const jid = '923001234567@s.whatsapp.net';
  const opened = await svc.open(jid);
  assert.equal(opened.ok, true);
  assert.equal(opened.messages.length, 2);
  assert.deepEqual(client.reads, [{ jid, ids: ['A1'] }]);
  assert.equal(chats.listChats()[0].unread, 0);
  assert.equal((await svc.send(jid, '  ')).ok, false);
  const sent = await svc.send(jid, 'Ji bilkul');
  assert.equal(sent.ok, true);
  assert.equal(chats.messages(jid).at(-1).text, 'Ji bilkul');
  assert.deepEqual(manual, [{ jid, phone: '+923001234567' }]);
  assert.match((await svc.send(jid, 'again')).error, /Please wait/);
  // The echo from WhatsApp is not stored twice.
  client.emit('chat-messages', [{ ...normalizeMessage(msg()), id: 'S1', fromMe: true, text: 'Ji bilkul', status: 'sent', pushName: null }], { live: true });
  assert.equal(chats.messages(jid).filter((m) => m.id === 'S1').length, 1);
  client.emit('chat-status', [{ jid, id: 'S1', status: 'delivered' }]);
  assert.equal(chats.messages(jid).find((m) => m.id === 'S1').status, 'delivered');
  assert.equal((await svc.loadOlder(jid)).ok, true);
  assert.equal(client.history.oldest.id, 'H');
  svc.list('');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(chats.listChats()[0].avatar, 'data:image/jpeg;base64,AAAA');
  client.state = 'reconnecting';
  assert.match((await svc.send(jid, 'offline')).error, /not connected/);
});

// --- WhatsApp client: Baileys events become chat data --------------------------

function fakeBaileys() {
  const sockets = [];
  const mod = {
    initAuthCreds: () => ({ noiseKey: {} }),
    BufferJSON: {},
    proto: { Message: { AppStateSyncKeyData: { fromObject: (o) => o } } },
    DisconnectReason: { loggedOut: 401, restartRequired: 515, connectionReplaced: 440, forbidden: 403, badSession: 500 },
    Browsers: { appropriate: () => ['Linux', 'Lead Finder', '1'] },
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    makeCacheableSignalKeyStore: (k) => k,
    default: (opts) => {
      const sock = { ev: new EventEmitter(), opts, user: { id: '923000000000:1@s.whatsapp.net', name: 'Me' } };
      sock.end = async () => {};
      sock.signalRepository = { lidMapping: { getPNForLID: async (lid) => (lid === '555@lid' ? '923004445556@s.whatsapp.net' : null) } };
      sockets.push(sock);
      return sock;
    },
  };
  return { mod, sockets };
}

test('WhatsApp client: live messages, history sync, LIDs and receipts reach the chat view', async () => {
  const fake = fakeBaileys();
  const client = new WhatsAppClient({ dir: tmp(), cipher, loadBaileys: async () => fake.mod });
  await client.connect();
  const sock = fake.sockets[0];
  assert.equal(sock.opts.syncFullHistory, false, 'never the full archive');
  assert.equal(sock.opts.shouldSyncHistoryMessage, undefined, 'recent and on-demand history are accepted');
  sock.ev.emit('connection.update', { connection: 'open' });
  const got = [];
  const meta = [];
  const statuses = [];
  client.on('chat-messages', (list, o) => got.push({ list, live: o.live }));
  client.on('chat-meta', (list) => meta.push(...list));
  client.on('chat-status', (list) => statuses.push(...list));
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [msg(), msg({ key: { remoteJid: '555@lid', id: 'L1', fromMe: false } }), msg({ key: { remoteJid: '1@g.us', id: 'G', fromMe: false } })] });
  sock.ev.emit('messaging-history.set', { chats: [{ id: '923001234567@s.whatsapp.net', name: 'Zahid', unreadCount: 2, conversationTimestamp: 1792560000 }], contacts: [{ id: '923001234567@s.whatsapp.net', name: 'Zahid Bhai', notify: 'Zahid' }], messages: [msg({ key: { remoteJid: '923001234567@s.whatsapp.net', id: 'H1', fromMe: true }, status: 4 })] });
  sock.ev.emit('messages.update', [{ key: { remoteJid: '923001234567@s.whatsapp.net', id: 'H1', fromMe: true }, update: { status: 3 } }]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(got[0].live, true);
  assert.deepEqual(got[0].list.map((m) => [m.jid, m.phone]), [
    ['923001234567@s.whatsapp.net', '+923001234567'],
    ['923004445556@s.whatsapp.net', '+923004445556'],
  ], 'the LID chat is filed under the phone number; the group is skipped');
  assert.equal(got[1].live, false, 'history sync');
  assert.equal(got[1].list[0].status, 'read');
  assert.ok(meta.some((m) => m.name === 'Zahid Bhai' && m.phone === '+923001234567'));
  assert.ok(meta.some((m) => m.unread === 2));
  assert.deepEqual(statuses, [{ jid: '923001234567@s.whatsapp.net', id: 'H1', status: 'delivered' }]);
});

test('migration from version 3 (through 4, 5 and 6) keeps existing leads and settings', () => {
  const dir = tmp();
  const file = path.join(dir, 'leads.db');
  const v3 = new LeadStore(file);
  const cat = v3.ensureCategory('Real Estate');
  v3.save({ placeKey: '0x9:0x9', mapsUrl: 'https://www.google.com/maps/place/K', name: 'Kept Estate', phoneRaw: '03001112223', address: 'Lahore', websiteStatus: 'no_website', categoryId: cat.id });
  v3.setState('theme', { mode: 'dark' });
  // Turn it back into a version 3 database.
  v3.db.exec('DROP TABLE wa_chats; DROP TABLE wa_chat_messages; DROP TABLE outreach_contacts; DROP TABLE outreach_sends; DROP TABLE outreach_optouts; PRAGMA user_version = 3;');
  v3.close();
  const v4 = new LeadStore(file);
  assert.equal(v4.db.prepare('PRAGMA user_version').get().user_version, 11, 'upgraded through version 4 to the current version');
  assert.deepEqual(v4.listLeads({}).map((l) => l.name), ['Kept Estate']);
  assert.deepEqual(v4.getState('theme'), { mode: 'dark' });
  assert.equal(v4.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('wa_chats','wa_chat_messages','outreach_contacts','outreach_sends','outreach_optouts')").get().n, 5);
  v4.close();
});
