'use strict';

// The subscription on this computer, from the 4-digit activation code the
// customer entered (see activation-code.js). No server: the code is checked
// here against this computer's Activation ID, the plan chosen, the days it
// is valid and the codes already used here.
//
// Stored in the lead database's app_state (kept across restarts and
// updates): 'activation' { plan, startedAt, expiresAt, day, mac },
// 'activation.used', 'activation.attempts' (wrong codes, for the lockout),
// 'activation.seen' (the latest time seen, so turning the clock back
// doesn't bring a plan back) and 'activation.salt' (only on computers
// without a machine id).
//
// Limits, stated plainly: all of this runs on the customer's computer with a
// secret built into the app. It stops guessing and code sharing, not someone
// who extracts the secret or modifies the app.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { PLANS, CODE_RE, activationIdFor, addMonths, matchCode } = require('./activation-code');

const DAY = 86_400_000;
const CLOCK_SLACK = 60 * 60 * 1000;
const MAX_TRIES = 5;
const LOCK_MS = 15 * 60 * 1000;

function readMachineId() {
  try {
    if (process.platform === 'linux') {
      for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
      }
    } else if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      return (out.match(/MachineGuid\s+REG_SZ\s+(\S+)/) || [])[1] || '';
    } else if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 5000 });
      return (out.match(/"IOPlatformUUID" = "([^"]+)"/) || [])[1] || '';
    }
  } catch {}
  return '';
}

class Activation {
  // config: { secret (base64), contact: { whatsapp, phone } }.
  constructor({ store, config, machineId = readMachineId, clock = () => Date.now() }) {
    this.store = store;
    this.config = config || {};
    this.clock = clock;
    this.netOffset = null;
    const secret = Buffer.from(String(this.config.secret || ''), 'base64');
    this.secret = secret.length >= 16 ? secret : null;
    let seed = typeof machineId === 'function' ? machineId() : machineId;
    if (!seed) {
      seed = store.getState('activation.salt');
      if (!seed) store.setState('activation.salt', (seed = crypto.randomBytes(16).toString('hex')));
    }
    this.activationId = activationIdFor(seed);
  }

  // The time used for codes and plan ends: never earlier than the latest
  // time this app has seen, and the network's time when it is known.
  now() {
    const seen = this.store.getState('activation.seen') || 0;
    const t = this.netOffset !== null ? this.clock() + this.netOffset : Math.max(this.clock(), seen);
    if (t > seen + 60_000) this.store.setState('activation.seen', t);
    return t;
  }

  // The current time from a trusted source (the Date of an HTTPS answer).
  setNetworkTime(serverMs, receivedAt = this.clock()) {
    if (!Number.isFinite(serverMs)) return;
    this.netOffset = serverMs - receivedAt;
    const t = this.clock() + this.netOffset;
    // A clock that was set too far ahead must not keep a plan ended.
    if ((this.store.getState('activation.seen') || 0) > t + CLOCK_SLACK) this.store.setState('activation.seen', t);
  }

  mac(rec) {
    return crypto.createHmac('sha256', this.secret).update(JSON.stringify([this.activationId, rec.plan, rec.startedAt, rec.expiresAt, rec.day])).digest('base64');
  }

  // The stored plan, if it is genuine and for this computer (a database
  // edited by hand, or copied from another computer, gives none).
  current() {
    const rec = this.store.getState('activation');
    if (!rec || !this.secret || !PLANS.some((p) => p.id === rec.plan)) return null;
    const want = Buffer.from(this.mac(rec));
    const got = Buffer.from(String(rec.mac || ''));
    return want.length === got.length && crypto.timingSafeEqual(want, got) ? rec : null;
  }

  // { activationId, state: 'none'|'active'|'expired', plan, planName,
  //   expiresAt, daysLeft, activatedAt, configured, contact, plans }
  status() {
    const base = { activationId: this.activationId, configured: Boolean(this.secret), contact: this.config.contact || null, plans: PLANS };
    const now = this.now();
    const c = this.current();
    if (!c) return { ...base, state: 'none', plan: null };
    const planName = PLANS.find((p) => p.id === c.plan).name;
    const expired = c.expiresAt !== null && now >= c.expiresAt;
    return {
      ...base,
      state: expired ? 'expired' : 'active',
      plan: c.plan,
      planName,
      expiresAt: c.expiresAt ? new Date(c.expiresAt).toISOString() : null,
      daysLeft: c.expiresAt && !expired ? Math.ceil((c.expiresAt - now) / DAY) : null,
      activatedAt: new Date(c.startedAt).toISOString(),
    };
  }

  get active() {
    return this.status().state === 'active';
  }

  // Checks a code for `plan` and starts (or extends) the plan:
  // { ok, plan, planName, expiresAt } or { ok: false, reason, error }.
  activate(text, plan) {
    const fail = (reason, error) => ({ ok: false, reason, error });
    if (!this.secret) return fail('unconfigured', 'Activation is not set up in this copy of Lead Finder.');
    const p = PLANS.find((x) => x.id === plan);
    if (!p) return fail('plan', 'Choose a plan first.');
    const code = String(text ?? '').replace(/\s+/g, '');
    if (!CODE_RE.test(code)) return fail('invalid', 'Enter the 4-digit activation code.');
    const now = this.now();
    const tries = this.store.getState('activation.attempts') || { count: 0, until: 0 };
    if (tries.until > now) return fail('locked', `Too many wrong codes. Try again in ${Math.ceil((tries.until - now) / 60_000)} minutes.`);

    const day = matchCode(this.secret, this.activationId, plan, code, now);
    if (day === null) {
      // Every refused code counts towards the lockout, so the answers below
      // can't be used to test guesses for free.
      const count = tries.count + 1;
      this.store.setState('activation.attempts', count >= MAX_TRIES ? { count: 0, until: now + LOCK_MS } : { count, until: 0 });
      const left = count >= MAX_TRIES ? ' Too many wrong codes: try again in 15 minutes.' : '';
      const other = PLANS.find((x) => x.id !== plan && matchCode(this.secret, this.activationId, x.id, code, now) !== null);
      if (other) return fail('plan', `This code is for the ${other.name} plan. Choose ${other.name} and enter it again.${left}`);
      if (matchCode(this.secret, this.activationId, plan, code, now, 7) !== null) return fail('expired', `This code has expired. Ask for a new one.${left}`);
      return fail('invalid', left ? `Wrong code.${left}` : `Wrong code. Check it and try again (${MAX_TRIES - count} ${MAX_TRIES - count === 1 ? 'try' : 'tries'} left).`);
    }
    const used = this.store.getState('activation.used') || [];
    const key = `${plan}:${day}`;
    if (used.includes(key)) return fail('used', 'This code has already been used.');

    // A plan still running is extended from its end; Lifetime is final.
    const cur = this.current();
    const curActive = cur && (cur.expiresAt === null || now < cur.expiresAt);
    if (curActive && cur.expiresAt === null) return fail('lifetime', 'You already have the Lifetime plan. Nothing was changed.');
    const from = curActive ? cur.expiresAt : now;
    const rec = { plan, startedAt: now, expiresAt: p.months ? addMonths(new Date(from), p.months).getTime() : null, day };
    this.store.setState('activation', { ...rec, mac: this.mac(rec) });
    this.store.setState('activation.used', [...used, key].slice(-200));
    this.store.setState('activation.attempts', { count: 0, until: 0 });
    return { ok: true, plan, planName: p.name, expiresAt: rec.expiresAt ? new Date(rec.expiresAt).toISOString() : null };
  }
}

module.exports = { Activation, readMachineId };
