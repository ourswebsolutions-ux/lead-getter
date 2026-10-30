'use strict';
// The Auto Dialer's rules with a stand-in Dialer: which leads it calls,
// answered -> stops and waits for the user; ended by the user -> 1 minute;
// not answered -> the next lead; ringing too long -> ended; Bluetooth lost ->
// paused; off -> no further calls; calling hours; Call Seen kept apart
// from WhatsApp.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { LeadStore } = require('../src/database/db');
const { AutoDialer, isMobile } = require('../src/dialer/auto-dialer');

const tick = () => new Promise((r) => setImmediate(r));

// Timers run only when the test says so.
function fakeTimers() {
  let id = 0;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => (pending.set(++id, { fn, ms }), id),
    clearTimeout: (i) => pending.delete(i),
    pending,
    async fire(filter = () => true) {
      for (const [i, t] of [...pending]) {
        if (!filter(t)) continue;
        pending.delete(i);
        await t.fn();
      }
      await tick();
    },
  };
}

class FakeDialer extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.s = { link: 'ready', call: null };
    this.calls = [];
    this.hangups = [];
  }
  async call(number, { leadId, auto }) {
    if (this.s.link !== 'ready') return { ok: false, error: 'Connect your phone first.' };
    if (this.s.call && this.s.call.state !== 'ended') return { ok: false, error: 'A call is already in progress.' };
    this.calls.push({ number, leadId, auto });
    this.store.markCallSeen(leadId);
    this.s.call = { number, leadId, auto, state: 'dialing', name: `Lead ${leadId}` };
    this.emit('state', this.s);
    return { ok: true };
  }
  async hangup({ by = 'user' } = {}) {
    this.hangups.push(by);
    this.end(by === 'user' ? 'cancelled' : 'no_answer', by);
    return { ok: true };
  }
  answer() {
    this.s.call.state = 'active';
    this.emit('state', this.s);
  }
  end(status, endedBy) {
    const c = { ...this.s.call, state: 'ended', status, endedBy, reason: status };
    this.s.call = null;
    this.emit('state', this.s);
    this.emit('ended', c);
  }
}

function setup(leads = ['+923001111111', '+923002222222', '+923003333333']) {
  const store = new LeadStore(':memory:');
  leads.forEach((phone, i) => store.save({ placeKey: `p${i}`, mapsUrl: `https://www.google.com/maps/place/${i}`, name: `Shop ${i}`, keyword: 'k', phone, websiteStatus: 'no_website' }));
  const ids = store.listLeads().map((l) => l.id).sort((a, b) => a - b);
  const dialer = new FakeDialer(store);
  const timers = fakeTimers();
  const auto = new AutoDialer({ dialer, store, timers, clock: () => new Date(2026, 9, 30, 12, 0) });
  return { store, ids, dialer, timers, auto };
}

test('mobile numbers only by default (landlines skipped)', () => {
  assert.equal(isMobile('+923001234567'), true);
  assert.equal(isMobile('+924235761234'), false);
});

test('calls Call Unseen leads in order; not answered -> the next one after the gap; done when all are called', async () => {
  const { store, ids, dialer, timers, auto } = setup();
  assert.equal(auto.start().ok, true);
  assert.equal(auto.state().total, 3);
  await timers.fire();
  assert.deepEqual(dialer.calls.map((c) => c.leadId), [ids[0]]);
  assert.equal(dialer.calls[0].auto, true);
  assert.equal(store.leadById(ids[0]).callStatus, 'seen');
  assert.equal(store.leadById(ids[0]).campaign, 'unseen'); // WhatsApp status untouched
  // Never a second call while one is going on.
  await auto.step();
  assert.equal(dialer.calls.length, 1);
  dialer.end('no_answer');
  assert.equal(auto.state().status, 'waiting');
  assert.equal([...timers.pending.values()].at(-1).ms, 10_000);
  await timers.fire((t) => t.ms === 10_000);
  assert.deepEqual(dialer.calls.map((c) => c.leadId), [ids[0], ids[1]]);
  dialer.end('busy');
  await timers.fire((t) => t.ms === 10_000);
  dialer.end('failed');
  await timers.fire((t) => t.ms === 10_000);
  assert.equal(auto.state().status, 'off');
  assert.match(auto.state().reason, /Done/);
  assert.equal(auto.state().processed, 3);
  assert.deepEqual(new Set(dialer.calls.map((c) => c.leadId)).size, 3); // nobody twice
});

test('answered: no more dialling; after the call it waits for the user to continue', async () => {
  const { dialer, timers, auto } = setup();
  auto.start();
  await timers.fire();
  dialer.answer();
  assert.match(auto.state().reason, /Answered/);
  dialer.end('answered');
  assert.equal(auto.state().status, 'paused');
  assert.equal(timers.pending.size, 0); // nothing scheduled
  assert.equal(dialer.calls.length, 1);
  assert.equal(auto.resume().ok, true);
  await timers.fire();
  assert.equal(dialer.calls.length, 2);
});

test('ended by the user before an answer: the next call 1 minute later; turning it off cancels that call', async () => {
  const { dialer, timers, auto } = setup();
  auto.start();
  await timers.fire();
  await dialer.hangup({ by: 'user' });
  assert.equal(auto.state().status, 'waiting');
  assert.equal([...timers.pending.values()].at(-1).ms, 60_000);
  auto.stop();
  assert.equal(timers.pending.size, 0);
  await timers.fire();
  assert.equal(dialer.calls.length, 1);
  assert.equal(auto.state().status, 'off');
});

test('rings too long: the Auto Dialer ends it as not answered and moves on', async () => {
  const { dialer, timers, auto } = setup();
  auto.start();
  await timers.fire();
  const ring = [...timers.pending.values()].find((t) => t.ms === 45_000);
  assert.ok(ring);
  await timers.fire((t) => t.ms === 45_000);
  assert.deepEqual(dialer.hangups, ['auto']);
  assert.equal(auto.state().status, 'waiting');
  assert.equal(auto.state().log[0].outcome, 'no_answer');
});

test('Bluetooth lost: paused, nothing dialled until the user continues with the phone connected', async () => {
  const { dialer, timers, auto } = setup();
  auto.start();
  await timers.fire();
  dialer.end('no_answer');
  dialer.s.link = 'idle';
  dialer.emit('state', dialer.s);
  assert.equal(auto.state().status, 'paused');
  assert.match(auto.state().reason, /Bluetooth/);
  await timers.fire();
  assert.equal(dialer.calls.length, 1);
  assert.match(auto.resume().error, /Connect/);
  dialer.s.link = 'ready';
  assert.equal(auto.resume().ok, true);
  await timers.fire();
  assert.equal(dialer.calls.length, 2);
});

test('only eligible leads: Call Seen, do-not-call, opted out, invalid and landline numbers are not called', async () => {
  const { store, ids, dialer, timers, auto } = setup(['+923001111111', '+923002222222', '+923003333333', '+924235761234', '+923004444444']);
  store.markCallSeen(ids[0]);
  store.setDoNotCall(ids[1], true);
  store.db.prepare('INSERT INTO outreach_optouts (phone, reason, at) VALUES (?, ?, ?)').run('+923003333333', 'stop', 1);
  assert.equal(auto.start().ok, true);
  assert.equal(auto.state().total, 1);
  await timers.fire();
  assert.deepEqual(dialer.calls.map((c) => c.number), ['+923004444444']);
  assert.equal(store.leadById(ids[1]).callStatus, 'dnc');
  assert.deepEqual(store.listLeads({ call: 'unseen' }).map((l) => l.phone).sort(), ['+923003333333', '+924235761234']);
});

test('calling hours: outside them it pauses instead of calling', async () => {
  const { dialer, timers, auto } = setup();
  auto.clock = () => new Date(2026, 9, 30, 23, 30);
  auto.start();
  await timers.fire();
  assert.equal(dialer.calls.length, 0);
  assert.match(auto.state().reason, /calling hours/);
  auto.setSettings({ hours: { on: false } });
  auto.resume();
  await timers.fire();
  assert.equal(dialer.calls.length, 1);
});

test('nothing to call, or no phone: it does not start', () => {
  const { dialer, auto } = setup([]);
  assert.match(auto.start().error, /No leads/);
  dialer.s.link = 'idle';
  assert.match(auto.start().error, /Connect/);
});
