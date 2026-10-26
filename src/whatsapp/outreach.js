'use strict';

// Real-estate outreach campaigns: a three-message introduction to verified
// WhatsApp leads, sent automatically by a persistent, rate-limited scheduler.
//
// Timing: a contact's three messages go about one minute apart; the next
// contact starts 45-60 minutes (random within the campaign's range) after
// the previous contact's last message.
//
// Safety rules (all enforced here, whatever the UI sends):
//   - one campaign runs at a time and one contact at a time; the daily limit
//     (10-15 unique contacts) and the gap between contacts count across all
//     campaigns, so several campaigns can't multiply the volume;
//   - each stage is reserved in the database before it is sent, so a stage
//     is never sent twice (retries, restarts, duplicate events, resets);
//   - someone messaged in any campaign is never messaged by another one
//     unless that campaign explicitly allows previously contacted people;
//     opt-outs are never messaged, whatever the settings;
//   - nothing is sent in the recipient's quiet hours or outside the
//     campaign's dates;
//   - a reply pauses that contact; an opt-out stops it for good; WhatsApp
//     refusals pause the campaign;
//   - live sending needs the user's explicit acknowledgement of WhatsApp's
//     rules on automated messages. Test runs send nothing.

const { EventEmitter } = require('node:events');
const { DEFAULT_TEMPLATES, render, validateTemplates, isOptOut, cleanBusiness, extractName } = require('./templates');
const { eligibleContacts, isVerified } = require('./eligibility');

const LIMITS = { intervalMin: 45, intervalMax: 60, capMin: 10, capMax: 15 };
const DEFAULT_CONFIG = {
  templates: DEFAULT_TEMPLATES,
  intervalMin: 45,
  intervalMax: 60,
  dailyCap: 10,
  quietStart: 21,
  quietEnd: 9,
  test: true,
  startDate: null, // YYYY-MM-DD, this computer's calendar; null = no limit
  endDate: null,
  allowPrevious: false, // also people messaged before (never opt-outs)
  filters: { categories: [], from: null, to: null }, // last lead selection, for convenience
};
const MIN = 60_000;
const STAGE_GAP = 60_000; // between one contact's messages (55-65 s)
const SYNC_EVERY = 60_000; // category campaigns look for new eligible leads
// Definite failures are retried automatically: 3 attempts in all, the
// second after an hour, the third after six hours. Uncertain sends never.
const MAX_ATTEMPTS = 3;
const RETRY_AFTER = [60 * 60_000, 6 * 60 * 60_000];
const ACK_KEY = 'outreach.ack';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Recipient time zone from the country calling code (one-zone countries).
const ZONES = [
  ['92', 'Asia/Karachi'], ['971', 'Asia/Dubai'], ['966', 'Asia/Riyadh'], ['974', 'Asia/Qatar'], ['968', 'Asia/Muscat'], ['965', 'Asia/Kuwait'],
  ['973', 'Asia/Bahrain'], ['91', 'Asia/Kolkata'], ['880', 'Asia/Dhaka'], ['44', 'Europe/London'], ['353', 'Europe/Dublin'], ['49', 'Europe/Berlin'],
  ['33', 'Europe/Paris'], ['34', 'Europe/Madrid'], ['39', 'Europe/Rome'], ['31', 'Europe/Amsterdam'], ['90', 'Europe/Istanbul'], ['86', 'Asia/Shanghai'],
  ['60', 'Asia/Kuala_Lumpur'], ['65', 'Asia/Singapore'], ['27', 'Africa/Johannesburg'], ['20', 'Africa/Cairo'], ['94', 'Asia/Colombo'], ['977', 'Asia/Kathmandu'],
];
function timeZoneOf(phone) {
  const digits = String(phone || '').replace(/^\+/, '');
  const hit = ZONES.filter(([cc]) => digits.startsWith(cc)).sort((a, b) => b[0].length - a[0].length)[0];
  return hit ? hit[1] : null; // null: this computer's time zone
}

function hourIn(ms, zone) {
  const opts = { hour: 'numeric', hourCycle: 'h23', ...(zone ? { timeZone: zone } : {}) };
  return Number(new Intl.DateTimeFormat('en-GB', opts).format(new Date(ms)));
}

function inQuietHours(hour, start, end) {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

// The sender's local calendar day: the daily cap resets at local midnight.
function dayOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function errorText(err) {
  return String(err?.message || err || 'unknown error').split('\n')[0].slice(0, 300);
}

// WhatsApp refusing messages (rate limits, restrictions, bans): automation
// stops instead of trying to get around it.
function isRestriction(err) {
  const code = err?.output?.statusCode ?? err?.data?.code ?? err?.code;
  return [401, 403, 405, 429, 463, 479].includes(Number(code)) || /rate.?over.?limit|not.?authori[sz]ed|forbidden|banned|restricted|spam|too many|blocked|logged.?out/i.test(errorText(err));
}

function isTimeout(err) {
  return /timed out|timeout/i.test(errorText(err));
}

class Outreach extends EventEmitter {
  // store: OutreachStore; state: { get(key), set(key, value) } (app_state);
  // transport: { ready() -> bool, send(phone, text) -> Promise<{ id }> };
  // details(contact) -> { business } (the lead's business name);
  // hasReplied(phone, sinceMs) -> bool (safety net for missed reply events);
  // canSend() -> Promise<bool> (subscription).
  // leads() -> LeadStore.listLeads() rows (for category campaigns);
  // nameFor(lead) -> the name to use for a lead added automatically.
  constructor({ store, state, transport, details = () => ({}), hasReplied = () => false, canSend = async () => true, clock = () => Date.now(), random = Math.random, zoneOf = timeZoneOf, tickMs = 30_000, leads = () => [], nameFor = (lead) => extractName(lead.name) }) {
    super();
    Object.assign(this, { store, state, transport, details, hasReplied, canSend, clock, random, zoneOf, tickMs, leads, nameFor });
    this.syncedAt = new Map(); // campaign id -> last queue sync
    this.busy = false;
    this.timer = null;
    this.waiting = new Map(); // campaign id -> reason
  }

  // --- campaigns -----------------------------------------------------------------

  load(id) {
    const c = this.store.campaign(id);
    return c ? { ...c, config: { ...DEFAULT_CONFIG, ...c.config, filters: { ...DEFAULT_CONFIG.filters, ...(c.config.filters || {}) } } } : null;
  }

  save(st) {
    this.store.saveCampaign(st, this.clock());
    this.emit('change', { id: st.id });
  }

  create(name) {
    const clean = String(name || '').trim().slice(0, 60) || `Campaign ${this.store.campaigns().length + 1}`;
    const id = this.store.createCampaign(clean, { ...DEFAULT_CONFIG }, this.clock());
    this.emit('change', { id });
    return { ok: true, id };
  }

  remove(ids) {
    const list = this.idList(ids);
    if (!list.length) return { ok: false, error: 'Select a campaign first.' };
    for (const id of list) this.store.deleteCampaign(id);
    for (const id of list) this.waiting.delete(id);
    this.emit('change', {});
    return { ok: true, deleted: list.length };
  }

  reset(ids) {
    const list = this.idList(ids);
    if (!list.length) return { ok: false, error: 'Select a campaign first.' };
    for (const id of list) {
      this.store.resetCampaign(id, this.clock());
      this.waiting.delete(id);
    }
    this.emit('change', {});
    return { ok: true, reset: list.length };
  }

  idList(ids) {
    const known = new Set(this.store.campaigns().map((c) => c.id));
    return [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number))].filter((id) => known.has(id));
  }

  // A handle with the per-campaign operations.
  campaign(id) {
    const self = this;
    const has = () => Boolean(self.store.campaign(id));
    const call = (fn) => (...args) => (has() ? fn(...args) : { ok: false, error: 'That campaign no longer exists.' });
    return {
      id,
      load: () => self.load(id),
      configure: call((patch) => self.configure(id, patch)),
      start: call((opts) => self.start(id, opts)),
      pause: call((reason) => self.pause(id, reason)),
      resume: call(() => self.resume(id)),
      stop: call(() => self.stop(id)),
      addLeads: call((list) => self.addLeads(id, list)),
      setName: call((phone, name) => self.setName(id, phone, name)),
      exclude: call((phone) => self.exclude(id, phone)),
      include: call((phone) => self.include(id, phone)),
      removeContact: call((phone) => self.removeContact(id, phone)),
      optOut: (phone, reason) => self.optOut(phone, reason),
      contact: (phone) => self.store.contact(id, phone),
      contacts: () => self.store.contacts(id),
      setContact: (phone, fields) => self.store.setContact(id, phone, fields, self.clock()),
      sends: ({ test } = {}) => self.store.sends({ campaignId: id, test }),
      preview: (contact) => self.preview(contact),
      snapshot: () => self.snapshot(id),
    };
  }

  // --- category campaigns ------------------------------------------------------
  //
  // One campaign per lead category ('<category id>' or 'none'). Switched ON,
  // it fills its own queue with the category's eligible leads (confirmed on
  // WhatsApp, never messaged by any campaign, not opted out) and keeps
  // adding new ones as they are found and verified.

  categoryCampaign(category, name) {
    const key = String(category);
    const found = this.store.campaignForCategory(key);
    if (found) return found.id;
    const id = this.store.createCampaign(String(name || 'Category campaign').slice(0, 60), { ...DEFAULT_CONFIG }, this.clock(), key);
    this.emit('change', { id });
    return id;
  }

  setCategoryEnabled(category, name, on, opts = {}) {
    const id = this.categoryCampaign(category, name);
    if (!on) {
      // Stops scheduling; a message already being sent finishes and is recorded.
      const r = this.stop(id);
      this.waiting.delete(id);
      return { ...r, id };
    }
    this.syncQueue(id, this.clock(), true);
    return { ...this.start(id, opts), id };
  }

  // Adds the category's new eligible leads to the campaign's queue.
  syncQueue(id, now = this.clock(), force = false) {
    const st = this.load(id);
    if (!st?.category) return 0;
    if (!force && now - (this.syncedAt.get(id) || 0) < SYNC_EVERY) return 0;
    this.syncedAt.set(id, now);
    const leads = this.leads();
    const { eligible } = eligibleContacts({ leads, store: this.store, campaign: st, filters: { categories: [st.category] } });
    // Oldest leads first (the order they were collected in).
    const when = new Map(leads.map((l) => [l.id, l.discoveredAt || '']));
    const list = eligible
      .filter((l) => !l.inCampaign)
      .sort((a, b) => String(when.get(a.id)).localeCompare(String(when.get(b.id))) || a.id - b.id)
      .map((l) => ({ phone: l.phone, leadId: l.id, name: this.nameFor(l) }));
    if (!list.length) return 0;
    const r = this.store.addContacts(id, list, { allowPrevious: st.config.allowPrevious }, now);
    if (r.added) this.emit('change', { id });
    return r.added;
  }

  // Leads of each category: Seen (a campaign message was sent), Unseen and
  // confirmed on WhatsApp (can be messaged), Unseen and not (yet) confirmed.
  categoryStats() {
    const out = {};
    for (const l of this.leads()) {
      const key = l.categoryId == null ? 'none' : String(l.categoryId);
      const s = (out[key] ||= { leads: 0, seen: 0, unseenVerified: 0, unseenNotVerified: 0, optedOut: 0 });
      s.leads++;
      if (l.campaign === 'seen') s.seen++;
      else if (l.phone && this.store.isOptedOut(l.phone)) s.optedOut++;
      else if (isVerified(l)) s.unseenVerified++;
      else s.unseenNotVerified++;
    }
    return out;
  }

  // --- configuration ---------------------------------------------------------

  static checkConfig(c) {
    const errors = validateTemplates(c.templates);
    const int = (v) => Number.isInteger(v);
    if (!int(c.intervalMin) || !int(c.intervalMax) || c.intervalMin < LIMITS.intervalMin || c.intervalMax > LIMITS.intervalMax || c.intervalMin > c.intervalMax) {
      errors.push(`The gap between contacts must be between ${LIMITS.intervalMin} and ${LIMITS.intervalMax} minutes.`);
    }
    if (!int(c.dailyCap) || c.dailyCap < LIMITS.capMin || c.dailyCap > LIMITS.capMax) errors.push(`The daily limit must be between ${LIMITS.capMin} and ${LIMITS.capMax} contacts.`);
    if (!int(c.quietStart) || !int(c.quietEnd) || c.quietStart < 0 || c.quietStart > 23 || c.quietEnd < 0 || c.quietEnd > 23) errors.push('Sending hours must be whole hours (0-23).');
    else {
      const open = Array.from({ length: 24 }, (_, h) => h).filter((h) => !inQuietHours(h, c.quietStart, c.quietEnd)).length;
      if (open < 4) errors.push('Allow at least 4 sending hours a day.');
    }
    if ((c.startDate && !DATE.test(c.startDate)) || (c.endDate && !DATE.test(c.endDate))) errors.push('Dates must be YYYY-MM-DD.');
    else if (c.startDate && c.endDate && c.startDate > c.endDate) errors.push('The end date is before the start date.');
    return errors;
  }

  configure(id, patch) {
    const st = this.load(id);
    if (st.status === 'running') return { ok: false, error: 'Pause the campaign before changing its settings.' };
    const config = { ...st.config, ...patch };
    config.templates = (config.templates || []).map((t) => ({ text: String(t?.text ?? '').trim(), fallback: String(t?.fallback ?? '').trim() }));
    for (const k of ['intervalMin', 'intervalMax', 'dailyCap', 'quietStart', 'quietEnd']) config[k] = Number(config[k]);
    config.test = Boolean(config.test);
    config.allowPrevious = Boolean(config.allowPrevious);
    config.startDate = config.startDate || null;
    config.endDate = config.endDate || null;
    const f = config.filters || {};
    config.filters = {
      categories: Array.isArray(f.categories) ? f.categories.map(String).slice(0, 100) : [],
      from: f.from && DATE.test(f.from) ? f.from : null,
      to: f.to && DATE.test(f.to) ? f.to : null,
    };
    const errors = Outreach.checkConfig(config);
    if (errors.length) return { ok: false, error: errors.join(' ') };
    const name = patch.name !== undefined ? String(patch.name).trim().slice(0, 60) : st.name;
    if (!name) return { ok: false, error: 'Give the campaign a name.' };
    delete config.name;
    if (st.config.test && !config.test) this.store.clearTest(id); // switching to live: forget simulated progress
    this.save({ ...st, name, config });
    return { ok: true, snapshot: this.snapshot(id) };
  }

  // --- controls ---------------------------------------------------------------

  acknowledged() {
    return Boolean(this.state.get(ACK_KEY));
  }

  start(id, { acknowledge = false } = {}) {
    const st = this.load(id);
    const errors = Outreach.checkConfig(st.config);
    if (errors.length) return { ok: false, error: errors.join(' ') };
    // Several campaigns may be on; the scheduler still sends to one contact
    // at a time with the gap between contacts shared by all of them.
    if (!st.category && !this.store.contacts(id).some((c) => ['queued', 'active'].includes(c.state))) return { ok: false, error: 'Add verified leads to the campaign first.' };
    if (!st.config.test && !this.acknowledged() && !acknowledge) return { ok: false, error: 'Confirm that you accept WhatsApp’s rules on automated messages before sending for real.', needsAcknowledgement: true };
    if (!st.config.test && !this.acknowledged()) this.state.set(ACK_KEY, this.clock());
    st.status = 'running';
    st.pauseReason = null;
    st.failures = 0;
    // A contact whose sequence was interrupted (pause, stop, restart) is
    // finished first, a minute after their last message; otherwise the next
    // contact waits the full gap after the last campaign message (any
    // campaign).
    const now = this.clock();
    const current = this.current(st);
    if (current) st.nextDueAt = Math.max(now, (current.lastSentAt || 0) + STAGE_GAP);
    else {
      st.current = null;
      const last = this.store.lastSendAt(st.config.test);
      st.nextDueAt = Math.max(now, last ? last + this.contactGap(st.config) : 0);
    }
    this.save(st);
    this.kick();
    return { ok: true, snapshot: this.snapshot(id) };
  }

  pause(id, reason = 'user') {
    const st = this.load(id);
    if (st.status !== 'running') return { ok: true, snapshot: this.snapshot(id) };
    st.status = 'paused';
    st.pauseReason = reason;
    this.save(st);
    return { ok: true, snapshot: this.snapshot(id) };
  }

  resume(id) {
    const st = this.load(id);
    if (st.status !== 'paused') return { ok: false, error: 'The campaign is not paused.' };
    return this.start(id);
  }

  stop(id) {
    const st = this.load(id);
    st.status = 'stopped';
    st.pauseReason = null;
    this.save(st);
    return { ok: true, snapshot: this.snapshot(id) };
  }

  addLeads(id, list) {
    const st = this.load(id);
    const r = this.store.addContacts(id, list, { allowPrevious: st.config.allowPrevious }, this.clock());
    this.emit('change', { id });
    return { ok: true, ...r };
  }

  setName(id, phone, name) {
    const clean = name == null ? null : String(name).trim().slice(0, 40) || null;
    this.store.setContact(id, phone, { name: clean }, this.clock());
    this.emit('change', { id });
    return { ok: true };
  }

  exclude(id, phone) {
    if (!this.store.contact(id, phone)) return { ok: false, error: 'Not in the campaign.' };
    this.store.setContact(id, phone, { state: 'excluded', note: 'Excluded by you' }, this.clock());
    this.emit('change', { id });
    return { ok: true };
  }

  // Back into the queue: an excluded contact, or one whose last attempt
  // failed for certain. Uncertain sends are never retried automatically.
  include(id, phone) {
    const c = this.store.contact(id, phone);
    if (!c || !['excluded', 'failed', 'uncertain', 'replied', 'skipped'].includes(c.state)) return { ok: false, error: 'This contact can’t be resumed.' };
    if (this.store.isOptedOut(phone)) return { ok: false, error: 'This contact asked not to be messaged.' };
    if (c.stage === 0 && !this.load(id).config.allowPrevious && this.store.wasContacted(phone, id)) return { ok: false, error: 'Already contacted in another campaign. Allow previously contacted contacts in this campaign’s settings to message them again.' };
    this.store.setContact(id, phone, { state: c.stage === 0 ? 'queued' : c.stage >= 3 ? 'done' : 'active', note: null, attempts: 0, retryAt: null }, this.clock());
    this.emit('change', { id });
    return { ok: true };
  }

  optOut(phone, reason = 'Marked by you') {
    this.store.optOut(phone, reason, this.clock());
    this.emit('change', {});
    return { ok: true };
  }

  removeContact(id, phone) {
    this.store.removeContact(id, phone);
    this.emit('change', { id });
    return { ok: true };
  }

  // --- WhatsApp events ----------------------------------------------------------

  // An incoming message: a reply hands the contact to the user in every
  // campaign it is in; an opt-out stops it for good.
  onIncoming({ phone, text }) {
    if (!phone) return;
    const entries = this.store.contactsByPhone(phone);
    if (isOptOut(text)) {
      this.store.optOut(phone, 'Asked not to be contacted', this.clock());
      if (entries.length) this.emit('replied', { phone, optOut: true });
    } else {
      const open = entries.filter((c) => ['queued', 'active', 'done', 'failed', 'uncertain'].includes(c.state));
      if (!open.length) return;
      for (const c of open) this.store.setContact(c.campaignId, phone, { state: 'replied', note: 'Replied: continue the conversation yourself' }, this.clock());
      this.emit('replied', { phone, optOut: false });
    }
    this.emit('change', {});
  }

  // The user messaged a contact themselves (from the chat view).
  onManualMessage(phone) {
    let changed = false;
    for (const c of this.store.contactsByPhone(phone)) {
      if (!['queued', 'active'].includes(c.state)) continue;
      this.store.setContact(c.campaignId, phone, { state: 'replied', note: 'You are handling this conversation' }, this.clock());
      changed = true;
    }
    if (changed) this.emit('change', {});
  }

  onStatus(waId, status) {
    if (this.store.updateStatus(waId, status)) this.emit('change', {});
  }

  // --- scheduler -------------------------------------------------------------------

  init() {
    // A crash or forced quit during a send leaves a reservation: never resend it.
    this.store.settleInterrupted(this.clock() - 2 * MIN);
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
    this.kick();
  }

  dispose() {
    clearInterval(this.timer);
    this.timer = null;
  }

  kick() {
    setTimeout(() => this.tick(), 0).unref?.();
  }

  setWaiting(id, reason) {
    if (this.waiting.get(id) === reason) return;
    this.waiting.set(id, reason);
    this.emit('change', { id });
  }

  // ~1 minute between one contact's messages; 45-60 minutes between contacts.
  stageGap() {
    return STAGE_GAP - 5000 + Math.round(this.random() * 10_000);
  }

  contactGap(cfg) {
    return Math.round((cfg.intervalMin + this.random() * (cfg.intervalMax - cfg.intervalMin)) * MIN);
  }

  // The contact whose sequence is in progress, if it still is.
  current(st) {
    if (!st.current) return null;
    const c = this.store.contact(st.id, st.current);
    return c && c.state === 'active' && c.stage >= 1 && c.stage < 3 ? c : null;
  }

  // Picks the next message. The contact in progress comes first (their next
  // message); otherwise a contact whose sequence was resumed, then new
  // contacts, within the daily cap and outside quiet hours.
  next(now, st) {
    const cfg = st.config;
    const day = dayOf(now);
    const used = this.store.recipientsOn(day, cfg.test);
    const allowed = (c) => this.store.messagedOn(c.phone, day, cfg.test) || used < cfg.dailyCap;
    const quiet = (c) => inQuietHours(hourIn(now, this.zoneOf(c.phone)), cfg.quietStart, cfg.quietEnd);
    const cur = this.current(st);
    if (cur) {
      // Finish this contact before anyone else (waiting if needed).
      if (quiet(cur)) return { reason: 'quiet_hours' };
      if (!allowed(cur)) return { reason: 'daily_cap' };
      return { contact: cur, stage: cur.stage + 1, day };
    }
    const contacts = this.store.contacts(st.id);
    const resumed = contacts.filter((c) => c.state === 'active' && c.stage >= 1 && c.stage < 3).sort((a, b) => a.lastSentAt - b.lastSentAt);
    const fresh = contacts.filter((c) => c.state === 'queued' && c.stage === 0);
    const retries = contacts.filter((c) => c.state === 'failed' && c.attempts < MAX_ATTEMPTS && c.retryAt && c.retryAt <= now && c.stage < 3);
    let quietSeen = false;
    let capped = false;
    for (const c of [...resumed, ...retries, ...fresh]) {
      if (this.store.isOptedOut(c.phone)) continue;
      if (quiet(c)) {
        quietSeen = true;
        continue;
      }
      if (!allowed(c)) {
        capped = true;
        continue;
      }
      return { contact: c, stage: c.stage + 1, day };
    }
    const waitingRetry = contacts.some((c) => c.state === 'failed' && c.attempts < MAX_ATTEMPTS && c.retryAt && c.stage < 3);
    if (!resumed.length && !fresh.length && !retries.length) return { reason: waitingRetry ? 'retry_later' : 'done' };
    return { reason: capped ? 'daily_cap' : quietSeen ? 'quiet_hours' : 'nothing_due' };
  }

  async tick() {
    if (this.busy) return; // one send at a time, ever
    this.busy = true;
    try {
      const running = this.store.campaigns().filter((c) => c.status === 'running');
      if (!running.length) return;
      const now = this.clock();
      const today = dayOf(now);
      for (const c of running) if (c.category) this.syncQueue(c.id, now);
      const active = [];
      for (const r of running) {
        const st = this.load(r.id);
        if (st.config.endDate && today > st.config.endDate) {
          st.status = 'stopped';
          st.pauseReason = 'ended';
          this.save(st);
          this.setWaiting(st.id, null);
          continue;
        }
        if (st.config.startDate && today < st.config.startDate) {
          this.setWaiting(st.id, 'not_started');
          continue;
        }
        if (st.current && !this.current(st)) {
          // The contact in progress left the sequence early (reply, opt-out,
          // exclusion): the next contact waits the full gap after their last
          // message.
          const ended = this.store.contact(st.id, st.current);
          st.current = null;
          st.nextDueAt = Math.max(st.nextDueAt || 0, (ended?.lastSentAt || now) + this.contactGap(st.config));
          this.save(st);
          this.spaceOthers(st);
        }
        active.push(st);
      }
      // One contact at a time across all campaigns: a contact in progress
      // is finished first; otherwise the campaign that has waited longest.
      const inProgress = active.filter((st) => this.current(st));
      const order = inProgress.length ? inProgress.slice(0, 1) : active.sort((x, y) => (x.nextDueAt || 0) - (y.nextDueAt || 0) || x.id - y.id);
      if (inProgress.length) for (const st of active) if (st.id !== inProgress[0].id) this.setWaiting(st.id, 'other_campaign');
      for (const st of order) {
        const id = st.id;
        const test = st.config.test;
        if (st.nextDueAt && now < st.nextDueAt) {
          this.setWaiting(id, st.current ? 'next_message' : 'interval');
          continue;
        }
        if (!test && !this.transport.ready()) {
          this.setWaiting(id, 'whatsapp');
          continue;
        }
        // Asked only when a message is due (it is a licence-server request).
        if (!test && !(await this.canSend())) {
          this.setWaiting(id, 'subscription');
          continue;
        }
        const pick = this.next(now, st);
        if (!pick.contact) {
          if (pick.reason === 'done' && !st.category) {
            st.status = 'stopped';
            st.pauseReason = 'finished';
            this.save(st);
          }
          // A category campaign stays on and waits for new leads.
          this.setWaiting(id, pick.reason === 'done' ? 'completed' : pick.reason);
          continue;
        }
        await this.sendOne(pick, st);
        break; // one message per tick
      }
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.busy = false;
    }
  }

  // The gap before the next contact applies to every campaign that is on
  // (same mode), so several campaigns never send faster than one.
  spaceOthers(st) {
    if (!st.nextDueAt) return;
    for (const c of this.store.campaigns()) {
      if (c.id === st.id || c.status !== 'running' || c.current) continue;
      const o = this.load(c.id);
      if (Boolean(o.config.test) !== Boolean(st.config.test) || (o.nextDueAt || 0) >= st.nextDueAt) continue;
      o.nextDueAt = st.nextDueAt;
      this.store.saveCampaign(o, this.clock());
    }
  }

  // After a contact's message: their next one in about a minute, or (after
  // the third) the next contact in 45-60 minutes.
  scheduleAfter(st, phone, stage, at) {
    if (stage < 3) {
      st.current = phone;
      st.nextDueAt = at + this.stageGap();
    } else {
      st.current = null;
      st.nextDueAt = at + this.contactGap(st.config);
      this.spaceOthers(st);
    }
    this.waiting.set(st.id, stage < 3 ? 'next_message' : 'interval'); // shown at once, not at the next tick
  }

  // A send takes time; the user may have switched the campaign off (or
  // deleted it) meanwhile. Its status from the database wins.
  keepLatestStatus(st) {
    const latest = this.load(st.id);
    if (!latest) return false;
    if (latest.status !== 'running') {
      st.status = latest.status;
      st.pauseReason = latest.pauseReason;
    }
    return true;
  }

  async sendOne({ contact, stage, day }, st) {
    const cfg = st.config;
    const now = this.clock();
    const id = st.id;
    // Safety net: a reply that arrived without being matched still stops
    // the sequence for this contact.
    if (stage > 1 && this.hasReplied(contact.phone, contact.lastSentAt)) {
      this.onIncoming({ phone: contact.phone, text: '' });
      return;
    }
    // Contacted by another campaign since being added: skipped, unless
    // this campaign allows previously contacted people.
    if (stage === 1 && !cfg.test && !cfg.allowPrevious && this.store.wasContacted(contact.phone, id)) {
      this.store.setContact(id, contact.phone, { state: 'skipped', note: 'Already contacted in another campaign' }, now);
      this.emit('change', { id });
      return;
    }
    const sendId = this.store.reserve({ campaignId: id, campaignName: st.name, phone: contact.phone, stage, test: cfg.test, day, now });
    if (sendId === null) {
      // Already sent (or possibly sent) in an earlier run: bring the contact
      // up to date, never send it again.
      this.store.setContact(id, contact.phone, { stage, state: stage >= 3 ? 'done' : 'active', lastSentAt: contact.lastSentAt ?? now }, now);
      this.scheduleAfter(st, contact.phone, stage, contact.lastSentAt ?? now);
      this.save(st);
      return;
    }
    // Until this send succeeds, assume the worst: a full gap before anyone
    // else (this is what a crash during the send leaves behind).
    st.current = null;
    st.nextDueAt = now + this.contactGap(cfg);
    this.save(st);
    this.spaceOthers(st);
    const text = render(cfg.templates[stage - 1], this.values(contact));
    try {
      const res = cfg.test ? { id: `TEST-${sendId}` } : await this.transport.send(contact.phone, text);
      const at = this.clock();
      this.store.markSent(sendId, res.id, at);
      this.store.setContact(id, contact.phone, { stage, state: stage >= 3 ? 'done' : 'active', lastSentAt: at, note: null, attempts: 0, retryAt: null }, at);
      st.failures = 0;
      const exists = this.keepLatestStatus(st);
      this.scheduleAfter(st, contact.phone, stage, at);
      if (exists) this.save(st);
      this.emit('sent', { campaignId: id, phone: contact.phone, stage, text, waId: res.id, test: cfg.test, at });
    } catch (err) {
      const msg = errorText(err);
      if (err?.code === 'not_connected') {
        // Checked before anything was handed to WhatsApp: nothing was sent.
        this.store.release(sendId);
        st.nextDueAt = now;
        if (stage > 1) st.current = contact.phone; // still this contact's turn
        if (this.keepLatestStatus(st)) this.save(st);
        return this.setWaiting(id, 'whatsapp');
      }
      if (isTimeout(err)) {
        this.store.markFailed(sendId, `${msg} (it may still have been delivered)`, 'unknown');
        this.store.setContact(id, contact.phone, { state: 'uncertain', note: 'Sending timed out; check the chat before continuing.' }, now);
      } else {
        // A definite failure: nothing was delivered. The lead stays Unseen
        // and is retried later (same reservation, so never twice).
        this.store.markFailed(sendId, msg);
        const attempts = (contact.attempts || 0) + 1;
        const retryAt = attempts < MAX_ATTEMPTS ? now + RETRY_AFTER[attempts - 1] : null;
        this.store.setContact(id, contact.phone, { state: 'failed', note: retryAt ? `${msg} (attempt ${attempts} of ${MAX_ATTEMPTS}; retried automatically)` : `${msg} (${MAX_ATTEMPTS} attempts; use Retry)`, attempts, retryAt }, now);
      }
      st.failures = (st.failures || 0) + 1;
      if (!this.keepLatestStatus(st)) return;
      if (isRestriction(err)) {
        st.status = 'paused';
        st.pauseReason = 'restricted';
      } else if (st.failures >= 3) {
        st.status = 'paused';
        st.pauseReason = 'errors';
      }
      this.save(st);
      this.emit('failed', { campaignId: id, phone: contact.phone, stage, error: msg, paused: st.status === 'paused' ? st.pauseReason : null });
    }
  }

  // --- for the UI -------------------------------------------------------------------

  // Template values: the name chosen when the lead was added (and editable
  // by the user; null = use the version without a name), and the business
  // name from Google Maps (cleaned; null = use the version without it).
  values(contact) {
    return { name: contact.name ?? null, business: cleanBusiness(this.details(contact).business) };
  }

  preview(contact, templates = null) {
    const list = templates || (contact.campaignId ? this.load(contact.campaignId).config.templates : DEFAULT_TEMPLATES);
    return list.map((t) => render(t, this.values(contact)));
  }

  summary(c) {
    const contacts = this.store.contacts(c.id);
    const counts = contacts.reduce((m, x) => ((m[x.state] = (m[x.state] || 0) + 1), m), {});
    const now = this.clock();
    const work = contacts.some((x) => ['queued', 'active'].includes(x.state) || (x.state === 'failed' && x.attempts < MAX_ATTEMPTS && x.retryAt && x.stage < 3));
    const waiting = c.status === 'running' ? this.waiting.get(c.id) || null : null;
    // OFF / Paused / Running / Completed (on, everything sent; new leads
    // are still picked up).
    const display = c.status === 'stopped' ? 'off' : c.status === 'paused' ? 'paused' : !work && c.category ? 'completed' : 'running';
    return { id: c.id, name: c.name, category: c.category, status: c.status, display, pauseReason: c.pauseReason, test: Boolean({ ...DEFAULT_CONFIG, ...c.config }.test), contacts: contacts.length, counts, waiting, retriesDue: contacts.filter((x) => x.state === 'failed' && x.retryAt && x.retryAt <= now).length };
  }

  overview() {
    const now = this.clock();
    const day = dayOf(now);
    return {
      campaigns: this.store.campaigns().map((c) => this.summary(c)),
      categories: this.categoryStats(),
      acknowledged: this.acknowledged(),
      limits: LIMITS,
      today: { day, recipients: this.store.recipientsOn(day, false), testRecipients: this.store.recipientsOn(day, true) },
    };
  }

  snapshot(id) {
    const st = this.load(id);
    if (!st) return null;
    const now = this.clock();
    const test = st.config.test;
    return {
      id: st.id,
      name: st.name,
      category: st.category,
      display: this.summary(st).display,
      status: st.status,
      pauseReason: st.pauseReason,
      waiting: st.status === 'running' ? this.waiting.get(id) || null : null,
      nextDueAt: st.nextDueAt,
      current: st.current || null,
      acknowledged: this.acknowledged(),
      config: st.config,
      limits: LIMITS,
      today: { day: dayOf(now), recipients: this.store.recipientsOn(dayOf(now), test), cap: st.config.dailyCap },
      contacts: this.store.contacts(id).map((c) => ({ ...c, optedOut: this.store.isOptedOut(c.phone), zone: this.zoneOf(c.phone) })),
      sends: this.store.sends({ campaignId: id, test, limit: 100 }),
    };
  }
}

module.exports = { Outreach, DEFAULT_CONFIG, LIMITS, STAGE_GAP, MAX_ATTEMPTS, RETRY_AFTER, timeZoneOf, inQuietHours, hourIn, dayOf, isRestriction };
