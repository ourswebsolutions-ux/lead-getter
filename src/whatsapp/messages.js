'use strict';

// Turns Baileys message objects into the small records the chat view and the
// outreach campaign use. Only one-to-one chats are handled: groups,
// broadcasts, status updates and newsletters are skipped.

const PERSON = /@(s\.whatsapp\.net|lid)$/;

// Baileys' WebMessageInfo status values (proto.WebMessageInfo.Status).
const STATUS = { 0: 'failed', 1: 'pending', 2: 'sent', 3: 'delivered', 4: 'read', 5: 'read' };
const STATUS_RANK = { pending: 1, sent: 2, delivered: 3, read: 4, failed: 0 };

function isPersonJid(jid) {
  return PERSON.test(String(jid || ''));
}

// '+923001234567' for a phone-number JID; null for a privacy ID (LID).
function phoneOfJid(jid) {
  const m = String(jid || '').match(/^(\d{6,15})(?::\d+)?@s\.whatsapp\.net$/);
  return m ? `+${m[1]}` : null;
}

function jidOfPhone(e164) {
  return `${String(e164).replace(/^\+/, '')}@s.whatsapp.net`;
}

function toMs(ts) {
  if (ts == null) return null;
  const n = typeof ts === 'object' && typeof ts.toNumber === 'function' ? ts.toNumber() : Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n; // Baileys uses seconds
}

// Unwraps ephemeral / view-once / edited containers.
function inner(message) {
  let m = message;
  for (let i = 0; m && i < 5; i++) {
    const next = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.viewOnceMessageV2Extension?.message || m.documentWithCaptionMessage?.message || m.editedMessage?.message;
    if (!next) break;
    m = next;
  }
  return m || null;
}

// { kind, text } for displayable content; null for protocol messages,
// reactions, receipts and other things that aren't chat messages.
function contentOf(message) {
  const m = inner(message);
  if (!m) return null;
  if (typeof m.conversation === 'string' && m.conversation) return { kind: 'text', text: m.conversation };
  if (m.extendedTextMessage?.text) return { kind: 'text', text: m.extendedTextMessage.text };
  const media = [
    ['imageMessage', 'image', 'Photo'],
    ['videoMessage', 'video', 'Video'],
    ['audioMessage', 'audio', 'Voice message'],
    ['documentMessage', 'document', 'Document'],
    ['stickerMessage', 'sticker', 'Sticker'],
    ['contactMessage', 'contact', 'Contact'],
    ['locationMessage', 'location', 'Location'],
    ['liveLocationMessage', 'location', 'Live location'],
  ];
  for (const [field, kind, label] of media) {
    const x = m[field];
    if (!x) continue;
    const extra = x.caption || x.fileName || x.displayName || x.name || '';
    return { kind, text: extra ? `${label}: ${extra}` : label };
  }
  if (m.buttonsResponseMessage?.selectedDisplayText) return { kind: 'text', text: m.buttonsResponseMessage.selectedDisplayText };
  if (m.listResponseMessage?.title) return { kind: 'text', text: m.listResponseMessage.title };
  if (m.templateMessage || m.interactiveMessage || m.buttonsMessage || m.listMessage) return { kind: 'other', text: 'Interactive message' };
  return null; // protocol, reaction, senderKeyDistribution, pollUpdate, ...
}

// Normalizes one Baileys WebMessageInfo. Returns null when it isn't a
// displayable one-to-one message.
function normalizeMessage(msg) {
  const key = msg?.key || {};
  let jid = key.remoteJid;
  if (!isPersonJid(jid)) return null;
  const content = contentOf(msg.message);
  if (!content) return null;
  const ts = toMs(msg.messageTimestamp);
  if (!key.id || !ts) return null;
  // Baileys 7 gives the phone-number JID next to a privacy ID when known.
  const alt = key.remoteJidAlt || key.senderPn || null;
  const phone = phoneOfJid(jid) || phoneOfJid(alt);
  return {
    jid,
    id: String(key.id),
    fromMe: Boolean(key.fromMe),
    phone,
    pushName: !key.fromMe && typeof msg.pushName === 'string' && msg.pushName.trim() ? msg.pushName.trim().slice(0, 80) : null,
    ts,
    kind: content.kind,
    text: String(content.text).slice(0, 4000),
    status: key.fromMe ? STATUS[msg.status] || 'sent' : null,
  };
}

// For messages.update: { jid, id, status } when the update carries a
// delivery status of one of our own messages.
function normalizeStatus(update) {
  const key = update?.key || {};
  const status = STATUS[update?.update?.status];
  if (!isPersonJid(key.remoteJid) || !key.id || !status || !key.fromMe) return null;
  return { jid: key.remoteJid, id: String(key.id), status };
}

// A status never goes backwards (e.g. 'read' then a late 'delivered').
function laterStatus(current, next) {
  if (!current) return next;
  if (next === 'failed') return current === 'pending' ? 'failed' : current;
  return (STATUS_RANK[next] || 0) > (STATUS_RANK[current] || 0) ? next : current;
}

module.exports = { normalizeMessage, normalizeStatus, laterStatus, isPersonJid, phoneOfJid, jidOfPhone, toMs, contentOf };
