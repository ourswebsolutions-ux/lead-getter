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
//
// Data: Supabase Postgres (store) and Supabase Storage (screenshots).

const http = require('node:http');
const crypto = require('node:crypto');
const { PLANS, PAYMENT_METHODS, TRIAL_SEARCHES, addMonths } = require('./plans');
const c = require('./crypto');
const pages = require('./pages');

const MAX_BODY = 8 * 1024 * 1024;
const MAX_SCREENSHOT = 5 * 1024 * 1024;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const REISSUE_GAP_MS = 10 * 60 * 1000;
// New applications are always allowed (even with one pending); this only
// stops a flood of emails to the administrator.
const MAX_APPLICATIONS_PER_DAY = 10;
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

function createApp({ config, store, storage, mailer, now = () => new Date(), logger = console }) {
  const privateKey = crypto.createPrivateKey(config.licensePrivateKey);
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
    req.machineId = machine || `device:${deviceId}`;
    return deviceId;
  }

  // Free searches are counted per computer (machine id), so reinstalling or
  // clearing the app's data does not start a new trial.
  async function trialFor(machineId) {
    const used = await store.trialUsed(machineId);
    return { limit: TRIAL_SEARCHES, used: Math.min(used, TRIAL_SEARCHES), remaining: Math.max(0, TRIAL_SEARCHES - used) };
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

  // A new random token; only its hash is stored.
  function makeToken(action, ttl) {
    const token = c.randomToken();
    return { token, hash: c.hashToken(token), action, expiresAt: new Date(now().getTime() + ttl).toISOString() };
  }

  // A valid, unused, unexpired token for this application and action.
  async function checkToken(token, applicationId, action) {
    if (!token || typeof token !== 'string' || token.length > 100) return { error: 'This link is invalid.' };
    const row = await store.token(c.hashToken(token));
    if (!row || row.application_id !== applicationId || row.action !== action) return { error: 'This link is invalid.' };
    if (row.used_at) return { error: 'This link has already been used.', used: true };
    if (row.expires_at < nowIso()) return { error: 'This link has expired.', expired: true };
    return { row };
  }

  async function subscriptionFor(deviceId) {
    const lic = await store.license(deviceId);
    if (!lic) return { state: 'none' };
    const active = !lic.expiresAt || lic.expiresAt > nowIso();
    return { state: active ? 'active' : 'expired', plan: lic.plan, activatedAt: lic.activatedAt, expiresAt: lic.expiresAt || null };
  }

  async function sendAdminEmail(app, approve, cancel, attachment) {
    const approveUrl = link(`/admin/applications/${app.id}/approve?token=${approve}`);
    const cancelUrl = link(`/admin/applications/${app.id}/cancel?token=${cancel}`);
    await mailer.send({
      to: config.adminEmail,
      subject: `Subscription request ${app.id}: ${app.plan.name} (${app.plan.priceLabel})`,
      html: pages.adminEmail(app, approveUrl, cancelUrl),
      text: pages.adminEmailText(app, approveUrl, cancelUrl),
      attachments: attachment ? [attachment] : [],
    });
  }

  // --- API ---------------------------------------------------------------------

  async function apply(req, res, url) {
    const body = await readBody(req);
    const deviceId = await authenticate(req, url, body);
    let data;
    try {
      data = JSON.parse(body.toString('utf8'));
    } catch {
      throw new HttpError(400, 'Invalid JSON');
    }
    const plan = PLANS[data.plan];
    if (!plan) throw new HttpError(400, 'Choose a subscription plan.');
    const message = typeof data.message === 'string' ? data.message.trim() : '';
    if (message.length > 1000) throw new HttpError(400, 'The message is too long (1000 characters maximum).');
    const email = typeof data.email === 'string' && data.email.trim() ? data.email.trim() : null;
    if (email && !EMAIL_RE.test(email)) throw new HttpError(400, 'The email address is not valid.');
    const shot = Buffer.from(typeof data.screenshot?.data === 'string' ? data.screenshot.data : '', 'base64');
    if (!shot.length) throw new HttpError(400, 'Attach the payment screenshot.');
    if (shot.length > MAX_SCREENSHOT) throw new HttpError(400, 'The screenshot is larger than 5 MB.');
    const kind = IMAGE_TYPES.find((t) => t.test(shot));
    if (!kind) throw new HttpError(400, 'The screenshot must be a PNG, JPEG or WebP image.');

    const since = new Date(now().getTime() - 24 * 60 * 60 * 1000).toISOString();
    if ((await store.countApplicationsSince(deviceId, since)) >= MAX_APPLICATIONS_PER_DAY) {
      throw new HttpError(429, 'Too many applications today. Please try again tomorrow.');
    }

    const id = `LF-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const objectPath = `applications/${id}/${crypto.randomBytes(8).toString('hex')}.${kind.ext}`;
    // The screenshot goes to private Supabase Storage first; a failed
    // database insert leaves an orphan that maintenance removes after a day.
    await storage.upload(objectPath, shot, kind.type);
    const approve = makeToken('approve', ACTION_TTL_MS);
    const cancel = makeToken('cancel', ACTION_TTL_MS);
    const verify = email ? makeToken('verify_email', EMAIL_TTL_MS) : null;
    await store.createApplication(
      { id, deviceId, plan: plan.id, message, email, screenshotPath: objectPath, screenshotType: kind.type, screenshotSize: shot.length, screenshotSha256: c.sha256(shot).toString('hex'), createdAt: nowIso() },
      [approve, cancel, ...(verify ? [verify] : [])],
    );

    const app = { id, plan, message, email, deviceId, createdAt: nowIso(), current: await subscriptionFor(deviceId) };
    try {
      await sendAdminEmail(app, approve.token, cancel.token, { filename: `payment-${id}.${kind.ext}`, content: shot, contentType: kind.type });
    } catch (err) {
      // Without the email nobody can approve it: remove the application
      // (it was never seen by anyone) and its upload, so the user retries.
      await store.discardUnsentApplication(id);
      await storage.remove([objectPath]).catch(() => {});
      logger.error(`[mail] admin email for ${id} failed: ${err.code || ''} ${String(err.message).split('\n')[0]}`);
      throw new HttpError(502, 'The application could not be sent for approval (email failed). Please try again later.');
    }
    if (verify) {
      const v = link(`/verify-email?token=${verify.token}`);
      mailer
        .send({ to: email, subject: 'Confirm your email for Lead Finder', html: pages.verifyEmail(v), text: `Confirm your email for Lead Finder: ${v}` })
        .catch((err) => logger.error(`[mail] verification email for ${id} failed: ${err.code || ''}`));
    }
    json(res, 201, { applicationId: id, status: 'pending', plan: plan.id, emailVerificationSent: Boolean(verify) });
  }

  async function license(req, res, url) {
    const body = await readBody(req);
    const deviceId = await authenticate(req, url, body);
    const nonce = url.searchParams.get('nonce') || '';
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw new HttpError(400, 'Missing nonce');
    const [subscription, application, pendingApplications, trial] = await Promise.all([
      subscriptionFor(deviceId),
      store.latestApplication(deviceId),
      store.pendingCount(deviceId),
      trialFor(req.machineId),
    ]);
    const payload = { v: 1, deviceId, nonce, serverTime: nowIso(), subscription, application, pendingApplications, trial };
    json(res, 200, { token: c.signToken(payload, privateKey) });
  }

  // Uses one free search, atomically; refused once all are used.
  async function consumeTrial(req, res, url) {
    const body = await readBody(req);
    const deviceId = await authenticate(req, url, body);
    if ((await subscriptionFor(deviceId)).state === 'active') return json(res, 200, { consumed: false, subscribed: true, trial: await trialFor(req.machineId) });
    if (!(await store.consumeTrial(req.machineId, TRIAL_SEARCHES, nowIso()))) {
      throw new HttpError(402, `Your ${TRIAL_SEARCHES} free searches have been used. Choose a plan to keep searching.`);
    }
    json(res, 200, { consumed: true, trial: await trialFor(req.machineId) });
  }

  // --- admin actions ------------------------------------------------------------

  async function appRow(id) {
    return /^LF-[0-9A-F]{10}$/.test(id) ? store.application(id) : null;
  }

  async function adminPage(req, res, url, id, action) {
    const app = await appRow(id);
    const t = app ? await checkToken(url.searchParams.get('token'), id, action) : { error: 'This link is invalid.' };
    // An expired link of a still-pending application: email fresh links
    // (to the administrator only, at most every 10 minutes).
    if (t.expired && app.status === 'pending') {
      const last = await store.lastTokenIssued(id);
      if (!last || now().getTime() - Date.parse(last) > REISSUE_GAP_MS) {
        const approve = makeToken('approve', ACTION_TTL_MS);
        const cancel = makeToken('cancel', ACTION_TTL_MS);
        await store.addTokens(id, [approve, cancel], nowIso());
        const plan = PLANS[app.plan];
        await sendAdminEmail({ id, plan, message: app.message, email: app.email, deviceId: app.device_id, createdAt: app.created_at, current: await subscriptionFor(app.device_id) }, approve.token, cancel.token);
      }
      return html(res, 410, pages.result('Link expired', `This link has expired, but application ${id} is still pending. Fresh Approve and Cancel links have been emailed to you.`));
    }
    if (t.error) return html(res, t.used ? 409 : 400, pages.result('Link not usable', `${t.error}${app && app.status !== 'pending' ? ` The application is ${app.status}.` : ''}`));
    if (app.status !== 'pending') return html(res, 409, pages.result('Already processed', `Application ${id} is already ${app.status}.`));
    html(res, 200, pages.confirm({ ...app, planInfo: PLANS[app.plan], current: await subscriptionFor(app.device_id) }, action, url.searchParams.get('token')));
  }

  async function adminAction(req, res, id, action) {
    const body = (await readBody(req)).toString('utf8');
    const token = new URLSearchParams(body).get('token');
    const app = await appRow(id);
    if (!app) return html(res, 404, pages.result('Not found', 'This application does not exist.'));
    if (!token || token.length > 100) return html(res, 400, pages.result('Link not usable', 'This link is invalid.'));
    const decidedAt = now();
    // A renewal before expiry continues from the current end date.
    const licenceFor = (row, cur) => {
      const plan = PLANS[row.plan];
      const start = cur && cur.expiresAt && cur.expiresAt > decidedAt.toISOString() ? new Date(cur.expiresAt) : decidedAt;
      const keepLifetime = cur && !cur.expiresAt;
      return { plan: keepLifetime ? cur.plan : plan.id, expiresAt: keepLifetime || plan.months === null ? null : addMonths(start, plan.months).toISOString() };
    };
    const r = await store.decide({ id, tokenHash: c.hashToken(token), action, now: decidedAt.toISOString(), licenceFor });
    if (r.error) {
      const text = { invalid: 'This link is invalid.', used: 'This link has already been used.', expired: 'This link has expired.', processed: `Application ${id} was already ${r.status}.` }[r.error];
      return html(res, r.error === 'used' || r.error === 'processed' ? 409 : 400, pages.result(r.error === 'processed' ? 'Already processed' : 'Link not usable', text));
    }
    const plan = PLANS[app.plan];
    const outcome =
      action === 'approve'
        ? { title: 'Subscription approved', text: `${plan.name} activated for application ${id}. ${r.licence.expiresAt ? `It expires on ${new Date(r.licence.expiresAt).toUTCString()}.` : 'It never expires.'}` }
        : { title: 'Application cancelled', text: `Application ${id} was cancelled. The subscription was not activated.` };
    if (app.email && app.email_verified) {
      const subject = action === 'approve' ? 'Your Lead Finder subscription is active' : 'Your Lead Finder subscription application was not approved';
      const text =
        action === 'approve'
          ? `Your ${plan.name} subscription (application ${id}) is now active.${r.licence.expiresAt ? ` It is valid until ${new Date(r.licence.expiresAt).toUTCString()}.` : ' It never expires.'}`
          : `Your application ${id} was cancelled and no subscription was activated. You can submit a new application in Lead Finder.`;
      mailer.send({ to: app.email, subject, text, html: pages.userNotice(subject, text) }).catch((err) => logger.error(`[mail] user notice for ${id} failed: ${err.code || ''}`));
    }
    html(res, 200, pages.result(outcome.title, outcome.text));
  }

  async function screenshot(req, res, url, id) {
    const app = await appRow(id);
    const token = url.searchParams.get('token');
    let ok = false;
    if (app) for (const a of ['approve', 'cancel']) if (!(await checkToken(token, id, a)).error) ok = true;
    if (!ok) return html(res, 403, pages.result('Not available', 'This link is invalid or has been used.'));
    if (!app.screenshot_path || app.screenshot_deleted_at) return html(res, 410, pages.result('Screenshot removed', 'The screenshot was removed after its retention period.'));
    const data = await storage.download(app.screenshot_path);
    res.writeHead(200, { 'content-type': app.screenshot_type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(data);
  }

  async function verifyEmail(req, res, url) {
    const token = url.searchParams.get('token');
    const ok = token && token.length <= 100 ? await store.verifyEmail(c.hashToken(token), nowIso()) : false;
    if (!ok) return html(res, 400, pages.result('Link not usable', 'This confirmation link is invalid, expired or already used.'));
    html(res, 200, pages.result('Email confirmed', 'Thank you. You will be notified by email when your subscription is approved or cancelled.'));
  }

  // --- router -------------------------------------------------------------------------

  async function route(req, res) {
    const url = new URL(req.url, 'http://local');
    const m = url.pathname.match(/^\/admin\/applications\/([^/]+)\/(approve|cancel|screenshot)$/);
    if (req.method === 'GET' && url.pathname === '/api/plans') {
      return json(res, 200, { plans: Object.values(PLANS), paymentMethods: PAYMENT_METHODS, paymentInstructions: config.paymentInstructions || '', trialSearches: TRIAL_SEARCHES });
    }
    if (req.method === 'POST' && url.pathname === '/api/applications') return apply(req, res, url);
    if (req.method === 'GET' && url.pathname === '/api/license') return license(req, res, url);
    if (req.method === 'POST' && url.pathname === '/api/trial/consume') return consumeTrial(req, res, url);
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
