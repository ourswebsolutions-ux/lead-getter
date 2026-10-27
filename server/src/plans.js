'use strict';

// Authoritative plans (the app only displays what the server returns), with
// each plan's daily allowance of qualified leads:
//   { total: n }                 shared by Google Maps and Facebook
//   { maps: n, facebook: n }     separate per source (Free)
//   null                         unlimited (One-Time)
// Prices, durations and allowances can be changed with environment
// variables (PLAN_*, see .env.example); the ids are part of the protocol.

function intEnv(env, key, fallback) {
  const v = Number(env[key]);
  return env[key] !== undefined && env[key] !== '' && Number.isInteger(v) && v >= 0 ? v : fallback;
}

const pkr = (n) => `PKR ${n.toLocaleString('en-US')}`;

function plan(id, name, price, months, daily) {
  const duration = id === 'free' ? 'Free' : months === null ? 'One-time payment, never expires' : months === 1 ? '1 month' : `${months} months`;
  return { id, name, priceLabel: pkr(price), price, currency: 'PKR', months, duration, daily };
}

function loadPlans(env = process.env) {
  return {
    free: plan('free', 'Free', 0, null, { maps: intEnv(env, 'PLAN_FREE_DAILY_MAPS', 5), facebook: intEnv(env, 'PLAN_FREE_DAILY_FACEBOOK', 5) }),
    monthly: plan('monthly', 'Monthly', intEnv(env, 'PLAN_MONTHLY_PRICE', 3000), intEnv(env, 'PLAN_MONTHLY_MONTHS', 1), { total: intEnv(env, 'PLAN_MONTHLY_DAILY_LEADS', 100) }),
    six_months: plan('six_months', 'Six Months', intEnv(env, 'PLAN_SIX_MONTHS_PRICE', 10000), intEnv(env, 'PLAN_SIX_MONTHS_MONTHS', 6), { total: intEnv(env, 'PLAN_SIX_MONTHS_DAILY_LEADS', 250) }),
    lifetime: plan('lifetime', 'One-Time', intEnv(env, 'PLAN_ONE_TIME_PRICE', 20000), null, null),
  };
}

const PLANS = loadPlans();
// The plans an administrator can assign, and those a customer pays for.
const PLAN_IDS = ['free', 'monthly', 'six_months', 'lifetime'];
const PAID_PLAN_IDS = ['monthly', 'six_months', 'lifetime'];

// Where customers send payment.
const PAYMENT_METHODS = [
  { id: 'nayapay', name: 'NayaPay', account: '03245237429' },
  { id: 'jazzcash', name: 'JazzCash', account: '03245237429' },
  { id: 'easypaisa', name: 'Easypaisa', account: '03245237429' },
];

// Calendar-month addition; the 31st becomes the month's last day if needed.
function addMonths(date, months) {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

// End of a plan bought at `from`: null for plans that never expire.
function planExpiry(p, from) {
  return p.months === null ? null : addMonths(from, p.months).toISOString();
}

module.exports = { PLANS, PLAN_IDS, PAID_PLAN_IDS, PAYMENT_METHODS, loadPlans, addMonths, planExpiry };
