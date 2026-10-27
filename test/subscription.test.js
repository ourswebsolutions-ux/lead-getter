'use strict';
// Licence server + the app's licence client, over real HTTP, with captured
// email and a controllable clock: the Free plan, activation (code emailed to
// the administrator, entered in the app), the daily allowance as the app
// sees it, suspension, and tampering/replay attempts.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../server/src/app');
const { testLicenseStore } = require('./license-harness');
const { LicenseClient } = require('../src/main/license');
const { LeadStore } = require('../src/database/db');

const DAY = 86_400_000;
const ADMIN = 'info.axoraweb@gmail.com';

async function harness({ failMail = false } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  let t = Date.parse('2026-10-27T05:00:00.000Z');
  const clock = { now: () => new Date(t), advance: (ms) => (t += ms), ms: () => t };
  const mails = [];
  const mailer = { send: async (m) => (failMail ? Promise.reject(Object.assign(new Error('auth failed'), { code: 'EAUTH' })) : mails.push(m)) };
  const config = { publicBaseUrl: 'http://placeholder', adminEmail: ADMIN, licensePrivateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }), timezone: 'Asia/Karachi' };
  const sb = testLicenseStore();
  const server = createApp({ config, store: sb.store, mailer, now: clock.now, logger: { error() {} } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.publicBaseUrl = base;
  const appConfig = { serverUrl: base, publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  // Each client is a separate computer unless a machine id is given.
  const newClient = (over = {}) => new LicenseClient({ store: new LeadStore(':memory:'), cipher: null, config: appConfig, clock: clock.ms, machineId: crypto.randomUUID(), ...over });
  const codeIn = (m) => m.text.match(/Activation code: (\d{4})/)[1];
  return { base, clock, mails, newClient, codeIn, appConfig, sb, close: async () => (server.close(), sb.drop()) };
}

const key = (n) => crypto.createHash('sha256').update(String(n)).digest('hex');

test('a new installation is on Free and can search; paid features stay paid', async (t) => {
  const h = await harness();
  t.after(h.close);
  const s = await h.newClient().status();
  assert.deepEqual([s.reason, s.allowed, s.canSearch, s.sources, s.plan.id, s.activation], ['free', false, true, ['maps', 'facebook'], 'free', null]);
  assert.deepEqual([s.credits.maps, s.credits.facebook], [{ used: 0, limit: 5, remaining: 5 }, { used: 0, limit: 5, remaining: 5 }]);
});

test('activation from the app: plan, code to the administrator, code entered, plan active', async (t) => {
  const h = await harness();
  t.after(h.close);
  const client = h.newClient();
  const r = await client.requestActivation('monthly');
  assert.equal(r.activation.plan, 'monthly');
  assert.deepEqual(h.mails.map((m) => m.to), [ADMIN], 'only the administrator is emailed');
  let s = await client.status();
  assert.deepEqual([s.activation.id, s.activation.status, s.reason], [r.activation.id, 'pending', 'free']);

  const code = h.codeIn(h.mails[0]);
  const wrong = code === '0000' ? '1111' : '0000';
  await assert.rejects(client.verifyCode(wrong), (err) => err.code === 'server' && err.details.reason === 'invalid' && err.details.attemptsLeft === 4 && /Incorrect code\. 4 attempts left/.test(err.message));
  assert.equal((await client.status()).allowed, false);
  const ok = await client.verifyCode(code);
  assert.deepEqual([ok.activated, ok.plan, ok.expiresAt], [true, 'monthly', '2026-11-27T05:00:00.000Z']);
  s = await client.status();
  assert.deepEqual([s.reason, s.allowed, s.canSearch, s.plan.id, s.plan.daysLeft, s.activation], ['active', true, true, 'monthly', 31, null]);
  assert.deepEqual(s.credits.total, { used: 0, limit: 100, remaining: 100 });
  await assert.rejects(client.verifyCode(code), (err) => err.details.reason === 'used');

  // A new code goes to the administrator again.
  const other = h.newClient();
  await other.requestActivation('lifetime');
  h.clock.advance(61_000);
  await other.resendCode();
  assert.equal(h.mails.at(-1).to, ADMIN);
  await other.verifyCode(h.codeIn(h.mails.at(-1)));
  assert.deepEqual([(await other.status()).plan.id, (await other.status()).credits.scope], ['lifetime', 'unlimited']);
});

test('the allowance as the app sees it: per source on Free, exhausted, suspended', async (t) => {
  const h = await harness();
  t.after(h.close);
  const client = h.newClient();
  for (let i = 0; i < 5; i++) assert.equal((await client.reserveCredit('maps', key(i))).granted, true);
  let s = await client.status();
  assert.deepEqual([s.reason, s.canSearch, s.sources], ['free', true, ['facebook']], 'Facebook still has its own five');
  for (let i = 10; i < 15; i++) await client.reserveCredit('facebook', key(i));
  s = await client.status();
  assert.deepEqual([s.reason, s.canSearch, s.sources], ['exhausted', false, []]);
  h.clock.advance(DAY);
  assert.deepEqual((await client.status()).sources, ['maps', 'facebook'], 'a new day');

  h.sb.store.q("INSERT INTO devices (id, public_key, created_at, last_seen_at) VALUES (?, 'x', ?, ?) ON CONFLICT DO NOTHING").run(client.deviceId, 'now', 'now');
  h.sb.store.q("INSERT INTO subscriptions (device_id, plan, status, updated_at) VALUES (?, 'monthly', 'suspended', 'now')").run(client.deviceId);
  s = await client.status();
  assert.deepEqual([s.reason, s.canSearch, s.allowed, s.plan.state], ['suspended', false, false, 'suspended']);
  assert.equal((await client.reserveCredit('maps', key(99))).reason, 'suspended');
});

test('signed status cannot be forged, replayed, or bypassed with the local clock', async (t) => {
  const h = await harness();
  t.after(h.close);
  const client = h.newClient();
  await client.requestActivation('lifetime');
  await client.verifyCode(h.codeIn(h.mails[0]));
  assert.equal((await client.status()).allowed, true);

  // A client trusting a different server key rejects the server's answer.
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const forgedTrust = h.newClient({ config: { ...h.appConfig, publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') } });
  forgedTrust.store = client.store; // same device
  forgedTrust.k = client.keys();
  assert.equal((await forgedTrust.status()).reason, 'invalid');

  // Replaying the exact signed request is refused.
  const { publicKey: pk, privateKey } = client.keys();
  const ts = String(h.clock.ms());
  const pq = '/api/license?nonce=aaaaaaaaaaaaaaaaaaaaaaaa';
  const rn = 'cccccccccccccccccccccc';
  const sig = crypto.sign(null, Buffer.from(`GET\n${pq}\n${ts}\n${rn}\n\n${crypto.createHash('sha256').update('').digest('hex')}`), privateKey).toString('base64');
  const headers = { 'x-lf-key': pk, 'x-lf-ts': ts, 'x-lf-nonce': rn, 'x-lf-sig': sig };
  assert.equal((await fetch(`${h.base}${pq}`, { headers })).status, 200);
  assert.equal((await fetch(`${h.base}${pq}`, { headers })).status, 401);
  // A tampered path fails the signature.
  assert.equal((await fetch(`${h.base}/api/license?nonce=bbbbbbbbbbbbbbbbbbbbbbbb`, { headers: { ...headers, 'x-lf-sig': sig } })).status, 401);

  // Changing this computer's clock does not help: requests are refused.
  const skewed = h.newClient({ clock: () => h.clock.ms() + 400 * DAY });
  skewed.store = client.store;
  skewed.k = client.keys();
  const s = await skewed.status();
  assert.deepEqual([s.allowed, s.canSearch], [false, false]);
  assert.match(s.message, /out of range|could not be verified/i);

  // A device without a code stays on Free, whatever it sends.
  const stranger = h.newClient();
  await assert.rejects(stranger.verifyCode('1234'), (err) => err.details.reason === 'not_open');
  assert.equal((await stranger.status()).allowed, false);
});

test('if the code email cannot be sent, nothing is left half-done', async (t) => {
  const h = await harness({ failMail: true });
  t.after(h.close);
  const client = h.newClient();
  await assert.rejects(client.requestActivation('monthly'), /email failed/);
  assert.equal((await client.status()).activation, null);
});

test('an unreachable local server is reported as "not running", not as an internet problem', async () => {
  const c = new LicenseClient({ store: new LeadStore(':memory:'), cipher: null, config: { serverUrl: 'http://127.0.0.1:9', publicKey: crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }, machineId: 'm' });
  await assert.rejects(c.plans(), /not running \(http:\/\/127\.0\.0\.1:9\)\. Start it with "npm run server"/);
  const s = await c.status();
  assert.deepEqual([s.reason, s.canSearch], ['offline', false]);
  assert.match(s.message, /npm run server/);
});

test('a server not yet updated (status version 1): the earlier rules, nothing charged per lead', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  let v1 = {};
  // Answers like the earlier licence server: the version 1 signed status.
  const fetchImpl = async (url) => {
    const nonce = new URL(url).searchParams.get('nonce');
    const body = Buffer.from(JSON.stringify({ v: 1, deviceId: client.deviceId, nonce, serverTime: '2026-10-27T05:00:00.000Z', ...v1 })).toString('base64url');
    const token = `${body}.${crypto.sign(null, Buffer.from(body), privateKey).toString('base64url')}`;
    return new Response(JSON.stringify({ token }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new LicenseClient({ store: new LeadStore(':memory:'), cipher: null, config: { serverUrl: 'https://example.test/lead-getter', publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }, fetchImpl, machineId: 'm' });

  v1 = { subscription: { state: 'none' }, trial: { limit: 3, used: 1, remaining: 2 } };
  let s = await client.status();
  assert.deepEqual([s.legacy, s.reason, s.canSearch, s.allowed, s.credits, s.plan.id, s.trial.remaining], [true, 'free', true, false, null, 'free', 2]);
  v1 = { subscription: { state: 'none' }, trial: { limit: 3, used: 3, remaining: 0 } };
  s = await client.status();
  assert.deepEqual([s.reason, s.canSearch, s.message], ['exhausted', false, 'Your 3 free searches have been used.']);
  v1 = { subscription: { state: 'active', expiresAt: '2026-11-26T05:00:00.000Z' }, trial: { limit: 3, used: 3, remaining: 0 } };
  s = await client.status();
  assert.deepEqual([s.reason, s.canSearch, s.allowed, s.plan.daysLeft, s.sources], ['active', true, true, 30, ['maps', 'facebook']]);
  v1 = { subscription: { state: 'suspended' }, trial: { limit: 3, used: 0, remaining: 3 } };
  s = await client.status();
  assert.deepEqual([s.reason, s.canSearch], ['suspended', false]);
});
