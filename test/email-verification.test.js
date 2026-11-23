'use strict';
// Email verification before outreach: each kind of address gets the right
// status (valid, invalid, disposable, malformed, catch-all, unreachable,
// greylisted, refused for the sender, full, role), results are kept and not
// asked again until they expire, and Reacher's answers are read the same way.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { EmailVerification, chooseEmail, isRole, isDisposable } = require('../src/email/verification');
const { EmailVerifier } = require('../src/browser/email-verify');
const { startMx, testEngine } = require('./fake-mx');

function memState() {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v), delete: (k) => m.delete(k) };
}

async function setup(t, mxOpts, opts = {}) {
  const mx = await startMx(mxOpts);
  const time = { now: 1_800_000_000_000 };
  const state = memState();
  const secrets = memState();
  const v = new EmailVerification({ db: new DatabaseSync(':memory:'), state, vault: secrets, makeEngine: testEngine(mx), clock: () => time.now, sender: () => 'sender@axora.pk', ...opts });
  t.after(async () => {
    v.stop();
    await mx.close();
  });
  return { mx, v, time, state, secrets };
}

test('Each kind of address gets the right status, with the reason', async (t) => {
  const { mx, v } = await setup(t, {
    exists: ['ali@good.test', 'info@good.test', 'sara@grey.test'],
    catchAll: ['catchall.test'],
    policy: ['blocked.test'],
    greylist: { 'grey.test': 1 },
    full: ['full@good.test'],
    disabled: ['old@good.test'],
  });
  const list = ['ali@good.test', 'nobody@good.test', 'info@good.test', 'x@mailinator.com', 'a..b@good.test', 'any@catchall.test', 'z@unreachable.test', 'q@blocked.test', 'f@nomx.test', 'g@gone.invalid', 'full@good.test', 'old@good.test'];
  const r = await v.ensure(list, { timeout: 20_000 });
  const st = (e) => r.get(e)?.status;
  assert.equal(st('ali@good.test'), 'valid');
  assert.match(r.get('ali@good.test').reason, /confirmed the mailbox/);
  assert.equal(st('nobody@good.test'), 'invalid');
  assert.match(r.get('nobody@good.test').detail, /User unknown/, 'the server’s own words are kept');
  assert.equal(st('info@good.test'), 'valid');
  assert.equal(r.get('info@good.test').role, true, 'a role address is shown as one');
  assert.equal(st('x@mailinator.com'), 'risky');
  assert.equal(r.get('x@mailinator.com').disposable, true);
  assert.equal(st('a..b@good.test'), 'invalid');
  assert.equal(st('any@catchall.test'), 'catch_all');
  assert.equal(st('f@nomx.test'), 'invalid');
  assert.equal(st('g@gone.invalid'), 'invalid');
  assert.equal(st('full@good.test'), 'risky');
  assert.equal(st('old@good.test'), 'invalid');
  assert.match(r.get('old@good.test').reason, /disabled/);
  // Never "invalid" for a connection problem or a refusal of the sender: asked again later.
  for (const e of ['z@unreachable.test', 'q@blocked.test']) {
    assert.notEqual(st(e), 'invalid', e);
    assert.notEqual(st(e), 'valid', e);
  }
  assert.ok(v.row('q@blocked.test').next_at > 0, 'a refusal for the sender is asked again later');
  assert.match(v.row('q@blocked.test').reason, /spam list or policy/);
  // Nothing was asked over the network for malformed or disposable addresses.
  assert.ok(!mx.rcpts.some((e) => /mailinator|a\.\.b/.test(e)));
  // Greylisted the first time: asked again later, then confirmed.
  assert.equal(v.row('sara@grey.test'), null);
  const g = await v.ensure(['sara@grey.test'], { timeout: 10_000 });
  assert.equal(g.get('sara@grey.test').status, null, 'not decided yet');
  assert.match(v.row('sara@grey.test').reason, /try again later/);
  assert.ok(v.row('sara@grey.test').next_at > 0);
});

test('Temporary answers are asked again (three times) before an address is Unknown; Unknown is never sent; results are kept until they expire', async (t) => {
  const { mx, v, time } = await setup(t, { exists: ['ali@good.test', 'sara@grey.test'], greylist: { 'grey.test': 1 } });
  await v.ensure(['sara@grey.test', 'z@unreachable.test'], { timeout: 10_000 });
  // Greylisting passes on the next try.
  time.now += 16 * 60_000;
  let r = await v.ensure(['sara@grey.test'], { timeout: 10_000 });
  assert.equal(r.get('sara@grey.test').status, 'valid');
  // An unreachable server: after the tries, Unknown (with why).
  for (const wait of [16 * 60_000, 61 * 60_000, 6.1 * 3600_000]) {
    time.now += wait;
    v.engine = null; // as when the app has been running a while
    await v.ensure(['z@unreachable.test'], { timeout: 10_000 });
  }
  r = v.lookup(['z@unreachable.test']);
  assert.equal(r.get('z@unreachable.test').status, 'unknown');
  assert.match(r.get('z@unreachable.test').reason, /could not be reached/);
  assert.equal(v.allows('z@unreachable.test'), false);
  // Kept: asking again does not talk to the server.
  await v.ensure(['ali@good.test'], { timeout: 10_000 });
  const asked = mx.rcpts.filter((e) => e === 'ali@good.test').length;
  await v.ensure(['ali@good.test'], { timeout: 10_000 });
  assert.equal(mx.rcpts.filter((e) => e === 'ali@good.test').length, asked, 'a fresh result is reused');
  assert.equal(v.allows('ali@good.test'), true);
  // Expired (30 days for valid): not allowed until checked again, then asked again.
  time.now += 31 * 24 * 3600_000;
  assert.equal(v.allows('ali@good.test'), false);
  await v.ensure(['ali@good.test'], { timeout: 10_000 });
  assert.equal(mx.rcpts.filter((e) => e === 'ali@good.test').length, asked + 1);
  assert.equal(v.allows('ali@good.test'), true);
  assert.ok(v.logs(50).some((l) => l.email === 'z@unreachable.test' && l.status === 'retry'), 'the log shows each try');
});

test('Policy: only Valid by default; Risky, Unknown and Catch-all each allowed only when asked; role addresses risky when asked; never the Reacher secret in the status', async (t) => {
  const { v, secrets } = await setup(t, { exists: ['info@good.test', 'ali@good.test'], catchAll: ['catchall.test'] });
  await v.ensure(['info@good.test', 'ali@good.test', 'any@catchall.test', 'x@mailinator.com'], { timeout: 10_000 });
  assert.deepEqual(v.allowed(), ['valid']);
  assert.equal(v.allows('any@catchall.test'), false);
  assert.equal(v.allows('x@mailinator.com'), false);
  assert.ok(v.save({ allow: { catch_all: true } }).ok);
  assert.equal(v.allows('any@catchall.test'), true);
  assert.equal(v.allows('x@mailinator.com'), false);
  assert.ok(v.save({ roleRisky: true }).ok);
  assert.equal(v.statusOf('info@good.test').status, 'risky');
  assert.equal(v.allows('info@good.test'), false);
  assert.equal(v.allows('ali@good.test'), true);
  v.save({ roleRisky: false });
  assert.equal(v.statusOf('info@good.test').status, 'valid');
  assert.equal(v.save({ engine: 'reacher', reacherUrl: '' }).ok, false);
  assert.ok(v.save({ engine: 'reacher', reacherUrl: 'https://verify.example.com/', secret: 'top-secret-value' }).ok);
  assert.equal(secrets.get('email.reacherSecret'), 'top-secret-value');
  assert.ok(!JSON.stringify(v.status()).includes('top-secret-value'));
  assert.equal(v.status().settings.hasSecret, true);
  // The lead's address that passed is the one chosen.
  assert.deepEqual(chooseEmail(['nobody@x.invalid', 'ali@good.test'], v), { email: 'ali@good.test', state: 'allowed' });
  assert.equal(isRole('Sales@x.com'), true);
  assert.equal(isRole('ali@x.com'), false);
  assert.equal(isDisposable('a@sub.mailinator.com'), true);
});

test('Reacher (self-hosted): its secret header, and its answers read into the same statuses', async () => {
  const asked = [];
  const reply = {
    'ok@x.com': { is_reachable: 'safe', misc: { is_disposable: false, is_role_account: false }, mx: { accepts_mail: true }, smtp: { can_connect_smtp: true, is_deliverable: true, is_catch_all: false, has_full_inbox: false, is_disabled: false }, syntax: { is_valid_syntax: true } },
    'info@x.com': { is_reachable: 'risky', misc: { is_disposable: false, is_role_account: true }, mx: { accepts_mail: true }, smtp: { can_connect_smtp: true, is_deliverable: true, is_catch_all: false, has_full_inbox: false, is_disabled: false }, syntax: { is_valid_syntax: true } },
    'all@y.com': { is_reachable: 'risky', misc: {}, mx: { accepts_mail: true }, smtp: { can_connect_smtp: true, is_deliverable: true, is_catch_all: true }, syntax: { is_valid_syntax: true } },
    'no@x.com': { is_reachable: 'invalid', misc: {}, mx: { accepts_mail: true }, smtp: { can_connect_smtp: true, is_deliverable: false }, syntax: { is_valid_syntax: true } },
    'q@z.com': { is_reachable: 'unknown', misc: {}, mx: { accepts_mail: true }, smtp: { can_connect_smtp: false }, syntax: { is_valid_syntax: true } },
  };
  const engine = new EmailVerifier({
    reacherUrl: 'https://verify.example.com',
    reacherSecret: 's3',
    fetchImpl: async (url, init) => {
      asked.push({ url, secret: init.headers['x-reacher-secret'], body: JSON.parse(init.body) });
      return new Response(JSON.stringify(reply[JSON.parse(init.body).to_email]), { headers: { 'content-type': 'application/json' } });
    },
  });
  const r = (e) => engine.verify(e);
  assert.equal((await r('ok@x.com')).status, 'verified');
  const info = await r('info@x.com');
  assert.equal(info.status, 'verified', 'a role address that exists: the role is a flag');
  assert.equal(info.role, true);
  assert.equal((await r('all@y.com')).status, 'catch_all');
  assert.equal((await r('no@x.com')).status, 'invalid');
  const unknown = await r('q@z.com');
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.temporary, true);
  assert.equal(asked[0].url, 'https://verify.example.com/v0/check_email');
  assert.equal(asked[0].secret, 's3');
  const down = new EmailVerifier({ reacherUrl: 'https://verify.example.com', fetchImpl: async () => new Response('no', { status: 401 }) });
  assert.match((await down.verify('ok@x.com')).reason, /secret/);
});

test('New lead emails are checked in the background, a few domains at once, each domain one conversation at a time', async (t) => {
  const emails = ['a@one.test', 'b@one.test', 'c@two.test', 'd@three.test'];
  const { mx, v } = await setup(t, { exists: (e) => !e.includes('nouser') }, { newEmails: () => emails, sweepEvery: 3_600_000 });
  v.start();
  for (const end = Date.now() + 10_000; Date.now() < end && v.counts().valid < 4; ) await new Promise((r) => setTimeout(r, 50));
  assert.equal(v.counts().valid, 4);
  assert.equal(mx.sessions.n, 3, 'one conversation per domain (both one.test addresses in one)');
  // Asked again: nothing new.
  v.sweep();
  assert.equal(v.counts().queued, 0);
});
