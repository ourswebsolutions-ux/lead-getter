'use strict';
// Activation when the activation email cannot be sent: a request reference
// the customer passes on, and that request's own code (worked out by the
// administrator). Uses a stand-in code form: the real one is private
// (tools/activation/.env) and is never in the repository.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Activation, FALLBACK_TTL, FALLBACK_TRIES } = require('../src/main/activation');
const { fallbackCode, normalizeReference, validPattern } = require('../src/main/fallback-code');
const { mailError } = require('../src/main/mailer');
const { LeadStore } = require('../src/database/db');

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-11-01T10:00:00Z');
const FORM = '4x1xx9'; // stand-in
const FORM_RE = /^4\d1\d\d9$/;
const secretB64 = crypto.randomBytes(32).toString('base64');
const config = { secret: secretB64, adminEmail: 'admin@example.com', smtp: { host: '127.0.0.1', port: 2525, user: 'u', pass: 'p' }, contact: { whatsapp: '923000000000', phone: '+923000000000' }, fallbackPattern: FORM };
const smtpDown = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:2525'), { code: 'ESOCKET' });

function device({ store = new LeadStore(':memory:'), machine = 'machine-a', cfg = config, failMail = true } = {}) {
  const clock = { t: T0 };
  const mail = { sent: [], fail: failMail ? smtpDown : null };
  const mailer = { send: async (msg) => (mail.fail ? Promise.reject(mail.fail) : mail.sent.push(msg)) };
  const act = new Activation({ store, config: cfg, mailer, mailError, machineId: () => machine, clock: () => clock.t });
  return { act, store, clock, mail };
}
// What the administrator works out from the customer's message.
const adminCode = (act, plan, reference) => fallbackCode(Buffer.from(secretB64, 'base64'), FORM, { activationId: act.activationId, plan, reference });
// Every code of the form except `but`.
const sameForm = (but) => {
  const out = [];
  for (let n = 0; n < 1000 && out.length < 40; n++) {
    const d = String(n).padStart(3, '0');
    const c = `4${d[0]}1${d[1]}${d[2]}9`;
    if (c !== but) out.push(c);
  }
  return out;
};
const next = (clock, ms = 2 * MIN) => (clock.t += ms);

test('email works: the normal code is emailed and activates, as before (no reference)', async () => {
  const { act, mail } = device({ failMail: false });
  const r = await act.request('monthly');
  assert.equal(r.ok, true);
  assert.equal(r.reference, undefined);
  assert.equal(act.status().pending.reference, null);
  const code = mail.sent[0].text.match(/Activation code \(OTP\): (\d{6})/)[1];
  assert.equal((await act.verify(code, 'monthly')).ok, true);
  assert.equal(act.status().state, 'active');
});

test('email fails: a reference to send instead; the code is never shown, stored or put in a message', async () => {
  const { act, store } = device();
  const r = await act.request('six_months');
  assert.equal(r.ok, true);
  assert.match(r.reference, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const st = act.status();
  assert.equal(st.pending.reference, r.reference);
  assert.equal(st.pending.triesLeft, FALLBACK_TRIES);
  assert.equal(Date.parse(st.pending.expiresAt) - T0, FALLBACK_TTL);
  const code = adminCode(act, 'six_months', r.reference);
  for (const shown of [JSON.stringify(r), JSON.stringify(st), JSON.stringify(store.getState('activation.pending'))]) {
    assert.ok(!shown.includes(code), 'the code is never shown or stored');
    assert.ok(!shown.includes(FORM) && !/fallback|pattern/i.test(shown), 'nothing about its form');
  }
  assert.equal(st.state, 'none', 'a failed email activates nothing');
});

test('the request’s own code activates (and only after every plan check); it follows the form; its digits vary', async () => {
  const { act } = device();
  const r = await act.request('monthly');
  const code = adminCode(act, 'monthly', r.reference);
  assert.match(code, FORM_RE);
  const done = await act.verify(code, 'monthly');
  assert.equal(done.ok, true);
  assert.equal(act.status().state, 'active');
  assert.equal(act.status().plan, 'monthly');
  // Different references give different codes; every derived digit varies.
  const codes = [];
  for (let i = 0; i < 60; i++) {
    const d = device({ machine: `m${i}` });
    const rr = await d.act.request('monthly');
    codes.push(adminCode(d.act, 'monthly', rr.reference));
  }
  assert.ok(codes.every((c) => FORM_RE.test(c)));
  for (const pos of [1, 3, 4]) assert.ok(new Set(codes.map((c) => c[pos])).size >= 4, `digit ${pos + 1} varies`);
  assert.ok(new Set(codes).size >= 40);
});

test('a code of the same form is not enough: only this request’s code works (not another reference, plan or computer)', async () => {
  const store = new LeadStore(':memory:');
  const { act, clock } = device({ store });
  const r = await act.request('monthly');
  const right = adminCode(act, 'monthly', r.reference);
  // Same form, wrong digits.
  const w1 = await act.verify(sameForm(right)[0], 'monthly');
  assert.equal(w1.ok, false);
  assert.equal(w1.reason, 'wrong');
  assert.doesNotMatch(w1.error, /4.1..9|form|pattern|digit/i, 'the message gives nothing away');
  // Another reference's code.
  const other = adminCode(act, 'monthly', r.reference === 'AAAA-AAAA' ? 'BBBB-BBBB' : 'AAAA-AAAA');
  assert.equal((await act.verify(other, 'monthly')).ok, false);
  // The right code for another plan.
  assert.equal((await act.verify(right, 'lifetime')).reason, 'plan');
  // On another computer (same database).
  const b = new Activation({ store, config, mailer: { send: async () => Promise.reject(smtpDown) }, mailError, machineId: () => 'machine-b', clock: () => clock.t });
  assert.equal((await b.verify(right, 'monthly')).ok, false);
  assert.equal(act.status().state, 'none');
});

test('expired, reused and replaced codes are refused', async () => {
  const { act, clock } = device();
  let r = await act.request('monthly');
  next(clock, FALLBACK_TTL + 1000);
  assert.equal((await act.verify(adminCode(act, 'monthly', r.reference), 'monthly')).reason, 'expired');
  // A new request replaces the earlier one.
  r = await act.request('monthly');
  const first = adminCode(act, 'monthly', r.reference);
  next(clock);
  const r2 = await act.request('monthly');
  assert.notEqual(r2.reference, r.reference);
  assert.equal((await act.verify(first, 'monthly')).ok, false, 'the replaced code no longer works');
  const second = adminCode(act, 'monthly', r2.reference);
  assert.equal((await act.verify(second, 'monthly')).ok, true);
  // Used once.
  assert.equal((await act.verify(second, 'monthly')).reason, 'none');
});

test('three tries per request; then even the right code is refused', async () => {
  const { act } = device();
  const r = await act.request('monthly');
  const right = adminCode(act, 'monthly', r.reference);
  const wrongs = sameForm(right);
  let res;
  for (let i = 0; i < FALLBACK_TRIES; i++) res = await act.verify(wrongs[i], 'monthly');
  assert.match(res.error, /last try/);
  assert.equal((await act.verify(right, 'monthly')).ok, false);
  assert.equal(act.status().state, 'none');
});

test('limits: 3 such requests and 6 wrong codes a day; then a failed email is just reported (no reference)', async () => {
  const { act, clock } = device();
  const refs = [];
  for (let i = 0; i < 3; i++) {
    refs.push((await act.request('monthly')).reference);
    next(clock);
  }
  assert.ok(refs.every(Boolean));
  const fourth = await act.request('monthly');
  assert.equal(fourth.ok, false);
  assert.equal(fourth.reason, 'email');
  assert.equal(fourth.reference, undefined);
  // A day later: allowed again.
  next(clock, 24 * HOUR);
  assert.ok((await act.request('monthly')).reference);

  // Six wrong codes in a day stop requests and checks of this kind.
  const d = device({ machine: 'brute' });
  let wrongCount = 0;
  for (let s = 0; s < 3 && wrongCount < 6; s++) {
    const rr = await d.act.request('monthly');
    if (!rr.reference) break;
    const bad = sameForm(adminCode(d.act, 'monthly', rr.reference));
    for (let i = 0; i < 3 && wrongCount < 6; i++, wrongCount++) await d.act.verify(bad[i], 'monthly');
    next(d.clock);
  }
  assert.equal(wrongCount, 6);
  const blocked = await d.act.request('monthly');
  assert.equal(blocked.reference, undefined, 'no new request after six wrong codes');
  assert.equal(d.act.status().state, 'none');
});

test('requests are rate limited as before (a minute between them)', async () => {
  const { act } = device();
  assert.ok((await act.request('monthly')).reference);
  const again = await act.request('monthly');
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'wait');
});

test('a build without the private form reports a failed email exactly as before', async () => {
  const { act } = device({ cfg: { ...config, fallbackPattern: undefined } });
  const r = await act.request('monthly');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'email');
  assert.match(r.error, /could not be sent/);
  assert.equal(act.status().pending, null);
  assert.ok(!validPattern('12345x') && !validPattern('0x8x07x') && validPattern(FORM));
});

test('the administrator’s command works out the same code; references are forgiving to type', async () => {
  const { act } = device();
  const r = await act.request('lifetime');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-fb-'));
  try {
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, `ACTIVATION_SECRET=${secretB64}\nFALLBACK_CODE_PATTERN=${FORM}\n`);
    const typed = r.reference.toLowerCase().replace('-', ' ');
    const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'activation', 'fallback-code.js'), act.activationId, 'Lifetime', typed], { env: { ...process.env, ACTIVATION_ENV_FILE: envFile }, encoding: 'utf8' });
    const code = out.trim().split(': ').at(-1);
    assert.equal(code, adminCode(act, 'lifetime', r.reference));
    assert.equal(normalizeReference(typed), r.reference);
    assert.equal((await act.verify(code, 'lifetime')).ok, true);
    assert.equal(act.status().plan, 'lifetime');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('nothing about this reaches the window: the built UI and the status have no form, code or setting name', () => {
  const dist = path.join(__dirname, '..', 'dist', 'renderer', 'assets');
  if (fs.existsSync(dist)) {
    for (const f of fs.readdirSync(dist).filter((x) => x.endsWith('.js'))) {
      const js = fs.readFileSync(path.join(dist, f), 'utf8');
      assert.ok(!/fallbackPattern|FALLBACK_CODE_PATTERN|fallback-code/.test(js), f);
    }
  }
  const { act } = device();
  assert.ok(!/fallback|pattern/i.test(JSON.stringify(act.status())));
});
