'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Activation } = require('../src/main/activation');
const { activationIdFor, addMonths, codeFor, createCode, dayOf, PLANS } = require('../src/main/activation-code');
const { LeadStore } = require('../src/database/db');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const secret = crypto.randomBytes(32);
const config = { secret: secret.toString('base64'), contact: { whatsapp: '923000000000', phone: '+923000000000' } };
const T0 = Date.parse('2026-11-01T10:00:00Z');

// An app on one computer, with a clock the test controls.
function device({ store = new LeadStore(':memory:'), machine = 'machine-a', at = T0, cfg = config } = {}) {
  const clock = { t: at };
  const act = new Activation({ store, config: cfg, machineId: () => machine, clock: () => clock.t });
  return { act, store, clock };
}
// What the administrator's tool emails.
const code = (activationId, plan, now = T0) => createCode({ activationId, plan, secret, now: new Date(now) }).code;
// A 4-digit code that is not valid for this ID/plan in the last ten days.
function wrongCode(id, plan, now = T0) {
  const valid = new Set();
  for (const p of PLANS) for (let d = 0; d < 10; d++) valid.add(codeFor(secret, id, p.id, dayOf(now) - d));
  for (let n = 0; ; n++) if (!valid.has(String(n).padStart(4, '0'))) return String(n).padStart(4, '0');
}

test('codes are 4 digits; the Activation ID is stable per computer and different between computers', () => {
  const a = device().act.activationId;
  assert.match(a, /^LF-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(device().act.activationId, a);
  assert.notEqual(device({ machine: 'machine-b' }).act.activationId, a);
  assert.match(code(a, 'monthly'), /^\d{4}$/);
  const store = new LeadStore(':memory:');
  const x = new Activation({ store, config, machineId: () => '' }).activationId;
  assert.equal(new Activation({ store, config, machineId: () => '' }).activationId, x);
  assert.throws(() => createCode({ activationId: 'LF-XXXX', plan: 'monthly', secret }), /LF-XXXX-XXXX-XXXX/);
  assert.throws(() => createCode({ activationId: a, plan: 'weekly', secret }), /plan must be/);
});

test('no plan at first; a valid code activates the chosen plan immediately', () => {
  const { act } = device();
  assert.equal(act.status().state, 'none');
  assert.equal(act.active, false);
  const r = act.activate(code(act.activationId, 'monthly'), 'monthly');
  assert.equal(r.ok, true, r.error);
  const st = act.status();
  assert.equal(st.state, 'active');
  assert.equal(st.plan, 'monthly');
  assert.equal(st.expiresAt, addMonths(new Date(T0), 1).toISOString());
  assert.equal(st.daysLeft, 30);
  assert.equal(act.active, true);
});

test('plan expiry: each plan lasts its length; Lifetime never expires', () => {
  for (const p of PLANS) {
    const { act, clock } = device();
    assert.equal(act.activate(code(act.activationId, p.id), p.id).ok, true, p.id);
    clock.t = T0 + 10 * 365 * DAY;
    assert.equal(act.status().state, p.months ? 'expired' : 'active', p.id);
  }
  const { act, clock } = device();
  act.activate(code(act.activationId, 'six_months'), 'six_months');
  clock.t = addMonths(new Date(T0), 6).getTime() - 1000;
  assert.equal(act.status().state, 'active');
  clock.t += 2000;
  assert.equal(act.status().state, 'expired');
  assert.equal(act.status().planName, '6 Months');
  assert.equal(act.active, false);
});

test('device binding: a code for another computer does not work here', () => {
  const other = device({ machine: 'machine-b' }).act.activationId;
  const { act } = device();
  const c = code(other, 'monthly');
  if (c !== code(act.activationId, 'monthly')) {
    assert.equal(act.activate(c, 'monthly').ok, false);
    assert.equal(act.status().state, 'none');
  }
  assert.equal(device({ machine: 'machine-b' }).act.activate(c, 'monthly').ok, true);
});

test('plan binding: the code must match the plan chosen', () => {
  const { act } = device();
  const c = code(act.activationId, 'lifetime');
  const r = act.activate(c, 'monthly');
  assert.equal(r.ok, false);
  if (r.reason === 'plan') assert.match(r.error, /Lifetime/);
  assert.equal(act.activate(c, 'lifetime').ok, true);
});

test('OTP expiration: a code works on its issue day and the next two (UTC), then expires', () => {
  const issued = Date.parse('2026-11-01T23:00:00Z');
  const ok = device({ at: Date.parse('2026-11-03T23:59:00Z') });
  assert.equal(ok.act.activate(code(ok.act.activationId, 'monthly', issued), 'monthly').ok, true);
  const late = device({ at: Date.parse('2026-11-04T00:01:00Z') });
  const r = late.act.activate(code(late.act.activationId, 'monthly', issued), 'monthly');
  assert.equal(r.reason, 'expired');
  assert.match(r.error, /expired/);
  assert.equal(late.act.status().state, 'none');
});

test('reuse prevention: a code works once, also after a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-act-'));
  const file = path.join(dir, 'leads.db');
  let store = new LeadStore(file);
  let { act } = device({ store });
  const c = code(act.activationId, 'monthly');
  assert.equal(act.activate(c, 'monthly').ok, true);
  assert.equal(act.activate(c, 'monthly').reason, 'used');
  store.close();
  store = new LeadStore(file);
  ({ act } = device({ store }));
  assert.equal(act.status().state, 'active', 'kept across restarts');
  assert.equal(act.activate(c, 'monthly').reason, 'used');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('guessing: wrong codes are counted; 5 lock entry for 15 minutes, even the right code', () => {
  const { act, clock } = device();
  const id = act.activationId;
  const bad = wrongCode(id, 'monthly');
  for (let i = 1; i <= 4; i++) assert.match(act.activate(bad, 'monthly').error, new RegExp(`${5 - i} tr`));
  assert.match(act.activate(bad, 'monthly').error, /15 minutes/);
  const r = act.activate(code(id, 'monthly'), 'monthly');
  assert.equal(r.reason, 'locked');
  clock.t += 15 * 60_000 + 1000;
  assert.equal(act.activate(code(id, 'monthly', clock.t), 'monthly').ok, true);
  // Not-4-digit input isn't a try.
  assert.equal(device().act.activate('12a4', 'monthly').reason, 'invalid');
  // A code for another plan counts as a try too (no free oracle).
  const d = device();
  d.act.activate(code(d.act.activationId, 'lifetime'), 'monthly');
  assert.equal(d.store.getState('activation.attempts').count, 1);
});

test('the stored plan is checked: edited data or another computer\'s database gives no plan', () => {
  const { act, store } = device();
  act.activate(code(act.activationId, 'monthly'), 'monthly');
  assert.equal(device({ store, machine: 'machine-b' }).act.status().state, 'none');
  const rec = store.getState('activation');
  store.setState('activation', { ...rec, plan: 'lifetime', expiresAt: null });
  assert.equal(act.status().state, 'none');
  store.setState('activation', rec);
  assert.equal(act.status().state, 'active');
});

test('setting the computer clock back does not bring an ended plan or an expired code back', () => {
  const { act, clock } = device();
  act.activate(code(act.activationId, 'monthly'), 'monthly');
  clock.t = T0 + 40 * DAY;
  assert.equal(act.status().state, 'expired');
  clock.t = T0 + 5 * DAY;
  assert.equal(act.status().state, 'expired');
  const late = device({ at: T0 + 10 * DAY });
  const c = code(late.act.activationId, 'monthly');
  late.act.status();
  late.clock.t = T0;
  assert.notEqual(late.act.activate(c, 'monthly').ok, true);
});

test('network time overrides a wrong computer clock', () => {
  const { act, clock } = device();
  act.activate(code(act.activationId, 'monthly'), 'monthly');
  clock.t = T0 + 5 * DAY;
  act.setNetworkTime(T0 + 40 * DAY);
  assert.equal(act.status().state, 'expired');
  const d = device();
  d.act.activate(code(d.act.activationId, 'monthly'), 'monthly');
  d.clock.t = T0 + 400 * DAY;
  assert.equal(d.act.status().state, 'expired');
  d.clock.t = T0 + 2 * DAY;
  d.act.setNetworkTime(T0 + 2 * DAY);
  assert.equal(d.act.status().state, 'active');
});

test('renewal: a code during a plan adds its length to the end; after the end it starts now; Lifetime is final', () => {
  const { act, clock } = device();
  act.activate(code(act.activationId, 'monthly'), 'monthly');
  const end1 = act.status().expiresAt;
  clock.t = T0 + 10 * DAY;
  assert.equal(act.activate(code(act.activationId, 'six_months', clock.t), 'six_months').ok, true);
  assert.equal(act.status().expiresAt, addMonths(new Date(end1), 6).toISOString());
  assert.equal(act.activate(code(act.activationId, 'lifetime', clock.t), 'lifetime').ok, true);
  assert.equal(act.status().expiresAt, null);
  assert.equal(act.activate(code(act.activationId, 'monthly', clock.t), 'monthly').reason, 'lifetime');
  const d = device();
  d.act.activate(code(d.act.activationId, 'monthly'), 'monthly');
  d.clock.t = T0 + 45 * DAY;
  assert.equal(d.act.status().state, 'expired');
  assert.equal(d.act.activate(code(d.act.activationId, 'monthly', d.clock.t), 'monthly').ok, true);
  assert.equal(d.act.status().expiresAt, addMonths(new Date(d.clock.t), 1).toISOString());
});

test('without the secret nothing can be activated', () => {
  const { act } = device({ cfg: {} });
  assert.equal(act.status().configured, false);
  assert.equal(act.activate('1234', 'monthly').reason, 'unconfigured');
  assert.equal(act.active, false);
});

test('administrator tool: emails the 4-digit code to ADMIN_EMAIL only and never prints it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-tool-'));
  const envFile = path.join(dir, '.env');
  const b64 = secret.toString('base64');
  fs.writeFileSync(envFile, `ADMIN_EMAIL=admin@example.com\nACTIVATION_SECRET=${b64}\nMAIL_OUTBOX_DIR=${path.join(dir, 'outbox')}\n`);
  const tool = path.join(__dirname, '..', 'tools', 'activation', 'otp.js');
  const env = { PATH: process.env.PATH, ACTIVATION_ENV_FILE: envFile };
  const { act } = device({ at: Date.now() });
  const out = execFileSync(process.execPath, [tool, act.activationId, 'six_months'], { env, encoding: 'utf8' });
  assert.match(out, /emailed to admin@example.com/);
  const files = fs.readdirSync(path.join(dir, 'outbox'));
  assert.equal(files.length, 1);
  const mail = JSON.parse(fs.readFileSync(path.join(dir, 'outbox', files[0]), 'utf8'));
  assert.equal(mail.to, 'admin@example.com');
  const sent = mail.text.match(/Activation code: (\d{4})/)[1];
  assert.ok(!out.includes(sent), 'the code is not printed');
  assert.equal(act.activate(sent, 'six_months').ok, true);
  const log = fs.readFileSync(path.join(dir, 'issued.log'), 'utf8');
  assert.match(log, new RegExp(act.activationId));
  assert.doesNotMatch(log, /code/i);
  // Bad input and missing settings are refused without sending anything.
  assert.throws(() => execFileSync(process.execPath, [tool, 'LF-BAD', 'monthly'], { env, stdio: 'pipe' }), /Usage/);
  assert.throws(() => execFileSync(process.execPath, [tool, act.activationId, 'weekly'], { env, stdio: 'pipe' }), /plan must be/);
  fs.writeFileSync(envFile, `ACTIVATION_SECRET=${b64}\n`);
  assert.throws(() => execFileSync(process.execPath, [tool, act.activationId, 'monthly'], { env, stdio: 'pipe' }), /ADMIN_EMAIL/);
  fs.writeFileSync(envFile, `ADMIN_EMAIL=admin@example.com\nACTIVATION_SECRET=${b64}\n`);
  assert.throws(() => execFileSync(process.execPath, [tool, act.activationId, 'monthly'], { env, stdio: 'pipe' }), /SMTP_HOST/);
  fs.writeFileSync(envFile, `ADMIN_EMAIL=admin@example.com\nMAIL_OUTBOX_DIR=${path.join(dir, 'outbox')}\n`);
  assert.throws(() => execFileSync(process.execPath, [tool, act.activationId, 'monthly'], { env, stdio: 'pipe' }), /npm run setup/);
  assert.equal(fs.readdirSync(path.join(dir, 'outbox')).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
