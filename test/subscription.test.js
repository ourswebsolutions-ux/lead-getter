'use strict';
// Licence server + app client, over real HTTP, with a fake mailer and a
// controllable clock. Covers applications, email approval/cancellation,
// expiry, lifetime, and tampering/replay attempts.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/src/app');
const { testLicenseStore } = require('./license-harness');
const { LicenseClient } = require('../src/main/license');
const { LeadStore } = require('../src/database/db');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(200)]);
const DAY = 86_400_000;

async function harness({ failMail = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-sub-'));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  let t = Date.parse('2026-10-21T10:00:00.000Z');
  const clock = { now: () => new Date(t), advance: (ms) => (t += ms), ms: () => t };
  // mails: to the administrator; allMails: everything (applicants too).
  const mails = [];
  const allMails = [];
  const mailer = { send: async (m) => (failMail ? Promise.reject(Object.assign(new Error('auth failed'), { code: 'EAUTH' })) : (allMails.push(m), m.to === config.adminEmail && mails.push(m))) };
  const config = { publicBaseUrl: 'http://placeholder', adminEmail: 'info.axoraweb@gmail.com', paymentInstructions: 'JazzCash 0300-0000000', licensePrivateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }) };
  const sb = testLicenseStore();
  const server = createApp({ config, store: sb.store, storage: sb.storage, mailer, now: clock.now, logger: { error() {} } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.publicBaseUrl = base;
  const appConfig = { serverUrl: base, publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  // Each client is a separate computer unless a machine id is given.
  const newClient = (over = {}) => new LicenseClient({ store: new LeadStore(':memory:'), cipher: null, config: appConfig, clock: clock.ms, machineId: crypto.randomUUID(), ...over });
  const linksOf = (mail) => ({
    approve: mail.html.match(/href="([^"]*\/approve\?token=[^"]+)"/)[1].replace(/&amp;/g, '&'),
    cancel: mail.html.match(/href="([^"]*\/cancel\?token=[^"]+)"/)[1].replace(/&amp;/g, '&'),
  });
  const confirm = async (url) => {
    const u = new URL(url);
    const token = u.searchParams.get('token');
    return fetch(`${u.origin}${u.pathname}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(token)}` });
  };
  return { base, clock, mails, allMails, newClient, linksOf, confirm, appConfig, sb, close: async () => (server.close(), sb.drop(), fs.rmSync(dir, { recursive: true, force: true })) };
}

const apply = (client, extra = {}) => client.apply({ plan: 'monthly', message: 'Paid via JazzCash, TID 123456', email: 'customer@example.com', screenshot: { type: 'image/png', data: PNG }, ...extra });

test('plans and the full approve flow, with expiry from the activation date', async (t) => {
  const h = await harness();
  t.after(h.close);
  const plans = await h.newClient().plans();
  assert.deepEqual(plans.plans.map((p) => [p.id, p.priceLabel, p.months]), [
    ['monthly', 'PKR 3,000', 1],
    ['six_months', 'PKR 10,000', 6],
    ['lifetime', 'PKR 20,000', null],
  ]);
  assert.equal(plans.paymentInstructions, 'JazzCash 0300-0000000');

  const client = h.newClient();
  assert.equal((await client.status()).reason, 'trial', 'a new computer starts with free searches');
  const res = await apply(client);
  assert.match(res.applicationId, /^LF-[0-9A-F]{10}$/);
  assert.equal(res.status, 'pending');
  const s1 = await client.status();
  assert.deepEqual([s1.allowed, s1.application.status], [false, 'pending']);

  // Admin email: details, screenshot, two action buttons.
  assert.equal(h.mails.length, 1);
  const mail = h.mails[0];
  assert.equal(mail.to, 'info.axoraweb@gmail.com');
  assert.match(mail.subject, new RegExp(`${res.applicationId}: Monthly \\(PKR 3,000\\)`));
  assert.match(mail.html, /Approve Subscription/);
  assert.match(mail.html, /Cancel Subscription/);
  assert.match(mail.html, /Paid via JazzCash, TID 123456/);
  assert.equal(mail.attachments[0].contentType, 'image/png');
  assert.ok(mail.attachments[0].content.equals(PNG));
  const links = h.linksOf(mail);

  // Opening the link only shows a confirmation page.
  const page = await fetch(links.approve);
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /Approve Subscription\?/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal((await client.status()).allowed, false, 'GET changes nothing (safe against link scanners)');
  const shot = await fetch(new URL(pageHtml.match(/src="([^"]*screenshot[^"]+)"/)[1].replace(/&amp;/g, '&'), links.approve));
  assert.ok(Buffer.from(await shot.arrayBuffer()).equals(PNG));

  h.clock.advance(60_000);
  const done = await h.confirm(links.approve);
  assert.equal(done.status, 200);
  assert.match(await done.text(), /Subscription approved/);
  const s2 = await client.status();
  assert.equal(s2.allowed, true);
  assert.equal(s2.subscription.plan, 'monthly');
  assert.equal(s2.subscription.activatedAt, '2026-10-21T10:01:00.000Z');
  assert.equal(s2.subscription.expiresAt, '2026-11-21T10:01:00.000Z');
  assert.equal(s2.subscription.daysLeft, 31);

  // Duplicate processing and the other button are refused.
  assert.equal((await h.confirm(links.approve)).status, 409);
  const cancelAfter = await h.confirm(links.cancel);
  assert.equal(cancelAfter.status, 409);
  assert.equal((await client.status()).allowed, true, 'still active');

  // Expiry is decided by the server clock.
  h.clock.advance(31 * DAY);
  const s3 = await client.status();
  assert.deepEqual([s3.allowed, s3.subscription.state], [false, 'expired']);
});

test('cancellation leaves the subscription inactive and allows a new application', async (t) => {
  const h = await harness();
  t.after(h.close);
  const client = h.newClient();
  await apply(client);
  const { cancel } = h.linksOf(h.mails[0]);
  const r = await h.confirm(cancel);
  assert.match(await r.text(), /cancelled/);
  const s = await client.status();
  assert.deepEqual([s.allowed, s.application.status, s.subscription.state], [false, 'cancelled', 'none']);
  const again = await apply(client, { plan: 'lifetime' });
  assert.equal(again.status, 'pending');
  assert.equal((await client.status()).application.status, 'pending');
});

test('lifetime never expires; six months and renewal dates', async (t) => {
  const h = await harness();
  t.after(h.close);
  const life = h.newClient();
  await apply(life, { plan: 'lifetime' });
  await h.confirm(h.linksOf(h.mails[0]).approve);
  h.clock.advance(3650 * DAY);
  const s = await life.status();
  assert.equal(s.allowed, true);
  assert.equal(s.subscription.expiresAt, null);
  assert.equal(s.subscription.daysLeft, null);

  const six = h.newClient();
  await apply(six, { plan: 'six_months' });
  const start = h.clock.now().toISOString();
  await h.confirm(h.linksOf(h.mails[1]).approve);
  const exp = (await six.status()).subscription.expiresAt;
  assert.equal(new Date(exp).getUTCMonth(), (new Date(start).getUTCMonth() + 6) % 12);
  // Renewing early continues from the current end date.
  h.clock.advance(10 * DAY);
  await apply(six, { plan: 'monthly' });
  await h.confirm(h.linksOf(h.mails[2]).approve);
  const renewed = (await six.status()).subscription.expiresAt;
  assert.equal(new Date(renewed).getUTCMonth(), (new Date(exp).getUTCMonth() + 1) % 12);
});

test('application validation', async (t) => {
  const h = await harness();
  t.after(h.close);
  const c = h.newClient();
  await assert.rejects(apply(c, { plan: 'weekly' }), /Choose a subscription plan/);
  await assert.rejects(apply(c, { message: 'x'.repeat(1001) }), /too long/);
  await assert.rejects(apply(c, { screenshot: { type: 'image/png', data: Buffer.from('not an image at all') } }), /PNG, JPEG or WebP/);
  await assert.rejects(apply(c, { screenshot: { type: 'image/png', data: Buffer.alloc(0) } }), /Attach the payment screenshot/);
  await assert.rejects(apply(c, { screenshot: { type: 'image/png', data: Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]) } }), /larger than 5 MB/);
  await assert.rejects(apply(c, { email: 'not-an-email' }), /email address is not valid/);
  await assert.rejects(apply(c, { email: '' }), /Enter your email address/);
  await assert.rejects(apply(c, { email: undefined }), /Enter your email address/);
  assert.equal(h.allMails.length, 0, 'nothing emailed for invalid applications');
});

test('links: tampered, wrong application, expired, and replays are refused', async (t) => {
  const h = await harness();
  t.after(h.close);
  const a = h.newClient();
  const b = h.newClient();
  await apply(a);
  await apply(b);
  const la = h.linksOf(h.mails[0]);
  const lb = h.linksOf(h.mails[1]);
  // b's token on a's application
  const crossed = la.approve.replace(/token=.*/, lb.approve.match(/token=(.*)/)[0]);
  assert.equal((await h.confirm(crossed)).status, 400);
  // altered token
  assert.equal((await h.confirm(la.approve.slice(0, -2) + 'xx')).status, 400);
  assert.equal((await a.status()).allowed, false);
  // expired after 7 days
  h.clock.advance(8 * DAY);
  const expired = await h.confirm(la.approve);
  assert.equal(expired.status, 400);
  assert.match(await expired.text(), /expired/);
  assert.equal((await a.status()).allowed, false);
});

test('signed status cannot be forged, replayed, or bypassed with the local clock', async (t) => {
  const h = await harness();
  t.after(h.close);
  const client = h.newClient();
  await apply(client, { plan: 'lifetime' });
  await h.confirm(h.linksOf(h.mails[0]).approve);
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

  // A tampered request body/path fails the signature.
  assert.equal((await fetch(`${h.base}/api/license?nonce=bbbbbbbbbbbbbbbbbbbbbbbb`, { headers: { ...headers, 'x-lf-sig': sig } })).status, 401);

  // Changing this computer's clock does not help: requests are refused.
  const skewed = h.newClient({ clock: () => h.clock.ms() + 400 * DAY });
  skewed.store = client.store;
  skewed.k = client.keys();
  const s = await skewed.status();
  assert.equal(s.allowed, false);
  assert.match(s.message, /out of range|could not be verified/i);

  // A device with no subscription stays without one, whatever it sends.
  assert.equal((await h.newClient().status()).allowed, false);
});

test('user notifications only go to a verified email', async (t) => {
  const h = await harness();
  t.after(h.close);
  const c1 = h.newClient();
  await apply(c1, { email: 'buyer@example.com' });
  const verifyMail = h.allMails.find((m) => m.to === 'buyer@example.com');
  assert.match(verifyMail.subject, /Confirm your email/);
  // Not yet verified: approval sends nothing to the user.
  const before = h.allMails.length;
  await h.confirm(h.linksOf(h.mails[0]).approve);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.allMails.length, before);

  const c2 = h.newClient();
  await apply(c2, { email: 'second@example.com' });
  const admin2 = h.mails.filter((m) => m.to === 'info.axoraweb@gmail.com').at(-1);
  const v = h.allMails.find((m) => m.to === 'second@example.com').html.match(/href="([^"]+verify-email[^"]+)"/)[1].replace(/&amp;/g, '&');
  assert.match(await (await fetch(v)).text(), /Email confirmed/);
  assert.equal((await fetch(v)).status, 400, 'verification link is single-use');
  await h.confirm(h.linksOf(admin2).cancel);
  await new Promise((r) => setTimeout(r, 20));
  const notice = h.allMails.filter((m) => m.to === 'second@example.com').at(-1);
  assert.match(notice.subject, /was not approved/);
});

test('if the approval email cannot be sent, the application is removed (not shown as cancelled) and can be retried', async (t) => {
  const h = await harness({ failMail: true });
  t.after(h.close);
  const c = h.newClient();
  await assert.rejects(apply(c), /email failed/);
  const s = await c.status();
  assert.equal(s.application, null);
});

test('free trial: 3 searches per computer, enforced by the server, not reset by reinstalling', async (t) => {
  const h = await harness();
  t.after(h.close);
  const machine = 'machine-A';
  const c = h.newClient({ machineId: machine });
  const s0 = await c.status();
  assert.deepEqual([s0.reason, s0.canSearch, s0.allowed, s0.trial.remaining], ['trial', true, false, 3]);
  assert.match(s0.message, /3 of 3 free searches left/);
  for (const left of [2, 1, 0]) assert.equal((await c.consumeTrial()).trial.remaining, left);
  await assert.rejects(c.consumeTrial(), /3 free searches have been used/);
  const used = await c.status();
  assert.deepEqual([used.reason, used.canSearch], ['trial_used', false]);
  // "Reinstall": fresh app data and device key on the same computer.
  const reinstalled = h.newClient({ machineId: machine });
  assert.notEqual(reinstalled.deviceId, c.deviceId);
  const r = await reinstalled.status();
  assert.deepEqual([r.reason, r.trial.remaining], ['trial_used', 0]);
  await assert.rejects(reinstalled.consumeTrial(), /free searches have been used/);
  // Another computer has its own trial.
  assert.equal((await h.newClient({ machineId: 'machine-B' }).status()).trial.remaining, 3);
  // Subscribers search without using free searches.
  await apply(c, { plan: 'lifetime' });
  await h.confirm(h.linksOf(h.mails.at(-1)).approve);
  const sub = await c.status();
  assert.deepEqual([sub.reason, sub.canSearch, sub.allowed], ['active', true, true]);
  assert.equal((await c.consumeTrial()).consumed, false);
});

test('several applications: each stored separately, processed once each; message optional', async (t) => {
  const h = await harness();
  t.after(h.close);
  const c = h.newClient();
  const a1 = await apply(c, { plan: 'monthly', message: '' });
  const a2 = await apply(c, { plan: 'six_months', message: '' });
  assert.notEqual(a1.applicationId, a2.applicationId);
  assert.equal((await c.status()).pendingApplications, 2);
  assert.match(h.mails[0].html, /\(no message\)/);
  const [l1, l2] = [h.linksOf(h.mails[0]), h.linksOf(h.mails[1])];
  assert.match(await (await h.confirm(l1.cancel)).text(), /cancelled/);
  assert.equal((await h.confirm(l1.approve)).status, 409, 'a processed request is never processed again');
  const a3 = await apply(c, { plan: 'monthly' }); // after a cancellation
  assert.equal(a3.status, 'pending');
  assert.match(await (await h.confirm(l2.approve)).text(), /approved/);
  const s = await c.status();
  assert.equal(s.subscription.plan, 'six_months');
  assert.equal(s.pendingApplications, 1);
  assert.equal(s.application.id, a3.applicationId);
});

test('plans come with the three payment accounts', async (t) => {
  const h = await harness();
  t.after(h.close);
  const p = await h.newClient().plans();
  assert.deepEqual(p.paymentMethods.map((m) => [m.name, m.account]), [
    ['NayaPay', '03245237429'],
    ['JazzCash', '03245237429'],
    ['Easypaisa', '03245237429'],
  ]);
  assert.equal(p.trialSearches, 3);
});

test('an unreachable local server is reported as "not running", not as an internet problem', async () => {
  const c = new LicenseClient({ store: new LeadStore(':memory:'), cipher: null, config: { serverUrl: 'http://127.0.0.1:9', publicKey: crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }, machineId: 'm' });
  await assert.rejects(c.plans(), /not running \(http:\/\/127\.0\.0\.1:9\)\. Start it with "npm run server"/);
  const s = await c.status();
  assert.deepEqual([s.reason, s.canSearch], ['offline', false]);
  assert.match(s.message, /npm run server/);
});
