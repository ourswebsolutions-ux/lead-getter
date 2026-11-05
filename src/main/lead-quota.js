'use strict';

// The lead allowance of a plan: how many unique new leads a plan may find
// per day (the Free Trial: in total), across every source (Google Maps, Facebook, LinkedIn,
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

const TRIAL = 'free_trial';
const TRIAL_ENDED = 'free_trial_ended';
const CANCELLED = 'cancelled';

class LeadQuota {
  // plan(): the active plan's id or null ('free_trial_ended': a trial that ran
  // out; 'cancelled': cancelled by the administrator); now(): the plan clock; config: { timeZone, dailyLeads: { <plan id>: number | null }, trialLeads }.
  constructor({ store, plan, now, config = {} }) {
    this.store = store;
    this.plan = plan;
    this.now = now;
    this.timeZone = config.timeZone || DEFAULT.timeZone;
    this.limits = { ...DEFAULT.dailyLeads, ...(config.dailyLeads || {}) };
    this.trialLeads = config.trialLeads ?? 30;
  }

  // The trial's leads are counted in total, under their own key: a day never resets them.
  day() {
    return [TRIAL, TRIAL_ENDED].includes(this.plan()) ? TRIAL : dayIn(this.now(), this.timeZone);
  }

  // The allowance of the active plan (null: unlimited).
  limit() {
    const plan = this.plan();
    if (!plan) return null; // no plan: searching is refused elsewhere
    if (plan === TRIAL) return this.trialLeads;
    if (plan === TRIAL_ENDED || plan === CANCELLED) return 0;
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
    return { day, limit, used, remaining: limit == null ? null : Math.max(0, limit - used), reached: limit != null && used >= limit, plan: this.plan(), timeZone: this.timeZone, trial: day === TRIAL, message: this.message(limit) };
  }

  message(limit = this.limit()) {
    const plan = this.plan();
    if (plan === CANCELLED) return 'Your subscription has been cancelled. Lead finding is stopped. Contact us under Activate to reactivate it.';
    if (plan === TRIAL_ENDED) return 'Your Free Trial has ended. Upgrade your plan to find more leads.';
    if (plan === TRIAL) return `You have used all ${limit} leads of your Free Trial. Upgrade your plan to find more leads.`;
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
