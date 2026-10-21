'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { AppLock } = require('../src/main/applock');
const { LeadStore } = require('../src/database/db');

const key = crypto.randomBytes(32);
const cipher = {
  encrypt: (t) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const e = Buffer.concat([c.update(t, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), e]);
  },
  decrypt: (b) => {
    const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  },
};

test('first launch: create a 4-digit PIN with confirmation; never stored in plain text', () => {
  const store = new LeadStore(':memory:');
  const lock = new AppLock({ store, cipher });
  assert.deepEqual(lock.state().configured, false);
  assert.throws(() => lock.setup('123', '123'), /exactly four digits/);
  assert.throws(() => lock.setup('12a4', '12a4'), /exactly four digits/);
  assert.throws(() => lock.setup('12345', '12345'), /exactly four digits/);
  assert.throws(() => lock.setup('1234', '1235'), /do not match/);
  lock.setup('4821', '4821');
  assert.equal(lock.state().unlocked, true);
  const raw = JSON.stringify(store.getState('app_lock'));
  assert.ok(!raw.includes('4821'));
  assert.equal(store.getState('app_lock').encrypted, true, 'record encrypted with the keychain');
  assert.throws(() => lock.setup('1111', '1111'), /already set/);
});

test('restart = locked again; only the right PIN unlocks; wrong tries lock out', () => {
  const store = new LeadStore(':memory:');
  new AppLock({ store, cipher }).setup('4821', '4821');
  let t = 1_000_000;
  const lock = new AppLock({ store, cipher, now: () => t }); // a new process
  assert.equal(lock.state().unlocked, false);
  assert.match(lock.unlock('48211').error, /exactly four digits/);
  for (let i = 0; i < 4; i++) assert.equal(lock.unlock('0000').ok, false);
  const fifth = lock.unlock('1111');
  assert.equal(fifth.retryAfterMs, 30_000);
  assert.match(lock.unlock('4821').error, /wait/, 'even the right PIN waits out the lockout');
  t += 30_001;
  assert.equal(lock.unlock('2222').retryAfterMs, 60_000, 'lockouts grow');
  t += 60_001;
  assert.equal(lock.unlock('4821').ok, true);
  assert.equal(lock.state().failures, 0);
  // The lockout persists across restarts.
  const again = new AppLock({ store, cipher, now: () => t });
  for (let i = 0; i < 5; i++) again.unlock('9999');
  assert.ok(new AppLock({ store, cipher, now: () => t }).state().retryAfterMs > 0);
});

test('change PIN after unlocking', () => {
  const store = new LeadStore(':memory:');
  const lock = new AppLock({ store, cipher });
  lock.setup('4821', '4821');
  assert.throws(() => lock.change('0000', '1357', '1357'), /current PIN is incorrect/);
  assert.equal(lock.state().failures, 1, 'wrong current PIN counts as a failed attempt');
  assert.throws(() => lock.change('4821', '1357', '1358'), /do not match/);
  lock.change('4821', '1357', '1357');
  const next = new AppLock({ store, cipher });
  assert.equal(next.unlock('4821').ok, false);
  assert.equal(next.unlock('1357').ok, true);
  const locked = new AppLock({ store, cipher });
  assert.throws(() => locked.change('1357', '2468', '2468'), /Unlock first/);
});

test('without a keychain the PIN is still only stored as a salted scrypt hash', () => {
  const store = new LeadStore(':memory:');
  new AppLock({ store, cipher: null }).setup('4821', '4821');
  const rec = store.getState('app_lock');
  assert.equal(rec.encrypted, false);
  assert.ok(!JSON.stringify(rec).includes('4821'));
  assert.equal(Buffer.from(rec.data.hash, 'base64').length, 32);
  assert.equal(new AppLock({ store, cipher: null }).unlock('4821').ok, true);
});
