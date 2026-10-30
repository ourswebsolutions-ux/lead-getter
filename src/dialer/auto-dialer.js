'use strict';

// The Auto Dialer: calls Call Unseen leads one after another through the
// Dialer (the same Bluetooth Hands-Free calls as the Call button), while the
// user has it on.
//
//   answered         -> stops dialling; after the call, waits for the user to continue
//   ended by the user before an answer -> waits 1 minute, then the next lead
//   not answered, busy, failed -> a short gap, then the next lead
//
// It only calls leads with a valid (by default mobile) number that are Call
// Unseen, not marked "do not call" and not opted out; each lead at most once
// per run; never while a call is going on or the phone is not connected;
// only within the calling hours. Bluetooth lost -> paused. Stopped -> it
// never starts again by itself (it is always off when the app starts).
//
// Events: 'state'.

const { EventEmitter } = require('node:events');
const { parsePhoneNumberFromString } = require('libphonenumber-js/max');
const { dialable } = require('./dialer');

const DEFAULTS = {
  gapSeconds: 10, // between an unanswered call and the next
  afterManualSeconds: 60, // after the user ended a call before it was answered
  ringSeconds: 45, // ring this long, then end the call as not answered
  mobileOnly: true,
  hours: { on: true, from: '09:00', to: '20:00' },
};

const isMobile = (number) => {
  const type = parsePhoneNumberFromString(number)?.getType();
  return type === 'MOBILE' || type === 'FIXED_LINE_OR_MOBILE';
};

const minutes = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2])) : null;
};

function settingsFrom(raw = {}) {
  const n = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
  const h = raw.hours || {};
  return {
    gapSeconds: n(raw.gapSeconds, 5, 600, DEFAULTS.gapSeconds),
    afterManualSeconds: DEFAULTS.afterManualSeconds,
    ringSeconds: n(raw.ringSeconds, 15, 120, DEFAULTS.ringSeconds),
    mobileOnly: raw.mobileOnly !== false,
    hours: { on: h.on !== false, from: minutes(h.from) != null ? h.from : DEFAULTS.hours.from, to: minutes(h.to) != null ? h.to : DEFAULTS.hours.to },
  };
}

class AutoDialer extends EventEmitter {
  constructor({ dialer, store, now = () => Date.now(), clock = () => new Date(), timers = { setTimeout, clearTimeout } }) {
    super();
    this.dialer = dialer;
    this.store = store;
    this.now = now;
    this.clock = clock;
    this.timers = timers;
    this.settings = settingsFrom(store.getState('autoDialerSettings') || {});
    this.timer = null;
    this.ringTimer = null;
    this.tried = new Set();
    this.s = { status: 'off', reason: null, lead: null, nextAt: null, processed: 0, skipped: 0, total: 0, log: [] };
    dialer.on('ended', (call) => this.onEnded(call));
    dialer.on('state', (st) => this.onDialerState(st));
  }

  state() {
    return { ...this.s, settings: this.settings, eligible: this.s.status === 'off' ? this.count() : undefined };
  }

  changed() {
    this.emit('state', this.state());
  }

  // Leads this run may still call (number checks included).
  eligible(limit = 5000) {
    return this.store.callableLeads({ exclude: [...this.tried], limit }).filter((l) => this.callable(l));
  }

  callable(lead) {
    const n = dialable(lead.phone);
    return Boolean(n) && (!this.settings.mobileOnly || isMobile(n));
  }

  count() {
    try {
      return this.eligible().length;
    } catch {
      return 0;
    }
  }

  setSettings(raw) {
    this.settings = settingsFrom({ ...this.settings, ...raw, hours: { ...this.settings.hours, ...(raw?.hours || {}) } });
    this.store.setState('autoDialerSettings', this.settings);
    this.changed();
    return { ok: true, settings: this.settings };
  }

  inHours() {
    const h = this.settings.hours;
    if (!h.on) return true;
    const d = this.clock();
    const t = d.getHours() * 60 + d.getMinutes();
    const from = minutes(h.from);
    const to = minutes(h.to);
    return from <= to ? t >= from && t < to : t >= from || t < to;
  }

  log(entry) {
    this.s.log = [{ at: this.now(), ...entry }, ...this.s.log].slice(0, 20);
  }

  clearTimers() {
    this.timers.clearTimeout(this.timer);
    this.timers.clearTimeout(this.ringTimer);
    this.timer = null;
    this.ringTimer = null;
    this.s.nextAt = null;
  }

  // --- the user's controls -------------------------------------------------------

  start() {
    if (this.s.status !== 'off') return { ok: false, error: 'The Auto Dialer is already on.' };
    if (this.dialer.s.link !== 'ready') return { ok: false, error: 'Connect your phone first.' };
    this.tried = new Set();
    const total = this.count();
    if (!total) return { ok: false, error: 'No leads to call: every lead with a valid mobile number is Call Seen, marked do-not-call or opted out.' };
    this.s = { status: 'running', reason: null, lead: null, nextAt: null, processed: 0, skipped: 0, total, log: [] };
    this.changed();
    this.schedule(0);
    return { ok: true };
  }

  pause(reason = 'Paused by you') {
    if (this.s.status === 'off' || this.s.status === 'paused') return { ok: true };
    this.clearTimers();
    this.s.status = 'paused';
    this.s.reason = reason;
    this.changed();
    return { ok: true };
  }

  // Continue after a pause (also the confirmation after an answered call).
  resume() {
    if (this.s.status !== 'paused') return { ok: false, error: 'The Auto Dialer is not paused.' };
    if (this.dialer.s.link !== 'ready') return { ok: false, error: 'Connect your phone first.' };
    this.s.status = 'running';
    this.s.reason = null;
    this.changed();
    this.schedule(0);
    return { ok: true };
  }

  // Off: no further calls (a call going on is left alone).
  stop(reason = 'Stopped by you') {
    this.clearTimers();
    const was = this.s.status;
    this.s.status = 'off';
    this.s.reason = was === 'off' ? this.s.reason : reason;
    this.s.lead = null;
    this.changed();
    return { ok: true };
  }

  // --- the sequence --------------------------------------------------------------

  schedule(seconds, status = 'running') {
    this.timers.clearTimeout(this.timer);
    this.s.status = status;
    this.s.nextAt = seconds ? this.now() + seconds * 1000 : null;
    this.timer = this.timers.setTimeout(() => this.step(), seconds * 1000);
    this.changed();
  }

  async step() {
    this.timer = null;
    this.s.nextAt = null;
    if (!['running', 'waiting'].includes(this.s.status)) return;
    if (this.dialer.s.link !== 'ready') return this.pause('Bluetooth disconnected: reconnect the phone, then continue');
    if (this.dialer.s.call && this.dialer.s.call.state !== 'ended') {
      // A call is going on (made by hand, or incoming): try again after it.
      this.s.status = 'running';
      this.s.reason = 'Waiting for the current call to end';
      this.changed();
      return;
    }
    if (!this.inHours()) return this.pause(`Outside the calling hours (${this.settings.hours.from}–${this.settings.hours.to})`);
    let lead = null;
    for (const l of this.store.callableLeads({ exclude: [...this.tried], limit: 50 })) {
      this.tried.add(l.id);
      if (this.callable(l)) {
        lead = l;
        break;
      }
      this.s.skipped++;
      this.log({ leadId: l.id, name: l.name, number: l.phone, outcome: 'skipped', reason: dialable(l.phone) ? 'Not a mobile number' : 'Invalid number' });
    }
    if (!lead) {
      if (this.store.callableLeads({ exclude: [...this.tried], limit: 1 }).length) return this.schedule(0);
      this.clearTimers();
      this.s.status = 'off';
      this.s.reason = 'Done: every eligible lead was called';
      this.s.lead = null;
      this.changed();
      return;
    }
    const person = lead.kind === 'person';
    this.s.lead = { id: lead.id, name: person ? lead.name : lead.contactName || lead.name, business: person ? lead.companyName || null : lead.name, number: lead.phone };
    this.s.status = 'calling';
    this.s.reason = null;
    this.changed();
    const r = await this.dialer.call(lead.phone, { leadId: lead.id, auto: true });
    if (r.ok) return;
    // Not placed (no service, the phone refused…): counted, then the next one, unless the phone is gone.
    this.s.processed++;
    this.log({ leadId: lead.id, name: this.s.lead.name, number: lead.phone, outcome: 'failed', reason: r.error });
    if (this.s.status !== 'calling') return;
    if (this.dialer.s.link !== 'ready') return this.pause('Bluetooth disconnected: reconnect the phone, then continue');
    this.schedule(this.settings.gapSeconds, 'waiting');
  }

  onDialerState(st) {
    const call = st.call;
    // Ring for at most ringSeconds, then end it as not answered.
    if (call?.auto && ['dialing', 'alerting', 'requesting'].includes(call.state) && this.s.status === 'calling' && !this.ringTimer) {
      this.ringTimer = this.timers.setTimeout(() => {
        this.ringTimer = null;
        const c = this.dialer.s.call;
        if (c?.auto && c.state !== 'active' && c.state !== 'ended') this.dialer.hangup({ by: 'auto' });
      }, this.settings.ringSeconds * 1000);
    }
    if (call?.auto && call.state === 'active' && this.s.status === 'calling') {
      // Answered: no more dialling until the user says so.
      this.timers.clearTimeout(this.ringTimer);
      this.ringTimer = null;
      this.s.reason = 'Answered: talk now; the Auto Dialer waits for you after the call';
      this.changed();
    }
    if (st.link !== 'ready' && ['running', 'waiting', 'calling'].includes(this.s.status)) this.pause('Bluetooth disconnected: reconnect the phone, then continue');
    // The call that blocked a step ended: go on.
    if (this.s.status === 'running' && this.s.reason === 'Waiting for the current call to end' && !(call && call.state !== 'ended') && !this.timer) this.schedule(this.settings.gapSeconds);
  }

  onEnded(call) {
    if (!call.auto) return;
    this.timers.clearTimeout(this.ringTimer);
    this.ringTimer = null;
    if (this.s.status === 'off') return;
    this.s.processed++;
    this.log({ leadId: call.leadId, name: call.name || call.business, number: call.number, outcome: call.status, reason: call.reason });
    if (this.s.status === 'paused') return this.changed();
    if (call.status === 'answered') {
      this.clearTimers();
      this.s.status = 'paused';
      this.s.reason = 'The last call was answered: continue when you are ready';
      this.changed();
      return;
    }
    if (call.status === 'cancelled') return this.schedule(this.settings.afterManualSeconds, 'waiting');
    this.schedule(this.settings.gapSeconds, 'waiting');
  }
}

module.exports = { AutoDialer, settingsFrom, isMobile, DEFAULTS };
