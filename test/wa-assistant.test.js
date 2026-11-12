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
    settings: { admins: [ADMIN], suggestions: true, shutdownComputer: false },
    ...over,
  };
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
  await say('pause');
  assert.match(last(), /Paused 2 campaigns/);
  await say('resume');
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
