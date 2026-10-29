'use strict';

// The code for an activation request the app could not email (the customer
// sends you their Activation ID, plan and reference by WhatsApp or phone):
//
//   npm run fallback-code -- LF-XXXX-XXXX-XXXX monthly ABCD-EFGH
//
// Plans: monthly, six_months, lifetime (or their names). Uses ACTIVATION_SECRET
// and FALLBACK_CODE_PATTERN from .env; the code is valid for 30 minutes after
// the customer's request. Give it only after the payment is confirmed. The
// code is printed here only; keep it out of chats other than the customer's.

const { loadEnv } = require('./lib');
const { fallbackCode, normalizeReference, validPattern } = require('../../src/main/fallback-code');
const { PLANS } = require('../../src/main/activation');

const [activationId, planArg, reference] = process.argv.slice(2);
const env = loadEnv();
const secret = Buffer.from(String(env.ACTIVATION_SECRET || ''), 'base64');
const pattern = (env.FALLBACK_CODE_PATTERN || '').trim().toLowerCase();
const plan = PLANS.find((p) => p.id === String(planArg).toLowerCase() || p.name.toLowerCase() === String(planArg).toLowerCase().replace(/-/g, ' '));
const usage = () => {
  console.error('Usage: npm run fallback-code -- <Activation ID> <plan: monthly | six_months | lifetime> <reference>');
  process.exit(1);
};
if (!/^LF-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/i.test(activationId || '') || !plan || normalizeReference(reference).length !== 9) usage();
if (secret.length < 16) {
  console.error('ACTIVATION_SECRET is missing in tools/activation/.env.');
  process.exit(1);
}
if (!validPattern(pattern)) {
  console.error('FALLBACK_CODE_PATTERN is missing or not valid in tools/activation/.env.');
  process.exit(1);
}
const code = fallbackCode(secret, pattern, { activationId: activationId.toUpperCase(), plan: plan.id, reference });
console.log(`${plan.name} for ${activationId.toUpperCase()}, reference ${normalizeReference(reference)}: ${code}`);
