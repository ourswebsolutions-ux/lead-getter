'use strict';

// Continuous search: saved searches (a keyword, a category and countries)
// that run one country after another, round after round, until the user
// stops them. Each country is an ordinary Google Maps search, "<keyword> in
// <country>", run by the existing search engine (runSearch, main.js), so
// leads are saved as they are found and a business already saved is skipped
// without being opened again.
//
// Everything is kept in the app's database (app_state), written before and
// after each step, so a crash, a restart or a power cut loses at most the
// country being searched; it is searched again, and what it already saved is
// skipped. Google Maps has no result pages to continue from, so a country
// restarts from its first result.
//
// Task status: pending (waiting its turn), running, waiting (a pause with a
// reason and a time: next round, network, Chrome, daily lead limit, Google's
// verification), paused (by the user), completed (stopped by the user) and
// failed (needs the user: no plan, Chrome's permission). Several tasks take
// turns, one country at a time. A CAPTCHA during a search is handled by the
// search itself: it pauses, waits for the user to complete it in Chrome and
// continues on its own (search-session.js); it is never solved or bypassed.
//
// runSearch({ task, country, query, signal }) resolves to
//   { state: 'done' | 'stopped' | 'error', code, message, newLeads, leads }
// code (for errors): 'offline' | 'chrome' | 'quota' | 'plan' | 'captcha' |
// 'busy' | 'needs_user' | 'unknown'.

const crypto = require('node:crypto');

const KEY = 'autopilot.tasks';
const ENGINE = 'autopilot.engine';
const MAX_COUNTRIES = 60;

const TIMINGS = {
  betweenCountries: 60_000, // a short rest before the next country
  betweenRounds: 30 * 60_000, // before a country is searched again
  retryBase: 30_000, // network or Chrome trouble: 30 s, 1, 2, 4 … min
  retryMax: 30 * 60_000,
  busyWait: 15_000, // a search the user started is running
  idle: 60_000, // nothing to do: look again
  captchaRetry: 15 * 60_000, // Google still blocking after the search waited
  allowRetry: 5 * 60_000, // Chrome waiting for the user's Allow
};

// Errors that need the user: retried only when they say so.
const NEEDS_USER = new Set(['plan', 'needs_user']);

const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

class Autopilot {
  // onDone(task): a search finished all its countries (it is not started again).
  constructor({ store, runSearch, notify = () => {}, log = () => {}, now = () => Date.now(), timings = {}, onChange = () => {}, onDone = () => {} }) {
    Object.assign(this, { store, runSearch, notify, log, now, onChange, onDone });
    this.t = { ...TIMINGS, ...timings };
    this.current = null; // { id, controller, promise }
    this.loopPromise = null;
    this.wake = null;
  }

  // --- saved state ---------------------------------------------------------------

  tasks() {
    return (this.store.getState(KEY) || []).map((t) => ({ ...t }));
  }

  saveTasks(list) {
    this.store.setState(KEY, list);
    this.onChange(this.state());
  }

  update(id, patch) {
    const list = this.tasks();
    const t = list.find((x) => x.id === id);
    if (!t) return null;
    Object.assign(t, typeof patch === 'function' ? patch(t) : patch, { updatedAt: this.now() });
    this.saveTasks(list);
    return t;
  }

  engine() {
    return this.store.getState(ENGINE) || { state: 'stopped' };
  }

  state() {
    return { engine: this.engine().state, running: this.current?.id || null, tasks: this.tasks() };
  }

  // --- tasks -----------------------------------------------------------------------

  // search: the Leads tab's sources ({ withMaps, withFacebook, withLinkedIn,
  // linkedinKeyword }); origin: 'leads' (the Leads tab) or 'assistant'.
  // queued: kept in the search pool until it is started (activate).
  add({ keyword, category, countries, websiteFilter = 'without', findEmails = false, search = null, origin = 'settings', queued = false }) {
    const k = clean(keyword, 120);
    const c = clean(category, 60);
    const list = [...new Set((Array.isArray(countries) ? countries : []).map((x) => clean(x, 56)).filter((x) => /^[\p{L}][\p{L} .'()-]*$/u.test(x)))].slice(0, MAX_COUNTRIES);
    if (k.length < 2) return { ok: false, error: 'Enter a keyword, for example Shoes Shop.' };
    if (!c) return { ok: false, error: 'Choose a category for the leads.' };
    if (!list.length) return { ok: false, error: 'Choose at least one country.' };
    // Any number of continuous searches can be saved.
    const tasks = this.tasks();
    const task = {
      id: crypto.randomBytes(6).toString('hex'),
      keyword: k,
      category: c,
      countries: list,
      websiteFilter: ['without', 'with', 'all'].includes(websiteFilter) ? websiteFilter : 'without',
      findEmails: findEmails === true,
      search: search && typeof search === 'object' ? { withMaps: search.withMaps !== false, withFacebook: Boolean(search.withFacebook), withLinkedIn: Boolean(search.withLinkedIn), linkedinKeyword: clean(search.linkedinKeyword, 120) } : null,
      origin: ['leads', 'assistant'].includes(origin) ? origin : 'settings',
      status: queued ? 'queued' : 'pending',
      reason: queued ? 'In the search pool' : '',
      round: 1,
      processed: 0, // businesses checked
      listed: 0, // results Google Maps listed (the most seen in one country)
      exhausted: false, // Google Maps showed the end of its results
      index: 0, // the country being searched (or next)
      nextRunAt: 0,
      retries: 0,
      leads: 0,
      lastRunAt: 0,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.saveTasks([...tasks, task]);
    this.kick();
    return { ok: true, task };
  }

  remove(id) {
    if (this.current?.id === id) return { ok: false, error: 'Stop this search first.' };
    this.saveTasks(this.tasks().filter((t) => t.id !== id));
    return { ok: true };
  }

  // Pause: keeps its place. Resume: from that place. Stop: completed (it can
  // be resumed later, from where it stopped).
  pause(id) {
    if (!this.update(id, { status: 'paused', reason: 'Paused by you' })) return { ok: false, error: 'Not found.' };
    if (this.current?.id === id) this.current.controller.abort();
    return { ok: true };
  }

  resume(id) {
    const t = this.update(id, { status: 'pending', reason: '', nextRunAt: 0, retries: 0 });
    if (!t) return { ok: false, error: 'Not found.' };
    if (this.engine().state !== 'running') this.start();
    else this.kick();
    return { ok: true };
  }

  stop(id) {
    if (!this.update(id, { status: 'completed', reason: 'Stopped by you' })) return { ok: false, error: 'Not found.' };
    if (this.current?.id === id) this.current.controller.abort();
    return { ok: true };
  }

  // --- one search at a time, and the pool ---------------------------------------------

  // The search being worked on (running, between countries or retrying).
  active() {
    return this.tasks().find((t) => ['running', 'pending', 'waiting', 'paused'].includes(t.status)) || null;
  }

  // Starts a search from the pool (or a stopped one again).
  activate(id) {
    const t = this.tasks().find((x) => x.id === id);
    if (!t) return { ok: false, error: 'That search is not in the list.' };
    const other = this.active();
    if (other && other.id !== id) return { ok: false, error: `"${other.keyword}" is running. Stop it first.`, busy: other };
    this.update(id, { status: 'pending', reason: '', nextRunAt: 0, retries: 0, ...(t.status === 'completed' && t.exhausted ? { index: 0, exhausted: false, doneProcessed: 0, doneListed: 0, curProcessed: 0, curListed: 0, processed: 0, listed: 0 } : {}) });
    if (this.engine().state !== 'running') this.start();
    else this.kick();
    return { ok: true, task: this.tasks().find((x) => x.id === id) };
  }

  // Stop: the running search ends now, and every search that was waiting its
  // turn stops too. The pool (queued) stays as it is.
  stopAll(reason = 'Stopped by you') {
    const list = this.tasks();
    let n = 0;
    for (const t of list) {
      if (['running', 'pending', 'waiting', 'paused'].includes(t.status)) {
        t.status = 'completed';
        t.reason = reason;
        t.stoppedAt = this.now();
        n++;
      }
    }
    this.saveTasks(list);
    this.current?.controller.abort();
    this.kick();
    return { ok: true, count: n };
  }

  pauseActive() {
    const t = this.active();
    if (!t || t.status === 'paused') return { ok: false, error: t ? 'The search is already paused.' : 'No search is running.' };
    return { ...this.pause(t.id), task: t };
  }

  resumeActive() {
    const t = this.tasks().find((x) => x.status === 'paused');
    if (!t) return { ok: false, error: 'No search is paused.' };
    return { ...this.resume(t.id), task: t };
  }

  // Pool order: moves a queued search to position `to` (1 = next).
  move(id, to) {
    const list = this.tasks();
    const i = list.findIndex((t) => t.id === id);
    if (i < 0) return { ok: false, error: 'That search is not in the list.' };
    const [t] = list.splice(i, 1);
    const queued = list.filter((x) => x.status === 'queued');
    const anchor = queued[Math.max(0, Math.min(queued.length, to - 1))];
    list.splice(anchor ? list.indexOf(anchor) : list.length, 0, t);
    this.saveTasks(list);
    return { ok: true };
  }

  // Back to the pool (not started until it is chosen again).
  hold(id) {
    const t = this.tasks().find((x) => x.id === id);
    if (!t) return { ok: false, error: 'That search is not in the list.' };
    if (this.current?.id === id) this.current.controller.abort();
    this.update(id, { status: 'queued', reason: 'In the search pool' });
    return { ok: true };
  }

  pool() {
    return this.tasks().filter((t) => t.status === 'queued');
  }

  // --- the engine ------------------------------------------------------------------

  // Starts (or restarts after a crash or a restart of the computer): a task
  // that was running when the app ended searches its country again.
  start() {
    this.store.setState(ENGINE, { state: 'running', since: this.now() });
    const list = this.tasks();
    let resumed = 0;
    for (const t of list) {
      if (t.status === 'running') {
        t.status = 'pending';
        t.reason = 'Resumed after Lead Finder restarted';
        t.nextRunAt = 0;
        resumed++;
      }
    }
    this.saveTasks(list);
    if (resumed) this.notify('resumed', 'Search resumed', `${resumed} continuous search${resumed === 1 ? '' : 'es'} resumed where ${resumed === 1 ? 'it' : 'they'} stopped.`);
    if (!this.loopPromise) this.loopPromise = this.loop().finally(() => (this.loopPromise = null));
    this.onChange(this.state());
    return { ok: true };
  }

  // Pause the engine: the running search stops; every task keeps its place.
  pauseEngine() {
    this.store.setState(ENGINE, { state: 'paused', since: this.now() });
    this.current?.controller.abort();
    this.kick();
    this.onChange(this.state());
    return { ok: true };
  }

  async stopEngine() {
    this.store.setState(ENGINE, { state: 'stopped', since: this.now() });
    this.current?.controller.abort();
    this.kick();
    await this.loopPromise?.catch(() => {});
    this.onChange(this.state());
    return { ok: true };
  }

  // On quit: stops without changing what is saved, so the next start resumes.
  async shutdown() {
    this.closing = true;
    this.current?.controller.abort();
    this.kick();
    await this.loopPromise?.catch(() => {});
  }

  kick() {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(done, Math.max(0, ms));
      const self = this;
      function done() {
        clearTimeout(t);
        if (self.wake === done) self.wake = null;
        resolve();
      }
      this.wake = done;
    });
  }

  // The task whose turn it is: due now, the one that ran longest ago first.
  next(now = this.now()) {
    const ready = this.tasks().filter((t) => ['pending', 'waiting'].includes(t.status) && t.nextRunAt <= now);
    return ready.sort((a, b) => a.lastRunAt - b.lastRunAt)[0] || null;
  }

  nextDue() {
    const times = this.tasks().filter((t) => ['pending', 'waiting'].includes(t.status)).map((t) => t.nextRunAt);
    return times.length ? Math.min(...times) : null;
  }

  async loop() {
    while (!this.closing && this.engine().state === 'running') {
      const task = this.next();
      if (!task) {
        const due = this.nextDue();
        await this.sleep(due === null ? this.t.idle : Math.min(this.t.idle, due - this.now()));
        continue;
      }
      await this.step(task);
    }
  }

  async step(task) {
    const country = task.countries[task.index % task.countries.length];
    const query = `${task.keyword} in ${country}`;
    const controller = new AbortController();
    this.update(task.id, { status: 'running', reason: '', country, lastRunAt: this.now() });
    this.log(`continuous search ${task.id}: "${query}" (round ${task.round}, ${task.index + 1} of ${task.countries.length})`);
    const promise = Promise.resolve()
      .then(() => this.runSearch({ task, country, query, signal: controller.signal }))
      .catch((err) => ({ state: 'error', code: 'unknown', message: String(err?.message || err) }));
    this.current = { id: task.id, controller, promise };
    let r;
    try {
      r = await promise;
    } finally {
      this.current = null;
    }
    const now = this.now();
    const t = this.tasks().find((x) => x.id === task.id);
    if (!t) return; // deleted meanwhile
    const leads = (t.leads || 0) + (r.newLeads || 0);
    // Counted once per business: a country searched again after a stop or a
    // restart re-reads what it already checked, so its own count is the
    // larger of the two runs, added to the countries already finished.
    const cur = { processed: Math.max(t.curProcessed || 0, r.processed || 0), listed: Math.max(t.curListed || 0, r.listed || 0) };
    const base = { processed: t.doneProcessed || 0, listed: t.doneListed || 0 };
    const progress = { curProcessed: cur.processed, curListed: cur.listed, processed: base.processed + cur.processed, listed: base.listed + cur.listed, exhausted: Boolean(r.exhausted) };
    if (r.newLeads) this.notify('leads', 'New leads', `${r.newLeads} new lead${r.newLeads === 1 ? '' : 's'} for "${query}".`);

    // Paused, stopped or quitting: the country is searched again later.
    if (r.state === 'stopped' || controller.signal.aborted) {
      if (t.status === 'running') this.update(t.id, { status: 'pending', leads, ...progress, reason: '' });
      else this.update(t.id, { leads, ...progress });
      return;
    }
    // A country's results are used up: the next country, or the search is
    // complete. Nothing is started again by itself.
    if (r.state === 'done') {
      const last = t.index + 1 >= t.countries.length;
      if (last) {
        const done = this.update(t.id, { status: 'completed', leads, ...progress, doneProcessed: progress.processed, doneListed: progress.listed, curProcessed: 0, curListed: 0, exhausted: true, retries: 0, completedAt: now, reason: 'Completed: all results checked' });
        this.notify('done', 'Search completed', `"${query}": ${done.processed} businesses checked, ${done.leads} new leads.`);
        this.onDone(done);
        return;
      }
      const nextCountry = t.countries[t.index + 1];
      this.update(t.id, { status: 'waiting', leads, ...progress, doneProcessed: progress.processed, doneListed: progress.listed, curProcessed: 0, curListed: 0, exhausted: false, retries: 0, index: t.index + 1, nextRunAt: now + this.t.betweenCountries, reason: `Next: ${nextCountry}` });
      this.notify('country', 'Country changed', `"${t.keyword}": ${country} done, next ${nextCountry}.`);
      return;
    }
    // Errors.
    const code = r.code || 'unknown';
    if (NEEDS_USER.has(code)) {
      this.update(t.id, { status: 'failed', leads, reason: r.message || 'Needs your attention' });
      this.notify('failed', 'Continuous search stopped', `"${t.keyword}": ${r.message}`);
      return;
    }
    // Google still asked for verification after the search waited: tried
    // again later (never sooner), and then waits again for the user's check.
    if (code === 'captcha') {
      this.update(t.id, { status: 'waiting', leads, nextRunAt: now + this.t.captchaRetry, reason: `Google asked for verification (${query}). Complete it in Chrome; Lead Finder looks again in ${fmtWait(this.t.captchaRetry)}` });
      this.notify('captcha', 'Manual verification required', `"${query}": complete Google's check in Chrome. The search continues once it is done.`);
      return;
    }
    if (code === 'quota') {
      this.update(t.id, { status: 'waiting', leads, nextRunAt: nextMidnight(now), reason: r.message || "Today's lead limit is reached. Continues tomorrow" });
      return;
    }
    // Chrome waits for the user's Allow: asked again in 5 minutes, not sooner.
    if (code === 'needs_allow') {
      this.update(t.id, { status: 'waiting', leads, nextRunAt: now + this.t.allowRetry, reason: `${r.message} Trying again in ${fmtWait(this.t.allowRetry)}` });
      this.notify('needs_user', 'Chrome needs you', 'Click Allow in Chrome, or choose the Lead Finder automation profile in Settings > Chrome, which never asks.');
      return;
    }
    if (code === 'busy') {
      this.update(t.id, { status: 'pending', leads, nextRunAt: now + this.t.busyWait, reason: 'Waiting for the search you started' });
      return;
    }
    const retries = (t.retries || 0) + 1;
    const wait = Math.min(this.t.retryMax, this.t.retryBase * 2 ** (retries - 1));
    this.update(t.id, { status: 'waiting', leads, retries, nextRunAt: now + wait, reason: `${r.message || 'Failed'}. Trying again in ${fmtWait(wait)}` });
    if (retries === 1 || retries % 5 === 0) this.notify(code, code === 'offline' ? 'Internet disconnected' : code === 'chrome' ? 'Chrome disconnected' : 'Search problem', `"${query}": ${r.message}. Lead Finder tries again by itself.`);
  }
}

function nextMidnight(now) {
  const d = new Date(now);
  d.setHours(24, 0, 30, 0);
  return d.getTime();
}

function fmtWait(ms) {
  return ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;
}

module.exports = { Autopilot, TIMINGS, MAX_COUNTRIES };
