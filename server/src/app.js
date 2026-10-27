'use strict';

// HTTP API for Lead Finder subscriptions. This standalone server is for
// development, tests and CI; production serves the same API from the
// subscription website (subscription.axorawebsolutions.com/lead-getter).
//
//   GET  /api/plans                      plans and payment accounts (public)
//   GET  /api/license?nonce=…            (device-signed) signed status: plan, today's
//                                        allowance, activation request
//   POST /api/activation                 (device-signed) { plan } an Activation ID and a
//                                        4-digit code for that plan, emailed to the administrator
//   POST /api/activation/verify          (device-signed) { code } activates the plan
//   POST /api/activation/resend          (device-signed) a new code (to the administrator)
//   POST /api/credits/reserve            (device-signed) { source, key } charge one new
//                                        qualified lead to today's allowance
//   GET  /health
//
// Activation: the app asks for a plan; the server makes an Activation ID
// and a 4-digit code and emails both to the administrator (SUBSCRIPTION_
// ADMIN_EMAIL) only. Once paid, the administrator gives the customer the
// code (WhatsApp, phone, …); entering it in the app activates that plan.

const http = require('node:http');
const crypto = require('node:crypto');
const { PLANS, PAID_PLAN_IDS, PAYMENT_METHODS } = require('./plans');
const credits = require('./credits');
const { MAX_OTP_ATTEMPTS } = require('./store');
const c = require('./crypto');
const pages = require('./pages');

const MAX_BODY = 64 * 1024;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
// The administrator passes the code on by hand, so it lasts a day.
const OTP_TTL_MS = 24 * 60 * 60 * 1000;
const OTP_RESEND_MS = 60 * 1000;
const OTP_MAX_PER_DAY = 5;
const MAX_REQUESTS_PER_DAY = 5;

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function createApp({ config, store, mailer, now = () => new Date(), logger = console }) {
  const privateKey = crypto.createPrivateKey(config.licensePrivateKey);
  const otpKey = c.otpKey(config.licensePrivateKey);
  const timezone = config.timezone || credits.DEFAULT_TIMEZONE;
  const plans = config.plans || PLANS;
  const nowIso = () => now().toISOString();
  const later = (ms) => new Date(now().getTime() + ms).toISOString();
  const link = (p) => `${config.publicBaseUrl.replace(/\/$/, '')}${p}`;
  // When served under a path (PUBLIC_BASE_URL https://host/lead-getter), the
  // prefix is removed here, whether or not the host's proxy already did.
  const localPath = (u) => {
    const base = new URL(config.publicBaseUrl).pathname.replace(/\/+$/, '');
    return base && (u === base || u.startsWith(`${base}/`) || u.startsWith(`${base}?`)) ? u.slice(base.length) || '/' : u;
  };

  // --- helpers --------------------------------------------------------------

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (d) => {
        size += d.length;
        if (size > MAX_BODY) {
          reject(new HttpError(413, 'Request too large'));
          req.destroy();
        } else chunks.push(d);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function parseJson(body) {
    if (!body.length) return {};
    try {
      const data = JSON.parse(body.toString('utf8'));
      if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    } catch {}
    throw new HttpError(400, 'Invalid JSON');
  }

  // Verifies a device-signed request: { deviceId, machineId }.
  async function authenticate(req, url, body) {
    const key = req.headers['x-lf-key'];
    const ts = Number(req.headers['x-lf-ts']);
    const sig = req.headers['x-lf-sig'];
    const nonce = req.headers['x-lf-nonce'];
    const machine = String(req.headers['x-lf-machine'] || '');
    if (machine && !/^[0-9a-f]{64}$/.test(machine)) throw new HttpError(401, 'Invalid machine id');
    if (!key || !ts || !sig || !/^[A-Za-z0-9_-]{16,64}$/.test(String(nonce || ''))) throw new HttpError(401, 'Unsigned request');
    if (Math.abs(now().getTime() - ts) > CLOCK_SKEW_MS) throw new HttpError(401, 'Request time is out of range. Check the computer clock.');
    let publicKey;
    try {
      publicKey = c.publicKeyFromB64(key);
    } catch {
      throw new HttpError(401, 'Invalid device key');
    }
    const ok = crypto.verify(null, c.requestDigest(req.method, url.pathname + url.search, ts, nonce, body, machine), publicKey, Buffer.from(String(sig), 'base64'));
    if (!ok) throw new HttpError(401, 'Bad signature');
    if (!(await store.rememberRequest(c.hashToken(sig), now().getTime(), CLOCK_SKEW_MS * 2))) throw new HttpError(401, 'Replayed request');
    const deviceId = c.deviceIdFromKey(key);
    try {
      await store.upsertDevice(deviceId, key, nowIso());
    } catch {
      throw new HttpError(401, 'Device key mismatch');
    }
    return { deviceId, machineId: machine || `device:${deviceId}` };
  }

  function json(res, status, data) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(data));
  }

  function html(res, status, body) {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    });
    res.end(body);
  }

  function audit(actor, action, target, details) {
    try {
      store.audit({ at: nowIso(), actor, action, target, details });
    } catch (err) {
      logger.error(`[audit] ${err.message}`);
    }
  }

  // --- status ---------------------------------------------------------------

  // Today's allowance for the device (or computer, on Free).
  function creditState(deviceId, machineId) {
    const t = now();
    const sub = store.subscription(deviceId, t.toISOString());
    const ent = credits.entitlementFor(sub, plans);
    const account = credits.accountFor(ent, { deviceId, machineId });
    const day = credits.dayKey(t, timezone);
    const view = () =>
      credits.snapshot(ent, { day, timezone, resetsAt: credits.nextDayStart(t, timezone), usage: store.usageToday(account, day), discovered: ent.scope === 'unlimited' ? store.discovered(account) : null });
    return { sub, ent, account, day, view };
  }

  // What the app shows of a request (never the code).
  function activationView(r) {
    if (!r) return null;
    return {
      id: r.id,
      status: r.status,
      plan: r.plan,
      createdAt: r.created_at,
      code: {
        sentAt: r.otp_sent_at,
        expiresAt: r.otp_expires_at,
        attemptsLeft: r.otp_hash ? Math.max(0, MAX_OTP_ATTEMPTS - r.otp_attempts) : 0,
        resendAt: r.otp_sent_at ? new Date(Date.parse(r.otp_sent_at) + OTP_RESEND_MS).toISOString() : null,
      },
    };
  }

  function planView(sub, ent) {
    const p = plans[ent.planId] || plans.free;
    return { id: p.id, name: p.name, state: ent.state === 'active' && p.id === 'free' ? 'free' : ent.state, expiresAt: sub.state === 'active' || sub.state === 'expired' || sub.state === 'suspended' ? sub.expiresAt || null : null, activatedAt: sub.activatedAt || null, expiredPlan: sub.state === 'expired' ? sub.plan : null };
  }

  async function license(req, res, url) {
    const body = await readBody(req);
    const { deviceId, machineId } = await authenticate(req, url, body);
    const nonce = url.searchParams.get('nonce') || '';
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw new HttpError(400, 'Missing nonce');
    const cs = creditState(deviceId, machineId);
    const payload = {
      v: 2,
      deviceId,
      nonce,
      serverTime: nowIso(),
      plan: planView(cs.sub, cs.ent),
      credits: cs.view(),
      activation: activationView(store.openActivation(deviceId, nowIso())),
      subscription: { state: cs.sub.state, plan: cs.sub.plan || null, expiresAt: cs.sub.expiresAt || null },
    };
    json(res, 200, { token: c.signToken(payload, privateKey) });
  }

  // --- activation ---------------------------------------------------------------

  // Emails the Activation ID and its code to the administrator (only).
  function sendCode(r, code, { renewed = false } = {}) {
    const row = { ...r, current: store.subscription(r.device_id, nowIso()) };
    const p = plans[r.plan];
    return mailer.send({
      to: config.adminEmail,
      subject: `Lead Finder activation ${r.id}: ${p.name}${renewed ? ' (new code)' : ''}`,
      html: pages.adminCodeEmail(row, plans, code),
      text: pages.adminCodeText(row, plans, code),
    });
  }

  async function requestActivation(req, res, url) {
    const body = await readBody(req);
    const { deviceId, machineId } = await authenticate(req, url, body);
    const data = parseJson(body);
    if (!PAID_PLAN_IDS.includes(data.plan)) throw new HttpError(400, 'Choose a plan.');
    const open = store.openActivation(deviceId, nowIso());
    if (open?.plan === data.plan) return json(res, 200, { activation: activationView(open) });
    if (store.countActivationsSince(deviceId, new Date(now().getTime() - 86_400_000).toISOString()) >= MAX_REQUESTS_PER_DAY) {
      throw new HttpError(429, 'Too many activation requests today. Please try again tomorrow.');
    }
    const id = c.activationId();
    const code = c.newOtp();
    const { row, created } = store.createActivation({ id, deviceId, machineId, plan: data.plan, otpHash: c.otpHash(otpKey, id, code), otpExpiresAt: later(OTP_TTL_MS), now: nowIso() });
    if (created) {
      try {
        await sendCode(row, code);
      } catch (err) {
        // Nobody has the code: the request is closed so it can be asked again.
        store.cancelActivation(row.id);
        logger.error(`[mail] activation ${row.id} email failed: ${err.code || ''} ${String(err.message).split('\n')[0]}`);
        throw new HttpError(502, 'The activation request could not be sent (email failed). Please try again later.');
      }
      audit(`device:${deviceId}`, 'activation.requested', row.id, { plan: row.plan });
    }
    json(res, created ? 201 : 200, { activation: activationView(store.activation(row.id)) });
  }

  async function verify(req, res, url) {
    const body = await readBody(req);
    const { deviceId } = await authenticate(req, url, body);
    const code = String(parseJson(body).code ?? '').trim();
    if (!/^\d{4}$/.test(code)) throw new HttpError(400, 'Enter the 4-digit code.');
    const open = store.openActivation(deviceId, nowIso());
    if (!open) {
      const last = store.latestActivation(deviceId);
      if (last?.status === 'activated') throw new HttpError(409, 'This code has already been used.', { reason: 'used' });
      if (last?.status === 'expired') throw new HttpError(410, 'This code has expired. Request a new code.', { reason: 'expired' });
      throw new HttpError(409, 'Request an activation code first.', { reason: 'not_open' });
    }
    const claimed = store.claimOtpAttempt(open.id, deviceId);
    if (!claimed) throw new HttpError(429, 'Too many incorrect codes. Request a new code.', { reason: 'locked' });
    const out = store.activateWithOtp({ id: open.id, deviceId, otpHash: c.otpHash(otpKey, open.id, code), matches: c.sameHash, now: nowIso() });
    if (out.error === 'invalid') {
      const left = MAX_OTP_ATTEMPTS - claimed.otp_attempts;
      audit(`device:${deviceId}`, 'activation.code_incorrect', open.id, { attemptsLeft: left });
      throw new HttpError(400, left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Incorrect code. Request a new code.', { reason: left > 0 ? 'invalid' : 'locked', attemptsLeft: left });
    }
    if (out.error === 'expired') throw new HttpError(410, 'This code has expired. Request a new code.', { reason: 'expired' });
    if (out.error) throw new HttpError(409, 'Request an activation code first.', { reason: 'not_open' });
    audit(`device:${deviceId}`, 'activation.activated', open.id, { plan: out.subscription.plan, expiresAt: out.subscription.expiresAt });
    json(res, 200, { activated: true, plan: out.subscription.plan, expiresAt: out.subscription.expiresAt || null });
  }

  async function resend(req, res, url) {
    const body = await readBody(req);
    const { deviceId } = await authenticate(req, url, body);
    const open = store.openActivation(deviceId, nowIso());
    if (!open) throw new HttpError(409, 'Request an activation code first.');
    const code = c.newOtp();
    const out = store.replaceOtp({ id: open.id, otpHash: c.otpHash(otpKey, open.id, code), otpExpiresAt: later(OTP_TTL_MS), now: nowIso(), cooldownMs: OTP_RESEND_MS, maxPerDay: OTP_MAX_PER_DAY });
    if (out.error === 'cooldown') throw new HttpError(429, 'Please wait a minute before requesting another code.', { retryAt: out.retryAt });
    if (out.error === 'limit') throw new HttpError(429, 'Too many codes today. Please try again tomorrow.');
    if (out.error) throw new HttpError(409, 'Request an activation code first.');
    try {
      await sendCode(out.row, code, { renewed: true });
    } catch (err) {
      logger.error(`[mail] code for ${open.id} failed: ${err.code || ''}`);
      throw new HttpError(502, 'The code could not be sent. Please try again later.');
    }
    audit(`device:${deviceId}`, 'activation.code_renewed', open.id, null);
    json(res, 200, { activation: activationView(out.row) });
  }

  // --- daily allowance ----------------------------------------------------------

  // Charges one new qualified lead. `key` identifies the lead (a hash: the
  // server never sees the number), so finding it again, retrying, or the
  // other source finding it costs nothing. The allowance comes from the
  // server's own record of the plan; nothing the app sends changes it.
  async function reserve(req, res, url) {
    const body = await readBody(req);
    const { deviceId, machineId } = await authenticate(req, url, body);
    const data = parseJson(body);
    if (!credits.SOURCES.includes(data.source)) throw new HttpError(400, 'Unknown lead source');
    if (!credits.KEY_RE.test(String(data.key))) throw new HttpError(400, 'Invalid lead key');
    const cs = creditState(deviceId, machineId);
    if (cs.ent.scope === 'blocked') return json(res, 200, { granted: false, reason: 'suspended', credits: cs.view() });
    const bucket = credits.bucketFor(cs.ent, data.source);
    const limit = cs.ent.scope === 'unlimited' ? null : cs.ent.limits[bucket];
    const r = store.reserveCredit({ account: cs.account, key: data.key, day: cs.day, bucket, limit, source: data.source, deviceId, now: nowIso() });
    json(res, 200, { granted: r.granted, duplicate: r.duplicate, reason: r.granted ? null : 'exhausted', credits: cs.view() });
  }

  // --- router -------------------------------------------------------------------------

  async function route(req, res) {
    const url = new URL(localPath(req.url), 'http://local');
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/plans') {
      return json(res, 200, { plans: PAID_PLAN_IDS.map((id) => plans[id]), freePlan: plans.free, paymentMethods: PAYMENT_METHODS, paymentInstructions: config.paymentInstructions || '', timezone });
    }
    if (req.method === 'GET' && p === '/api/license') return license(req, res, url);
    if (req.method === 'POST' && p === '/api/activation') return requestActivation(req, res, url);
    if (req.method === 'POST' && p === '/api/activation/verify') return verify(req, res, url);
    if (req.method === 'POST' && p === '/api/activation/resend') return resend(req, res, url);
    if (req.method === 'POST' && p === '/api/credits/reserve') return reserve(req, res, url);
    if (req.method === 'GET' && p === '/health') return json(res, 200, { ok: true });
    throw new HttpError(404, 'Not found');
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) logger.error(`[error] ${req.method} ${req.url.split('?')[0]}: ${String(err.message).split('\n')[0]}`);
      if (res.headersSent) return res.end();
      if (localPath(req.url).startsWith('/api/')) json(res, status, { error: status === 500 ? 'Server error' : err.message, ...(err.extra || {}) });
      else html(res, status, pages.result('Error', status === 500 ? 'Something went wrong.' : err.message));
    });
  });
  return server;
}

module.exports = { createApp, HttpError, OTP_TTL_MS, OTP_RESEND_MS, OTP_MAX_PER_DAY };
