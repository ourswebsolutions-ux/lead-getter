'use strict';

// Admin email commands that cancel a subscription: the rules, with no
// network, so they can be tested. cancellations.js connects them to the inbox.

const crypto = require('node:crypto');
const { simpleParser } = require('mailparser');
const { dkimVerify } = require('mailauth/lib/dkim/verify');
const { hashId, signedBytes } = require('../../src/main/cancellations');

const SUBJECT = 'Subscription Cancellation';
const COMMAND = /^[ \t]*Activation ID:[ \t]*(LF-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})[ \t]*\(stop\)[ \t]*$/gm;
const MAX_SEEN = 5000;
const CLOCK_MARGIN = 60 * 60 * 1000;

// The exact command in the body. The subject alone never cancels anything.
function parseCommand({ subject, text }) {
  if (String(subject || '').trim() !== SUBJECT) return { error: 'the subject is not "Subscription Cancellation"' };
  const ids = [...String(text || '').matchAll(COMMAND)].map((m) => m[1]);
  if (!ids.length) return { error: 'no line "Activation ID: LF-XXXX-XXXX-XXXX (stop)" in the body' };
  if (new Set(ids).size > 1) return { error: 'more than one Activation ID in the body' };
  return { id: ids[0] };
}

// A From address can be forged, and so can any header stored in the mailbox:
// its login is built into the app (SMTP), so someone who extracts it could
// plant a message there with whatever headers they like. So the proof is the
// DKIM signature itself, checked here against the sender's published key. A
// signed From means the mail really left the administrator's account. It is
// checked as of the day the mail arrived, because Gmail's signatures expire
// after about a week and a late run must not refuse a genuine command.
async function trustedSender({ source, date, adminEmail, resolver }) {
  const admin = String(adminEmail).toLowerCase();
  const domain = admin.split('@')[1];
  const curTime = new Date(new Date(date).getTime() + CLOCK_MARGIN);
  const { fromFields, headerFrom, results } = await dkimVerify(source, { curTime, ...(resolver ? { resolver } : {}) });
  // One From header only: an extra one could hide the address that was signed.
  if (fromFields !== 1 || headerFrom.length !== 1 || String(headerFrom[0]).toLowerCase() !== admin) return { ok: false, reason: 'not from the administrator address' };
  const own = results.filter((r) => String(r.signingDomain).toLowerCase() === domain);
  const genuine = own.some((r) => r.status?.result === 'pass' && r.canonBodyLengthLimit === undefined && r.signingHeaders?.keys.split(/[:\s]+/).some((k) => k.toLowerCase() === 'from'));
  if (genuine) return { ok: true };
  // The key could not be fetched: not a verdict. The run fails and is repeated.
  if (own.some((r) => r.status?.result === 'temperror')) throw Object.assign(new Error('DKIM key lookup failed'), { code: 'DKIM_LOOKUP' });
  return { ok: false, reason: 'the sender address failed DKIM verification' };
}

function sign(doc, privateKey) {
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  return crypto.sign(null, signedBytes(doc), key).toString('base64');
}

function newKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') };
}

const messageKey = (m, parsed) => crypto.createHash('sha256').update(parsed.messageId || m.source).digest('hex').slice(0, 32);

// mailbox: { commands() -> [{ source, date }], known(activationId) };
// state: the published list, or null. Returns { state, changed, events }:
// each email is handled once, so a repeated run does nothing. events:
// [{ at, result: 'cancelled' | 'ignored' | 'refused', activationId, reason }].
async function processCommands({ mailbox, state, adminEmail, privateKey, resolver, now = Date.now() }) {
  const seen = new Set(state?.seen || []);
  const entries = new Map((state?.entries || []).map((e) => [e.id, e]));
  const events = [];
  let changed = false;
  for (const m of await mailbox.commands()) {
    const parsed = await simpleParser(m.source);
    // The inbox search also finds replies and this job's own notices.
    if (String(parsed.subject || '').trim() !== SUBJECT) continue;
    const key = messageKey(m, parsed);
    if (seen.has(key)) continue;
    const sender = await trustedSender({ source: m.source, date: m.date || now, adminEmail, resolver });
    seen.add(key);
    changed = true;
    const at = new Date(now).toISOString();
    if (!sender.ok) {
      events.push({ at, result: 'refused', reason: sender.reason });
      continue;
    }
    const cmd = parseCommand({ subject: parsed.subject, text: parsed.text });
    if (cmd.error) {
      events.push({ at, result: 'ignored', reason: cmd.error });
      continue;
    }
    if (!(await mailbox.known(cmd.id))) {
      events.push({ at, result: 'ignored', activationId: cmd.id, reason: 'no activation or trial email for this Activation ID was found in the Sent mail' });
      continue;
    }
    const id = hashId(cmd.id);
    const when = new Date(m.date || now).getTime();
    entries.set(id, { id, at: Math.max(when, entries.get(id)?.at || 0) });
    events.push({ at, result: 'cancelled', activationId: cmd.id });
  }
  if (!changed) return { state, changed: false, events };
  const doc = { issuedAt: now, entries: [...entries.values()], seen: [...seen].slice(-MAX_SEEN) };
  return { state: { ...doc, sig: sign(doc, privateKey) }, changed: true, events };
}

module.exports = { SUBJECT, parseCommand, trustedSender, sign, newKeys, processCommands };
