'use strict';

// Subscription client for the licence server (see server/). The device has
// its own Ed25519 key (private key encrypted with the OS keychain); every
// request is signed with it. Status comes back as a token signed by the
// server, carrying the server's time and a nonce chosen here, so neither the
// local clock nor a stored/replayed response can grant access.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

// This computer's OS machine id (survives reinstalling the app), hashed so
// the raw id never leaves the computer. Free searches are counted per id.
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

class LicenseError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const REASON_TEXT = {
  none: 'You do not have a subscription yet. Choose a plan to start finding leads.',
  trial_used: 'Your 3 free searches have been used. Choose a plan to keep finding leads.',
  pending: 'Your subscription application is awaiting approval. You can search as soon as it is approved.',
  cancelled: 'Your last subscription application was cancelled. You can apply again.',
  expired: 'Your subscription has expired. Renew it to continue finding leads.',
  offline: 'Your subscription could not be verified. Check the internet connection and try again.',
  unconfigured: 'Subscriptions are not configured in this copy of Lead Finder.',
  invalid: 'The subscription server gave an invalid answer, so access could not be confirmed.',
};

class LicenseClient {
  // store: LeadStore (app_state), cipher: { encrypt, decrypt } or null,
  // config: { serverUrl, publicKey (SPKI DER base64) }
  constructor({ store, cipher, config, fetchImpl = globalThis.fetch, timeoutMs = 70_000, clock = () => Date.now(), machineId = readMachineId }) {
    const raw = typeof machineId === 'function' ? machineId() : machineId;
    this.machine = raw ? crypto.createHash('sha256').update(`lead-finder:${raw}`).digest('hex') : '';
    this.clock = clock;
    this.store = store;
    this.cipher = cipher;
    this.config = config || {};
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs; // generous: a free-tier host can take a minute to wake up
    this.last = null;
    try {
      this.serverKey = this.config.publicKey ? crypto.createPublicKey({ key: Buffer.from(this.config.publicKey, 'base64'), format: 'der', type: 'spki' }) : null;
    } catch {
      this.serverKey = null;
    }
  }

  get configured() {
    return Boolean(this.config.serverUrl && this.serverKey);
  }

  keys() {
    if (this.k) return this.k;
    let rec = this.store.getState('device_key');
    if (!rec) {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
      rec = {
        publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
        privateKey: this.cipher ? this.cipher.encrypt(pem).toString('base64') : Buffer.from(pem).toString('base64'),
        encrypted: Boolean(this.cipher),
      };
      this.store.setState('device_key', rec);
    }
    const pem = rec.encrypted ? this.cipher.decrypt(Buffer.from(rec.privateKey, 'base64')) : Buffer.from(rec.privateKey, 'base64').toString('utf8');
    this.k = { publicKey: rec.publicKey, privateKey: crypto.createPrivateKey(pem) };
    return this.k;
  }

  get deviceId() {
    const raw = crypto.createHash('sha256').update(Buffer.from(this.keys().publicKey, 'base64')).digest();
    return raw.toString('base64url').slice(0, 32);
  }

  async request(method, pathQuery, body = null, timeoutMs = this.timeoutMs) {
    if (!this.configured) throw new LicenseError('unconfigured', REASON_TEXT.unconfigured);
    const payload = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
    const ts = String(this.clock());
    const { publicKey, privateKey } = this.keys();
    const reqNonce = crypto.randomBytes(16).toString('base64url');
    const digest = Buffer.from(`${method}\n${pathQuery}\n${ts}\n${reqNonce}\n${this.machine}\n${crypto.createHash('sha256').update(payload).digest('hex')}`);
    const headers = {
      'x-lf-key': publicKey,
      'x-lf-ts': ts,
      'x-lf-nonce': reqNonce,
      ...(this.machine ? { 'x-lf-machine': this.machine } : {}),
      'x-lf-sig': crypto.sign(null, digest, privateKey).toString('base64'),
    };
    if (body) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await this.fetch(new URL(pathQuery, this.config.serverUrl), { method, headers, body: body ? payload : undefined, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new LicenseError('offline', err?.name === 'TimeoutError' ? 'The subscription server did not answer in time. Please try again.' : this.unreachableText());
    }
    let data = null;
    try {
      data = await res.json();
    } catch {}
    if (!res.ok) throw new LicenseError('server', data?.error || `Subscription server error (${res.status}).`, res.status);
    return data;
  }

  // A local server address means the server simply isn't running; anything
  // else is most likely a connection problem.
  unreachableText() {
    const url = this.config.serverUrl || '';
    return /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)
      ? `The subscription server is not running (${url}). Start it with "npm run server" in the Lead Finder folder, or deploy it and rebuild the app.`
      : `The subscription server (${url}) could not be reached. Check the internet connection and try again.`;
  }

  async plans() {
    if (!this.configured) throw new LicenseError('unconfigured', REASON_TEXT.unconfigured);
    try {
      const res = await this.fetch(new URL('/api/plans', this.config.serverUrl), { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) throw new Error(String(res.status));
      return await res.json();
    } catch {
      throw new LicenseError('offline', this.unreachableText());
    }
  }

  // Current status, freshly signed by the server. Never cached as authority.
  async status() {
    const out = { checkedAt: this.clock(), deviceId: null, allowed: false, canSearch: false, reason: 'unconfigured', message: REASON_TEXT.unconfigured, subscription: null, application: null, trial: null, serverTime: null };
    if (!this.configured) return (this.last = out);
    out.deviceId = this.deviceId;
    const nonce = crypto.randomBytes(18).toString('base64url');
    let token;
    try {
      ({ token } = await this.request('GET', `/api/license?nonce=${nonce}`));
    } catch (err) {
      return (this.last = { ...out, reason: err.code === 'unconfigured' ? 'unconfigured' : 'offline', message: err.message || REASON_TEXT.offline });
    }
    const p = verifyToken(token, this.serverKey);
    if (!p || p.deviceId !== out.deviceId || p.nonce !== nonce) return (this.last = { ...out, reason: 'invalid', message: REASON_TEXT.invalid });
    const sub = p.subscription || { state: 'none' };
    const app = p.application || null;
    const trial = p.trial || { limit: 0, used: 0, remaining: 0 };
    let reason = 'active';
    if (sub.state !== 'active') {
      if (trial.remaining > 0) reason = 'trial';
      else if (app?.status === 'pending') reason = 'pending';
      else if (sub.state === 'expired') reason = 'expired';
      else if (app?.status === 'cancelled') reason = 'cancelled';
      else reason = 'trial_used';
    }
    // Days left measured against the server's clock, not this computer's.
    const daysLeft = sub.state === 'active' && sub.expiresAt ? Math.max(0, Math.ceil((Date.parse(sub.expiresAt) - Date.parse(p.serverTime)) / 86_400_000)) : null;
    let message = reason === 'active' ? '' : reason === 'trial' ? `Free trial: ${trial.remaining} of ${trial.limit} free searches left.` : REASON_TEXT[reason];
    if (reason === 'pending' && sub.state === 'expired') message = 'Your subscription has expired. Your new application is awaiting approval; you can search again as soon as it is approved.';
    return (this.last = {
      ...out,
      allowed: reason === 'active',
      canSearch: reason === 'active' || reason === 'trial',
      reason,
      message,
      subscription: { ...sub, daysLeft },
      application: app,
      pendingApplications: p.pendingApplications || 0,
      trial,
      serverTime: p.serverTime,
    });
  }

  // Counts one free search on the server (refused when none are left).
  async consumeTrial() {
    return this.request('POST', '/api/trial/consume', {});
  }

  async apply({ plan, message, email, screenshot }) {
    // Submitting waits for the approval email to be sent, so allow longer.
    return this.request('POST', '/api/applications', { plan, message, email: email || undefined, screenshot: { type: screenshot.type, data: screenshot.data.toString('base64') } }, 90_000);
  }
}

function verifyToken(token, publicKey) {
  try {
    const [body, sig] = String(token).split('.');
    if (!body || !sig || !crypto.verify(null, Buffer.from(body), publicKey, Buffer.from(sig, 'base64url'))) return null;
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// Validates a screenshot chosen by the user: real PNG/JPEG/WebP, <= 5 MB.
function readScreenshot(buf) {
  if (!buf?.length) throw new Error('The file is empty.');
  if (buf.length > 5 * 1024 * 1024) throw new Error('The screenshot is larger than 5 MB.');
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  throw new Error('Choose a PNG, JPEG or WebP image.');
}

module.exports = { readMachineId, LicenseClient, LicenseError, REASON_TEXT, readScreenshot, verifyToken };
