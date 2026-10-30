'use strict';

// SMS campaigns: one message (with placeholders) to many recipients, sent
// one at a time through the connected phone (Sms.send, Bluetooth MAP).
//
// Each recipient has its own persisted status:
//   pending -> sending -> submitted (the phone accepted it) -> sent (the phone
//   reported it or lists it in its sent folder) -> delivered (delivery report)
//   failed (with the reason; retried up to max_retries) · skipped (opted out,
//   already texted, no message after placeholders)
//
// One campaign sends at a time, with the campaign's delay between messages
// and its hourly limit. Messages disconnected -> the campaign waits and goes
// on when they are back. After a restart nothing is sent twice: a message
// whose outcome is unknown (Lead Finder closed while handing it to the
// phone) is marked failed with that reason, not sent again.
//
// Events: 'changed' ({ id }).

const { EventEmitter } = require('node:events');

const MIN_DELAY = 10; // seconds between two texts, at least
const SPEEDS = { slow: 60, normal: 30, fast: 15 };
const DISCONNECTED = 'Waiting for the phone: messages are not connected';

// {name} {business_name} {business} {phone} {category} {city}; an empty field leaves no gap.
function render(message, r) {
  const values = {
    name: r.name || r.business || '',
    business_name: r.business || r.name || '',
    business: r.business || r.name || '',
    phone: r.phone || '',
    category: r.category || '',
    city: r.city || '',
  };
  return String(message || '')
    .replace(/\{(name|business_name|business|phone|category|city)\}/gi, (_, k) => values[k.toLowerCase()])
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.!?;:])/g, '$1')
    .replace(/([,;:])(?=[,;:.!?])/g, '')
    .replace(/^[ \t,]+/gm, '')
    .trim();
}

// Provinces and states that come after the city in addresses.
const REGIONS = new Set(
  [
    'punjab', 'sindh', 'balochistan', 'khyber pakhtunkhwa', 'kpk', 'islamabad capital territory', 'gilgit-baltistan', 'azad kashmir', 'azad jammu and kashmir',
    'england', 'scotland', 'wales', 'northern ireland', 'ontario', 'quebec', 'british columbia', 'alberta', 'new south wales', 'victoria', 'queensland', 'dubai', 'abu dhabi', 'sharjah',
    'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming',
  ],
);

// The city of an address, best effort: without the country, postcode and
// province/state ("…, Gulberg, Lahore, Punjab 54000, Pakistan" -> Lahore;
// "Blue Area, Islamabad, Pakistan" -> Islamabad; "Austin, TX 78701, USA" -> Austin).
function cityOf(address) {
  let parts = String(address || '')
    .split(',')
    .map((p) => p.replace(/\b[A-Z]{0,2}\d[\dA-Z-]*\b/g, '').replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  parts = parts.slice(0, -1); // the country
  while (parts.length > 1 && (REGIONS.has(parts.at(-1).toLowerCase()) || /^[A-Z]{2}$/.test(parts.at(-1)))) parts.pop();
  return parts.at(-1) || null;
}

function settingsFrom(raw = {}) {
  const n = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
  const delay = raw.speed && SPEEDS[raw.speed] ? SPEEDS[raw.speed] : n(raw.delaySeconds, MIN_DELAY, 3600, 30);
  return { delaySeconds: delay, perHour: n(raw.perHour, 1, 500, 60), maxRetries: n(raw.maxRetries, 0, 5, 2), skipTexted: raw.skipTexted !== false };
}

class SmsCampaigns extends EventEmitter {
  constructor({ sms, store, now = () => Date.now(), timers = { setTimeout, clearTimeout } }) {
    super();
    this.sms = sms;
    this.store = store;
    this.now = now;
    this.timers = timers;
    this.timer = null;
    this.busy = false;
    sms.on('changed', () => {
      if (this.store.syncSmsRecipients()) this.emit('changed', {});
    });
    sms.on('state', (st) => this.onSmsState(st));
  }

  // After a restart: messages handed over when Lead Finder closed are not sent again.
  init() {
    for (const c of this.store.smsCampaigns()) {
      const sending = this.store.smsRecipients(c.id, { status: 'sending', limit: 2000 }).rows;
      for (const r of sending) {
        const msg = r.smsId ? this.store.smsMessages(r.phone).find((m) => m.id === r.smsId) : null;
        if (msg && ['submitted', 'sent', 'delivered'].includes(msg.status)) this.store.updateSmsRecipient(r.id, { status: msg.status });
        else this.store.updateSmsRecipient(r.id, { status: 'failed', reason: 'Lead Finder closed while handing this message to the phone: not sent again, to avoid a duplicate. Check the phone’s sent messages.' });
      }
    }
    this.schedule(2_000);
  }

  list() {
    return this.store.smsCampaigns();
  }

  running() {
    return this.store.smsCampaigns().find((c) => c.status === 'running') || null;
  }

  create({ name, message, ...raw }) {
    const n = String(name || '').trim().slice(0, 80);
    const m = String(message || '').trim().slice(0, 1600);
    if (!n) return { ok: false, error: 'Give the campaign a name.' };
    if (!m) return { ok: false, error: 'Write the message.' };
    const id = this.store.createSmsCampaign({ name: n, message: m, ...settingsFrom(raw), device: this.sms.address || null });
    this.emit('changed', { id });
    return { ok: true, id };
  }

  // Name, message and sending controls (not while it sends).
  update(id, { name, message, ...raw }) {
    const c = this.store.smsCampaign(id);
    if (!c) return { ok: false, error: 'That campaign no longer exists.' };
    if (c.status === 'running') return { ok: false, error: 'Pause the campaign to change it.' };
    const fields = { ...settingsFrom({ ...c, ...raw }) };
    if (name != null) fields.name = String(name).trim().slice(0, 80) || c.name;
    if (message != null) {
      if (!String(message).trim()) return { ok: false, error: 'Write the message.' };
      fields.message = String(message).trim().slice(0, 1600);
    }
    this.store.updateSmsCampaign(id, fields);
    this.emit('changed', { id });
    return { ok: true };
  }

  addRecipients(id, recipients) {
    const c = this.store.smsCampaign(id);
    if (!c) return { ok: false, error: 'That campaign no longer exists.' };
    if (['stopped', 'done'].includes(c.status)) return { ok: false, error: 'This campaign has ended.' };
    const r = this.store.addSmsRecipients(id, recipients.filter((x) => x.phone));
    this.emit('changed', { id });
    return { ok: true, ...r };
  }

  removeRecipients(id, ids) {
    const removed = this.store.removeSmsRecipients(id, ids);
    this.emit('changed', { id });
    return { ok: true, removed };
  }

  start(id) {
    const c = this.store.smsCampaign(id);
    if (!c) return { ok: false, error: 'That campaign no longer exists.' };
    if (!['draft', 'paused'].includes(c.status)) return { ok: false, error: c.status === 'running' ? 'It is already sending.' : 'This campaign has ended.' };
    if (!c.counts.pending) return { ok: false, error: 'There is nobody left to send to: add recipients.' };
    const other = this.running();
    if (other && other.id !== id) return { ok: false, error: `"${other.name}" is sending: pause it first (one campaign at a time).` };
    this.store.updateSmsCampaign(id, { status: 'running', reason: this.sms.s.state === 'ready' ? null : DISCONNECTED, startedAt: c.startedAt || this.now() });
    this.emit('changed', { id });
    this.schedule(0);
    return { ok: true };
  }

  pause(id, reason = 'Paused by you') {
    const c = this.store.smsCampaign(id);
    if (!c || c.status !== 'running') return { ok: false, error: 'It is not sending.' };
    this.store.updateSmsCampaign(id, { status: 'paused', reason });
    this.emit('changed', { id });
    return { ok: true };
  }

  // Ends it: what was not sent stays unsent.
  stop(id) {
    const c = this.store.smsCampaign(id);
    if (!c || ['stopped', 'done'].includes(c.status)) return { ok: false, error: 'This campaign has ended.' };
    this.store.updateSmsCampaign(id, { status: 'stopped', reason: 'Stopped by you', finishedAt: this.now() });
    this.emit('changed', { id });
    return { ok: true };
  }

  retryFailures(id) {
    const c = this.store.smsCampaign(id);
    if (!c) return { ok: false, error: 'That campaign no longer exists.' };
    if (c.status === 'stopped') return { ok: false, error: 'This campaign was stopped.' };
    const n = this.store.retrySmsFailures(id);
    if (n && c.status === 'done') this.store.updateSmsCampaign(id, { status: 'paused', reason: `${n} failed message${n === 1 ? '' : 's'} ready to send again: resume to send` });
    this.emit('changed', { id });
    return { ok: true, retried: n };
  }

  remove(id) {
    const c = this.store.smsCampaign(id);
    if (c?.status === 'running') return { ok: false, error: 'Pause or stop the campaign first.' };
    this.store.deleteSmsCampaign(id);
    this.emit('changed', { id });
    return { ok: true };
  }

  // Previews of the message for the first recipients (real data).
  preview(id, limit = 5) {
    const c = this.store.smsCampaign(id);
    if (!c) return [];
    return this.store.smsRecipients(id, { limit }).rows.map((r) => ({ recipient: r, text: render(c.message, r) }));
  }

  onSmsState(st) {
    const c = this.running();
    if (!c) return;
    if (st.state === 'ready') {
      if (c.reason === DISCONNECTED) {
        this.store.updateSmsCampaign(c.id, { reason: null });
        this.emit('changed', { id: c.id });
      }
      this.schedule(1_000);
    } else if (c.reason !== DISCONNECTED) {
      this.store.updateSmsCampaign(c.id, { reason: DISCONNECTED });
      this.emit('changed', { id: c.id });
    }
  }

  schedule(ms) {
    this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => this.tick(), ms);
  }

  // One step of the queue: the next recipient of the sending campaign.
  async tick() {
    this.timer = null;
    if (this.busy) return;
    const c = this.running();
    if (!c || this.sms.s.state !== 'ready') return;
    this.busy = true;
    try {
      // Hourly limit (all texts handed to the phone, by hand or by campaigns).
      const hourAgo = this.now() - 3_600_000;
      if (this.store.smsSentSince(hourAgo) >= c.perHour) {
        this.store.updateSmsCampaign(c.id, { reason: `Hourly limit of ${c.perHour} texts reached: going on later` });
        this.emit('changed', { id: c.id });
        return this.schedule(60_000);
      }
      const r = this.store.nextSmsRecipient(c.id, this.now());
      if (!r) {
        const retryAt = this.store.nextSmsRetryAt(c.id);
        if (retryAt) return this.schedule(Math.max(1_000, retryAt - this.now()));
        this.store.updateSmsCampaign(c.id, { status: 'done', reason: null, finishedAt: this.now() });
        this.emit('changed', { id: c.id });
        return this.schedule(1_000); // nothing else runs; harmless
      }
      if (c.reason && /limit/.test(c.reason)) this.store.updateSmsCampaign(c.id, { reason: null });
      const skip = (reason) => this.store.updateSmsRecipient(r.id, { status: 'skipped', reason });
      if (this.store.isOptedOut(r.phone)) {
        skip('Opted out: never texted');
        this.emit('changed', { id: c.id });
        return this.schedule(0);
      }
      if (c.skipTexted && this.store.textedBefore(r.phone)) {
        skip('Already texted before (in another campaign or by hand)');
        this.emit('changed', { id: c.id });
        return this.schedule(0);
      }
      const body = render(c.message, r);
      if (!body) {
        skip('The message is empty for this contact');
        return this.schedule(0);
      }
      this.store.updateSmsRecipient(r.id, { status: 'sending', attempts: r.attempts + 1, body, nextAt: null, reason: null });
      this.emit('changed', { id: c.id });
      const res = await this.sms.send(r.phone, body, { leadId: r.kind === 'lead' ? r.refId : null, numberId: r.kind === 'number' ? r.refId : null });
      if (res.ok) {
        this.store.updateSmsRecipient(r.id, { status: 'submitted', smsId: res.id });
      } else if (res.optedOut) {
        skip('Opted out: never texted');
      } else if (this.sms.s.state !== 'ready') {
        // The phone went away: not this recipient's fault; it waits in the queue.
        this.store.updateSmsRecipient(r.id, { status: 'pending', attempts: r.attempts, reason: null });
      } else if (r.attempts + 1 <= c.maxRetries) {
        this.store.updateSmsRecipient(r.id, { status: 'pending', nextAt: this.now() + 60_000 * (r.attempts + 1), reason: `${res.error} (will try again)` });
      } else {
        this.store.updateSmsRecipient(r.id, { status: 'failed', reason: res.error });
      }
      this.emit('changed', { id: c.id });
      this.schedule(c.delaySeconds * 1000);
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { SmsCampaigns, render, cityOf, settingsFrom, SPEEDS, MIN_DELAY };
