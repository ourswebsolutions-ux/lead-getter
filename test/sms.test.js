'use strict';
// SMS over Bluetooth MAP with a stand-in for the helper's map_* commands:
// connecting with the phone connection, the phone refusing message access,
// reading the inbox and sent folder once, sending (Call and WhatsApp status
// untouched, SMS Seen set), a failed send, the phone's sent copy matched,
// delivery reports, templates.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { LeadStore } = require('../src/database/db');
const { Sms, render, parseTimestamp, otherParty } = require('../src/messaging/sms');

const PHONE = '20:31:1C:F9:43:26';
const tick = () => new Promise((r) => setImmediate(r));

class FakeBt extends EventEmitter {
  constructor() {
    super();
    this.cmds = [];
    this.connectError = null;
    this.pushError = null;
    this.folders = {
      inbox: [{ path: '/m/1', handle: '1', folder: 'telecom/msg/inbox', senderAddress: '+923001112233', sender: 'Ali', timestamp: '20261030T101500', read: false, subject: 'Hi' }],
      sent: [],
    };
    this.bodies = { '/m/1': 'Hello from Ali' };
  }
  async request(cmd, args) {
    this.cmds.push([cmd, args]);
    if (cmd === 'map_connect' && this.connectError) throw new Error(this.connectError);
    if (cmd === 'map_list') return this.folders[args.folder] || [];
    if (cmd === 'map_get') return this.bodies[args.path] ?? '';
    if (cmd === 'map_push') {
      if (this.pushError) throw new Error(this.pushError);
      return { transfer: '/t/1' };
    }
    return true;
  }
}

function setup() {
  const store = new LeadStore(':memory:');
  store.save({ placeKey: 'p1', mapsUrl: 'https://www.google.com/maps/place/A', name: 'Acme', keyword: 'k', phone: '+923001112233', websiteStatus: 'no_website' });
  const bt = new FakeBt();
  const dialer = new EventEmitter();
  const timers = { setTimeout: () => 0, clearTimeout() {}, setInterval: () => 1, clearInterval() {} };
  const sms = new Sms({ bluetooth: bt, store, dialer, timers });
  return { store, bt, dialer, sms };
}

test('helpers: MAP timestamps, the other party, templates', () => {
  assert.equal(new Date(parseTimestamp('20261030T101500')).getHours(), 10);
  assert.equal(otherParty({ senderAddress: '+92 300 111' }, 'inbox'), '+92300111');
  assert.equal(otherParty({ recipientAddress: '0300-111' }, 'sent'), '0300111');
  assert.equal(render('Hi {name}, about {business}.', { name: 'Ali', business: 'SEO Hub' }), 'Hi Ali, about SEO Hub.');
  assert.equal(render('Hi {name}, thanks', {}), 'Hi, thanks');
});

test('connects with the phone; reads the inbox once; the lead is named', async () => {
  const { store, bt, dialer, sms } = setup();
  const incoming = [];
  sms.on('incoming', (m) => incoming.push(m));
  dialer.emit('state', { link: 'ready', saved: { address: PHONE } });
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(sms.state().state, 'ready');
  const threads = sms.threads();
  assert.equal(threads.length, 1);
  assert.equal(threads[0].contact.name, 'Acme');
  assert.equal(threads[0].unread, 1);
  assert.equal(incoming.length, 1);
  assert.equal(sms.messages('+923001112233').messages[0].body, 'Hello from Ali');
  assert.equal(sms.threads()[0].unread, 0); // read once opened
  await sms.sync();
  assert.equal(store.smsMessages('+923001112233').length, 1); // not saved twice
  // Phone disconnected: messages too.
  dialer.emit('state', { link: 'idle', saved: { address: PHONE } });
  assert.equal(sms.state().state, 'off');
  assert.ok(bt.cmds.some(([c]) => c === 'map_disconnect'));
});

test('the phone refuses message access: said, with what to do', async () => {
  const { bt, dialer, sms } = setup();
  bt.connectError = 'denied: The phone refused message access. On the phone: Settings, Bluetooth, this computer, turn on Text messages (Message access).';
  dialer.emit('state', { link: 'ready', saved: { address: PHONE } });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(sms.state().state, 'denied');
  assert.match(sms.state().error, /Text messages/);
  assert.match((await sms.send('+923001112233', 'Hi')).error, /refused message access/);
});

test('sending: pushed to the phone, SMS Seen for the lead (call and WhatsApp untouched); the sent copy matched; delivery; failure', async () => {
  const { store, bt, dialer, sms } = setup();
  dialer.emit('state', { link: 'ready', saved: { address: PHONE } });
  for (let i = 0; i < 10; i++) await tick();
  const lead = store.listLeads()[0];
  const r = await sms.send('+92 300 1112233', 'Hi Acme', { leadId: lead.id });
  assert.equal(r.ok, true);
  const push = bt.cmds.find(([c]) => c === 'map_push')[1];
  assert.deepEqual({ number: push.number, text: push.text }, { number: '+923001112233', text: 'Hi Acme' });
  const after = store.leadById(lead.id);
  assert.equal(after.smsStatus, 'seen');
  assert.equal(after.callStatus, 'unseen');
  assert.equal(after.campaign, 'unseen');
  // The phone's sent folder lists it (as 0300…): matched, not saved again.
  bt.folders.sent = [{ path: '/m/9', handle: '9', recipientAddress: '03001112233', timestamp: '20261030T101600' }];
  bt.bodies['/m/9'] = 'Hi Acme';
  await sms.sync('sent');
  const out = store.smsMessages('+923001112233').filter((m) => m.direction === 'out');
  assert.equal(out.length, 1);
  assert.equal(out[0].status, 'sent');
  assert.equal(out[0].handle, 'sent:9');
  bt.emit('sms_status', { address: PHONE, handle: '9', changed: { status: 'delivery-success' } });
  assert.equal(store.smsMessages('+923001112233').find((m) => m.direction === 'out').status, 'delivered');
  // A send the phone rejects is saved as failed.
  bt.pushError = 'The transfer failed.';
  assert.equal((await sms.send('+923214445566', 'Hello')).ok, false);
  assert.equal(store.smsMessages('+923214445566')[0].status, 'failed');
  assert.equal((await sms.send('abc', 'x')).ok, false);
  assert.equal((await sms.send('+923214445566', '   ')).ok, false);
});

test('templates are stored', () => {
  const { sms } = setup();
  sms.saveTemplates([{ name: 'First', text: 'Hi {name}' }, { name: '', text: 'dropped' }]);
  assert.deepEqual(sms.templates().map((t) => t.name), ['First']);
});

test('a connection that timed out (the phone was still asking the user) is tried again, by itself or with Try again', async () => {
  const store = new LeadStore(':memory:');
  const bt = new FakeBt();
  const dialer = new EventEmitter();
  const later = [];
  const timers = { setTimeout: (fn, ms) => (later.push({ fn, ms }), later.length), clearTimeout() {}, setInterval: () => 1, clearInterval() {} };
  const sms = new Sms({ bluetooth: bt, store, dialer, timers });
  bt.connectError = 'Timed out waiting for response';
  dialer.emit('state', { link: 'ready', saved: { address: PHONE } });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(sms.state().state, 'error');
  assert.match(sms.state().error, /Allow/);
  assert.equal(later.at(-1).ms, 20_000);
  // The user allowed it on the phone meanwhile: the retry connects.
  bt.connectError = null;
  later.at(-1).fn();
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(sms.state().state, 'ready');
  // Try again does nothing harmful when already connected.
  assert.equal(sms.retry().ok, true);
});
