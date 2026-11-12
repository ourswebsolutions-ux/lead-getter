'use strict';

// Four-digit application lock. The PIN is hashed with scrypt (random salt)
// and the record is additionally encrypted with the OS keychain when one is
// available, because 10,000 possible PINs would otherwise be quick to try
// offline. Failed attempts trigger growing lockouts. The main process keeps
// every other function blocked until unlock() succeeds.
//
// Forgotten PIN: requestReset() makes a random four-digit PIN and has it
// emailed to the administrator only (never shown here). The user gets it from
// the administrator and enters it like any PIN: it then becomes their PIN.
// Until then the old PIN still works (and using it cancels the reset). A reset
// PIN lasts 24 hours, is kept only as a salted hash, and is guessed under the
// same limiter as the PIN; requests are limited so the administrator is never
// flooded.

const crypto = require('node:crypto');

const PIN_RE = /^\d{4}$/;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const FREE_ATTEMPTS = 5;
const RESET_TTL = 24 * 60 * 60_000;
const RESET_GAP = 60_000; // between two reset requests
const RESET_PER_DAY = 5;

const hash = (pin, salt) => crypto.scryptSync(pin, salt, 32, SCRYPT);

class AppLock {
  constructor({ store, cipher, now = () => Date.now() }) {
    this.store = store;
    this.cipher = cipher;
    this.now = now;
    this.unlocked = false;
  }

  record(key = 'app_lock') {
    const raw = this.store.getState(key);
    if (!raw) return null;
    if (raw.encrypted) {
      if (!this.cipher) throw new Error('The PIN record is encrypted but the system keychain is unavailable.');
      return JSON.parse(this.cipher.decrypt(Buffer.from(raw.data, 'base64')));
    }
    return raw.data;
  }

  save(rec, key = 'app_lock') {
    this.store.setState(key, this.cipher ? { encrypted: true, data: this.cipher.encrypt(JSON.stringify(rec)).toString('base64') } : { encrypted: false, data: rec });
  }

  attempts() {
    return this.store.getState('app_lock_attempts') || { failures: 0, lockedUntil: 0 };
  }

  state() {
    const a = this.attempts();
    const wait = Math.max(0, a.lockedUntil - this.now());
    return { configured: Boolean(this.store.getState('app_lock')), unlocked: this.unlocked, retryAfterMs: wait, failures: a.failures };
  }

  setup(pin, confirm) {
    if (this.store.getState('app_lock')) throw new Error('A PIN is already set.');
    check(pin, confirm);
    const salt = crypto.randomBytes(16);
    this.save({ v: 1, salt: salt.toString('base64'), hash: hash(pin, salt).toString('base64') });
    this.unlocked = true;
    return this.state();
  }

  verify(pin, rec = this.record()) {
    if (!rec || !PIN_RE.test(String(pin))) return false;
    return crypto.timingSafeEqual(hash(pin, Buffer.from(rec.salt, 'base64')), Buffer.from(rec.hash, 'base64'));
  }

  // The reset PIN waiting to be entered, if it is still valid.
  pendingReset() {
    const rec = this.record('app_lock_reset');
    return rec && rec.expiresAt > this.now() ? rec : null;
  }

  // send(pin, expiresAt): emails the new PIN to the administrator; throws when
  // it could not (nothing is kept then, and the request is not counted).
  async requestReset(send) {
    if (!this.store.getState('app_lock')) return { ok: false, error: 'No PIN is set yet.' };
    const now = this.now();
    const times = (this.store.getState('app_lock_resets') || []).filter((t) => t > now - 24 * 60 * 60_000 && t <= now);
    const wait = times.length ? times[times.length - 1] + RESET_GAP - now : 0;
    if (wait > 0) return { ok: false, error: `Please wait ${Math.ceil(wait / 1000)} seconds before asking again.` };
    if (times.length >= RESET_PER_DAY) return { ok: false, error: 'Too many reset requests today. Please contact the administrator.' };
    const pin = String(crypto.randomInt(10_000)).padStart(4, '0');
    const expiresAt = now + RESET_TTL;
    await send(pin, expiresAt);
    const salt = crypto.randomBytes(16);
    // Replaces (and so cancels) any earlier reset PIN.
    this.save({ v: 1, salt: salt.toString('base64'), hash: hash(pin, salt).toString('base64'), expiresAt }, 'app_lock_reset');
    this.store.setState('app_lock_resets', [...times, now]);
    return { ok: true, expiresAt: new Date(expiresAt).toISOString() };
  }

  unlock(pin) {
    const a = this.attempts();
    if (a.lockedUntil > this.now()) return { ok: false, error: 'Too many wrong attempts. Please wait.', retryAfterMs: a.lockedUntil - this.now() };
    if (!PIN_RE.test(String(pin))) return { ok: false, error: 'Enter exactly four digits.' };
    if (this.verify(pin)) {
      this.store.setState('app_lock_attempts', { failures: 0, lockedUntil: 0 });
      this.store.setState('app_lock_reset', null); // remembered: the reset is not needed
      this.unlocked = true;
      return { ok: true };
    }
    if (this.verify(pin, this.pendingReset())) {
      // The administrator's PIN becomes the user's PIN.
      this.save(this.record('app_lock_reset'));
      this.store.setState('app_lock_reset', null);
      this.store.setState('app_lock_attempts', { failures: 0, lockedUntil: 0 });
      this.unlocked = true;
      return { ok: true, reset: true };
    }
    const { failures, lockedUntil } = this.recordFailure();
    return { ok: false, error: 'Incorrect PIN.', retryAfterMs: Math.max(0, lockedUntil - this.now()), attemptsLeft: Math.max(0, FREE_ATTEMPTS - failures) };
  }

  // The PIN checked for something other than unlocking (the WhatsApp admin),
  // under the same limiter; the app's lock state does not change.
  checkPin(pin) {
    const a = this.attempts();
    if (a.lockedUntil > this.now()) return { ok: false, error: 'Too many wrong PINs. Please wait and try again.' };
    if (!PIN_RE.test(String(pin))) return { ok: false, error: 'Send "admin" and your four-digit Lead Finder PIN.' };
    if (this.verify(pin)) {
      this.store.setState('app_lock_attempts', { failures: 0, lockedUntil: 0 });
      return { ok: true };
    }
    this.recordFailure();
    return { ok: false, error: 'That is not the Lead Finder PIN.' };
  }

  // 5 free tries, then 30 s, 60 s, 2 min … up to 15 min between tries.
  recordFailure() {
    const failures = this.attempts().failures + 1;
    const lockedUntil = failures >= FREE_ATTEMPTS ? this.now() + Math.min(30_000 * 2 ** (failures - FREE_ATTEMPTS), 15 * 60_000) : 0;
    this.store.setState('app_lock_attempts', { failures, lockedUntil });
    return { failures, lockedUntil };
  }

  change(current, next, confirm) {
    if (!this.unlocked) throw new Error('Unlock first.');
    const a = this.attempts();
    if (a.lockedUntil > this.now()) throw new Error('Too many wrong attempts. Please wait.');
    if (!this.verify(current)) {
      this.recordFailure(); // same limiter as unlocking
      throw new Error('The current PIN is incorrect.');
    }
    this.store.setState('app_lock_attempts', { failures: 0, lockedUntil: 0 });
    check(next, confirm);
    const salt = crypto.randomBytes(16);
    this.save({ v: 1, salt: salt.toString('base64'), hash: hash(next, salt).toString('base64') });
    this.store.setState('app_lock_reset', null);
    return { ok: true };
  }

  lock() {
    this.unlocked = false;
  }
}

function check(pin, confirm) {
  if (!PIN_RE.test(String(pin))) throw new Error('The PIN must be exactly four digits.');
  if (pin !== confirm) throw new Error('The two PINs do not match.');
}

module.exports = { AppLock, PIN_RE, RESET_TTL, RESET_GAP, RESET_PER_DAY };
