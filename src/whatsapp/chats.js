'use strict';

// The chat view's data: everything comes from the linked WhatsApp account
// (live messages, the history WhatsApp syncs to a linked device, older
// messages on request, delivery receipts). Nothing is generated locally.

const { EventEmitter } = require('node:events');
const { isPersonJid } = require('./messages');

const AVATAR_TTL = 7 * 24 * 60 * 60 * 1000;
const AVATAR_GAP = 2000; // one profile picture request at a time, spaced out

class ChatService extends EventEmitter {
  // client: WhatsAppClient; store: ChatStore.
  constructor({ client, store, clock = () => Date.now() }) {
    super();
    Object.assign(this, { client, store, clock });
    this.avatarQueue = [];
    this.avatarBusy = false;
    this.lastSendAt = 0;
    client.on('chat-messages', (list, { live }) => this.onMessages(list, live));
    client.on('chat-meta', (list) => this.onMeta(list));
    client.on('chat-status', (list) => this.onStatus(list));
  }

  onMessages(list, live) {
    const changed = this.store.addMessages(list, { unreadIncrement: live });
    if (changed.length) this.emit('update', { jids: changed });
    // New incoming messages (not history) go to the outreach campaign:
    // replies pause it, opt-outs stop it.
    if (live) for (const m of list) if (!m.fromMe) this.emit('incoming', m);
  }

  onMeta(list) {
    for (const c of list) this.store.upsertChat({ jid: c.jid, phone: c.phone, name: c.name, unread: c.unread ?? null, lastTs: c.lastTs ?? null });
    this.emit('update', { jids: list.map((c) => c.jid) });
  }

  onStatus(list) {
    const changed = [];
    for (const s of list) {
      if (this.store.setStatus(s.jid, s.id, s.status)) changed.push(s.jid);
      this.emit('status', s);
    }
    if (changed.length) this.emit('update', { jids: changed });
  }

  list(search) {
    const chats = this.store.listChats({ search });
    // Fetch missing or old profile pictures in the background.
    for (const c of chats.slice(0, 40)) if (!c.avatarCheckedAt || this.clock() - c.avatarCheckedAt > AVATAR_TTL) this.queueAvatar(c.jid);
    return chats;
  }

  queueAvatar(jid) {
    if (this.avatarQueue.includes(jid)) return;
    this.avatarQueue.push(jid);
    this.pumpAvatars();
  }

  async pumpAvatars() {
    if (this.avatarBusy) return;
    this.avatarBusy = true;
    try {
      while (this.avatarQueue.length && this.client.state === 'open') {
        const jid = this.avatarQueue.shift();
        let avatar = null;
        try {
          avatar = await this.client.avatar(jid);
        } catch {
          continue; // try again another time
        }
        this.store.setAvatar(jid, avatar, this.clock());
        this.emit('update', { jids: [jid] });
        await new Promise((r) => setTimeout(r, AVATAR_GAP));
      }
    } finally {
      this.avatarBusy = false;
    }
  }

  messages(jid) {
    return this.store.messages(jid, { limit: 300 });
  }

  // Opening a chat: clear its unread count and send read receipts.
  async open(jid) {
    const chat = this.store.chat(jid);
    if (!chat) return { ok: false, error: 'That chat is no longer available.' };
    if (chat.unread > 0) {
      this.store.markRead(jid);
      this.emit('update', { jids: [jid] });
      if (this.client.state === 'open') this.client.markRead(jid, this.store.unreadIncoming(jid, Math.min(chat.unread, 50))).catch(() => {});
    }
    return { ok: true, chat: this.store.chat(jid), messages: this.messages(jid), canLoadOlder: Boolean(this.store.oldestMessage(jid)) };
  }

  // Asks WhatsApp for older messages of this chat. They are added when (and
  // if) the phone sends them.
  async loadOlder(jid) {
    const oldest = this.store.oldestMessage(jid);
    if (!oldest) return { ok: false, error: 'There are no messages to continue from.' };
    try {
      await this.client.fetchHistory(jid, oldest);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.code === 'not_connected' ? 'WhatsApp is not connected.' : `WhatsApp did not send older messages (${String(err.message).split('\n')[0]}).` };
    }
  }

  async send(jid, rawText, { minInterval = 3000 } = {}) {
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (!isPersonJid(jid)) return { ok: false, error: 'Only one-to-one chats are supported.' };
    if (!text) return { ok: false, error: 'Write a message first.' };
    if (text.length > 4000) return { ok: false, error: 'The message is too long (4000 characters maximum).' };
    if (this.client.state !== 'open') return { ok: false, error: 'WhatsApp is not connected.' };
    const wait = minInterval - (this.clock() - this.lastSendAt);
    if (wait > 0) return { ok: false, error: `Please wait ${Math.ceil(wait / 1000)}s before sending another message.` };
    this.lastSendAt = this.clock();
    try {
      const { id, ts } = await this.client.sendToChat(jid, text);
      // WhatsApp also echoes it as a message event; the store keeps one copy.
      const chat = this.store.chat(jid);
      this.store.addMessages([{ jid, id, fromMe: true, phone: chat?.phone ?? null, pushName: null, ts, kind: 'text', text, status: 'sent' }]);
      this.emit('update', { jids: [jid] });
      this.emit('manual', { jid, phone: chat?.phone ?? null });
      return { ok: true, id };
    } catch (err) {
      return { ok: false, error: `WhatsApp did not accept the message: ${String(err?.message || err).split('\n')[0]}` };
    }
  }
}

module.exports = { ChatService };
