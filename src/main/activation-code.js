'use strict';

// Activation codes: 4 digits the administrator's tool (tools/activation)
// emails to the administrator, and the app checks, with no server between.
//
// A code is HMAC-SHA256(secret, Activation ID | plan | issue day), cut to 4
// digits. It is only valid for that computer, that plan, and the issue day
// plus the next two (UTC). Checking it offline means the app must hold the
// same secret: it is never in the repository (it is added at build time),
// but anyone who unpacks an installed app could extract it. And 4 digits
// are 10,000 possibilities, so the app limits wrong tries. This stops
// casual sharing and guessing, not a determined person.

const crypto = require('node:crypto');

const PLANS = [
  { id: 'monthly', name: 'Monthly', priceLabel: 'PKR 3,000', months: 1 },
  { id: 'six_months', name: '6 Months', priceLabel: 'PKR 10,000', months: 6 },
  { id: 'lifetime', name: 'Lifetime', priceLabel: 'PKR 20,000', months: null },
];
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: no I, L, O, U
const ID_RE = /^LF-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const CODE_RE = /^\d{4}$/;
const DAY = 86_400_000;
// A code can be entered on its issue day and the next two (UTC).
const VALID_DAYS = 3;

// The Activation ID of a computer: LF-XXXX-XXXX-XXXX from a hash of its
// machine id (the same after reinstalling; different on another computer).
function activationIdFor(seed) {
  const h = crypto.createHash('sha256').update(`lead-finder-activation\n${seed}`).digest();
  let bits = h.readBigUInt64BE(0) >> 4n; // 60 bits
  let s = '';
  for (let i = 0; i < 12; i++) {
    s = B32[Number(bits & 31n)] + s;
    bits >>= 5n;
  }
  return `LF-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

// Calendar-month addition (UTC); the 31st becomes the month's last day.
function addMonths(date, months) {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

const dayOf = (ms) => Math.floor(ms / DAY);

// The 4 digits for an Activation ID, plan and issue day.
function codeFor(secret, activationId, plan, day) {
  const mac = crypto.createHmac('sha256', secret).update(`lead-finder-code\n${activationId}\n${plan}\n${day}`).digest();
  return String(mac.readUInt32BE(0) % 10_000).padStart(4, '0');
}

// The administrator's side.
function createCode({ activationId, plan, secret, now = new Date() }) {
  if (!ID_RE.test(activationId)) throw new Error('The Activation ID looks like LF-XXXX-XXXX-XXXX.');
  if (!PLANS.some((x) => x.id === plan)) throw new Error(`The plan must be one of: ${PLANS.map((x) => x.id).join(', ')}.`);
  const day = dayOf(now.getTime());
  return { code: codeFor(secret, activationId, plan, day), day, enterBy: new Date((day + VALID_DAYS) * DAY) };
}

// The app's side: which issue day `code` is from, among the days it is
// still valid (null if none). `lookBack` extra days find expired codes.
function matchCode(secret, activationId, plan, code, nowMs, lookBack = 0) {
  if (!CODE_RE.test(code)) return null;
  const today = dayOf(nowMs);
  for (let d = today; d > today - VALID_DAYS - lookBack; d--) {
    const want = Buffer.from(codeFor(secret, activationId, plan, d));
    if (crypto.timingSafeEqual(want, Buffer.from(code))) return d;
  }
  return null;
}

module.exports = { PLANS, ID_RE, CODE_RE, VALID_DAYS, activationIdFor, addMonths, dayOf, codeFor, createCode, matchCode };
