'use strict';

// Email campaign sequences and sending schedules (used by campaigns.js):
//   follow-ups  steps sent after the first email when the lead has not
//               replied: { on, steps: [{ days, subject, body }] } (days after
//               the previous email; an empty subject replies in the same
//               thread, "Re: ...")
//   schedule    the days and hours a campaign may send, in a time zone:
//               { on, days: [0-6, Sunday 0], start, end (minutes of the day), tz }
//   signature   the sender's sign-off every email ends with (never replaced by the AI)

const DAY = 24 * 3600_000;
const MAX_STEPS = 5;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const FOLLOWUP_DEFAULTS = { on: false, steps: [] };
const SCHEDULE_DEFAULTS = { on: false, days: [1, 2, 3, 4, 5], start: 9 * 60, end: 18 * 60, tz: '' };

function validTz(tz) {
  if (!tz) return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// -> { ok, value } | { ok: false, error }
function checkFollowups(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Follow-ups are not in the expected form.' };
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  if (steps.length > MAX_STEPS) return { ok: false, error: `Up to ${MAX_STEPS} follow-ups.` };
  const out = [];
  for (const [i, s] of steps.entries()) {
    const days = Number(s?.days);
    if (!Number.isFinite(days) || days < 1 || days > 60 || Math.round(days * 2) !== days * 2) return { ok: false, error: `Follow-up ${i + 1}: wait 1 to 60 days (whole or half days).` };
    const subject = String(s?.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
    const body = String(s?.body || '').trim();
    if (body.length > 20_000) return { ok: false, error: `Follow-up ${i + 1} is too long.` };
    out.push({ days, subject, body });
  }
  const on = raw.on === true;
  if (on && !out.length) return { ok: false, error: 'Add a follow-up, or turn follow-ups off.' };
  if (on && out.some((s) => !s.body)) return { ok: false, error: `Write follow-up ${out.findIndex((s) => !s.body) + 1} (its email, or its prompt for the AI).` };
  return { ok: true, value: { on, steps: out } };
}

function checkSchedule(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'The sending schedule is not in the expected form.' };
  const days = [...new Set((Array.isArray(raw.days) ? raw.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  const start = Math.round(Number(raw.start));
  const end = Math.round(Number(raw.end));
  const tz = String(raw.tz || '').trim().slice(0, 64);
  const on = raw.on === true;
  if (on && !days.length) return { ok: false, error: 'Choose at least one sending day.' };
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > 24 * 60 || end - start < 30) return { ok: false, error: 'The sending hours must be at least 30 minutes (start before end).' };
  if (!validTz(tz)) return { ok: false, error: 'That time zone is not known.' };
  return { ok: true, value: { on, days, start, end, tz } };
}

// The day of the week (0 Sunday) and minute of the day at `ms` in the zone.
function localTime(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { day: DAY_NAMES.indexOf(get('weekday')), minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

function inWindow(schedule, ms) {
  if (!schedule?.on) return true;
  const t = localTime(ms, schedule.tz);
  return schedule.days.includes(t.day) && t.minute >= schedule.start && t.minute < schedule.end;
}

// When the window next opens (ms), or null (always open / never).
function nextWindow(schedule, ms) {
  if (!schedule?.on) return null;
  if (inWindow(schedule, ms)) return ms;
  const step = 5 * 60_000;
  let t = Math.ceil(ms / step) * step;
  for (let i = 0; i < (8 * DAY) / step; i++, t += step) if (inWindow(schedule, t)) return t;
  return null;
}

// The pause before the campaign's next email: its delay, or a random one
// between the delay and its "up to" value.
function pauseMs(config, random = Math.random) {
  const min = Number(config.delaySeconds) || 60;
  const max = Number(config.delayMaxSeconds) > min ? Number(config.delayMaxSeconds) : min;
  return Math.round((min + random() * (max - min)) * 1000);
}

// The signature at the end of a text body, unless it already ends with it
// (the AI was asked to end with it; a template may include it).
function withSignature(text, signature) {
  const sig = String(signature || '').trim();
  if (!sig) return text;
  const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const body = String(text || '').trimEnd();
  if (norm(body.slice(-sig.length - 40)).endsWith(norm(sig))) return body;
  return `${body}\n\n${sig}`;
}

module.exports = { checkFollowups, checkSchedule, inWindow, nextWindow, localTime, pauseMs, withSignature, validTz, FOLLOWUP_DEFAULTS, SCHEDULE_DEFAULTS, MAX_STEPS, DAY };
