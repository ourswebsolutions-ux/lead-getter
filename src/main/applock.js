'use strict';

// Four-digit application lock. The PIN is hashed with scrypt (random salt)
// and the record is additionally encrypted with the OS keychain when one is
// available, because 10,000 possible PINs would otherwise be quick to try
// offline. Failed attempts trigger growing lockouts. The main process keeps
// every other function blocked until unlock() succeeds.

const crypto = require('node:crypto');

const PIN_RE = /^\d{4}$/;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const FREE_ATTEMPTS = 5;

const hash = (pin, salt) => crypto.scryptSync(pin, salt, 32, SCRYPT);

class AppLock {
  constructor({ store, cipher, now = () => Date.now() }) {
    this.store = store;
    this.cipher = cipher;
    this.now = now;
    this.unlocked = false;
  }

  record() {
    const raw = this.store.getState('app_lock');
    if (!raw) return null;
    if (raw.encrypted) {
      if (!this.cipher) throw new Error('The PIN record is encrypted but the system keychain is unavailable.');
      return JSON.parse(this.cipher.decrypt(Buffer.from(raw.data, 'base64')));
    }
    return raw.data;
  }

  save(rec) {
    this.store.setState('app_lock', this.cipher ? { encrypted: true, data: this.cipher.encrypt(JSON.stringify(rec)).toString('base64') } : { encrypted: false, data: rec });
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

  verify(pin) {
    const rec = this.record();
    if (!rec || !PIN_RE.test(String(pin))) return false;
    return crypto.timingSafeEqual(hash(pin, Buffer.from(rec.salt, 'base64')), Buffer.from(rec.hash, 'base64'));
  }

  unlock(pin) {
    const a = this.attempts();
    if (a.lockedUntil > this.now()) return { ok: false, error: 'Too many wrong attempts. Please wait.', retryAfterMs: a.lockedUntil - this.now() };
    if (!PIN_RE.test(String(pin))) return { ok: false, error: 'Enter exactly four digits.' };
    if (this.verify(pin)) {
      this.store.setState('app_lock_attempts', { failures: 0, lockedUntil: 0 });
      this.unlocked = true;
      return { ok: true };
    }
    const { failures, lockedUntil } = this.recordFailure();
    return { ok: false, error: 'Incorrect PIN.', retryAfterMs: Math.max(0, lockedUntil - this.now()), attemptsLeft: Math.max(0, FREE_ATTEMPTS - failures) };
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

module.exports = { AppLock, PIN_RE };
