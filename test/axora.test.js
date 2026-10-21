'use strict';
// Axora subscription website integration, end to end over real HTTP:
//
//   desktop LicenseClient ──signed──▶ Lead Getter licence server ──Bearer──▶ subscription website
//
// The website is its real Express app and Users class
// (../subcription.axorawebsolutions.com, or AXORA_SITE_DIR), with Prisma's
// database calls answered from memory instead of MySQL. When
// that project is not next to this one (CI), a stand-in written from its
// docs/API.md contract is used.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createApp } = require('../server/src/app');
const { AxoraClient } = require('../server/src/axora');
const { testLicenseStore } = require('./license-harness');
const { LicenseClient } = require('../src/main/license');
const { LeadStore } = require('../src/database/db');

const SITE_DIR = process.env.AXORA_SITE_DIR || path.join(__dirname, '..', '..', 'subcription.axorawebsolutions.com');
const REAL_SITE = fs.existsSync(path.join(SITE_DIR, 'src', 'app.js')) && fs.existsSync(path.join(SITE_DIR, 'node_modules', 'express'));
const ADMIN_TOKEN = 'a'.repeat(48);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(100)]);
const DAY = 86_400_000;

// --- subscription website ---------------------------------------------------

// The website's Prisma calls (src/users.js), on in-memory records. MySQL LIKE
// escapes (\_ \% \\) that users.js adds are undone, as MySQL would.
class MemoryPrisma {
  constructor(now) {
    const rows = new Map();
    const unlike = (v) => v.replace(/\\([\\%_])/g, '$1');
    const copy = (u) => u && structuredClone(u);
    const dup = (target) => Object.assign(new Error(`Unique constraint failed on ${target}`), { code: 'P2002', meta: { target } });
    this.user = {
      findMany: async ({ where }) =>
        [...rows.values()]
          .filter((u) => !where || where.OR.some((c) => (c.id ? u.id.startsWith(unlike(c.id.startsWith)) : u.email.includes(unlike(c.email.contains)))))
          .sort((x, y) => y.createdAt - x.createdAt || (x.id < y.id ? -1 : 1))
          .map(copy),
      findUnique: async ({ where }) => copy(rows.get(where.id)) || null,
      create: async ({ data }) => {
        if (rows.has(data.id)) throw dup('PRIMARY');
        if ([...rows.values()].some((u) => u.email === data.email)) throw dup('users_email_unique');
        const t = now();
        rows.set(data.id, { id: data.id, email: data.email, createdAt: t, updatedAt: t, subscription: { userId: data.id, status: data.subscription.create.status, expiresAt: null, activatedAt: null, suspendedAt: null, updatedAt: t } });
        return copy(rows.get(data.id));
      },
      deleteMany: async ({ where }) => ({ count: rows.delete(where.id) ? 1 : 0 }),
    };
    this.subscription = {
      updateMany: async ({ where, data }) => {
        const u = rows.get(where.userId);
        if (!u || (where.status?.not && u.subscription.status === where.status.not)) return { count: 0 };
        Object.assign(u.subscription, data, { updatedAt: now() });
        return { count: 1 };
      },
    };
  }
}

// For the stand-in: users as the website returns them.
class MemoryUsers {
  constructor(now) {
    this.rows = new Map();
    this.now = now;
  }
  out(r) {
    const expired = r.status === 'active' && r.expiresAt && r.expiresAt <= this.now();
    return { id: r.id, email: r.email, subscription: { status: r.status, effectiveStatus: expired ? 'expired' : r.status, expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null } };
  }
  async list(search = '') {
    const t = search.trim();
    return [...this.rows.values()].filter((r) => !t || r.id.startsWith(t) || r.email.includes(t.toLowerCase())).map((r) => this.out(r));
  }
  async create({ id, email }) {
    if (this.rows.has(id)) throw new Error('user_exists');
    if ([...this.rows.values()].some((r) => r.email === email)) throw new Error('email_exists');
    this.rows.set(id, { id, email, status: 'inactive', expiresAt: null });
    return this.out(this.rows.get(id));
  }
  async remove(id) {
    return this.rows.delete(id);
  }
  async activate(id, expiresAt) {
    const r = this.rows.get(id);
    return r ? (Object.assign(r, { status: 'active', expiresAt }), this.out(r)) : null;
  }
  async suspend(id) {
    const r = this.rows.get(id);
    return r ? ((r.status = 'suspended'), this.out(r)) : null;
  }
}

// Stand-in for CI: the routes Lead Getter uses, per docs/API.md.
function contractSite(users) {
  const send = (res, status, data) => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(data)));
  const err = (res, status, code) => send(res, status, { error: { code, message: code } });
  return http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) return err(res, 401, 'unauthorized');
    const url = new URL(req.url, 'http://x');
    let body = '';
    for await (const d of req) body += d;
    const data = body ? JSON.parse(body) : {};
    const sub = url.pathname.match(/^\/api\/v1\/users\/([A-Za-z0-9_-]{3,64})\/subscription$/);
    if (req.method === 'GET' && url.pathname === '/api/v1/users') {
      const list = await users.list(url.searchParams.get('search') || '');
      return send(res, 200, { users: list, count: list.length });
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/users') {
      try {
        return send(res, 201, { user: await users.create({ id: data.id, email: String(data.email).toLowerCase() }) });
      } catch (e) {
        return err(res, 409, /email/.test(e.message) ? 'email_exists' : 'user_exists');
      }
    }
    const one = url.pathname.match(/^\/api\/v1\/users\/([A-Za-z0-9_-]{3,64})$/);
    if (req.method === 'DELETE' && one) return (await users.remove(one[1])) ? send(res, 200, { deleted: true, id: one[1] }) : err(res, 404, 'user_not_found');
    if (req.method === 'PATCH' && sub) {
      const user = data.status === 'active' ? await users.activate(sub[1], data.expiresAt === null ? null : new Date(data.expiresAt)) : await users.suspend(sub[1]);
      return user ? send(res, 200, { user, status: user.subscription.effectiveStatus }) : err(res, 404, 'user_not_found');
    }
    err(res, 404, 'not_found');
  });
}

async function startSite() {
  let offset = 0;
  const now = () => new Date(Date.now() + offset);
  const users = REAL_SITE ? new (require(path.join(SITE_DIR, 'src', 'users.js')).Users)(new MemoryPrisma(now), { now }) : new MemoryUsers(now);
  let server;
  if (REAL_SITE) {
    const site = require(path.join(SITE_DIR, 'src', 'app.js'));
    const config = { admin: { username: 'admin', password: 'correct-horse-battery', apiToken: ADMIN_TOKEN }, publicOrigin: 'https://subscription.axorawebsolutions.com', trustProxy: false };
    server = http.createServer(site.createApp({ config, users, now, logger: { error() {}, log() {}, info() {}, warn() {} } }));
  } else server = contractSite(users);
  const requests = [];
  // fromAdmin: calls made by this test as the administrator; the rest come
  // from the licence server.
  server.on('request', (req) => requests.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', fromAdmin: req.headers['x-test-admin'] === '1' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  // What the administrator does on the website.
  const admin = async (method, p, body) => {
    const res = await fetch(`${base}${p}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json', 'x-test-admin': '1' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const port = server.address().port;
  const close = () => new Promise((r) => (server.closeAllConnections?.(), server.close(r)));
  return {
    base,
    users,
    requests,
    admin,
    // Registrations and other calls the licence server made.
    serverCalls: (method) => requests.filter((r) => !r.fromAdmin && r.method === method),
    advance: (ms) => (offset += ms),
    close,
    // Downtime and recovery on the same address, keeping the records.
    down: close,
    up: () => new Promise((r) => server.listen(port, '127.0.0.1', r)),
  };
}

// --- Lead Getter licence server + desktop client ------------------------------

// prefix: the licence server is published under a path (as in production,
// https://subscription.axorawebsolutions.com/lead-getter). clientPrefix: the
// path the app uses (none = a proxy that strips the prefix before the server).
async function harness({ siteUrl, token = ADMIN_TOKEN, timeoutMs = 2000, prefix = '', clientPrefix = prefix } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const mails = [];
  const errors = [];
  const sb = testLicenseStore();
  const config = { publicBaseUrl: 'http://placeholder', adminEmail: 'info.axoraweb@gmail.com', licensePrivateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }) };
  const axora = new AxoraClient({ baseUrl: siteUrl, token, timeoutMs });
  const server = createApp({ config, store: sb.store, storage: sb.storage, mailer: { send: async (m) => mails.push(m) }, axora, logger: { error: (m) => errors.push(m) } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.publicBaseUrl = `${base}${prefix}`;
  // The desktop app's configuration: licence server URL and public key only.
  const appConfig = { serverUrl: `${base}${clientPrefix}`, publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  const newClient = () => new LicenseClient({ store: new LeadStore(':memory:'), cipher: null, config: appConfig, machineId: crypto.randomUUID() });
  const confirm = async (url) => {
    const u = new URL(url.replace(/&amp;/g, '&'));
    return fetch(`${u.origin}${u.pathname}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(u.searchParams.get('token'))}` });
  };
  return { base, appConfig, mails, errors, newClient, confirm, store: sb.store, axora, close: () => (server.close(), sb.drop()) };
}

const futureIso = (ms) => new Date(Date.now() + ms).toISOString();

// --- tests ------------------------------------------------------------------

test(`website decides paid access (${REAL_SITE ? 'real subscription website app' : 'API contract stand-in'})`, async (t) => {
  const site = await startSite();
  const h = await harness({ siteUrl: site.base });
  t.after(async () => (h.close(), await site.close()));
  const app = h.newClient();
  const id = app.deviceId;

  // Not on the website yet: the 3 free searches work as before.
  let st = await app.status();
  assert.equal(st.reason, 'trial');
  assert.equal(st.allowed, false);
  assert.equal(st.canSearch, true);
  for (let i = 0; i < 3; i++) assert.equal((await app.consumeTrial()).consumed, true);
  await assert.rejects(app.consumeTrial(), /free searches have been used/);
  st = await app.status();
  assert.equal(st.reason, 'trial_used');
  assert.equal(st.canSearch, false);

  // Registered but not activated.
  assert.equal((await site.admin('POST', '/users', { id, email: 'customer@example.com' })).status, 201);
  st = await app.status();
  assert.equal(st.reason, 'inactive');
  assert.match(st.message, /not been activated/);

  // Activated with an expiry: paid searches allowed, no free search used.
  const expiresAt = futureIso(30 * DAY);
  assert.equal((await site.admin('PATCH', `/users/${id}/subscription`, { status: 'active', expiresAt })).status, 200);
  st = await app.status();
  assert.equal(st.reason, 'active');
  assert.equal(st.allowed, true);
  assert.equal(st.subscription.expiresAt, new Date(expiresAt).toISOString());
  assert.equal(st.subscription.daysLeft, 30);
  assert.equal((await app.consumeTrial()).subscribed, true);

  // Suspended on the website: blocked at the next check, with the reason.
  await site.admin('PATCH', `/users/${id}/subscription`, { status: 'suspended' });
  st = await app.status();
  assert.equal(st.reason, 'suspended');
  assert.equal(st.allowed, false);
  assert.equal(st.canSearch, false);
  assert.match(st.message, /suspended/);

  // Re-activated, then the expiry passes (website clock): expired.
  await site.admin('PATCH', `/users/${id}/subscription`, { status: 'active', expiresAt: futureIso(DAY) });
  assert.equal((await app.status()).reason, 'active');
  site.advance(2 * DAY);
  st = await app.status();
  assert.equal(st.reason, 'expired');
  assert.equal(st.allowed, false);
  assert.match(st.message, /expired/);

  // Lifetime (no expiry).
  site.advance(-2 * DAY);
  await site.admin('PATCH', `/users/${id}/subscription`, { status: 'active', expiresAt: null });
  st = await app.status();
  assert.equal(st.reason, 'active');
  assert.equal(st.subscription.expiresAt, null);

  // Another installation is a different user on the website.
  const other = h.newClient();
  assert.equal((await other.status()).reason, 'trial');

  // Every website call came from the licence server with the admin token;
  // the desktop app's own configuration holds no token.
  assert.ok(site.requests.length > 0);
  assert.ok(site.requests.every((r) => r.auth === `Bearer ${ADMIN_TOKEN}`));
  assert.ok(!JSON.stringify(h.appConfig).includes(ADMIN_TOKEN));
});

test('suspended or expired users keep their remaining free searches, with the reason shown', async (t) => {
  const site = await startSite();
  const h = await harness({ siteUrl: site.base });
  t.after(async () => (h.close(), await site.close()));
  const app = h.newClient();
  await site.admin('POST', '/users', { id: app.deviceId, email: 'free@example.com' });
  await site.admin('PATCH', `/users/${app.deviceId}/subscription`, { status: 'suspended' });
  const st = await app.status();
  assert.equal(st.reason, 'suspended');
  assert.equal(st.allowed, false);
  assert.equal(st.canSearch, true, 'free searches are not paid features');
  assert.match(st.message, /suspended.*You can still use 3 free searches\./s);
  assert.equal((await app.consumeTrial()).consumed, true);
});

test('website unreachable, refusing the token or too slow: access is not granted and nothing crashes', async (t) => {
  // Down: nothing listens there.
  const down = await startSite();
  const downUrl = down.base;
  await down.close();
  const h1 = await harness({ siteUrl: downUrl });
  t.after(() => h1.close());
  const a = h1.newClient();
  let st = await a.status();
  assert.equal(st.reason, 'unavailable');
  assert.equal(st.allowed, false);
  assert.match(st.message, /could not be confirmed/);
  assert.equal(st.canSearch, true, 'free searches still counted by the licence server');
  assert.match(h1.errors.join('\n'), /unreachable/);

  // Wrong token (401 unauthorized).
  const site = await startSite();
  t.after(() => site.close());
  const h2 = await harness({ siteUrl: site.base, token: 'wrong-token-'.padEnd(40, 'x') });
  t.after(() => h2.close());
  const b = h2.newClient();
  await site.admin('POST', '/users', { id: b.deviceId, email: 'b@example.com' });
  await site.admin('PATCH', `/users/${b.deviceId}/subscription`, { status: 'active', expiresAt: null });
  st = await b.status();
  assert.equal(st.reason, 'unavailable');
  assert.equal(st.allowed, false);
  assert.match(h2.errors.join('\n'), /401/);

  // Hangs: the licence server gives up after its timeout and still answers.
  const hang = http.createServer(() => {});
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  t.after(() => (hang.closeAllConnections(), hang.close()));
  const h3 = await harness({ siteUrl: `http://127.0.0.1:${hang.address().port}/api/v1`, timeoutMs: 300 });
  t.after(() => h3.close());
  const started = Date.now();
  st = await h3.newClient().status();
  assert.equal(st.reason, 'unavailable');
  assert.ok(Date.now() - started < 5000);
  assert.match(h3.errors.join('\n'), /timeout/);

  // The licence server itself unreachable: offline, as before.
  const lone = new LicenseClient({ store: new LeadStore(':memory:'), cipher: null, config: { ...h3.appConfig, serverUrl: downUrl.replace('/api/v1', '') }, machineId: 'x' });
  st = await lone.status();
  assert.equal(st.reason, 'offline');
  assert.equal(st.canSearch, false);
});

test('email Approve activates the device on the website', async (t) => {
  const site = await startSite();
  const h = await harness({ siteUrl: site.base });
  t.after(async () => (h.close(), await site.close()));
  const app = h.newClient();

  const r = await app.apply({ plan: 'six_months', message: '', email: 'buyer@example.com', screenshot: { type: 'image/png', data: PNG } });
  assert.equal(r.status, 'pending');
  const mail = h.mails.find((m) => m.subject.includes(r.applicationId));
  const approve = mail.html.match(/href="([^"]*\/approve\?token=[^"]+)"/)[1];
  const res = await h.confirm(approve);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Subscription approved/);

  const user = (await site.admin('GET', `/users?search=${app.deviceId}`)).body.users[0];
  assert.equal(user.email, 'buyer@example.com');
  assert.equal(user.subscription.effectiveStatus, 'active');
  const months = (Date.parse(user.subscription.expiresAt) - Date.now()) / DAY;
  assert.ok(months > 180 && months < 186, `about six months (${months} days)`);
  const st = await app.status();
  assert.equal(st.reason, 'active');
  assert.equal(st.subscription.expiresAt, user.subscription.expiresAt);

  // Suspending it on the website overrides the email approval.
  await site.admin('PATCH', `/users/${app.deviceId}/subscription`, { status: 'suspended' });
  assert.equal((await app.status()).reason, 'suspended');
});

test('email Approve of an old application without an email, or with the website down, changes nothing', async (t) => {
  const site = await startSite();
  const h = await harness({ siteUrl: site.base });
  t.after(async () => (h.close(), await site.close().catch(() => {})));
  const app = h.newClient();
  // Applications from before email became required have none.
  const r = await app.apply({ plan: 'monthly', message: '', email: 'old@example.com', screenshot: { type: 'image/png', data: PNG } });
  await site.admin('DELETE', `/users/${app.deviceId}`);
  h.store.q('UPDATE applications SET email = NULL WHERE id = ?').run(r.applicationId);
  const approve = h.mails.find((m) => m.subject.includes(r.applicationId)).html.match(/href="([^"]*\/approve\?token=[^"]+)"/)[1];
  const res = await h.confirm(approve);
  assert.equal(res.status, 409);
  assert.match(await res.text(), /no email address/);
  assert.equal((await site.admin('GET', `/users?search=${app.deviceId}`)).body.count, 0);
  let st = await app.status();
  assert.equal(st.application.status, 'pending');
  assert.equal(st.allowed, false);

  // With an email but the website down: link stays usable for later.
  const r2 = await app.apply({ plan: 'monthly', message: '', email: 'later@example.com', screenshot: { type: 'image/png', data: PNG } });
  const approve2 = h.mails.find((m) => m.subject.includes(r2.applicationId)).html.match(/href="([^"]*\/approve\?token=[^"]+)"/)[1];
  await site.close();
  const res2 = await h.confirm(approve2);
  assert.equal(res2.status, 503);
  assert.match(await res2.text(), /could not be reached/);
  st = await app.status();
  assert.equal(st.application.status, 'pending');
});

// --- registration when the app connects ----------------------------------------

const applyAs = (app, email) => app.apply({ plan: 'monthly', message: '', email, screenshot: { type: 'image/png', data: PNG } });
const useUpTrial = async (app) => {
  for (let i = 0; i < 3; i++) await app.consumeTrial();
};

test('new Device ID: registered once with the customer email, inactive, no paid access', async (t) => {
  const site = await startSite();
  const h = await harness({ siteUrl: site.base });
  t.after(async () => (h.close(), await site.close()));
  const app = h.newClient();

  // No application yet: no email on file, nothing registered.
  let st = await app.status();
  assert.equal(st.registration.state, 'no_email');
  assert.equal(site.serverCalls('POST').length, 0);

  const r = await applyAs(app, 'New.Customer@Example.com');
  assert.equal(r.status, 'pending');
  const users = (await site.admin('GET', `/users?search=${app.deviceId}`)).body.users;
  assert.equal(users.length, 1);
  assert.equal(users[0].id, app.deviceId, 'Device ID kept exactly (case-sensitive)');
  assert.equal(users[0].email, 'new.customer@example.com');
  assert.equal(users[0].subscription.status, 'inactive');
  assert.match(h.mails.find((m) => m.subject.includes(r.applicationId)).text, /Subscription website: Device ID registered/);

  // Registration grants nothing (the app shows the pending application).
  await useUpTrial(app);
  st = await app.status();
  assert.equal(st.registration.state, 'registered');
  assert.equal(st.subscription.state, 'inactive');
  assert.equal(st.reason, 'pending');
  assert.equal(st.allowed, false);
  assert.equal(st.canSearch, false);

  // Further checks only read; no duplicate registration.
  await app.status();
  await app.status();
  assert.equal(site.serverCalls('POST').length, 1);
  assert.equal(site.serverCalls('PATCH').length, 0, 'never activated automatically');

  // Activated by the administrator on the website: paid access.
  await site.admin('PATCH', `/users/${app.deviceId}/subscription`, { status: 'active', expiresAt: futureIso(30 * DAY) });
  st = await app.status();
  assert.equal(st.reason, 'active');
  assert.equal(st.allowed, true);
});

test('existing Device ID and email: status is read, nothing is created or changed', async (t) => {
  const site = await startSite();
  const h = await harness({ siteUrl: site.base });
  t.after(async () => (h.close(), await site.close()));
  const same = h.newClient();
  await site.admin('POST', '/users', { id: same.deviceId, email: 'known@example.com' });
  await site.admin('PATCH', `/users/${same.deviceId}/subscription`, { status: 'active', expiresAt: futureIso(10 * DAY) });
  await applyAs(same, 'known@example.com');
  let st = await same.status();
  assert.equal(st.reason, 'active');
  assert.equal(st.subscription.daysLeft, 10);

  // Registered under another email: kept as it is on the website.
  const other = h.newClient();
  await site.admin('POST', '/users', { id: other.deviceId, email: 'first@example.com' });
  await applyAs(other, 'second@example.com');
  st = await other.status();
  assert.equal(st.registration.state, 'registered');
  assert.equal((await site.admin('GET', `/users?search=${other.deviceId}`)).body.users[0].email, 'first@example.com');

  assert.equal(site.serverCalls('POST').length, 0);
  assert.equal(site.serverCalls('PATCH').length, 0);
});

test('duplicate Device ID and duplicate email are handled without changing the existing account', async (t) => {
  const site = await startSite();
  const h = await harness({ siteUrl: site.base });
  t.after(async () => (h.close(), await site.close()));

  // Duplicate Device ID (e.g. registered on the website a moment earlier).
  const axora = new AxoraClient({ baseUrl: site.base, token: ADMIN_TOKEN });
  await site.admin('POST', '/users', { id: 'Dup_Device-ID-0001', email: 'dup-id@example.com' });
  assert.deepEqual(await axora.register('Dup_Device-ID-0001', 'other@example.com').then((r) => r.state), 'exists');
  assert.equal((await site.admin('GET', '/users?search=Dup_Device-ID-0001')).body.users[0].email, 'dup-id@example.com');
  // IDs differing only in case are different users.
  assert.equal((await axora.register('dup_device-id-0001', 'lower@example.com')).state, 'registered');

  // Duplicate email: it belongs to another (active) device.
  const owner = h.newClient();
  await site.admin('POST', '/users', { id: owner.deviceId, email: 'shared@example.com' });
  await site.admin('PATCH', `/users/${owner.deviceId}/subscription`, { status: 'active', expiresAt: null });
  const before = (await site.admin('GET', `/users?search=${owner.deviceId}`)).body.users[0];

  const app = h.newClient();
  const r = await applyAs(app, 'shared@example.com');
  assert.equal(r.status, 'pending', 'the application itself is still accepted');
  assert.match(h.mails.find((m) => m.subject.includes(r.applicationId)).text, /already belongs to another Device ID/);
  await useUpTrial(app);
  const st = await app.status();
  assert.equal(st.reason, 'email_in_use');
  assert.equal(st.allowed, false);
  assert.match(st.message, /already linked to another Lead Getter device/);
  await app.status();

  assert.equal((await site.admin('GET', `/users?search=${app.deviceId}`)).body.count, 0, 'not registered');
  assert.deepEqual((await site.admin('GET', `/users?search=${owner.deviceId}`)).body.users[0], before, 'existing account untouched');
  assert.equal(site.serverCalls('PATCH').length + site.serverCalls('DELETE').length, 0);
  assert.equal(h.errors.filter((e) => /already belongs/.test(e)).length, 1, 'logged once, not on every check');
  assert.equal((await owner.status()).reason, 'active');
});

test('missing or invalid email: application refused, nothing sent to the website', async (t) => {
  const site = await startSite();
  const h = await harness({ siteUrl: site.base });
  t.after(async () => (h.close(), await site.close()));
  const app = h.newClient();
  const send = (email) => app.apply({ plan: 'monthly', message: '', email, screenshot: { type: 'image/png', data: PNG } });
  await assert.rejects(send(undefined), /Enter your email address/);
  await assert.rejects(send('   '), /Enter your email address/);
  for (const bad of ['no-at-sign', 'a@b', 'two@@example.com', 'spaces in@example.com', 'x@example.c0m', `${'a'.repeat(65)}@example.com`]) {
    await assert.rejects(send(bad), /email address is not valid/, bad);
  }
  assert.equal(site.serverCalls('POST').length, 0);
  assert.equal(h.mails.length, 0);
  assert.equal((await app.status()).registration.state, 'no_email');
});

test('website down at registration: application accepted, registered once it is back', async (t) => {
  const site = await startSite();
  const h = await harness({ siteUrl: site.base });
  t.after(async () => (h.close(), await site.close().catch(() => {})));
  const app = h.newClient();

  await site.down();
  const r = await applyAs(app, 'patient@example.com');
  assert.equal(r.status, 'pending');
  assert.match(h.mails.find((m) => m.subject.includes(r.applicationId)).text, /Not reachable right now; registration is retried automatically/);
  let st = await app.status();
  assert.equal(st.reason, 'unavailable');
  assert.equal(st.allowed, false);
  assert.equal(st.canSearch, true, 'free searches still work');

  await site.up();
  st = await app.status();
  assert.equal(st.registration.state, 'registered');
  const user = (await site.admin('GET', `/users?search=${app.deviceId}`)).body.users[0];
  assert.equal(user.email, 'patient@example.com');
  assert.equal(user.subscription.effectiveStatus, 'inactive');
  assert.equal(st.allowed, false);
});

test('invalid API token: no registration, no access, recovers with the right token', async (t) => {
  const site = await startSite();
  const bad = await harness({ siteUrl: site.base, token: 'not-the-website-token'.padEnd(48, 'x') });
  t.after(async () => (bad.close(), await site.close()));
  const app = bad.newClient();
  const r = await applyAs(app, 'token@example.com');
  assert.equal(r.status, 'pending');
  const st = await app.status();
  assert.equal(st.reason, 'unavailable');
  assert.equal(st.allowed, false);
  assert.equal((await site.admin('GET', `/users?search=${app.deviceId}`)).body.count, 0);
  assert.match(bad.errors.join('\n'), /401/);
  assert.ok(site.requests.filter((q) => !q.fromAdmin).every((q) => q.method === 'GET'), 'nothing written with a refused token');

  // Token corrected (server/.env fixed and the server restarted): the next
  // check registers the device, still inactive.
  bad.axora.token = ADMIN_TOKEN;
  const after = await app.status();
  assert.equal(after.registration.state, 'registered');
  assert.equal(after.allowed, false);
  assert.equal((await site.admin('GET', `/users?search=${app.deviceId}`)).body.users[0].subscription.status, 'inactive');
});

test('licence server published under a path, as in production (/lead-getter)', async (t) => {
  const site = await startSite();
  t.after(() => site.close());
  for (const clientPrefix of ['/lead-getter', '']) {
    const h = await harness({ siteUrl: site.base, prefix: '/lead-getter', clientPrefix });
    t.after(() => h.close());
    const app = h.newClient();

    // Signed status, free searches and plans through the prefixed address.
    assert.equal((await app.status()).reason, 'trial');
    assert.equal((await app.consumeTrial()).consumed, true);
    assert.equal((await app.plans()).plans.length, 3);
    await site.admin('POST', '/users', { id: app.deviceId, email: `p${clientPrefix.length}@example.com` });
    await site.admin('PATCH', `/users/${app.deviceId}/subscription`, { status: 'active', expiresAt: futureIso(DAY * 10) });
    assert.equal((await app.status()).reason, 'active');

    // Email links carry the prefix; the confirmation page's form and
    // screenshot are relative to it.
    const other = h.newClient();
    const r = await other.apply({ plan: 'monthly', message: '', email: `q${clientPrefix.length}@example.com`, screenshot: { type: 'image/png', data: PNG } });
    const approve = h.mails.find((m) => m.subject.includes(r.applicationId)).html.match(/href="([^"]*\/approve\?token=[^"]+)"/)[1].replace(/&amp;/g, '&');
    assert.ok(approve.startsWith(`${h.base}/lead-getter/admin/applications/`));
    const page = await (await fetch(approve)).text();
    assert.match(page, /<form method="post" action="approve"/);
    assert.match(page, /<img src="screenshot\?token=/);
    const shot = await fetch(new URL(page.match(/<img src="([^"]+)"/)[1].replace(/&amp;/g, '&'), approve));
    assert.equal(shot.status, 200);
    assert.equal((await h.confirm(approve)).status, 200);
    assert.equal((await other.status()).reason, 'active');
  }
});
