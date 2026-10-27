'use strict';
// Shared E2E helpers: unlocking through the real lock screen, and a plan
// activated through the real flow (Activate -> email -> code -> Verify)
// with a local mail server. The app accepts these test settings
// (LEAD_FINDER_ACTIVATION_CONFIG) only when it isn't packaged.

const crypto = require('node:crypto');
const { startSmtp } = require('../fake-smtp');

// A fixed port per test process, so the settings can be given at launch.
const port = 20000 + (process.pid % 20000);
const mail = startSmtp({ port, unref: true });
const smtp = { host: '127.0.0.1', port, user: 'sender@example.com', pass: 'test-pass', from: 'Lead Finder <sender@example.com>', insecure: true };
const activationConfig = { secret: crypto.randomBytes(32).toString('base64'), adminEmail: 'admin@example.com', smtp };
const activationEnv = { LEAD_FINDER_ACTIVATION_CONFIG: JSON.stringify(activationConfig), LEAD_FINDER_NO_NETWORK_TIME: '1' };

// The code in the latest email for an Activation ID.
async function codeFor(activationId) {
  const m = (await mail).messages.filter((x) => x.text.includes(activationId)).at(-1);
  return m && m.text.match(/Activation code \(OTP\): (\d{6})/)[1];
}

// Activates `plan` through the app's own request and check (main process).
async function activatePlan(win, plan = 'lifetime') {
  await mail;
  const st = await win.evaluate(() => window.leadFinder.activationStatus());
  if (st.state === 'active') return st;
  const req = await win.evaluate((p) => window.leadFinder.requestActivation(p), plan);
  if (!req.ok) throw new Error(`Activation request failed: ${req.error}`);
  const r = await win.evaluate(([c, p]) => window.leadFinder.verifyActivation(c, p), [await codeFor(st.activationId), plan]);
  if (!r.ok) throw new Error(`Activation failed: ${r.error}`);
  return r.status;
}

// Sets the PIN on first launch (enter + confirm) or unlocks with it, then
// activates a plan (unless plan is null).
async function unlock(win, pin = '1357', { plan = 'lifetime' } = {}) {
  const dialog = win.getByRole('dialog', { name: /Create your PIN|Enter your PIN/ });
  await dialog.waitFor({ timeout: 20_000 });
  const creating = /Create/.test(await dialog.getAttribute('aria-label'));
  await win.keyboard.type(pin, { delay: 30 });
  if (creating) {
    await win.getByRole('dialog', { name: 'Confirm your PIN' }).waitFor();
    await win.keyboard.type(pin, { delay: 30 });
  }
  await win.getByRole('heading', { name: 'Lead Finder' }).waitFor();
  if (plan && !process.env.LEAD_FINDER_EXE) await activatePlan(win, plan);
}

module.exports = { unlock, activatePlan, activationEnv, activationConfig, codeFor, mail };
