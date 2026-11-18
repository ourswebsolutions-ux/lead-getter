'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Assistant, parseCountries } = require('../src/main/wa-assistant');
const { LeadStore } = require('../src/database/db');

const ADMIN = '923001112222';
function world(over = {}) {
  const store = new LeadStore(':memory:');
  let t = 1_000_000;
  const sent = [];
  const calls = [];
  const w = {
    accounts: [
      { id: 'primary', label: 'WhatsApp 1', number: '+92300', ready: true },
      { id: 'a2', label: 'WhatsApp 2', number: '+92301', ready: true },
      { id: 'a3', label: 'WhatsApp 3', number: '+92302', ready: true },
    ],
    campaigns: [
      { id: 1, name: 'Garments', status: 'running', accountId: 'primary', live: true, sentToday: 4, queued: 10 },
      { id: 2, name: 'Bakery', status: 'running', accountId: 'a2', live: true, sentToday: 2, queued: 5 },
    ],
    unused: [],
    settings: { admins: [ADMIN], suggestions: true, shutdownComputer: false, poolAuto: false },
    tasks: [],
    ...over,
  };
  let seq = 0;
  const active = () => w.tasks.find((x) => ['running', 'pending', 'waiting', 'paused'].includes(x.status));
  const a = new Assistant({
    store,
    now: () => t,
    send: async (accountId, phone, text) => sent.push({ accountId, phone, text }),
    accounts: () => w.accounts,
    campaigns: () => w.campaigns,
    unusedCategories: () => w.unused,
    categoryMessage: (key) => w.saved?.[key] || '',
    startSearch: async (x) => (calls.push(['search', x]), { ok: true, category: { key: '9', name: 'Shoes Shop' } }),
    startCampaign: async (x) => (calls.push(['campaign', x]), { ok: true }),
    pauseAll: async () => (calls.push(['pause']), { count: 2 }),
    resumeAll: async () => (calls.push(['resume']), { count: 2 }),
    status: () => 'STATUS TEXT',
    powerOff: async () => calls.push(['power']),
    settings: () => w.settings,
    setSettings: (p) => Object.assign(w.settings, p),
    searches: () => w.tasks,
    categories: () => ['Construction', 'Real Estate'],
    live: () => null,
    addSearch: async ({ country, category, business, start }) => {
      if (start && active()) return { ok: false, busy: active() };
      const t = { id: `t${++seq}`, keyword: business, category, countries: [country], status: start ? 'running' : 'queued', leads: 0, processed: 0, listed: 0 };
      w.tasks.push(t);
      calls.push(['add', { country, category, business, start }]);
      return start ? { ok: true, started: true, task: t } : { ok: true, started: false, position: w.tasks.filter((x) => x.status === 'queued').length };
    },
    startPooled: (id) => {
      if (active()) return { ok: false, error: 'busy' };
      const t = w.tasks.find((x) => x.id === id);
      t.status = 'running';
      calls.push(['start', id]);
      return { ok: true, task: t };
    },
    stopSearch: () => {
      const t = active();
      if (!t) return { ok: false };
      t.status = 'completed';
      calls.push(['stop']);
      return { ok: true };
    },
    pauseSearch: () => (active() ? ((active().status = 'paused'), { ok: true, task: w.tasks.find((x) => x.status === 'paused') }) : { ok: false, error: 'No search is running.' }),
    resumeSearch: () => {
      const t = w.tasks.find((x) => x.status === 'paused');
      if (!t) return { ok: false, error: 'No search is paused.' };
      t.status = 'running';
      return { ok: true, task: t };
    },
    poolRemove: (id) => (w.tasks = w.tasks.filter((x) => x.id !== id)),
    poolMove: (id, to) => {
      const t = w.tasks.find((x) => x.id === id);
      w.tasks = w.tasks.filter((x) => x.id !== id);
      const q = w.tasks.filter((x) => x.status === 'queued');
      const anchor = q[to - 1];
      w.tasks.splice(anchor ? w.tasks.indexOf(anchor) : w.tasks.length, 0, t);
    },
    poolHold: (id, held) => (w.tasks.find((x) => x.id === id).held = held),
  });
  const say = async (text, phone = ADMIN, accountId = 'a3') => {
    const handled = a.onMessage({ accountId, phone, text });
    await a.busy;
    return handled;
  };
  return { a, w, sent, calls, say, last: () => sent.at(-1)?.text || '', advance: (ms) => (t += ms) };
}

test('Scenario A: an idle account is offered; keyword, countries and message are asked once; nothing starts before YES', async () => {
  const { a, sent, calls, say, last } = world();
  await a.suggest();
  assert.equal(sent.at(-1).phone, ADMIN);
  assert.equal(sent.at(-1).accountId, 'a3', 'sent from the idle account');
  assert.match(last(), /WhatsApp 3.*is currently available.*new lead generation campaign/s);
  await say('haan');
  assert.match(last(), /Which business keyword/);
  await say('shoes shop');
  assert.match(last(), /Which countries/);
  await say('Pakistan, Qatar and dubai, xyzland');
  assert.match(last(), /don't know: xyzland/, 'an unknown country is asked again');
  await say('Pakistan, Qatar, UAE');
  assert.match(last(), /What message/);
  await say('Assalam-o-Alaikum {name}, we build websites for shoe shops.');
  assert.match(last(), /Please confirm:[\s\S]*shoes shop in Pakistan, Qatar, UAE[\s\S]*WhatsApp 3[\s\S]*WhatsApp’s rules/);
  await say('maybe');
  assert.match(last(), /Please reply YES or NO/, 'an unclear reply never starts anything');
  assert.equal(calls.length, 0);
  await say('YES');
  assert.deepEqual(calls[0], ['search', { keyword: 'shoes shop', countries: ['Pakistan', 'Qatar', 'UAE'] }]);
  assert.deepEqual(calls[1], ['campaign', { category: { key: '9', name: 'Shoes Shop' }, accountId: 'a3', message: 'Assalam-o-Alaikum {name}, we build websites for shoe shops.' }]);
  assert.match(last(), /Started/);
  // Not offered again soon.
  await a.suggest();
  assert.match(last(), /Started/);
});

test('Scenario B: unused categories first; NO moves to the next; YES with one free account suggests it; a saved message is offered', async () => {
  const { a, calls, say, last } = world({ unused: [{ key: '1', name: 'Shoes Shops – Pakistan', ready: 12 }, { key: '2', name: 'Garments – UAE', ready: 5 }, { key: '3', name: 'Empty', ready: 0 }], saved: { 2: 'Salam {name}!' } });
  await a.suggest();
  assert.match(last(), /12 leads in "Shoes Shops – Pakistan"[\s\S]*has not been used in a campaign/);
  await say('no');
  assert.match(last(), /"Garments – UAE"/, 'the next unused category');
  await say('yes');
  assert.match(last(), /Use WhatsApp 3/, 'the only free account is suggested');
  await say('yes');
  assert.match(last(), /already has a campaign message:[\s\S]*Salam \{name\}!/);
  await say('yes');
  assert.match(last(), /Please confirm:[\s\S]*Leads: Garments – UAE/);
  await say('ok');
  assert.deepEqual(calls, [['campaign', { category: { key: '2', name: 'Garments – UAE' }, accountId: 'a3', message: 'Salam {name}!' }]]);
});

test('Several free accounts: a numbered choice', async () => {
  const { a, say, last, calls } = world({ campaigns: [], unused: [{ key: '1', name: 'Shoes', ready: 3 }] });
  await a.suggest();
  await say('yes');
  assert.match(last(), /1\. WhatsApp 1[\s\S]*2\. WhatsApp 2[\s\S]*3\. WhatsApp 3/);
  await say('7');
  assert.match(last(), /number from 1 to 3/);
  await say('2');
  assert.match(last(), /What message/);
  await say('Hello {business name}');
  await say('yes');
  assert.equal(calls[0][1].accountId, 'a2');
});

test('Commands, power off with confirmation, cancel, timeout, and other numbers ignored', async () => {
  const { a, w, say, last, calls, advance, sent } = world();
  assert.equal(await say('status', '923339999999'), false, 'not the admin: not handled');
  assert.equal(calls.length, 0);
  await say('status');
  assert.equal(last(), 'STATUS TEXT');
  await say('accounts');
  assert.match(last(), /WhatsApp 1[^\n]*running a campaign[\s\S]*WhatsApp 3[^\n]*idle/);
  await say('campaigns');
  assert.match(last(), /Garments \(WhatsApp 1\): running, 4 sent today, 10 waiting/);
  await say('pause campaigns');
  assert.match(last(), /Paused 2 campaigns/);
  await say('resume campaigns');
  assert.match(last(), /Resumed 2/);
  await say('power off');
  assert.match(last(), /Are you sure you want to shut down Lead Finder\?/);
  await say('no');
  assert.match(last(), /keeps running/);
  assert.ok(!calls.some((c) => c[0] === 'power'));
  await say('computer shutdown on');
  assert.equal(w.settings.shutdownComputer, true);
  await say('power off');
  assert.match(last(), /and this computer/);
  await say('yes');
  assert.ok(calls.some((c) => c[0] === 'power'));
  // Cancel and timeout.
  await a.suggest();
  await say('yes');
  await say('cancel');
  assert.match(last(), /Cancelled/);
  const powers = calls.filter((c) => c[0] === 'power').length;
  await say('power off');
  advance(31 * 60_000);
  const before = sent.length;
  await say('yes');
  assert.ok(sent.slice(before).some((m) => /timed out/.test(m.text)), 'the user is told');
  assert.equal(calls.filter((c) => c[0] === 'power').length, powers, 'a late YES does nothing');
  await say('suggestions off');
  assert.equal(w.settings.suggestions, false);
  await say('admin off');
  assert.deepEqual(w.settings.admins, []);
  assert.equal(await say('status'), false, 'no longer the admin');
});

test('Country names in replies', () => {
  assert.deepEqual(parseCountries('pakistan, qatar & uae').countries, ['Pakistan', 'Qatar', 'UAE']);
  assert.deepEqual(parseCountries('KSA / Dubai').countries, ['Saudi Arabia', 'UAE']);
  assert.deepEqual(parseCountries('Pakistan, Mars').unknown, ['mars']);
});

test('"search": country, category, business type, confirm; started only after YES; busy: added to the pool', async () => {
  const { w, say, last, calls } = world({ unused: [] });
  await say('search');
  assert.match(last(), /Which country/);
  await say('Mars');
  assert.match(last(), /one country/);
  await say('UAE');
  assert.match(last(), /Select a category[\s\S]*1\. Construction/);
  await say('1');
  assert.match(last(), /Which business type/);
  await say('Fit Out Companies');
  assert.match(last(), /Country: UAE[\s\S]*Category: Construction[\s\S]*Business: Fit Out Companies[\s\S]*Should I start this search\?/);
  assert.equal(calls.length, 0, 'nothing before the answer');
  await say('haan');
  assert.match(last(), /Search started successfully/);
  assert.deepEqual(calls[0], ['add', { country: 'UAE', category: 'Construction', business: 'Fit Out Companies', start: true }]);
  // Another one while it runs: the pool.
  await say('search');
  await say('Qatar');
  await say('Real Estate');
  await say('Property Developers');
  await say('yes');
  assert.match(last(), /A search is running: UAE → Construction → Fit Out Companies[\s\S]*POOL/);
  await say('pool');
  assert.match(last(), /Added to the search pool \(number 1\)/);
  assert.equal(w.tasks[1].status, 'queued');
  // Stop: immediately.
  await say('stop');
  assert.match(last(), /Search stopped\. Nothing else starts/);
  assert.equal(w.tasks[0].status, 'completed');
  assert.equal(w.tasks[1].status, 'queued', 'the pool is not started by Stop');
});

test('"pool add" several at once; "next" asks which; pool edits; "leads" counts', async () => {
  const { w, say, last, calls } = world();
  await say('next');
  assert.match(last(), /pool is empty/);
  await say('pool add');
  await say('UAE, Construction, Fit Out Companies\nSaudi Arabia → Solar Energy → Solar Installation Companies\n3. Qatar, Real Estate, Property Developers\nPakistan, Construction, Contractors');
  assert.match(last(), /Add 4 searches to the pool\?[\s\S]*Saudi Arabia → Solar Energy → Solar Installation Companies/);
  await say('yes');
  assert.equal(w.tasks.filter((t) => t.status === 'queued').length, 4);
  assert.ok(!calls.some((c) => c[0] === 'start'), 'adding never starts one');
  await say('pool move 4 to 1');
  assert.match(last(), /1\. Pakistan → Construction → Contractors/);
  await say('pool remove 3');
  assert.match(last(), /Search pool \(3\)/);
  await say('pool pause 2');
  assert.match(last(), /2\. UAE → Construction → Fit Out Companies \(paused\)/);
  await say('next');
  // After the move and the removal: Pakistan, UAE (paused), Qatar.
  assert.match(last(), /Which search should I start next\?\n1\. Pakistan → Construction → Contractors\n2\. Qatar → Real Estate → Property Developers\n\n/, 'paused ones are not offered');
  await say('2');
  assert.match(last(), /Start Qatar → Real Estate → Property Developers\?/);
  await say('yes');
  assert.match(last(), /Search started successfully/);
  w.tasks.find((t) => t.status === 'running').leads = 12;
  w.tasks.find((t) => t.status === 'running').processed = 80;
  w.tasks.find((t) => t.status === 'running').listed = 120;
  await say('leads');
  assert.match(last(), /Qatar → Real Estate → Property Developers\nFound: 120 · Checked: 80 · Remaining: 40 · New leads: 12\nStatus: Active, plenty left/);
  await say('pause');
  assert.match(last(), /Paused "Property Developers"/);
  await say('resume');
  assert.match(last(), /Resumed/);
});

test('A completed search: the admin is asked what is next; nothing starts unless "pool auto on"', async () => {
  const { a, w, say, last, calls } = world();
  w.tasks.push({ id: 'p1', keyword: 'Contractors', category: 'Construction', countries: ['Pakistan'], status: 'queued' });
  const done = { id: 'd1', keyword: 'Fit Out Companies', category: 'Construction', countries: ['UAE'], status: 'completed', exhausted: true, processed: 118, listed: 118, leads: 31 };
  await a.searchDone(done);
  assert.match(last(), /Current search completed: UAE → Construction → Fit Out Companies\.\n118 businesses checked, 31 new leads\.[\s\S]*What would you like to search next\?[\s\S]*Nothing starts until you choose/);
  assert.ok(!calls.some((c) => c[0] === 'start'));
  await say('pool auto on');
  await a.searchDone(done);
  assert.match(last(), /Started the pool’s next search: Pakistan → Construction → Contractors/);
  w.tasks.find((t) => t.id === 'p1').status = 'completed';
  w.tasks.push(done);
  await say('leads');
  assert.match(last(), /Found: 118 · Checked: 118 · Remaining: 0 · New leads: 31\nStatus: Completed \(all results checked\)/);
});

test('A command is never blocked by an unanswered suggestion', async () => {
  const { a, say, last } = world({ campaigns: [] });
  await a.suggest();
  assert.match(last(), /is currently available/);
  await say('search');
  assert.match(last(), /Which country/, '"search" works although a YES / NO question was open');
  await say('UAE');
  assert.match(last(), /Select a category/);
  await say('stop');
  assert.match(last(), /No search is running/, '"stop" is never taken as an answer');
  await say('Construction');
  assert.match(last(), /I did not understand/, 'the setup was ended by stop');
});

