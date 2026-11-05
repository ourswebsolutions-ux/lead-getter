'use strict';

// Cancelling a customer's subscription by an email from the administrator.
//
// The administrator's mailbox is never opened by this app: a mailbox login
// inside every installed copy could be extracted, and it would give anyone
// the activation codes in that inbox. tools/activation/cancellations.js reads
// the inbox with credentials only it has, and publishes a list of cancelled
// Activation IDs, signed with a key only it has. Each copy of the app reads
// that list (it needs no login) and checks the signature with the public key
// in activation-config.json.
//
// Published: { issuedAt, entries: [{ id: <hash of the Activation ID>, at }], sig, seen }.
// The IDs are hashed because the list is public. `seen` is the publisher's own
// record of the emails it has handled, and isn't signed.

const crypto = require('node:crypto');

const POLL_EVERY = 10 * 60 * 1000;
const FIRST_POLL = 5000;
const TIMEOUT = 15_000;
const MAX_BYTES = 2_000_000;

const hashId = (activationId) => crypto.createHash('sha256').update(`lead-finder-cancel:${activationId}`).digest('hex');
const signedBytes = (doc) => Buffer.from(JSON.stringify({ issuedAt: doc.issuedAt, entries: doc.entries }));

function validList(doc, publicKey) {
  if (!doc || !Number.isFinite(doc.issuedAt) || !Array.isArray(doc.entries) || typeof doc.sig !== 'string') return false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, signedBytes(doc), key, Buffer.from(doc.sig, 'base64'));
  } catch {
    return false;
  }
}

class CancellationPoller {
  // config: { url, publicKey }; activation: applyCancellations(entries);
  // onCancelled(): the plan was just cancelled; state: { get, set } (app_state).
  constructor({ config, activation, onCancelled = () => {}, state, fetchImpl = globalThis.fetch, clock = () => Date.now(), interval = POLL_EVERY }) {
    Object.assign(this, { config, activation, onCancelled, state, fetchImpl, clock, interval });
    this.timers = [];
  }

  get enabled() {
    return Boolean(this.config?.url && this.config?.publicKey);
  }

  // One check. A failed one changes nothing: the next one tries again.
  async check() {
    if (!this.enabled) return false;
    try {
      // The address changes every 5 minutes, past GitHub's cache.
      const url = `${this.config.url}?t=${Math.floor(this.clock() / 300_000)}`;
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT), headers: { accept: 'application/json' } });
      if (!res.ok) return false;
      const text = await res.text();
      if (text.length > MAX_BYTES) return false;
      const doc = JSON.parse(text);
      if (!validList(doc, this.config.publicKey)) return false;
      // An older list is never used in place of a newer one.
      if (doc.issuedAt < (this.state.get('activation.cancellationsAt') || 0)) return false;
      this.state.set('activation.cancellationsAt', doc.issuedAt);
      const cancelled = this.activation.applyCancellations(doc.entries);
      if (cancelled) this.onCancelled();
      return cancelled;
    } catch {
      return false;
    }
  }

  start() {
    if (!this.enabled || this.timers.length) return;
    const first = setTimeout(() => this.check(), FIRST_POLL);
    const every = setInterval(() => this.check(), this.interval);
    first.unref?.();
    every.unref?.();
    this.timers = [first, every];
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}

module.exports = { CancellationPoller, hashId, signedBytes, validList };
