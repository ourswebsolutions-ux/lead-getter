'use strict';
// The Dialer over Bluetooth Hands-Free: the AT protocol (with the replies a
// vivo 1920 gave in a live session), call history, the audio devices and
// echo cancellation, and the call flow with a stand-in for the Bluetooth
// helper and the phone. The real phone, SIM and audio are tested with
// test/integration/dialer-live.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { LeadStore } = require('../src/database/db');
const { Hfp, HF_FEATURES, parseClcc, cindRanges } = require('../src/dialer/hfp');
const { CallAudio } = require('../src/dialer/audio');
const { Dialer, sortDevices, dialable } = require('../src/dialer/dialer');

const PHONE = '20:31:1C:F9:43:26';
const tick = () => new Promise((r) => setImmediate(r));

// An Android phone's Audio Gateway, answering as the vivo 1920 did.
class FakeAg {
  constructor(emitLine) {
    this.emitLine = emitLine;
    this.ind = { call: 0, callsetup: 0, service: 1, signal: 5, roam: 0, battchg: 2, callheld: 0 };
    this.names = ['call', 'callsetup', 'service', 'signal', 'roam', 'battchg', 'callheld'];
    this.sent = [];
    this.dialError = null;
  }
  reply(...lines) {
    for (const l of lines) setImmediate(() => this.emitLine(l));
  }
  ciev(name, v) {
    this.ind[name] = v;
    this.reply(`+CIEV: ${this.names.indexOf(name) + 1},${v}`);
  }
  at(line) {
    this.sent.push(line);
    if (line.startsWith('AT+BRSF=')) return this.reply('+BRSF: 2927', 'OK');
    if (line === 'AT+CIND=?') return this.reply('+CIND: ("call",(0,1)),("callsetup",(0-3)),("service",(0-1)),("signal",(0-5)),("roam",(0,1)),("battchg",(0-5)),("callheld",(0-2))', 'OK');
    if (line === 'AT+CIND?') return this.reply(`+CIND: ${this.names.map((n) => this.ind[n]).join(',')}`, 'OK');
    if (line === 'AT+CHLD=?') return this.reply('+CHLD: (0,1,2,3)', 'OK');
    if (line === 'AT+COPS?') return this.reply('+COPS: 0,0,"Jazz"', 'OK');
    if (line === 'AT+CNUM') return this.reply('+CNUM: ,"+923270583075",145,,4', 'OK');
    if (line === 'AT+CLCC') return this.reply(...(this.clcc ? [this.clcc] : []), 'OK');
    if (line.startsWith('ATD')) {
      if (this.dialError) return this.reply(this.dialError);
      this.reply('OK');
      setImmediate(() => this.ciev('callsetup', 2));
      return;
    }
    if (line === 'ATA') {
      this.reply('OK');
      setImmediate(() => {
        this.ciev('call', 1);
        this.ciev('callsetup', 0);
      });
      return;
    }
    if (line === 'AT+CHUP') {
      this.reply('OK');
      setImmediate(() => (this.ind.call ? this.ciev('call', 0) : this.ciev('callsetup', 0)));
      return;
    }
    this.reply('OK');
  }
}

test('dialable numbers: digits, + and service codes only', () => {
  assert.equal(dialable(' +92 (324) 523-7429 '), '+923245237429');
  assert.equal(dialable('*123#'), '*123#');
  assert.equal(dialable('12'), null);
  assert.equal(dialable('+92abc'), null);
  assert.equal(dialable('tel:123456'), null);
});

test('HFP: service level connection with the phone, as with the vivo 1920', async () => {
  let ag;
  const hfp = new Hfp({ send: (line) => ag.at(line) });
  ag = new FakeAg((l) => hfp.onLine(l));
  const info = await hfp.start();
  assert.deepEqual(ag.sent.slice(0, 5), [`AT+BRSF=${HF_FEATURES}`, 'AT+CIND=?', 'AT+CIND?', 'AT+CMER=3,0,0,1', 'AT+CHLD=?']);
  assert.equal(HF_FEATURES, 118);
  assert.equal(info.operator, 'Jazz');
  assert.equal(info.number, '+923270583075');
  assert.equal(info.canReject, true);
  assert.equal(info.callList, true);
  assert.deepEqual(info.indicators, { call: 0, callsetup: 0, service: 1, signal: 5, roam: 0, battchg: 2, callheld: 0 });
  assert.ok(info.features.includes('codec negotiation'));
  const seen = [];
  hfp.on('indicator', (e) => seen.push([e.name, e.value]));
  hfp.onLine('+CIEV: 2,1');
  hfp.onLine('+CIEV: 6,4');
  assert.deepEqual(seen, [['callsetup', 1], ['battchg', 4]]);
  // Errors in words.
  ag.at = () => setImmediate(() => hfp.onLine('+CME ERROR: 30'));
  assert.equal((await hfp.dial('123')).error, 'No network service');
  ag.at = () => setImmediate(() => hfp.onLine('BUSY'));
  assert.equal((await hfp.dial('123')).error, 'The number is busy.');
});

test('HFP: parsing of indicator lists and call lists', () => {
  assert.deepEqual(cindRanges('+CIND: ("call",(0,1)),("callsetup",(0-3)),("service",(0-1))'), ['call', 'callsetup', 'service']);
  assert.deepEqual(parseClcc('+CLCC: 1,0,3,0,0,"+923001234567",145'), { index: 1, direction: 'outgoing', state: 'alerting', voice: true, number: '+923001234567' });
  assert.equal(parseClcc('+CLCC: 1,1,4,0,0,"03001234567",129').direction, 'incoming');
});

test('HFP: a command the phone never answers times out; a dropped link ends waiting commands', async () => {
  const timers = { setTimeout: (fn) => (setImmediate(fn), 1), clearTimeout() {} };
  const hfp = new Hfp({ send: () => {}, timers });
  assert.equal((await hfp.cmd('AT')).error, 'The phone did not answer.');
  const slow = new Hfp({ send: () => {} });
  const p = slow.cmd('AT+CLCC');
  slow.reset();
  assert.equal((await p).error, 'The phone disconnected.');
});

test('call history: saved, updated, searched and filtered; lead lookup by number', () => {
  const s = new LeadStore(':memory:');
  s.save({ placeKey: 'p1', mapsUrl: 'https://www.google.com/maps/place/A', name: 'Acme Plumbing', keyword: 'k', phone: '+923001234567', websiteStatus: 'no_website' });
  const lead = s.listLeads()[0];
  assert.equal(s.findLeadByPhone('0300 1234567').id, lead.id);
  assert.equal(s.findLeadByPhone('+44 20 7946 0000'), null);
  const a = s.addCall({ leadId: lead.id, number: '+923001234567', name: 'Acme Plumbing', business: 'Acme Plumbing', direction: 'outgoing', status: 'dialing', startedAt: 1000, sim: 'Jazz' });
  s.updateCall(a, { status: 'answered', duration: 63, endedAt: 70_000 });
  const b = s.addCall({ number: '+15125550142', direction: 'incoming', status: 'ringing', startedAt: 2000 });
  s.updateCall(b, { status: 'missed', duration: 0, endedAt: 3000 });
  assert.deepEqual(s.listCalls().map((c) => c.id), [b, a]);
  assert.equal(s.listCalls()[1].duration, 63);
  assert.deepEqual(s.listCalls({ direction: 'incoming' }).map((c) => c.id), [b]);
  assert.deepEqual(s.listCalls({ status: 'answered' }).map((c) => c.id), [a]);
  assert.deepEqual(s.listCalls({ status: 'not_answered' }).map((c) => c.id), [b]);
  assert.deepEqual(s.listCalls({ search: 'acme' }).map((c) => c.id), [a]);
  assert.deepEqual(s.listCalls({ search: '555 0142' }).map((c) => c.id), [b]);
  assert.deepEqual(s.listCalls({ leadId: lead.id }).map((c) => c.id), [a]);
  assert.deepEqual(s.listCalls({ search: '100%' }), []);
  s.deleteLeads([lead.id]);
  assert.equal(s.listCalls()[1].name, 'Acme Plumbing'); // calls outlive the lead
});

test('devices: phones first, then paired, then by signal', () => {
  const list = sortDevices([
    { name: 'Speaker', icon: 'audio-card', paired: true, rssi: -40, deviceClass: 0x240414 },
    { name: 'Far phone', icon: 'phone', paired: false, rssi: -90, deviceClass: 0x5a020c },
    { name: 'My phone', icon: 'phone', paired: true, rssi: -70, deviceClass: 0x5a020c },
  ]);
  assert.deepEqual(list.map((d) => d.name), ['My phone', 'Far phone', 'Speaker']);
});

test('call audio devices: chosen speaker and microphone, echo cancellation between them', async () => {
  const ran = [];
  const data = {
    sinks: [{ name: 'alsa_output.speaker', description: 'Built-in Audio', properties: { 'device.api': 'alsa' } }],
    sources: [
      { name: 'alsa_output.speaker.monitor', monitor_source: 'alsa_output.speaker', properties: { 'device.class': 'monitor' } },
      { name: 'alsa_input.mic', description: 'Built-in Mic', monitor_source: '', properties: {} },
      { name: 'usb_mic', description: 'USB Mic', monitor_source: '', properties: {} },
    ],
  };
  const run = async (args) => {
    ran.push(args.join(' '));
    if (args[0] === '-f') return JSON.stringify(data[args[3]]);
    if (args[0] === 'get-default-sink') return 'alsa_output.speaker\n';
    if (args[0] === 'get-default-source') return 'alsa_input.mic\n';
    if (args[0] === 'load-module') return '41\n';
    return '';
  };
  const audio = new CallAudio({ run });
  const devs = await audio.devices();
  assert.deepEqual(devs.inputs.map((d) => d.name), ['alsa_input.mic', 'usb_mic']);
  const r = await audio.prepare({ input: 'usb_mic', echoCancel: true });
  assert.deepEqual({ play: r.play, record: r.record, output: r.output, input: r.input, echoCancel: r.echoCancel }, { play: 'leadfinder_call_speaker', record: 'leadfinder_call_mic', output: 'alsa_output.speaker', input: 'usb_mic', echoCancel: true });
  assert.ok(ran.some((c) => c.startsWith('load-module module-echo-cancel aec_method=webrtc source_master=usb_mic sink_master=alsa_output.speaker')));
  await audio.release();
  assert.ok(ran.includes('unload-module 41'));
  const plain = await audio.prepare({ input: 'gone_mic', echoCancel: false });
  assert.deepEqual({ play: plain.play, record: plain.record }, { play: 'alsa_output.speaker', record: 'alsa_input.mic' }); // a missing device falls back to the default
});

// --- the call flow, with a stand-in Bluetooth helper and phone ---

class FakeBt extends EventEmitter {
  constructor({ hfRole = true } = {}) {
    super();
    this.running = true;
    this.cmds = [];
    this.hfRole = hfRole;
    this.ag = new FakeAg((line) => this.emit('data', { address: PHONE, line }));
  }
  start() {
    setImmediate(() => this.emit('hf_profile', this.hfRole ? { ok: true } : { ok: false, busy: true, error: "The sound server (PipeWire) is using this computer's Hands-Free role." }));
  }
  stop() {}
  async request(cmd, args) {
    this.cmds.push([cmd, args]);
    if (cmd === 'send') this.ag.at(args.line);
    if (cmd === 'link') setImmediate(() => this.emit('link_up', { address: args.address }));
    if (cmd === 'register_hf') return this.hfRole;
    if (cmd === 'sco_connect') setImmediate(() => this.emit('sco_up', { address: args.address }));
    if (cmd === 'sco_disconnect') setImmediate(() => this.emit('sco_down', { address: args.address, reason: 'moved to the phone' }));
    return true;
  }
}

class FakeAudio extends EventEmitter {
  constructor() {
    super();
    this.route = null;
    this.prepared = 0;
  }
  async available() {
    return true;
  }
  async devices() {
    return { outputs: [{ name: 'spk' }], inputs: [{ name: 'mic' }], defaultOutput: 'spk', defaultInput: 'mic' };
  }
  async prepare() {
    this.prepared++;
    this.route = { play: 'ec_spk', record: 'ec_mic', output: 'spk', input: 'mic', echoCancel: true, modules: [1] };
    return this.route;
  }
  async release() {
    this.route = null;
  }
  watch() {}
  unwatch() {}
}

async function until(fn, n = 60) {
  for (let i = 0; i < n && !fn(); i++) await tick();
  assert.ok(fn(), 'condition not reached');
}

async function connected(store = new LeadStore(':memory:'), opts) {
  const bt = new FakeBt(opts);
  const audio = new FakeAudio();
  let now = 1_000_000;
  const dialer = new Dialer({ bluetooth: bt, audio, store, now: () => now });
  await dialer.start();
  bt.emit('ready', { state: { adapter: { powered: true, address: '00:11:22:33:44:55' }, devices: [{ address: PHONE, name: 'vivo 1920', icon: 'phone', paired: true, connected: true, path: '/p' }] } });
  await until(() => dialer.state().hfRole === 'ok');
  assert.equal((await dialer.connect(PHONE)).ok, true);
  await until(() => dialer.state().link === 'ready');
  return { bt, audio, dialer, store, ag: bt.ag, advance: (ms) => (now += ms) };
}

test('connect: Hands-Free with the phone; network, number, signal and battery from the phone', async () => {
  const { dialer, store } = await connected();
  const st = dialer.state();
  assert.deepEqual(st.phone, { operator: 'Jazz', number: '+923270583075', numbers: ['+923270583075'], features: st.phone.features, canReject: true, signal: 5, battery: 40, service: true, roam: false });
  assert.deepEqual(store.getState('dialerDevice'), { address: PHONE, name: 'vivo 1920' });
  dialer.stop();
});

test('outgoing call: ATD, dialing, ringing, answered, audio on the computer, mute, keypad tones, end from here', async () => {
  const { bt, ag, audio, dialer, store, advance } = await connected();
  store.save({ placeKey: 'p1', mapsUrl: 'https://www.google.com/maps/place/A', name: 'Acme Plumbing', keyword: 'k', phone: '+923001234567', websiteStatus: 'no_website' });
  const lead = store.listLeads()[0];
  const r = await dialer.call('+92 300 1234567', { leadId: lead.id });
  assert.equal(r.ok, true);
  assert.ok(ag.sent.includes('ATD+923001234567;'));
  await until(() => dialer.state().call.state === 'dialing');
  assert.equal(dialer.state().call.business, 'Acme Plumbing');
  assert.equal(audio.prepared, 1); // devices handed to the helper before the phone sends audio
  await until(() => bt.cmds.some(([c]) => c === 'audio'));
  assert.deepEqual(bt.cmds.find(([c]) => c === 'audio')[1], { play: 'ec_spk', record: 'ec_mic', muted: false });
  ag.ciev('callsetup', 3);
  await until(() => dialer.state().call.state === 'alerting');
  // Not answered yet and the audio is not here: no muting.
  assert.match((await dialer.mute(true)).error, /on the phone/);
  bt.emit('sco_up', { address: PHONE });
  ag.ciev('call', 1);
  ag.ciev('callsetup', 0);
  await until(() => dialer.state().call.state === 'active');
  assert.equal(dialer.state().call.audio.state, 'computer');
  assert.equal((await dialer.mute(true)).ok, true);
  assert.equal(bt.cmds.filter(([c]) => c === 'audio').at(-1)[1].muted, true);
  assert.equal((await dialer.dtmf('5')).ok, true);
  assert.ok(ag.sent.includes('AT+VTS=5'));
  advance(42_000);
  assert.equal((await dialer.hangup()).ok, true);
  await until(() => dialer.state().call.state === 'ended');
  const [rec] = store.listCalls();
  assert.deepEqual({ status: rec.status, duration: rec.duration, leadId: rec.leadId, direction: rec.direction, sim: rec.sim }, { status: 'answered', duration: 42, leadId: lead.id, direction: 'outgoing', sim: 'Jazz' });
  dialer.stop();
});

test('outgoing call nobody answers, and one the phone refuses', async () => {
  const { ag, dialer, store } = await connected();
  await dialer.call('03001234567');
  ag.ciev('callsetup', 3);
  await until(() => dialer.state().call?.state === 'alerting');
  ag.ciev('callsetup', 0);
  await until(() => dialer.state().call.state === 'ended');
  assert.equal(store.listCalls()[0].status, 'no_answer');
  assert.equal(store.listCalls()[0].duration, 0);
  dialer.s.call = null;
  ag.dialError = '+CME ERROR: 30';
  assert.deepEqual(await dialer.call('03001234567'), { ok: false, error: 'No network service' });
  assert.equal(store.listCalls()[0].status, 'failed');
  assert.equal(store.listCalls()[0].detail, 'No network service');
  assert.equal((await dialer.call('abc')).ok, false);
  dialer.stop();
});

test('incoming call: caller ID with the lead, answered from the computer; another rejected; another missed', async () => {
  const { ag, dialer, store, advance } = await connected();
  store.save({ placeKey: 'p1', mapsUrl: 'https://www.google.com/maps/place/A', name: 'Acme Plumbing', keyword: 'k', phone: '+923001234567', websiteStatus: 'no_website' });
  const rings = [];
  dialer.on('incoming', (c) => rings.push(c));
  ag.ciev('callsetup', 1);
  ag.reply('RING', '+CLIP: "03001234567",129');
  await until(() => rings.length === 1);
  assert.equal(rings[0].business, 'Acme Plumbing');
  assert.equal(rings[0].number, '03001234567');
  assert.equal((await dialer.answer()).ok, true);
  await until(() => dialer.state().call.state === 'active');
  advance(30_000);
  ag.ciev('call', 0);
  await until(() => dialer.state().call.state === 'ended');
  let rec = store.listCalls()[0];
  assert.deepEqual({ direction: rec.direction, status: rec.status, duration: rec.duration, business: rec.business }, { direction: 'incoming', status: 'answered', duration: 30, business: 'Acme Plumbing' });
  dialer.s.call = null;
  ag.ciev('callsetup', 1);
  ag.reply('+CLIP: "+15125550142",145');
  await until(() => dialer.state().call?.state === 'ringing');
  assert.equal((await dialer.reject()).ok, true);
  await until(() => dialer.state().call.state === 'ended');
  assert.equal(store.listCalls()[0].status, 'rejected');
  dialer.s.call = null;
  ag.ciev('callsetup', 1);
  await until(() => dialer.state().call?.state === 'ringing');
  ag.ciev('callsetup', 0);
  await until(() => dialer.state().call.state === 'ended');
  rec = store.listCalls()[0];
  assert.equal(rec.status, 'missed');
  dialer.stop();
});

test('a call dialled on the phone itself is followed and saved with its number', async () => {
  const { ag, dialer, store } = await connected();
  ag.clcc = '+CLCC: 1,0,2,0,0,"+923331112223",145';
  ag.ciev('callsetup', 2);
  await until(() => dialer.state().call?.number === '+923331112223');
  ag.ciev('callsetup', 0);
  await until(() => dialer.state().call.state === 'ended');
  assert.equal(store.listCalls()[0].number, '+923331112223');
  assert.equal(store.listCalls()[0].status, 'no_answer');
  dialer.stop();
});

test('audio moves to the phone and back during a call', async () => {
  const { bt, ag, dialer } = await connected();
  await dialer.call('03001234567');
  ag.ciev('call', 1);
  bt.emit('sco_up', { address: PHONE });
  await until(() => dialer.state().call?.audio?.state === 'computer');
  await dialer.audioTo('phone');
  await until(() => dialer.state().call.audio.state === 'phone');
  await dialer.audioTo('computer');
  await until(() => dialer.state().call.audio.state === 'computer');
  dialer.stop();
});

test('the Bluetooth link drops mid-call: the call is saved, reconnecting is scheduled', async () => {
  const { bt, ag, dialer, store } = await connected();
  await dialer.call('03001234567');
  ag.ciev('call', 1);
  await until(() => dialer.state().call?.state === 'active');
  bt.emit('link_down', { address: PHONE, reason: 'closed' });
  assert.equal(dialer.state().link, 'idle');
  assert.equal(store.listCalls()[0].detail, 'The phone disconnected during the call.');
  assert.ok(dialer.reconnectTimer);
  dialer.stop();
});

test('PipeWire holds the Hands-Free role: explained, and taken over only on request', async () => {
  const bt = new FakeBt({ hfRole: false });
  let took = 0;
  const handover = {
    takeOver: async () => {
      took++;
      bt.hfRole = true;
    },
  };
  const timers = { setTimeout: (fn) => (setImmediate(fn), 1), clearTimeout() {} };
  const dialer = new Dialer({ bluetooth: bt, audio: new FakeAudio(), store: new LeadStore(':memory:'), handover, timers });
  await dialer.start();
  await until(() => dialer.state().hfRole === 'pipewire');
  assert.equal(took, 0);
  assert.equal((await dialer.connect(PHONE)).ok, false);
  assert.equal((await dialer.takeHandsFree()).ok, true);
  assert.equal(took, 1);
  dialer.stop();
});

test('unsupported platform: the Dialer says so and starts nothing', async () => {
  const bt = new FakeBt();
  bt.start = () => assert.fail('must not start');
  const d = new Dialer({ bluetooth: bt, audio: new FakeAudio(), store: new LeadStore(':memory:'), supported: false });
  await d.start();
  assert.match(d.state().error, /Linux/);
});
