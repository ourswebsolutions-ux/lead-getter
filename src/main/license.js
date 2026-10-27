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
  constructor(code, message, status, details = null) {
    super(message);
    this.code = code;
    this.status = status;
    // The server's answer (e.g. { reason, attemptsLeft, retryAt }).
    this.details = details;
  }
}

const REASON_TEXT = {
  expired: 'Your plan has expired. You are back on the Free plan.',
  suspended: 'Your subscription is suspended. Contact Axora Web Solutions to restore it.',
  exhausted: 'Today’s qualified leads are used up.',
  offline: 'Your subscription could not be verified. Check the internet connection and try again.',
  misconfigured: 'The subscription server address in this copy of Lead Finder does not answer as the licence server, so subscriptions can’t be checked.',
  unconfigured: 'Subscriptions are not configured in this copy of Lead Finder.',
  invalid: 'The subscription server gave an invalid answer, so access could not be confirmed.',
};

class LicenseClient {
  // store: LeadStore (app_state), cipher: { encrypt, decrypt } or null,
  // config: { serverUrl, publicKey (SPKI DER base64) }
  // log(entry): diagnostics for failed requests (address, status, a short
  // piece of the answer); never keys, signatures or tokens.
  constructor({ store, cipher, config, fetchImpl = globalThis.fetch, timeoutMs = 15_000, clock = () => Date.now(), machineId = readMachineId, log = () => {} }) {
    const raw = typeof machineId === 'function' ? machineId() : machineId;
    this.machine = raw ? crypto.createHash('sha256').update(`lead-finder:${raw}`).digest('hex') : '';
    this.clock = clock;
    this.store = store;
    this.cipher = cipher;
    this.config = config || {};
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.log = log;
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
      res = await this.fetch(this.url(pathQuery), { method, headers, body: body ? payload : undefined, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw this.networkError(err, method, pathQuery);
    }
    const out = await this.answer(res, method, pathQuery);
    if (out instanceof LicenseError) throw out;
    return out;
  }

  // A request that got no HTTP answer at all.
  networkError(err, method, pathQuery) {
    this.log({ event: 'network-error', method, url: this.url(pathQuery.split('?')[0]), error: String(err?.cause?.code || err?.name || err?.message || err).slice(0, 120) });
    return new LicenseError('offline', err?.name === 'TimeoutError' ? 'The subscription server did not answer in time. Please try again.' : this.unreachableText());
  }

  // Reads an HTTP answer. Failures are told apart instead of all being
  // called "could not be reached":
  //   - an answer that isn't the licence server's (e.g. a login prompt from
  //     another website at that address) -> 'misconfigured';
  //   - the licence server's own refusal -> its message;
  //   - 5xx -> 'server'.
  async answer(res, method, pathQuery) {
    const text = await res.text().catch(() => '');
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    if (res.ok && data) return data;
    const type = res.headers?.get?.('content-type') || '';
    const challenge = res.headers?.get?.('www-authenticate') || '';
    this.log({ event: 'http-error', method, url: this.url(pathQuery.split('?')[0]), status: res.status, contentType: type.slice(0, 60), wwwAuthenticate: challenge.slice(0, 80), body: text.replace(/\s+/g, ' ').slice(0, 300) });
    // The licence server always answers JSON { error: '...' } (or the data).
    const fromLicenceServer = data && typeof data === 'object' && (typeof data.error === 'string' || res.ok);
    if (!fromLicenceServer) {
      const why = challenge ? 'asked for a website login' : !text ? 'sent an empty answer' : 'sent something that is not the licence server’s answer';
      return new LicenseError('misconfigured', `The subscription server address (${this.config.serverUrl}) answered HTTP ${res.status} and ${why}: the Lead Finder licence server is not installed there. Subscriptions can’t be checked until it is (see server/README.md, “Deployment”).`, res.status);
    }
    // The server's own message when it has one ("Server error" is its
    // generic answer to unexpected failures).
    if (data.error && data.error !== 'Server error') return new LicenseError('server', data.error, res.status, data);
    if (res.status >= 500) return new LicenseError('server', `The subscription server had a problem (HTTP ${res.status}). Please try again later.`, res.status);
    return new LicenseError('server', `The subscription server refused the request (HTTP ${res.status}).`, res.status);
  }

  // A local server address means the server simply isn't running; anything
  // else is most likely a connection problem.
  // The server may live under a path (https://host/lead-getter), which
  // new URL('/api/…', base) would drop. Signatures cover only '/api/…'.
  url(pathQuery) {
    return `${String(this.config.serverUrl).replace(/\/+$/, '')}${pathQuery}`;
  }

  unreachableText() {
    const url = this.config.serverUrl || '';
    return /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)
      ? `The subscription server is not running (${url}). Start it with "npm run server" in the Lead Finder folder, or deploy it and rebuild the app.`
      : `The subscription server (${url}) could not be reached. Check the internet connection and try again.`;
  }

  async plans() {
    if (!this.configured) throw new LicenseError('unconfigured', REASON_TEXT.unconfigured);
    let res;
    try {
      res = await this.fetch(this.url('/api/plans'), { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw this.networkError(err, 'GET', '/api/plans');
    }
    const out = await this.answer(res, 'GET', '/api/plans');
    if (out instanceof LicenseError) throw out;
    if (!Array.isArray(out?.plans)) throw new LicenseError('misconfigured', `The subscription server address (${this.config.serverUrl}) did not return the plan list: the Lead Finder licence server is not installed there.`);
    return out;
  }

  // Current status, freshly signed by the server. Never cached as authority.
  // Everything comes from the server's signed answer: the plan, today's
  // allowance and the activation request. Nothing stored locally counts.
  //   allowed    a paid plan is active (campaigns and WhatsApp features)
  //   canSearch  leads can be saved today from at least one source
  async status() {
    const out = { checkedAt: this.clock(), deviceId: null, allowed: false, canSearch: false, reason: 'unconfigured', message: REASON_TEXT.unconfigured, plan: null, credits: null, activation: null, subscription: null, serverTime: null };
    if (!this.configured) return (this.last = out);
    out.deviceId = this.deviceId;
    const nonce = crypto.randomBytes(18).toString('base64url');
    let token;
    try {
      ({ token } = await this.request('GET', `/api/license?nonce=${nonce}`));
    } catch (err) {
      const reason = err.code === 'unconfigured' || err.code === 'misconfigured' ? err.code : 'offline';
      return (this.last = { ...out, reason, message: err.message || REASON_TEXT[reason] });
    }
    const p = verifyToken(token, this.serverKey);
    if (!p || p.deviceId !== out.deviceId || p.nonce !== nonce || !p.plan || !p.credits) return (this.last = { ...out, reason: 'invalid', message: REASON_TEXT.invalid });
    const credits = p.credits;
    const plan = { ...p.plan, daysLeft: p.plan.expiresAt && p.plan.state === 'active' ? Math.max(0, Math.ceil((Date.parse(p.plan.expiresAt) - Date.parse(p.serverTime)) / 86_400_000)) : null };
    const left = (c) => c.limit === null || c.remaining > 0;
    const sources = credits.scope === 'blocked' ? [] : credits.scope === 'per_source' ? ['maps', 'facebook'].filter((s) => left(credits[s])) : left(credits.total) ? ['maps', 'facebook'] : [];
    const reason = plan.state === 'suspended' ? 'suspended' : !sources.length ? 'exhausted' : plan.state === 'active' && plan.id !== 'free' ? 'active' : plan.state === 'expired' ? 'expired' : 'free';
    return (this.last = {
      ...out,
      allowed: plan.state === 'active' && plan.id !== 'free',
      canSearch: sources.length > 0,
      // Sources that can still save leads today.
      sources,
      reason,
      message: REASON_TEXT[reason] || '',
      plan,
      credits,
      activation: p.activation || null,
      subscription: { state: plan.state, plan: plan.id, expiresAt: plan.expiresAt, daysLeft: plan.daysLeft },
      serverTime: p.serverTime,
    });
  }

  // An Activation ID and code for `plan`; the code goes to the
  // administrator, who gives it to the customer. -> { activation }
  requestActivation(plan) {
    return this.request('POST', '/api/activation', { plan });
  }

  verifyCode(code) {
    return this.request('POST', '/api/activation/verify', { code });
  }

  resendCode() {
    return this.request('POST', '/api/activation/resend', {});
  }

  // Charges one new qualified lead from `source` ('maps' | 'facebook') to
  // today's allowance. `key` is a hash identifying the lead, so the same
  // lead is never charged twice. -> { granted, duplicate, reason, credits }
  reserveCredit(source, key) {
    return this.request('POST', '/api/credits/reserve', { source, key });
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

module.exports = { readMachineId, LicenseClient, LicenseError, REASON_TEXT, verifyToken };
