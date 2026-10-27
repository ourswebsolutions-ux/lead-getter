'use strict';

// Daily qualified-lead allowance: which plan applies, which counter a lead
// is charged to, and the usage summary the app displays. Days are calendar
// days in one configured timezone (CREDITS_TIMEZONE, default Asia/Karachi),
// so every device's allowance resets at the same local midnight.

const { PLANS } = require('./plans');

const DEFAULT_TIMEZONE = 'Asia/Karachi';
const SOURCES = ['maps', 'facebook'];
const KEY_RE = /^[0-9a-f]{64}$/;

function timezoneFrom(env = process.env) {
  const tz = env.CREDITS_TIMEZONE || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    throw new Error(`CREDITS_TIMEZONE "${tz}" is not a valid timezone`);
  }
}

function parts(date, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second) };
}

// The calendar day (YYYY-MM-DD) of an instant in the timezone.
function dayKey(date, tz) {
  const { y, m, d } = parts(date, tz);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// When the next day starts in the timezone (ISO, UTC).
function nextDayStart(date, tz) {
  const { y, m, d } = parts(date, tz);
  const offsetAt = (t) => {
    const q = parts(new Date(t), tz);
    return Date.UTC(q.y, q.m - 1, q.d, q.h, q.mi, q.s) - Math.floor(t / 1000) * 1000;
  };
  // Local midnight as UTC; a second pass uses the offset in force at that
  // moment (it differs when the clocks change overnight).
  const midnight = Date.UTC(y, m - 1, d + 1);
  let t = midnight - offsetAt(midnight);
  t = midnight - offsetAt(t);
  return new Date(t).toISOString();
}

// The plan that applies to a device, from its subscription record
// { state: 'active'|'expired'|'suspended'|'inactive'|'none', plan, expiresAt }:
//   suspended        nothing (blocked)
//   active           its plan
//   anything else    Free (a paid plan that ran out falls back to Free)
function entitlementFor(sub, plans = PLANS) {
  if (sub?.state === 'suspended') return { planId: sub.plan || 'free', state: 'suspended', scope: 'blocked', limits: {} };
  const p = sub?.state === 'active' ? plans[sub.plan] || plans.free : plans.free;
  const state = sub?.state === 'active' ? 'active' : sub?.state === 'expired' ? 'expired' : 'free';
  if (!p.daily) return { planId: p.id, state, scope: 'unlimited', limits: {} };
  if (p.daily.total !== undefined) return { planId: p.id, state, scope: 'total', limits: { total: p.daily.total } };
  return { planId: p.id, state, scope: 'per_source', limits: { maps: p.daily.maps, facebook: p.daily.facebook } };
}

// Who is charged: the Free allowance belongs to the computer (so a reinstall
// doesn't start it again); a paid plan to the activated installation.
function accountFor(ent, { deviceId, machineId }) {
  return ent.scope === 'per_source' ? `machine:${machineId}` : `device:${deviceId}`;
}

// The counter a lead of `source` uses under this entitlement.
function bucketFor(ent, source) {
  return ent.scope === 'per_source' ? source : 'total';
}

// What the app shows: { day, timezone, resetsAt, scope, total, maps,
// facebook, discovered }. Each counter is { used, limit, remaining }
// (limit null = unlimited). `used` is the day's counter, the number the
// limit is enforced on (usage.counters); a shared total's split by source
// comes from the charged leads (usage.bySource).
function snapshot(ent, { day, resetsAt, timezone, usage, discovered }) {
  const c = (used, limit) => ({ used, limit: limit ?? null, remaining: limit === undefined || limit === null ? null : Math.max(0, limit - used) });
  const perSource = ent.scope === 'per_source';
  const maps = (perSource ? usage.counters.maps : usage.bySource.maps) || 0;
  const facebook = (perSource ? usage.counters.facebook : usage.bySource.facebook) || 0;
  const blocked = ent.scope === 'blocked';
  return {
    day,
    timezone,
    resetsAt,
    scope: ent.scope,
    total: c(perSource ? maps + facebook : usage.counters.total || 0, blocked ? 0 : ent.limits.total),
    maps: c(maps, blocked ? 0 : ent.limits.maps),
    facebook: c(facebook, blocked ? 0 : ent.limits.facebook),
    discovered: discovered ?? null,
  };
}

module.exports = { DEFAULT_TIMEZONE, SOURCES, KEY_RE, timezoneFrom, dayKey, nextDayStart, entitlementFor, accountFor, bucketFor, snapshot };
