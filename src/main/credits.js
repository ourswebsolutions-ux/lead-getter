'use strict';

// The daily qualified-lead allowance as the search workers see it. The
// subscription server decides: every new lead is charged there before it
// is saved (reserve), and each answer carries the up-to-date allowance, so
// a worker can stop as soon as its source is used up instead of opening
// more listings or posts (exhausted). Shared by both workers, so on a paid
// plan the shared daily total stops both.

const SOURCE_NAME = { maps: 'Google Maps', facebook: 'Facebook' };

class CreditGate {
  // credits: the allowance from the signed status; onChange(credits) after
  // every server answer.
  constructor({ license, credits = null, onChange = () => {} }) {
    this.license = license;
    this.credits = credits;
    this.onChange = onChange;
  }

  counter(source) {
    const c = this.credits;
    if (!c) return null;
    return c.scope === 'per_source' ? c[source] : c.total;
  }

  exhausted(source) {
    const c = this.credits;
    if (!c || c.scope === 'unlimited') return false;
    if (c.scope === 'blocked') return true;
    const k = this.counter(source);
    return k.limit !== null && k.remaining <= 0;
  }

  // -> { granted, duplicate, reason, credits } (throws when the server
  // can't be reached; the caller retries or stops).
  async reserve(source, key) {
    const r = await this.license.reserveCredit(source, key);
    if (r?.credits) {
      this.credits = r.credits;
      this.onChange(r.credits);
    }
    return r;
  }

  // Why `source` (or, without one, any source) can't save more leads
  // today, for the search status.
  message(source = null, reason = null) {
    const c = this.credits;
    if (reason === 'suspended' || c?.scope === 'blocked') return 'Your subscription is suspended, so no more leads can be saved.';
    const at = c?.resetsAt ? new Date(c.resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'midnight';
    if (c?.scope === 'per_source') {
      if (!source) return `Today's Google Maps and Facebook leads are used up. More at ${at}.`;
      const k = this.counter(source);
      return `Today's ${SOURCE_NAME[source]} leads are used up (${k.used} of ${k.limit}). More at ${at}.`;
    }
    const limit = this.counter('maps')?.limit;
    return `Today's ${limit ? `${limit} ` : ''}leads are used up. More at ${at}.`;
  }
}

module.exports = { CreditGate, SOURCE_NAME };
