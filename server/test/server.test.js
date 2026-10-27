'use strict';
// Standalone licence server: activation (an Activation ID and a 4-digit code
// emailed to the administrator only; entering the code activates the plan)
// and the daily qualified-lead allowance, over real HTTP with signed
// requests, a controllable clock and captured email (nothing is sent).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { Store } = require('../src/store');
const c = require('../src/crypto');

const DAY = 86_400_000;
const ADMIN = 'admin@example.com';

async function harness(t, { start = '2026-10-27T05:00:00.000Z' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-server-'));
  const file = path.join(dir, 'subscriptions.db');
  let clock = Date.parse(start);
  const now = () => new Date(clock);
  const mails = [];
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const config = { publicBaseUrl: 'http://placeholder/lead-getter', adminEmail: ADMIN, licensePrivateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }), timezone: 'Asia/Karachi' };
  let failMail = false;
  const mailer = { send: async (m) => (failMail ? Promise.reject(Object.assign(new Error('smtp down'), { code: 'ECONNREFUSED' })) : mails.push(m)) };
  let store = new Store(file);
  let server = createApp({ config, store, mailer, now, logger: { error() {} } });
  const listen = async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    config.publicBaseUrl = `http://127.0.0.1:${server.address().port}/lead-getter`;
  };
  await listen();
  t.after(() => {
    server.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const h = {
    mails,
    store: () => store,
    advance: (ms) => (clock += ms),
    nowIso: () => now().toISOString(),
    failMail: (v) => (failMail = v),
    base: () => config.publicBaseUrl,
    // Restart: a new store and server on the same database file.
    async restart() {
      server.close();
      store.close();
      store = new Store(file);
      server = createApp({ config, store, mailer, now, logger: { error() {} } });
      await listen();
    },
    // A desktop installation; `machine` is the hashed computer id.
    device({ machine = crypto.randomBytes(32).toString('hex') } = {}) {
      const kp = crypto.generateKeyPairSync('ed25519');
      const pk = kp.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
      const deviceId = c.deviceIdFromKey(pk);
      const call = async (method, pq, body) => {
        const payload = body ? JSON.stringify(body) : '';
        const ts = String(clock);
        const nonce = crypto.randomBytes(16).toString('base64url');
        const sig = crypto.sign(null, c.requestDigest(method, pq, ts, nonce, payload, machine), kp.privateKey).toString('base64');
        const res = await fetch(`${config.publicBaseUrl}${pq}`, { method, body: body ? payload : undefined, headers: { 'x-lf-key': pk, 'x-lf-ts': ts, 'x-lf-nonce': nonce, 'x-lf-machine': machine, 'x-lf-sig': sig, 'content-type': 'application/json' } });
        return { status: res.status, body: await res.json() };
      };
      return {
        deviceId,
        machine,
        call,
        async status() {
          const nonce = crypto.randomBytes(18).toString('base64url');
          const r = await call('GET', `/api/license?nonce=${nonce}`);
          assert.equal(r.status, 200, JSON.stringify(r.body));
          const p = c.verifyToken(r.body.token, publicKey);
          assert.ok(p && p.nonce === nonce && p.deviceId === deviceId, 'signed for this request and device');
          return p;
        },
        request: (plan) => call('POST', '/api/activation', { plan }),
        verify: (code) => call('POST', '/api/activation/verify', { code }),
        resend: () => call('POST', '/api/activation/resend', {}),
        reserve: (source, lead) => call('POST', '/api/credits/reserve', { source, key: crypto.createHash('sha256').update(String(lead)).digest('hex') }),
      };
    },
  };
  return h;
}

// The code in the administrator's email.
const codeIn = (mail) => (mail.text.match(/Activation code: (\d{4})/) || [])[1];

// The app asks for `plan`; the administrator's email carries the code.
async function requested(h, d, plan) {
  const r = await d.request(plan);
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
  return { id: r.body.activation.id, code: codeIn(h.mails.findLast((m) => m.subject.includes(r.body.activation.id))) };
}

test('plans: Free plus three paid plans, with their daily allowances', async (t) => {
  const h = await harness(t);
  const plans = await (await fetch(`${h.base()}/api/plans`)).json();
  assert.deepEqual(
    plans.plans.map((p) => [p.id, p.name, p.price, p.months, p.daily]),
    [
      ['monthly', 'Monthly', 3000, 1, { total: 100 }],
      ['six_months', 'Six Months', 10000, 6, { total: 250 }],
      ['lifetime', 'One-Time', 20000, null, null],
    ],
  );
  assert.deepEqual([plans.freePlan.price, plans.freePlan.daily], [0, { maps: 5, facebook: 5 }]);
  assert.equal(plans.timezone, 'Asia/Karachi');
  assert.equal((await fetch(`${h.base()}/api/license?nonce=${'a'.repeat(20)}`)).status, 401, 'unsigned request refused');
});

test('a new installation is on Free: 5 Google Maps and 5 Facebook leads a day', async (t) => {
  const h = await harness(t);
  const d = h.device();
  const st = await d.status();
  assert.deepEqual(st.plan, { id: 'free', name: 'Free', state: 'free', expiresAt: null, activatedAt: null, expiredPlan: null });
  assert.equal(st.activation, null);
  assert.deepEqual(st.credits, {
    day: '2026-10-27',
    timezone: 'Asia/Karachi',
    resetsAt: '2026-10-27T19:00:00.000Z',
    scope: 'per_source',
    total: { used: 0, limit: null, remaining: null },
    maps: { used: 0, limit: 5, remaining: 5 },
    facebook: { used: 0, limit: 5, remaining: 5 },
    discovered: null,
  });
});

test('activation: the code goes to the administrator only; entering it activates the plan', async (t) => {
  const h = await harness(t);
  const d = h.device();
  assert.equal((await d.request('gold')).status, 400, 'a known plan is required');
  assert.equal((await d.request('free')).status, 400, 'Free needs no activation');

  let r = await d.request('six_months');
  assert.equal(r.status, 201);
  const id = r.body.activation.id;
  assert.match(id, /^ACT-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  assert.deepEqual([r.body.activation.status, r.body.activation.plan, r.body.activation.code.attemptsLeft], ['pending', 'six_months', 5]);
  // One email, to the administrator, with the ID, plan and code.
  assert.equal(h.mails.length, 1);
  const mail = h.mails[0];
  assert.equal(mail.to, ADMIN);
  assert.match(mail.subject, new RegExp(`Lead Finder activation ${id}: Six Months`));
  assert.match(mail.text, new RegExp(`Activation ID: ${id}`));
  assert.match(mail.text, /Plan: Six Months: PKR 10,000, 250 leads a day/);
  assert.match(mail.text, new RegExp(`Device ID: ${d.deviceId}`));
  const code = codeIn(mail);
  assert.match(code, /^\d{4}$/);
  assert.ok(!JSON.stringify(h.store().activation(id)).includes(`"${code}"`), 'only an HMAC of the code is stored');
  assert.ok(!JSON.stringify(r.body).includes(code), 'never in an answer');
  // Asking again (reopening the window) keeps the same request and code.
  r = await d.request('six_months');
  assert.deepEqual([r.status, r.body.activation.id, h.mails.length], [200, id, 1]);

  let st = await d.status();
  assert.deepEqual([st.plan.id, st.activation.id, st.activation.status], ['free', id, 'pending']);
  assert.ok(!JSON.stringify(st).includes(code));

  const wrong = code === '0000' ? '1111' : '0000';
  r = await d.verify(wrong);
  assert.deepEqual([r.status, r.body.reason, r.body.attemptsLeft, r.body.error], [400, 'invalid', 4, 'Incorrect code. 4 attempts left.']);
  assert.equal((await d.status()).plan.id, 'free', 'a wrong code activates nothing');
  assert.equal((await d.verify('12a4')).status, 400);
  r = await d.verify(code);
  assert.deepEqual([r.status, r.body.plan, r.body.expiresAt], [200, 'six_months', '2027-04-27T05:00:00.000Z']);
  st = await d.status();
  assert.deepEqual([st.plan.id, st.plan.state, st.activation, st.credits.total], ['six_months', 'active', null, { used: 0, limit: 250, remaining: 250 }]);
  r = await d.verify(code);
  assert.deepEqual([r.status, r.body.reason], [409, 'used'], 'works once');
  assert.deepEqual(h.store().auditLog().map((e) => e.action).reverse(), ['activation.requested', 'activation.code_incorrect', 'activation.activated']);

  // Another device can't use this device's code.
  const other = h.device();
  assert.equal((await other.verify(code)).body.reason, 'not_open');
});

test('codes: lockout after 5 wrong tries (even all at once), new codes, expiry after a day, another plan', async (t) => {
  const h = await harness(t);
  const d = h.device();
  let { id, code } = await requested(h, d, 'lifetime');
  const wrong = code === '9999' ? '9998' : '9999';
  const answers = await Promise.all(Array.from({ length: 20 }, () => d.verify(wrong)));
  assert.equal(answers.filter((a) => a.status === 400).length, 5, 'only 5 guesses are ever compared');
  assert.equal(answers.filter((a) => a.status === 429).length, 15);
  assert.equal((await d.verify(code)).body.reason, 'locked', 'the right code no longer works either');

  // A new code (to the administrator again), with a cooldown and a daily limit.
  assert.equal((await d.resend()).status, 429);
  h.advance(61_000);
  let r = await d.resend();
  assert.equal(r.status, 200);
  assert.equal(r.body.activation.id, id, 'same Activation ID');
  assert.equal(h.mails.at(-1).to, ADMIN);
  assert.match(h.mails.at(-1).subject, /\(new code\)/);
  code = codeIn(h.mails.at(-1));
  for (let i = 0; i < 3; i++) {
    h.advance(61_000);
    assert.equal((await d.resend()).status, 200);
  }
  h.advance(61_000);
  assert.equal((await d.resend()).body.error, 'Too many codes today. Please try again tomorrow.');
  code = codeIn(h.mails.at(-1));

  // A code lasts a day.
  h.advance(25 * 3_600_000);
  r = await d.verify(code);
  assert.deepEqual([r.status, r.body.reason], [410, 'expired']);
  assert.equal((await d.status()).activation, null);

  // A new request; choosing another plan replaces the open request.
  ({ id, code } = await requested(h, d, 'monthly'));
  const second = await requested(h, d, 'six_months');
  assert.notEqual(second.id, id);
  assert.equal((await d.verify(code)).body.reason, 'invalid', "the replaced request's code is gone");
  assert.equal((await d.verify(second.code)).status, 200);
  assert.equal((await d.status()).plan.id, 'six_months');
});

test('requests: limited per day; a failed email leaves nothing half-done', async (t) => {
  const h = await harness(t);
  const e = h.device();
  const plans = ['monthly', 'six_months', 'lifetime', 'monthly', 'six_months'];
  for (const p of plans) assert.equal((await e.request(p)).status, 201);
  assert.equal((await e.request('lifetime')).status, 429);

  h.failMail(true);
  const f = h.device();
  const r = await f.request('monthly');
  assert.deepEqual([r.status, r.body.error], [502, 'The activation request could not be sent (email failed). Please try again later.']);
  h.failMail(false);
  assert.equal((await f.status()).activation, null);
  assert.equal((await f.request('monthly')).status, 201);
});

test('daily allowance on Free: 5 per source, per computer, never charged twice, survives restarts, resets daily', async (t) => {
  const h = await harness(t);
  const d = h.device();
  // Five Google Maps leads; the sixth is refused.
  for (let i = 0; i < 5; i++) assert.equal((await d.reserve('maps', `lead-${i}`)).body.granted, true);
  let r = await d.reserve('maps', 'lead-5');
  assert.deepEqual([r.body.granted, r.body.reason, r.body.credits.maps], [false, 'exhausted', { used: 5, limit: 5, remaining: 0 }]);
  // The same lead again (a retry, or found by Facebook too) is free.
  r = await d.reserve('facebook', 'lead-1');
  assert.deepEqual([r.body.granted, r.body.duplicate], [true, true]);
  assert.equal(r.body.credits.facebook.used, 0);
  // Facebook has its own five.
  for (let i = 10; i < 15; i++) assert.equal((await d.reserve('facebook', `lead-${i}`)).body.granted, true);
  assert.equal((await d.reserve('facebook', 'lead-15')).body.granted, false);

  // Reinstalling on the same computer (new device key) doesn't start over.
  const again = h.device({ machine: d.machine });
  assert.equal((await again.reserve('maps', 'lead-new')).body.granted, false);
  assert.deepEqual((await again.status()).credits.maps, { used: 5, limit: 5, remaining: 0 });

  // A server restart keeps the count.
  await h.restart();
  assert.equal((await d.reserve('maps', 'lead-new')).body.granted, false);

  // Midnight in Karachi (19:00 UTC): a new day.
  h.advance(14 * 3_600_000 + 1);
  const st = await d.status();
  assert.deepEqual([st.credits.day, st.credits.maps.used], ['2026-10-28', 0]);
  assert.equal((await d.reserve('maps', 'lead-new')).body.granted, true);
  // A lead charged yesterday is still not charged again.
  assert.equal((await d.reserve('maps', 'lead-1')).body.duplicate, true);
  assert.equal((await d.reserve('nope', 'x')).status, 400);
});

test('paid plans: one shared daily total, unlimited One-Time, expiry falls back to Free, suspension blocks', async (t) => {
  const h = await harness(t);
  const monthly = h.device();
  await requested(h, monthly, 'monthly').then(({ code }) => monthly.verify(code));
  // Both sources draw from the same 100 (even when asked all at once).
  const asks = [];
  for (let i = 0; i < 130; i++) asks.push(monthly.reserve(i % 2 ? 'facebook' : 'maps', `m-${i}`));
  const results = await Promise.all(asks);
  assert.equal(results.filter((r) => r.body.granted).length, 100);
  const st = await monthly.status();
  assert.deepEqual(st.credits.total, { used: 100, limit: 100, remaining: 0 });
  assert.equal(st.credits.maps.used + st.credits.facebook.used, 100);

  const six = h.device();
  await requested(h, six, 'six_months').then(({ code }) => six.verify(code));
  let six250 = 0;
  for (let i = 0; i < 260; i++) six250 += (await six.reserve('maps', `s-${i}`)).body.granted ? 1 : 0;
  assert.equal(six250, 250);
  assert.equal((await six.status()).plan.expiresAt, '2027-04-27T05:00:00.000Z', 'six calendar months');

  const once = h.device();
  await requested(h, once, 'lifetime').then(({ code }) => once.verify(code));
  for (let i = 0; i < 300; i++) assert.equal((await once.reserve('facebook', `o-${i}`)).body.granted, true);
  let os2 = await once.status();
  assert.deepEqual([os2.credits.scope, os2.credits.total.limit, os2.credits.discovered], ['unlimited', null, 300]);

  // Monthly runs out after one calendar month: back to Free.
  h.advance(31 * DAY);
  const after = await monthly.status();
  assert.deepEqual([after.plan.id, after.plan.state, after.plan.expiredPlan, after.credits.scope], ['free', 'expired', 'monthly', 'per_source']);
  os2 = await once.status();
  assert.deepEqual([os2.plan.id, os2.plan.state], ['lifetime', 'active'], 'One-Time never expires');

  // Suspended: no leads at all, whatever the app asks.
  h.store().setSubscriptionStatus(once.deviceId, 'suspended', h.nowIso());
  const r = await once.reserve('maps', 'o-new');
  assert.deepEqual([r.body.granted, r.body.reason], [false, 'suspended']);
  assert.deepEqual([(await once.status()).plan.state, (await once.status()).credits.scope], ['suspended', 'blocked']);
});
