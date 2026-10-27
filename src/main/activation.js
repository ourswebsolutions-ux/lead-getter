'use strict';

// The subscription on this computer. No server:
//   1. request(plan): makes a random 6-digit code, emails it (with the
//      Activation ID, plan and price) to the administrator only, and keeps
//      a slow salted hash of it, valid 10 minutes. A failed email keeps
//      nothing, so that code can never be used.
//   2. verify(code, plan): the administrator passed the code on after
//      payment; if it matches (same computer, same plan, unexpired, unused,
//      within 5 tries) the plan starts at once.
//
// Stored in the lead database's app_state (kept across restarts and
// updates): 'activation' (the plan), 'activation.pending' (the code's hash),
// 'activation.requests' (send times, for the rate limit), 'activation.seen'
// (the latest time seen, so turning the clock back changes nothing) and
// 'activation.salt' (only on computers without a machine id). Records are
// sealed with the build's secret, so editing the database doesn't help.
//
// Limits, stated plainly: everything runs on the customer's computer. The
// code is in this process for a moment, and the build's secret and SMTP
// login are inside the app. This stops ordinary users, not someone who
// takes the app apart.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const PLANS = [
  { id: 'monthly', name: 'Monthly', priceLabel: 'PKR 3,000', months: 1 },
  { id: 'six_months', name: '6 Months', priceLabel: 'PKR 10,000', months: 6 },
  { id: 'lifetime', name: 'Lifetime', priceLabel: 'PKR 20,000', months: null },
];
const DAY = 86_400_000;
const CODE_TTL = 10 * 60 * 1000;
const MAX_TRIES = 5;
const RESEND_GAP = 60 * 1000;
const MAX_PER_HOUR = 6;
const CLOCK_SLACK = 60 * 60 * 1000;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: no I, L, O, U

// The Activation ID of a computer: LF-XXXX-XXXX-XXXX from a hash of its
// machine id (the same after reinstalling; different on another computer).
function activationIdFor(seed) {
  const h = crypto.createHash('sha256').update(`lead-finder-activation\n${seed}`).digest();
  let bits = h.readBigUInt64BE(0) >> 4n; // 60 bits
  let s = '';
  for (let i = 0; i < 12; i++) {
    s = B32[Number(bits & 31n)] + s;
    bits >>= 5n;
  }
  return `LF-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

// Calendar-month addition (UTC); the 31st becomes the month's last day.
function addMonths(date, months) {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

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

const scrypt = (code, salt) =>
  new Promise((resolve, reject) => crypto.scrypt(code, salt, 32, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))));
const fmtTime = (ms) => new Date(ms).toUTCString();

class Activation {
  // config: { secret (base64), adminEmail, contact: { whatsapp, phone } };
  // mailer: { send({ to, subject, text }) } or null when SMTP isn't set up;
  // mailError(err) -> a safe description of a failed send.
  constructor({ store, config, mailer = null, mailError = () => 'the email could not be sent', machineId = readMachineId, clock = () => Date.now(), random = (n) => crypto.randomInt(n) }) {
    Object.assign(this, { store, mailer, mailError, clock, random });
    this.config = config || {};
    this.netOffset = null;
    const secret = Buffer.from(String(this.config.secret || ''), 'base64');
    this.secret = secret.length >= 16 ? secret : null;
    let seed = typeof machineId === 'function' ? machineId() : machineId;
    if (!seed) {
      seed = store.getState('activation.salt');
      if (!seed) store.setState('activation.salt', (seed = crypto.randomBytes(16).toString('hex')));
    }
    this.activationId = activationIdFor(seed);
    this.busy = null; // 'sending' | 'verifying': one at a time
  }

  get configured() {
    return Boolean(this.secret && this.mailer && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.config.adminEmail || ''));
  }

  // The time used for codes and plans: never earlier than the latest time
  // this app has seen, and the network's time when it is known.
  now() {
    const seen = this.store.getState('activation.seen') || 0;
    const t = this.netOffset !== null ? this.clock() + this.netOffset : Math.max(this.clock(), seen);
    if (t > seen + 1000) this.store.setState('activation.seen', t);
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

  // Sealed records: tied to this computer and the build's secret.
  seal(kind, rec) {
    const { mac, ...fields } = rec;
    return crypto.createHmac('sha256', this.secret).update(JSON.stringify([kind, this.activationId, fields])).digest('base64');
  }

  load(kind, key) {
    const rec = this.store.getState(key);
    if (!rec || !this.secret || typeof rec.mac !== 'string') return null;
    const want = Buffer.from(this.seal(kind, rec));
    const got = Buffer.from(rec.mac);
    return want.length === got.length && crypto.timingSafeEqual(want, got) ? rec : null;
  }

  save(kind, key, rec) {
    this.store.setState(key, { ...rec, mac: this.seal(kind, rec) });
  }

  current() {
    const rec = this.load('plan', 'activation');
    return rec && PLANS.some((p) => p.id === rec.plan) ? rec : null;
  }

  // The code waiting to be entered, if it is still valid.
  pending(now = this.now()) {
    const p = this.load('pending', 'activation.pending');
    return p && now < p.expiresAt && p.tries < MAX_TRIES ? p : null;
  }

  status() {
    const now = this.now();
    const base = { activationId: this.activationId, configured: this.configured, contact: this.config.contact || null, plans: PLANS, busy: this.busy };
    const p = this.pending(now);
    base.pending = p ? { plan: p.plan, planName: PLANS.find((x) => x.id === p.plan).name, expiresAt: new Date(p.expiresAt).toISOString(), triesLeft: MAX_TRIES - p.tries } : null;
    const c = this.current();
    if (!c) return { ...base, state: 'none', plan: null };
    const expired = c.expiresAt !== null && now >= c.expiresAt;
    return {
      ...base,
      state: expired ? 'expired' : 'active',
      plan: c.plan,
      planName: PLANS.find((x) => x.id === c.plan).name,
      expiresAt: c.expiresAt ? new Date(c.expiresAt).toISOString() : null,
      daysLeft: c.expiresAt && !expired ? Math.ceil((c.expiresAt - now) / DAY) : null,
      activatedAt: new Date(c.startedAt).toISOString(),
    };
  }

  get active() {
    return this.status().state === 'active';
  }

  // Step 1: a new code for `plan`, emailed to the administrator. Replaces
  // any earlier code. { ok, expiresAt } or { ok: false, reason, error }.
  async request(plan) {
    const fail = (reason, error) => ({ ok: false, reason, error });
    if (!this.configured) return fail('unconfigured', 'Activation is not set up in this copy of Lead Finder (no email settings). Please install the latest version.');
    const p = PLANS.find((x) => x.id === plan);
    if (!p) return fail('plan', 'Choose a plan first.');
    if (this.busy) return fail('busy', this.busy === 'sending' ? 'An activation request is already being sent.' : 'A code is being checked.');
    const cur = this.current();
    const now = this.now();
    if (cur && cur.expiresAt === null) return fail('lifetime', 'You already have the Lifetime plan.');
    const sent = (this.store.getState('activation.requests') || []).filter((t) => t > now - 60 * 60 * 1000 && t <= now);
    const wait = sent.length ? sent[sent.length - 1] + RESEND_GAP - now : 0;
    if (wait > 0) return fail('wait', `Please wait ${Math.ceil(wait / 1000)} seconds before requesting a new code.`);
    if (sent.length >= MAX_PER_HOUR) return fail('wait', 'Too many requests. Please try again in an hour, or contact us.');

    this.busy = 'sending';
    try {
      this.store.setState('activation.requests', [...sent, now]);
      const code = String(this.random(1_000_000)).padStart(6, '0');
      const salt = crypto.randomBytes(16).toString('base64');
      const hash = (await scrypt(code, salt)).toString('base64');
      const expiresAt = now + CODE_TTL;
      try {
        await this.mailer.send({
          to: this.config.adminEmail,
          subject: `Lead Finder activation ${code}: ${p.name} for ${this.activationId}`,
          text: [
            `Activation code (OTP): ${code}`,
            '',
            `Activation ID: ${this.activationId}`,
            `Plan: ${p.name}`,
            `Price: ${p.priceLabel}`,
            `Code expires: ${fmtTime(expiresAt)} (10 minutes, one use, this Activation ID and plan only)`,
            '',
            'After the payment is confirmed, give this code to the customer by WhatsApp or phone.',
            'If it expires, the customer clicks Activate again for a new code.',
          ].join('\n'),
        });
      } catch (err) {
        // Nothing is kept: a code that wasn't delivered can't be used. A
        // failed send doesn't count towards the wait between requests.
        this.store.setState('activation.requests', sent);
        return fail('email', `The activation request could not be sent: ${this.mailError(err)}. Please try again, or contact us by WhatsApp or phone.`);
      }
      // Replaces (and so cancels) any earlier code.
      this.save('pending', 'activation.pending', { plan, salt, hash, createdAt: now, expiresAt, tries: 0 });
      return { ok: true, plan, planName: p.name, expiresAt: new Date(expiresAt).toISOString() };
    } finally {
      this.busy = null;
    }
  }

  // Step 2: the code the administrator passed on. Starts (or extends) the
  // plan. { ok, plan, planName, expiresAt } or { ok: false, reason, error }.
  async verify(text, plan) {
    const fail = (reason, error) => ({ ok: false, reason, error });
    if (!this.secret) return fail('unconfigured', 'Activation is not set up in this copy of Lead Finder.');
    const code = String(text ?? '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) return fail('invalid', 'Enter the 6-digit code.');
    if (this.busy) return fail('busy', 'Please wait: the previous request is still running.');
    this.busy = 'verifying';
    try {
      const now = this.now();
      const p = this.load('pending', 'activation.pending');
      if (!p) return fail('none', 'There is no code to enter. Choose a plan and click Activate first.');
      if (now >= p.expiresAt) return fail('expired', 'This code has expired. Click Activate to get a new one.');
      if (p.tries >= MAX_TRIES) return fail('tries', 'Too many wrong codes. Click Activate to get a new one.');
      const planName = PLANS.find((x) => x.id === p.plan).name;
      if (plan !== p.plan) return fail('plan', `The code was requested for the ${planName} plan. Choose ${planName}, or click Activate for a new code.`);
      // The try is counted before the check, so stopping the app midway
      // doesn't give a free try.
      const tries = p.tries + 1;
      this.save('pending', 'activation.pending', { ...p, mac: undefined, tries });
      const got = await scrypt(code, p.salt);
      if (!crypto.timingSafeEqual(got, Buffer.from(p.hash, 'base64'))) {
        if (tries >= MAX_TRIES) this.store.setState('activation.pending', null);
        return fail('wrong', tries >= MAX_TRIES ? 'Wrong code. That was the last try: click Activate to get a new code.' : `Wrong code. ${MAX_TRIES - tries} ${MAX_TRIES - tries === 1 ? 'try' : 'tries'} left.`);
      }
      // Used once: removed before the plan is saved.
      this.store.setState('activation.pending', null);
      const months = PLANS.find((x) => x.id === p.plan).months;
      const cur = this.current();
      const running = cur && cur.expiresAt !== null && now < cur.expiresAt;
      const rec = { plan: p.plan, startedAt: now, expiresAt: months ? addMonths(new Date(running ? cur.expiresAt : now), months).getTime() : null };
      this.save('plan', 'activation', rec);
      return { ok: true, plan: p.plan, planName, expiresAt: rec.expiresAt ? new Date(rec.expiresAt).toISOString() : null };
    } finally {
      this.busy = null;
    }
  }
}

module.exports = { Activation, PLANS, CODE_TTL, MAX_TRIES, activationIdFor, addMonths, readMachineId };
