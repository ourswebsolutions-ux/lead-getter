'use strict';

// HTTP API and admin pages for Lead Finder subscriptions.
//
//   GET  /api/plans                     public plan list
//   POST /api/applications              (device-signed) apply with payment screenshot
//   GET  /api/license?nonce=…           (device-signed) signed subscription status
//   GET  /admin/applications/:id/:action?token=…   confirmation page (approve|cancel)
//   POST /admin/applications/:id/:action           performs it (single use)
//   GET  /admin/applications/:id/screenshot?token=…
//   GET  /verify-email?token=…

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PLANS, addMonths } = require('./plans');
const c = require('./crypto');
const pages = require('./pages');

const MAX_BODY = 8 * 1024 * 1024;
const MAX_SCREENSHOT = 5 * 1024 * 1024;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_APPLICATIONS_PER_DAY = 3;
const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]{1,190}\.[a-z]{2,24}$/i;

const IMAGE_TYPES = [
  { type: 'image/png', ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/webp', ext: 'webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createApp({ config, store, mailer, now = () => new Date(), logger = console }) {
  const privateKey = crypto.createPrivateKey(config.licensePrivateKey);
  const uploads = path.join(config.dataDir, 'uploads');
  fs.mkdirSync(uploads, { recursive: true, mode: 0o700 });
  const nowIso = () => now().toISOString();
  const link = (p) => `${config.publicBaseUrl.replace(/\/$/, '')}${p}`;

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

  // Verifies a device-signed request; returns the device id.
  function authenticate(req, url, body) {
    const key = req.headers['x-lf-key'];
    const ts = Number(req.headers['x-lf-ts']);
    const sig = req.headers['x-lf-sig'];
    if (!key || !ts || !sig) throw new HttpError(401, 'Unsigned request');
    if (Math.abs(now().getTime() - ts) > CLOCK_SKEW_MS) throw new HttpError(401, 'Request time is out of range. Check the computer clock.');
    let publicKey;
    try {
      publicKey = c.publicKeyFromB64(key);
    } catch {
      throw new HttpError(401, 'Invalid device key');
    }
    const ok = crypto.verify(null, c.requestDigest(req.method, url.pathname + url.search, ts, body), publicKey, Buffer.from(String(sig), 'base64'));
    if (!ok) throw new HttpError(401, 'Bad signature');
    if (!store.rememberRequest(c.hashToken(sig), now().getTime(), CLOCK_SKEW_MS * 2)) throw new HttpError(401, 'Replayed request');
    const deviceId = c.deviceIdFromKey(key);
    try {
      store.upsertDevice(deviceId, key, nowIso());
    } catch {
      throw new HttpError(401, 'Device key mismatch');
    }
    return deviceId;
  }

  function json(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(body);
  }

  function html(res, status, body) {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    });
    res.end(body);
  }

  function newToken(applicationId, action, ttl) {
    const token = c.randomToken();
    store.q('INSERT INTO action_tokens (hash, application_id, action, expires_at) VALUES (?, ?, ?, ?)').run(
      c.hashToken(token),
      applicationId,
      action,
      new Date(now().getTime() + ttl).toISOString(),
    );
    return token;
  }

  // A valid, unused, unexpired token for this application and action.
  function checkToken(token, applicationId, action) {
    if (!token || typeof token !== 'string' || token.length > 100) return { error: 'This link is invalid.' };
    const row = store.q('SELECT * FROM action_tokens WHERE hash = ?').get(c.hashToken(token));
    if (!row || row.application_id !== applicationId || row.action !== action) return { error: 'This link is invalid.' };
    if (row.used_at) return { error: 'This link has already been used.', used: true };
    if (row.expires_at < nowIso()) return { error: 'This link has expired.' };
    return { row };
  }

  function subscriptionFor(deviceId) {
    const lic = store.q('SELECT * FROM licenses WHERE device_id = ?').get(deviceId);
    if (!lic) return { state: 'none' };
    const active = !lic.expires_at || lic.expires_at > nowIso();
    return { state: active ? 'active' : 'expired', plan: lic.plan, activatedAt: lic.activated_at, expiresAt: lic.expires_at || null };
  }

  function latestApplication(deviceId) {
    const a = store.q('SELECT id, plan, status, created_at, decided_at FROM applications WHERE device_id = ? ORDER BY created_at DESC LIMIT 1').get(deviceId);
    return a ? { id: a.id, plan: a.plan, status: a.status, createdAt: a.created_at, decidedAt: a.decided_at } : null;
  }

  // --- API ---------------------------------------------------------------------

  async function apply(req, res, url) {
    const body = await readBody(req);
    const deviceId = authenticate(req, url, body);
    let data;
    try {
      data = JSON.parse(body.toString('utf8'));
    } catch {
      throw new HttpError(400, 'Invalid JSON');
    }
    const plan = PLANS[data.plan];
    if (!plan) throw new HttpError(400, 'Choose a subscription plan.');
    const message = typeof data.message === 'string' ? data.message.trim() : '';
    if (message.length < 3 || message.length > 1000) throw new HttpError(400, 'Write a short message with the payment details (3–1000 characters).');
    const email = typeof data.email === 'string' && data.email.trim() ? data.email.trim() : null;
    if (email && !EMAIL_RE.test(email)) throw new HttpError(400, 'The email address is not valid.');
    const shot = Buffer.from(typeof data.screenshot?.data === 'string' ? data.screenshot.data : '', 'base64');
    if (!shot.length) throw new HttpError(400, 'Attach the payment screenshot.');
    if (shot.length > MAX_SCREENSHOT) throw new HttpError(400, 'The screenshot is larger than 5 MB.');
    const kind = IMAGE_TYPES.find((t) => t.test(shot));
    if (!kind) throw new HttpError(400, 'The screenshot must be a PNG, JPEG or WebP image.');

    const since = new Date(now().getTime() - 24 * 60 * 60 * 1000).toISOString();
    if (store.q("SELECT 1 FROM applications WHERE device_id = ? AND status = 'pending'").get(deviceId)) {
      throw new HttpError(409, 'You already have an application awaiting approval.');
    }
    if (store.q('SELECT COUNT(*) n FROM applications WHERE device_id = ? AND created_at >= ?').get(deviceId, since).n >= MAX_APPLICATIONS_PER_DAY) {
      throw new HttpError(429, 'Too many applications today. Please try again tomorrow.');
    }

    const id = `LF-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const file = `${id}-${crypto.randomBytes(8).toString('hex')}.${kind.ext}`;
    fs.writeFileSync(path.join(uploads, file), shot, { mode: 0o600 });
    let approve;
    let cancel;
    let verify = null;
    store.tx(() => {
      store.q(
        "INSERT INTO applications (id, device_id, plan, message, email, screenshot_file, screenshot_type, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
      ).run(id, deviceId, plan.id, message, email, file, kind.type, nowIso());
      approve = newToken(id, 'approve', ACTION_TTL_MS);
      cancel = newToken(id, 'cancel', ACTION_TTL_MS);
      if (email) verify = newToken(id, 'verify_email', EMAIL_TTL_MS);
    });

    const app = { id, plan, message, email, deviceId, createdAt: nowIso(), current: subscriptionFor(deviceId) };
    try {
      await mailer.send({
        to: config.adminEmail,
        subject: `Subscription request ${id}: ${plan.name} (${plan.priceLabel})`,
        html: pages.adminEmail(app, link(`/admin/applications/${id}/approve?token=${approve}`), link(`/admin/applications/${id}/cancel?token=${cancel}`)),
        text: pages.adminEmailText(app, link(`/admin/applications/${id}/approve?token=${approve}`), link(`/admin/applications/${id}/cancel?token=${cancel}`)),
        attachments: [{ filename: `payment-${id}.${kind.ext}`, content: shot, contentType: kind.type }],
      });
    } catch (err) {
      // The application exists; without the email nobody can approve it.
      store.q("UPDATE applications SET status = 'cancelled', decided_at = ? WHERE id = ?").run(nowIso(), id);
      logger.error(`[mail] admin email for ${id} failed: ${err.code || ''} ${String(err.message).split('\n')[0]}`);
      throw new HttpError(502, 'The application could not be sent for approval (email failed). Please try again later.');
    }
    if (verify) {
      mailer
        .send({ to: email, subject: 'Confirm your email for Lead Finder', html: pages.verifyEmail(link(`/verify-email?token=${verify}`)), text: `Confirm your email for Lead Finder: ${link(`/verify-email?token=${verify}`)}` })
        .catch((err) => logger.error(`[mail] verification email for ${id} failed: ${err.code || ''}`));
    }
    json(res, 201, { applicationId: id, status: 'pending', plan: plan.id, emailVerificationSent: Boolean(verify) });
  }

  async function license(req, res, url) {
    const body = await readBody(req);
    const deviceId = authenticate(req, url, body);
    const nonce = url.searchParams.get('nonce') || '';
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw new HttpError(400, 'Missing nonce');
    const payload = { v: 1, deviceId, nonce, serverTime: nowIso(), subscription: subscriptionFor(deviceId), application: latestApplication(deviceId) };
    json(res, 200, { token: c.signToken(payload, privateKey) });
  }

  // --- admin actions ------------------------------------------------------------

  function appRow(id) {
    return /^LF-[0-9A-F]{10}$/.test(id) ? store.q('SELECT * FROM applications WHERE id = ?').get(id) : null;
  }

  async function adminPage(req, res, url, id, action) {
    const app = appRow(id);
    const t = app ? checkToken(url.searchParams.get('token'), id, action) : { error: 'This link is invalid.' };
    if (t.error) return html(res, t.used ? 409 : 400, pages.result('Link not usable', `${t.error}${app && app.status !== 'pending' ? ` The application is ${app.status}.` : ''}`));
    if (app.status !== 'pending') return html(res, 409, pages.result('Already processed', `Application ${id} is already ${app.status}.`));
    html(res, 200, pages.confirm({ ...app, planInfo: PLANS[app.plan], current: subscriptionFor(app.device_id) }, action, url.searchParams.get('token')));
  }

  async function adminAction(req, res, id, action) {
    const body = (await readBody(req)).toString('utf8');
    const token = new URLSearchParams(body).get('token');
    const app = appRow(id);
    if (!app) return html(res, 404, pages.result('Not found', 'This application does not exist.'));
    const decidedAt = now();
    let outcome;
    store.tx(() => {
      const t = checkToken(token, id, action);
      if (t.error) {
        outcome = { status: t.used ? 409 : 400, title: 'Link not usable', text: t.error };
        return;
      }
      // Single transition from pending; a second click changes nothing.
      const changed = store
        .q("UPDATE applications SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
        .run(action === 'approve' ? 'approved' : 'cancelled', decidedAt.toISOString(), id).changes;
      // Both action links for this application are spent either way.
      store.q("UPDATE action_tokens SET used_at = ? WHERE application_id = ? AND action IN ('approve', 'cancel') AND used_at IS NULL").run(decidedAt.toISOString(), id);
      if (!changed) {
        outcome = { status: 409, title: 'Already processed', text: `Application ${id} was already ${appRow(id).status}.` };
        return;
      }
      if (action === 'approve') {
        const plan = PLANS[app.plan];
        // A renewal before expiry continues from the current end date.
        const lic = store.q('SELECT * FROM licenses WHERE device_id = ?').get(app.device_id);
        const start = lic && lic.expires_at && lic.expires_at > decidedAt.toISOString() ? new Date(lic.expires_at) : decidedAt;
        const keepLifetime = lic && !lic.expires_at;
        const expiresAt = keepLifetime || plan.months === null ? null : addMonths(start, plan.months).toISOString();
        store
          .q(
            `INSERT INTO licenses (device_id, plan, application_id, activated_at, expires_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(device_id) DO UPDATE SET plan = excluded.plan, application_id = excluded.application_id, activated_at = excluded.activated_at, expires_at = excluded.expires_at`,
          )
          .run(app.device_id, keepLifetime ? lic.plan : plan.id, id, decidedAt.toISOString(), expiresAt);
        outcome = { status: 200, title: 'Subscription approved', text: `${plan.name} activated for application ${id}. ${expiresAt ? `It expires on ${new Date(expiresAt).toUTCString()}.` : 'It never expires.'}`, expiresAt, plan };
      } else {
        outcome = { status: 200, title: 'Application cancelled', text: `Application ${id} was cancelled. The subscription was not activated.` };
      }
    });
    if (outcome.status === 200) {
      const fresh = appRow(id);
      if (fresh.email && fresh.email_verified) {
        const subject = action === 'approve' ? 'Your Lead Finder subscription is active' : 'Your Lead Finder subscription application was not approved';
        const text =
          action === 'approve'
            ? `Your ${outcome.plan.name} subscription (application ${id}) is now active.${outcome.expiresAt ? ` It is valid until ${new Date(outcome.expiresAt).toUTCString()}.` : ' It never expires.'}`
            : `Your application ${id} was cancelled and no subscription was activated. You can submit a new application in Lead Finder.`;
        mailer.send({ to: fresh.email, subject, text, html: pages.userNotice(subject, text) }).catch((err) => logger.error(`[mail] user notice for ${id} failed: ${err.code || ''}`));
      }
    }
    html(res, outcome.status, pages.result(outcome.title, outcome.text));
  }

  function screenshot(req, res, url, id) {
    const app = appRow(id);
    const token = url.searchParams.get('token');
    const ok = app && ['approve', 'cancel'].some((a) => !checkToken(token, id, a).error);
    if (!ok) return html(res, 403, pages.result('Not available', 'This link is invalid or has been used.'));
    res.writeHead(200, { 'content-type': app.screenshot_type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(fs.readFileSync(path.join(uploads, app.screenshot_file)));
  }

  function verifyEmail(req, res, url) {
    const token = url.searchParams.get('token');
    const row = token ? store.q("SELECT * FROM action_tokens WHERE hash = ? AND action = 'verify_email'").get(c.hashToken(token)) : null;
    if (!row || row.used_at || row.expires_at < nowIso()) return html(res, 400, pages.result('Link not usable', 'This confirmation link is invalid, expired or already used.'));
    store.tx(() => {
      store.q('UPDATE action_tokens SET used_at = ? WHERE hash = ?').run(nowIso(), row.hash);
      store.q('UPDATE applications SET email_verified = 1 WHERE id = ?').run(row.application_id);
    });
    html(res, 200, pages.result('Email confirmed', 'Thank you. You will be notified by email when your subscription is approved or cancelled.'));
  }

  // --- router -------------------------------------------------------------------------

  async function route(req, res) {
    const url = new URL(req.url, 'http://local');
    const m = url.pathname.match(/^\/admin\/applications\/([^/]+)\/(approve|cancel|screenshot)$/);
    if (req.method === 'GET' && url.pathname === '/api/plans') {
      return json(res, 200, { plans: Object.values(PLANS), paymentInstructions: config.paymentInstructions || '' });
    }
    if (req.method === 'POST' && url.pathname === '/api/applications') return apply(req, res, url);
    if (req.method === 'GET' && url.pathname === '/api/license') return license(req, res, url);
    if (m && m[2] === 'screenshot' && req.method === 'GET') return screenshot(req, res, url, m[1]);
    if (m && req.method === 'GET') return adminPage(req, res, url, m[1], m[2]);
    if (m && req.method === 'POST') return adminAction(req, res, m[1], m[2]);
    if (req.method === 'GET' && url.pathname === '/verify-email') return verifyEmail(req, res, url);
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
    throw new HttpError(404, 'Not found');
  }

  return http.createServer((req, res) => {
    route(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) logger.error(`[error] ${req.method} ${req.url.split('?')[0]}: ${String(err.message).split('\n')[0]}`);
      if (res.headersSent) return res.end();
      if (req.url.startsWith('/api/')) json(res, status, { error: status === 500 ? 'Server error' : err.message });
      else html(res, status, pages.result('Error', status === 500 ? 'Something went wrong.' : err.message));
    });
  });
}

module.exports = { createApp, HttpError };
