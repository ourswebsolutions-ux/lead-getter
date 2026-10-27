'use strict';
// Shared E2E helpers: unlocking through the real lock screen, and a plan
// activated with a throwaway secret (the app accepts a test secret from
// LEAD_FINDER_ACTIVATION_SECRET only when it isn't packaged).

const crypto = require('node:crypto');
const { createCode } = require('../../src/main/activation-code');

const secret = crypto.randomBytes(32);
const activationEnv = {
  LEAD_FINDER_ACTIVATION_SECRET: secret.toString('base64'),
  LEAD_FINDER_NO_NETWORK_TIME: '1',
};

// What the administrator's tool would email.
const testCode = (activationId, plan, opts = {}) => createCode({ activationId, plan, secret, ...opts }).code;

// Activates `plan` through the app's own check (main process).
async function activatePlan(win, plan = 'lifetime') {
  const st = await win.evaluate(() => window.leadFinder.activationStatus());
  if (st.state === 'active') return st;
  const r = await win.evaluate(([c, p]) => window.leadFinder.activate(c, p), [testCode(st.activationId, plan), plan]);
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

module.exports = { unlock, activatePlan, activationEnv, testCode };
