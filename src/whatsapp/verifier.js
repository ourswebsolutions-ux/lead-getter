'use strict';

// Background WhatsApp availability checks for saved leads. Runs only while
// WhatsApp is connected, one number at a time at a gentle pace, and never
// blocks the lead search. Failures are recorded as 'failed' and retried
// later with backoff.

const DEFAULTS = {
  interval: 4000, // between checks
  idle: 30_000, // when nothing is waiting
  retryFailedAfter: 60 * 60 * 1000, // re-check failed numbers after 1h
  rateLimitPause: 5 * 60 * 1000, // after a rate-limit style error
};

function isRateLimit(err) {
  return /rate|too many|429|overlimit/i.test(String(err?.message || err));
}

class WhatsAppVerifier {
  constructor({ client, store, onResult, timings = {} }) {
    this.client = client;
    this.store = store;
    this.onResult = onResult || (() => {});
    this.t = { ...DEFAULTS, ...timings };
    this.timer = null;
    this.running = false;
    this.busy = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
  }

  // New leads arrived: check soon.
  poke() {
    if (this.running && !this.busy) this.schedule(500);
  }

  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), ms);
  }

  async tick() {
    if (!this.running || this.busy) return;
    if (this.client.state !== 'open') return this.schedule(this.t.idle);
    const [phone] = this.store.phonesToCheck(1, new Date(Date.now() - this.t.retryFailedAfter).toISOString());
    if (!phone) return this.schedule(this.t.idle);
    this.busy = true;
    let next = this.t.interval;
    try {
      const status = await this.client.check(phone);
      this.store.setWhatsAppResult(phone, status, 'baileys');
      this.onResult(phone, status);
    } catch (err) {
      if (err?.code === 'not_connected') {
        next = this.t.idle; // not a failure of the number; try when connected
      } else {
        this.store.setWhatsAppResult(phone, 'failed', 'baileys', String(err?.message || err).slice(0, 200));
        this.onResult(phone, 'failed');
        if (isRateLimit(err)) next = this.t.rateLimitPause;
      }
    } finally {
      this.busy = false;
    }
    if (this.running) this.schedule(next);
  }
}

module.exports = { WhatsAppVerifier };
