'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Autopilot } = require('../src/main/autopilot');
const { LeadStore } = require('../src/database/db');

// A clock the test moves; timers still run for real, with no waits set.
const timings = { betweenCountries: 1000, betweenRounds: 5000, retryBase: 100, retryMax: 400, busyWait: 50, idle: 5, captchaRetry: 900 };
function setup(runSearch, opts = {}) {
  const store = opts.store || new LeadStore(':memory:');
  let t = 1_000_000;
  const notes = [];
  const ap = new Autopilot({ store, runSearch, now: () => t, timings, notify: (kind, title, body) => notes.push({ kind, title, body }) });
  return { ap, store, notes, advance: (ms) => (t += ms), at: () => t };
}
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

test('countries one after another, then a new round; leads counted; progress saved', async () => {
  const queries = [];
  const { ap, advance, notes, store } = setup(async ({ query }) => (queries.push(query), { state: 'done', newLeads: 2 }));
  assert.equal(ap.add({ keyword: ' Shoes  Shop ', category: 'Shoes', countries: ['Pakistan', 'UAE', 'Pakistan', 'x<script>'] }).ok, true);
  ap.start();
  await until(() => queries.length === 1);
  await until(() => ap.tasks()[0].status === 'waiting');
  assert.deepEqual(ap.tasks()[0].countries, ['Pakistan', 'UAE'], 'duplicates and invalid names left out');
  assert.equal(ap.tasks()[0].index, 1);
  advance(1000);
  ap.kick();
  await until(() => queries.length === 2 && ap.tasks()[0].status === 'waiting');
  const t = ap.tasks()[0];
  assert.deepEqual(queries, ['Shoes Shop in Pakistan', 'Shoes Shop in UAE']);
  assert.deepEqual([t.round, t.index, t.leads], [2, 0, 4], 'a new round; a country is never "finished for good"');
  assert.match(t.reason, /Round 1 finished/);
  advance(4999);
  ap.kick();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(queries.length, 2, 'the next round waits');
  advance(1);
  ap.kick();
  await until(() => queries.length === 3);
  assert.equal(queries[2], 'Shoes Shop in Pakistan');
  assert.ok(notes.some((n) => n.kind === 'country') && notes.some((n) => n.kind === 'leads'));
  await ap.stopEngine();
  assert.equal(store.getState('autopilot.engine').state, 'stopped');
});

test('a crash during a country: the next start searches that country again, from the saved place', async () => {
  const store = new LeadStore(':memory:');
  const a = setup(() => new Promise(() => {}), { store }); // never ends: the app "dies" here
  a.ap.add({ keyword: 'Shoes Shop', category: 'Shoes', countries: ['Pakistan', 'UAE', 'Oman'] });
  store.setState('autopilot.tasks', store.getState('autopilot.tasks').map((t) => ({ ...t, index: 1 })));
  a.ap.start();
  await until(() => a.ap.tasks()[0].status === 'running');
  // A new process on the same database.
  const queries = [];
  const b = setup(async ({ query }) => (queries.push(query), { state: 'done' }), { store });
  b.ap.start();
  await until(() => queries.length === 1);
  assert.equal(queries[0], 'Shoes Shop in UAE');
  assert.ok(b.notes.some((n) => n.kind === 'resumed'));
  await b.ap.stopEngine();
});

test('network and Chrome trouble: retried with growing waits; needs-the-user stops it; daily limit waits for tomorrow', async () => {
  const answers = [{ state: 'error', code: 'offline', message: 'No internet' }, { state: 'error', code: 'chrome', message: 'Chrome closed' }, { state: 'error', code: 'quota', message: 'limit' }];
  const { ap, advance, at, notes } = setup(async () => answers.shift() || { state: 'error', code: 'plan', message: 'No active plan' });
  ap.add({ keyword: 'Shoes Shop', category: 'Shoes', countries: ['Pakistan'] });
  ap.start();
  await until(() => ap.tasks()[0].retries === 1 && ap.tasks()[0].status === 'waiting');
  assert.equal(ap.tasks()[0].nextRunAt - at(), 100);
  assert.ok(notes.some((n) => n.title === 'Internet disconnected'));
  advance(100);
  ap.kick();
  await until(() => ap.tasks()[0].retries === 2);
  assert.equal(ap.tasks()[0].nextRunAt - at(), 200, 'exponential backoff');
  advance(200);
  ap.kick();
  await until(() => /lead limit|limit/.test(ap.tasks()[0].reason) && ap.tasks()[0].retries === 2);
  const tomorrow = new Date(at());
  assert.ok(ap.tasks()[0].nextRunAt > at() && new Date(ap.tasks()[0].nextRunAt).getDate() !== tomorrow.getDate(), 'continues tomorrow');
  advance(48 * 3600_000);
  ap.kick();
  await until(() => ap.tasks()[0].status === 'failed');
  assert.match(ap.tasks()[0].reason, /No active plan/);
  assert.equal(ap.resume(ap.tasks()[0].id).ok, true);
  await ap.stopEngine();
});

test('pause, resume and stop a task; pausing the engine stops the running search; several tasks take turns', async () => {
  const runs = [];
  const { ap, advance } = setup(({ query, signal }) => {
    runs.push(query);
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ state: 'stopped' })));
  });
  const a = ap.add({ keyword: 'Shoes Shop', category: 'Shoes', countries: ['Pakistan', 'UAE'] }).task;
  const b = ap.add({ keyword: 'Bakery', category: 'Food', countries: ['Qatar'] }).task;
  ap.start();
  await until(() => runs.length === 1);
  ap.pause(a.id);
  await until(() => runs.length === 2);
  assert.deepEqual(runs, ['Shoes Shop in Pakistan', 'Bakery in Qatar'], 'the other task takes its turn');
  assert.equal(ap.tasks().find((t) => t.id === a.id).index, 0, 'a paused country keeps its place');
  ap.pauseEngine();
  await until(() => ap.tasks().every((t) => t.status !== 'running'));
  assert.equal(ap.state().engine, 'paused');
  ap.stop(b.id);
  assert.equal(ap.tasks().find((t) => t.id === b.id).status, 'completed');
  assert.equal(ap.remove(b.id).ok, true);
  advance(1);
  ap.resume(a.id);
  await until(() => runs.length === 3);
  assert.equal(runs[2], 'Shoes Shop in Pakistan');
  assert.equal(ap.remove(a.id).ok, false, 'a running search is stopped before it is deleted');
  await ap.stopEngine();
});

test('a CAPTCHA the search could not wait out: tried again later, never sooner, and the user is told', async () => {
  const { ap, at, notes } = setup(async () => ({ state: 'error', code: 'captcha', message: 'Google asked' }));
  ap.add({ keyword: 'Shoes Shop', category: 'Shoes', countries: ['Pakistan'] });
  ap.start();
  await until(() => ap.tasks()[0].status === 'waiting');
  assert.equal(ap.tasks()[0].nextRunAt - at(), 900);
  assert.equal(ap.tasks()[0].retries, 0);
  assert.ok(notes.some((n) => n.title === 'Manual verification required'));
  await ap.stopEngine();
});

test('input checks', () => {
  const { ap } = setup(async () => ({ state: 'done' }));
  assert.match(ap.add({ keyword: 'x', category: 'A', countries: ['UK'] }).error, /keyword/);
  assert.match(ap.add({ keyword: 'Shoes', category: '', countries: ['UK'] }).error, /category/);
  assert.match(ap.add({ keyword: 'Shoes', category: 'A', countries: [] }).error, /country/);
});

test("Chrome waiting for the user's Allow: asked again in 5 minutes, and the user is told once", async () => {
  const { ap, at, notes } = setup(async () => ({ state: 'error', code: 'needs_allow', message: 'Chrome did not allow the connection.' }));
  ap.add({ keyword: 'Shoes Shop', category: 'Shoes', countries: ['Pakistan'] });
  ap.start();
  await until(() => ap.tasks()[0].status === 'waiting');
  assert.equal(ap.tasks()[0].nextRunAt - at(), 5 * 60_000);
  assert.ok(notes.some((n) => n.title === 'Chrome needs you'));
  await ap.stopEngine();
});
