'use strict';

// The daily lead allowance of a plan: how many unique new leads a plan may
// find per day, across every source (Google Maps, Facebook, LinkedIn,
// Podcasts) together. Enforced in the database layer (LeadStore.guardedSave):
// the check and the save are one transaction, so parallel searches, tab
// changes and restarts cannot go past it; leads already saved (duplicates)
// use nothing.
//
// The day is the plan clock's day (Activation.now(): never earlier than the
// latest time seen, network time when known) in the configured time zone,
// so changing the computer's clock does not reset it.

const DEFAULT = { timeZone: 'Asia/Karachi', dailyLeads: { monthly: 100, six_months: null, lifetime: null } };

function dayIn(ms, timeZone) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

class LeadQuota {
  // plan(): the active plan's id or null; now(): the plan clock; config: { timeZone, dailyLeads: { <plan id>: number | null } }.
  constructor({ store, plan, now, config = {} }) {
    this.store = store;
    this.plan = plan;
    this.now = now;
    this.timeZone = config.timeZone || DEFAULT.timeZone;
    this.limits = { ...DEFAULT.dailyLeads, ...(config.dailyLeads || {}) };
  }

  day() {
    return dayIn(this.now(), this.timeZone);
  }

  // The allowance of the active plan (null: unlimited).
  limit() {
    const plan = this.plan();
    if (!plan) return null; // no plan: searching is refused elsewhere
    const n = this.limits[plan];
    return Number.isInteger(n) && n >= 0 ? n : null;
  }

  // For the database: today's day and allowance, read at the moment of each save.
  gate() {
    return { day: this.day(), limit: this.limit() };
  }

  status() {
    const day = this.day();
    const limit = this.limit();
    const used = this.store.creditsOn(day);
    return { day, limit, used, remaining: limit == null ? null : Math.max(0, limit - used), reached: limit != null && used >= limit, plan: this.plan(), timeZone: this.timeZone };
  }

  message(limit = this.limit()) {
    return `You have reached your daily limit of ${limit} leads. Upgrade your plan to find more leads.`;
  }

  // Before a search starts: { ok } or the refusal (opens the plans).
  check() {
    const st = this.status();
    if (!st.reached) return { ok: true, quota: st };
    return { ok: false, subscription: 'limit', limitReached: true, error: this.message(st.limit), quota: st };
  }
}

module.exports = { LeadQuota, dayIn, DEFAULT };
