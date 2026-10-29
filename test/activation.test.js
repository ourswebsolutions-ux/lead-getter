'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Activation, PLANS, addMonths } = require('../src/main/activation');
const { createMailer, mailError } = require('../src/main/mailer');
const { LeadStore } = require('../src/database/db');
const { startSmtp } = require('./fake-smtp');

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.parse('2026-11-01T10:00:00Z');
const config = { secret: crypto.randomBytes(32).toString('base64'), adminEmail: 'admin@example.com', smtp: { host: '127.0.0.1', port: 2525, user: 'u', pass: 'p' }, contact: { whatsapp: '923000000000', phone: '+923000000000' } };

// An app on one computer with a clock the test controls, and a mailer that
// records what it sends (or fails, when mail.fail is set).
function device({ store = new LeadStore(':memory:'), machine = 'machine-a', at = T0, cfg = config, mail = { sent: [], fail: null } } = {}) {
  const clock = { t: at };
  const mailer = {
    send: async (msg) => {
      if (mail.fail) throw mail.fail;
      mail.sent.push(msg);
    },
  };
  const act = new Activation({ store, config: cfg, mailer, mailError, machineId: () => machine, clock: () => clock.t });
  return { act, store, clock, mail };
}
const lastCode = (mail) => mail.sent.at(-1).text.match(/Activation code \(OTP\): (\d{6})/)[1];
const wrong = (c) => String((Number(c) + 1) % 1e6).padStart(6, '0');

test('Activate: a random 6-digit code is emailed only to the administrator with the Activation ID, plan and price', async () => {
  const { act, mail } = device();
  const r = await act.request('six_months');
  assert.equal(r.ok, true, r.error);
  assert.equal(mail.sent.length, 1);
  const m = mail.sent[0];
  assert.deepEqual(Object.keys(m).sort(), ['subject', 'text', 'to']);
  assert.equal(m.to, 'admin@example.com');
  assert.match(m.text, new RegExp(`Activation ID: ${act.activationId}`));
  assert.match(m.text, /Plan: 6 Months/);
  assert.match(m.text, /Price: PKR 15,000/);
  assert.match(lastCode(mail), /^\d{6}$/);
  // The code is not in the status the window gets, nor stored in plain text.
  const st = act.status();
  assert.equal(st.pending.plan, 'six_months');
  assert.equal(st.pending.triesLeft, 5);
  assert.ok(!JSON.stringify(st).includes(lastCode(mail)));
  assert.ok(!JSON.stringify(act.store.getState('activation.pending')).includes(lastCode(mail)));
  // Codes are random.
  const codes = new Set();
  for (let i = 0; i < 5; i++) {
    const d = device({ machine: `m${i}` });
    await d.act.request('monthly');
    codes.add(lastCode(d.mail));
  }
  assert.ok(codes.size >= 4);
});

test('Verify & Activate: the right code activates the plan at once, with the right expiry', async () => {
  for (const p of PLANS) {
    const { act, mail } = device();
    await act.request(p.id);
    const r = await act.verify(lastCode(mail), p.id);
    assert.equal(r.ok, true, r.error);
    const st = act.status();
    assert.equal(st.state, 'active');
    assert.equal(st.plan, p.id);
    assert.equal(st.expiresAt, p.months ? addMonths(new Date(T0), p.months).toISOString() : null);
    assert.equal(st.pending, null);
  }
});

test('OTP expiry: a code expires after 10 minutes', async () => {
  const { act, mail, clock } = device();
  await act.request('monthly');
  const code = lastCode(mail);
  clock.t += 10 * MIN;
  const r = await act.verify(code, 'monthly');
  assert.equal(r.reason, 'expired');
  assert.equal(act.status().state, 'none');
  assert.equal(act.status().pending, null);
  // Just inside 10 minutes works.
  const d = device();
  await d.act.request('monthly');
  d.clock.t += 10 * MIN - 1000;
  assert.equal((await d.act.verify(lastCode(d.mail), 'monthly')).ok, true);
});

test('single use: a code cannot be used again', async () => {
  const { act, mail } = device();
  await act.request('monthly');
  const code = lastCode(mail);
  assert.equal((await act.verify(code, 'monthly')).ok, true);
  const again = await act.verify(code, 'monthly');
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'none');
  assert.equal(act.status().expiresAt, addMonths(new Date(T0), 1).toISOString(), 'not extended');
});

test('a new request replaces (invalidates) the earlier code', async () => {
  const { act, mail, clock } = device();
  await act.request('monthly');
  const first = lastCode(mail);
  clock.t += 61_000;
  await act.request('monthly');
  const second = lastCode(mail);
  if (first !== second) assert.equal((await act.verify(first, 'monthly')).reason, 'wrong');
  assert.equal((await act.verify(second, 'monthly')).ok, true);
});

test('five tries per code; then it is cancelled, even for the right code', async () => {
  const { act, mail } = device();
  await act.request('monthly');
  const code = lastCode(mail);
  for (let i = 1; i <= 4; i++) {
    const r = await act.verify(wrong(code), 'monthly');
    assert.equal(r.reason, 'wrong');
    assert.match(r.error, new RegExp(`${5 - i} tr`));
  }
  assert.match((await act.verify(wrong(code), 'monthly')).error, /last try/);
  assert.equal(act.status().pending, null);
  assert.equal((await act.verify(code, 'monthly')).reason, 'none');
  assert.equal(act.status().state, 'none');
  // Badly formed input isn't a try.
  const d = device();
  await d.act.request('monthly');
  assert.equal((await d.act.verify('12345', 'monthly')).reason, 'invalid');
  assert.equal(d.act.status().pending.triesLeft, 5);
});

test('plan binding: the code only activates the plan it was requested for', async () => {
  const { act, mail } = device();
  await act.request('monthly');
  const r = await act.verify(lastCode(mail), 'lifetime');
  assert.equal(r.reason, 'plan');
  assert.match(r.error, /Monthly/);
  assert.equal(act.status().state, 'none');
  assert.equal((await act.verify(lastCode(mail), 'monthly')).ok, true);
  assert.equal(act.status().plan, 'monthly');
});

test('device binding: a code requested on one computer does not work on another (shared database)', async () => {
  const { act, mail, store } = device();
  await act.request('monthly');
  const other = device({ store, machine: 'machine-b' });
  assert.equal((await other.act.verify(lastCode(mail), 'monthly')).reason, 'none');
  assert.equal(other.act.status().state, 'none');
  // ... and a plan activated on one computer isn't active on the other.
  assert.equal((await act.verify(lastCode(mail), 'monthly')).ok, true);
  assert.equal(other.act.status().state, 'none');
});

test('email failure: nothing is kept, the user is told, and that code can never activate', async () => {
  const mail = { sent: [], fail: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNECTION' }) };
  let code;
  const { act } = device({ mail, cfg: config });
  // Capture the code the app generated for the failed email.
  act.random = (n) => {
    code = String(crypto.randomInt(n)).padStart(6, '0');
    return Number(code);
  };
  const r = await act.request('monthly');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'email');
  assert.match(r.error, /could not be sent: the email server could not be reached/);
  assert.doesNotMatch(r.error, /sent to|check your/i);
  assert.equal(act.status().pending, null);
  assert.equal((await act.verify(code, 'monthly')).reason, 'none');
  assert.equal(act.status().state, 'none');
});

test('no duplicate or concurrent requests and activations', async () => {
  const { act, mail, clock } = device();
  const [a, b] = await Promise.all([act.request('monthly'), act.request('monthly')]);
  assert.equal([a, b].filter((r) => r.ok).length, 1);
  assert.equal([a, b].find((r) => !r.ok).reason, 'busy');
  assert.equal(mail.sent.length, 1);
  // Requests are rate-limited: one a minute, six an hour.
  assert.equal((await act.request('monthly')).reason, 'wait');
  for (let i = 0; i < 5; i++) {
    clock.t += 61_000;
    assert.equal((await act.request('monthly')).ok, true);
  }
  clock.t += 61_000;
  assert.match((await act.request('monthly')).error, /Too many requests/);
  // Two verifications at once: one activates, the other is refused.
  const code = lastCode(mail);
  const [x, y] = await Promise.all([act.verify(code, 'monthly'), act.verify(code, 'monthly')]);
  assert.equal([x, y].filter((r) => r.ok).length, 1);
  assert.equal(act.status().expiresAt, addMonths(new Date(clock.t), 1).toISOString());
});

test('restarts: a waiting code and an activated plan are kept; edited records are rejected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-act-'));
  const file = path.join(dir, 'leads.db');
  const mail = { sent: [], fail: null };
  let store = new LeadStore(file);
  let { act } = device({ store, mail });
  await act.request('six_months');
  store.close();
  store = new LeadStore(file);
  ({ act } = device({ store, mail, at: T0 + 2 * MIN }));
  assert.equal(act.status().pending.plan, 'six_months');
  assert.equal((await act.verify(lastCode(mail), 'six_months')).ok, true);
  store.close();
  store = new LeadStore(file);
  ({ act } = device({ store, mail, at: T0 + 5 * DAY }));
  assert.equal(act.status().state, 'active');
  assert.equal(act.status().plan, 'six_months');
  // Edited by hand: no plan.
  const rec = store.getState('activation');
  store.setState('activation', { ...rec, plan: 'lifetime', expiresAt: null });
  assert.equal(act.status().state, 'none');
  store.setState('activation', rec);
  assert.equal(act.status().state, 'active');
  // A waiting code's tries or expiry edited by hand: no code.
  await act.request('monthly');
  const p = store.getState('activation.pending');
  store.setState('activation.pending', { ...p, tries: 0, expiresAt: p.expiresAt + DAY });
  assert.equal(act.status().pending, null);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('plan validity: Monthly and 6 Months end; Lifetime never does; renewal adds to a running plan', async () => {
  const { act, mail, clock } = device();
  await act.request('monthly');
  await act.verify(lastCode(mail), 'monthly');
  const end1 = act.status().expiresAt;
  clock.t = T0 + 10 * DAY;
  await act.request('six_months');
  await act.verify(lastCode(mail), 'six_months');
  assert.equal(act.status().expiresAt, addMonths(new Date(end1), 6).toISOString());
  clock.t = Date.parse(act.status().expiresAt) + 1000;
  assert.equal(act.status().state, 'expired');
  assert.equal(act.active, false);
  await act.request('lifetime');
  await act.verify(lastCode(mail), 'lifetime');
  clock.t += 50 * 365 * DAY;
  assert.equal(act.status().state, 'active');
  assert.equal(act.status().expiresAt, null);
  assert.equal((await act.request('monthly')).reason, 'lifetime');
});

test('the clock: turning it back does not revive a plan or a code; network time corrects it', async () => {
  const { act, mail, clock } = device();
  await act.request('monthly');
  await act.verify(lastCode(mail), 'monthly');
  clock.t = T0 + 40 * DAY;
  assert.equal(act.status().state, 'expired');
  clock.t = T0 + 5 * DAY;
  assert.equal(act.status().state, 'expired');
  const d = device();
  await d.act.request('monthly');
  d.clock.t += 20 * MIN;
  d.act.status();
  d.clock.t = T0;
  assert.equal((await d.act.verify(lastCode(d.mail), 'monthly')).reason, 'expired');
  const n = device();
  await n.act.request('monthly');
  await n.act.verify(lastCode(n.mail), 'monthly');
  n.clock.t = T0 + 5 * DAY;
  n.act.setNetworkTime(T0 + 40 * DAY);
  assert.equal(n.act.status().state, 'expired');
});

test('not configured (no secret, email or SMTP): nothing can be requested or activated', async () => {
  for (const cfg of [{ ...config, secret: '' }, { ...config, adminEmail: '' }]) {
    const { act, mail } = device({ cfg });
    assert.equal(act.status().configured, false);
    assert.equal((await act.request('monthly')).reason, 'unconfigured');
    assert.equal(mail.sent.length, 0);
  }
  const store = new LeadStore(':memory:');
  const act = new Activation({ store, config, mailer: null, machineId: () => 'x' });
  assert.equal(act.configured, false);
});

test('real SMTP: delivered to the administrator only; refused login and unreachable server are clear failures', async () => {
  const server = await startSmtp();
  try {
    const mailer = createMailer(server.smtp(), { allowInsecure: true });
    const { act } = device();
    act.mailer = mailer;
    const r = await act.request('lifetime');
    assert.equal(r.ok, true, r.error);
    assert.equal(server.messages.length, 1);
    const m = server.messages[0];
    assert.deepEqual(m.to, ['admin@example.com']);
    assert.match(m.text, /Plan: Lifetime/);
    assert.match(m.text, /Price: PKR 50,000/);
    assert.match(m.text, new RegExp(act.activationId));
    const code = m.text.match(/Activation code \(OTP\): (\d{6})/)[1];
    assert.equal((await act.verify(code, 'lifetime')).ok, true);

    server.setMode('auth-fail');
    const d = device({ machine: 'other' });
    d.act.mailer = mailer;
    const bad = await d.act.request('monthly');
    assert.equal(bad.reason, 'email');
    assert.match(bad.error, /rejected the login/);
    assert.doesNotMatch(bad.error, /test-pass|sender@/);
    assert.equal(d.act.status().pending, null);
  } finally {
    await server.close();
  }
  const down = device({ machine: 'down' });
  down.act.mailer = createMailer({ host: '127.0.0.1', port: 1, user: 'u', pass: 'p', insecure: true }, { allowInsecure: true });
  const r = await down.act.request('monthly');
  assert.equal(r.reason, 'email');
  assert.match(r.error, /could not be reached/);
  // Without allowInsecure (a packaged app), TLS is always required.
  const server2 = await startSmtp();
  try {
    const strict = device({ machine: 'strict' });
    strict.act.mailer = createMailer(server2.smtp());
    assert.equal((await strict.act.request('monthly')).reason, 'email');
    assert.equal(server2.messages.length, 0);
  } finally {
    await server2.close();
  }
});

test('missing settings are named (as in tools/activation/.env), and requests say which', async () => {
  const store = new LeadStore(':memory:');
  const mailer = { send: async () => {} };
  const none = new Activation({ store, config: {}, mailer: null, machineId: () => 'x' });
  assert.deepEqual(none.status().missing, ['ADMIN_EMAIL', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'ACTIVATION_SECRET']);
  const some = new Activation({ store, config: { ...config, smtp: { host: 'smtp.example.com', port: 465, user: 'u' } }, mailer, machineId: () => 'x' });
  assert.deepEqual(some.status().missing, ['SMTP_PASS']);
  const r = await some.request('monthly');
  assert.equal(r.reason, 'unconfigured');
  assert.match(r.error, /missing SMTP_PASS/);
  const all = new Activation({ store, config: { ...config, smtp: { host: 'smtp.example.com', port: 465, user: 'u', pass: 'p' } }, mailer, machineId: () => 'x' });
  assert.equal(all.status().configured, true);
  assert.deepEqual(all.status().missing, []);
});
