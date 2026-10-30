'use strict';

// Bluetooth Hands-Free Profile (HFP 1.7), Hands-Free side: the AT commands
// a car kit sends a phone. bt-helper.py carries the lines over the phone's
// RFCOMM channel; this module sets up the Service Level Connection and
// turns the phone's replies and unsolicited results into events.
//
// Events: 'ready' (the connection is set up: phone features, indicators,
// operator, own number), 'indicator' ({ name, value, indicators }),
// 'clip' ({ number }), 'ring', 'waiting' ({ number }), 'result' (BUSY, NO
// CARRIER, NO ANSWER), 'volume' ({ kind, level }).
//
// There is no SIM choice in HFP: the phone dials on its default calling SIM.

const { EventEmitter } = require('node:events');

// This unit's features (AT+BRSF): three-way calling, caller ID, remote volume,
// enhanced call status, enhanced call control. No codec negotiation: CVSD.
const HF_FEATURES = (1 << 1) | (1 << 2) | (1 << 4) | (1 << 5) | (1 << 6);
const AG_FEATURES = ['three-way calling', 'echo cancelling and noise reduction', 'voice recognition', 'in-band ring tone', 'voice tag', 'reject a call', 'enhanced call status', 'enhanced call control', 'extended error codes', 'codec negotiation', 'HF indicators', 'eSCO S4'];
const REJECT_CALL = 1 << 5;
const ENHANCED_STATUS = 1 << 6;
const THREE_WAY = 1;

// +CME ERROR codes phones use (3GPP TS 27.007).
const CME = {
  0: 'The phone failed',
  3: 'The phone does not allow this',
  4: 'The phone does not support this',
  10: 'No SIM in the phone',
  11: 'The SIM needs its PIN',
  13: 'SIM failure',
  16: 'Wrong password',
  30: 'No network service',
  31: 'The network timed out',
  32: 'Emergency calls only',
};

const unquote = (s) => String(s ?? '').trim().replace(/^"|"$/g, '');

function cindRanges(line) {
  // +CIND: ("call",(0,1)),("callsetup",(0-3)),...
  return [...line.matchAll(/\("([^"]+)",\(([^)]*)\)\)/g)].map((m) => m[1].toLowerCase());
}

// +CLCC: <idx>,<dir>,<stat>,<mode>,<mpty>[,<number>,<type>]
function parseClcc(line) {
  const parts = line.replace(/^\+CLCC:\s*/, '').split(',');
  const stat = ['active', 'held', 'dialing', 'alerting', 'incoming', 'waiting'][Number(parts[2])] || 'unknown';
  return { index: Number(parts[0]), direction: parts[1]?.trim() === '1' ? 'incoming' : 'outgoing', state: stat, voice: parts[3]?.trim() === '0', number: unquote(parts[5]) || null };
}

class Hfp extends EventEmitter {
  constructor({ send, timers = { setTimeout, clearTimeout } }) {
    super();
    this.sendLine = send;
    this.timers = timers;
    this.queue = [];
    this.current = null;
    this.names = [];
    this.indicators = {};
    this.agFeatures = 0;
    this.ready = false;
  }

  supports(bit) {
    return Boolean(this.agFeatures & bit);
  }

  features() {
    return AG_FEATURES.filter((_, i) => this.agFeatures & (1 << i));
  }

  // One AT command at a time; resolves { ok, lines, error }.
  cmd(at, { timeout = 10_000 } = {}) {
    return new Promise((resolve) => {
      this.queue.push({ at, timeout, resolve, lines: [] });
      this.next();
    });
  }

  next() {
    if (this.current || !this.queue.length) return;
    const c = this.queue.shift();
    this.current = c;
    c.timer = this.timers.setTimeout(() => this.finish({ ok: false, error: 'The phone did not answer.' }), c.timeout);
    Promise.resolve(this.sendLine(c.at)).catch((err) => this.finish({ ok: false, error: err.message }));
  }

  finish(r) {
    const c = this.current;
    if (!c) return;
    this.current = null;
    this.timers.clearTimeout(c.timer);
    c.resolve({ ...r, lines: c.lines });
    this.next();
  }

  // Ends every waiting command (the connection dropped).
  reset(error = 'The phone disconnected.') {
    if (this.current) this.finish({ ok: false, error });
    for (const c of this.queue.splice(0)) c.resolve({ ok: false, error, lines: [] });
    this.ready = false;
  }

  onLine(raw) {
    const line = String(raw).trim();
    if (!line) return;
    if (line === 'OK') return this.finish({ ok: true });
    if (line === 'ERROR') return this.finish({ ok: false, error: 'The phone refused.' });
    const cme = line.match(/^\+CME ERROR:\s*(\d+)/);
    if (cme) return this.finish({ ok: false, error: CME[cme[1]] || `The phone refused (error ${cme[1]}).`, code: Number(cme[1]) });
    if (/^\+CIEV:/.test(line)) {
      const [i, v] = line.replace(/^\+CIEV:\s*/, '').split(',').map((x) => Number(x));
      const name = this.names[i - 1];
      if (name) {
        this.indicators[name] = v;
        this.emit('indicator', { name, value: v, indicators: { ...this.indicators } });
      }
      return;
    }
    if (line === 'RING') return this.emit('ring');
    if (/^\+CLIP:/.test(line)) return this.emit('clip', { number: unquote(line.replace(/^\+CLIP:\s*/, '').split(',')[0]) || null });
    if (/^\+CCWA:/.test(line)) return this.emit('waiting', { number: unquote(line.replace(/^\+CCWA:\s*/, '').split(',')[0]) || null });
    if (/^(BUSY|NO CARRIER|NO ANSWER|NO DIALTONE)$/.test(line)) {
      this.emit('result', line);
      if (this.current && /^ATD/.test(this.current.at)) this.finish({ ok: false, error: line === 'BUSY' ? 'The number is busy.' : 'The call could not be connected.' });
      return;
    }
    const vol = line.match(/^\+VG([SM])[:=]\s*(\d+)/);
    if (vol) return this.emit('volume', { kind: vol[1] === 'S' ? 'speaker' : 'microphone', level: Number(vol[2]) });
    if (this.current) this.current.lines.push(line);
  }

  // The Service Level Connection, then caller ID, call waiting, errors,
  // operator and own number.
  async start() {
    const brsf = await this.cmd(`AT+BRSF=${HF_FEATURES}`);
    if (!brsf.ok) throw new Error(`The phone refused Hands-Free (${brsf.error}).`);
    this.agFeatures = Number((brsf.lines.find((l) => l.startsWith('+BRSF')) || '').split(':')[1]) || 0;
    const test = await this.cmd('AT+CIND=?');
    if (!test.ok) throw new Error('The phone did not list its call indicators.');
    this.names = cindRanges(test.lines.find((l) => l.startsWith('+CIND')) || '');
    const read = await this.cmd('AT+CIND?');
    const values = (read.lines.find((l) => l.startsWith('+CIND')) || '').replace(/^\+CIND:\s*/, '').split(',').map(Number);
    this.names.forEach((n, i) => (this.indicators[n] = values[i] ?? 0));
    const cmer = await this.cmd('AT+CMER=3,0,0,1');
    if (!cmer.ok) throw new Error('The phone did not turn on call status reports.');
    if (this.supports(THREE_WAY)) await this.cmd('AT+CHLD=?');
    await this.cmd('AT+CLIP=1');
    await this.cmd('AT+CCWA=1');
    if (this.supports(1 << 8)) await this.cmd('AT+CMEE=1');
    await this.cmd('AT+COPS=3,0');
    const { operator, numbers } = await this.sim();
    this.ready = true;
    const info = { features: this.features(), canReject: this.supports(REJECT_CALL), callList: this.supports(ENHANCED_STATUS), indicators: { ...this.indicators }, operator, number: numbers[0] || null, numbers };
    this.emit('ready', info);
    return info;
  }

  // The SIM the phone calls with, as HFP shows it: the network operator of
  // its default calling SIM (+COPS) and the subscriber numbers it lists (+CNUM).
  async sim() {
    const cops = await this.cmd('AT+COPS?');
    const operator = unquote((cops.lines.find((l) => l.startsWith('+COPS')) || '').split(',')[2]) || null;
    const cnum = await this.cmd('AT+CNUM');
    const numbers = cnum.lines.filter((l) => l.startsWith('+CNUM')).map((l) => unquote(l.split(',')[1])).filter(Boolean);
    return { operator, numbers };
  }

  dial(number) {
    return this.cmd(`ATD${number};`, { timeout: 30_000 });
  }

  answer() {
    return this.cmd('ATA');
  }

  hangup() {
    return this.cmd('AT+CHUP');
  }

  dtmf(key) {
    return this.cmd(`AT+VTS=${key}`);
  }

  async calls() {
    if (!this.supports(ENHANCED_STATUS)) return [];
    const r = await this.cmd('AT+CLCC');
    return r.ok ? r.lines.filter((l) => l.startsWith('+CLCC')).map(parseClcc) : [];
  }
}

module.exports = { Hfp, HF_FEATURES, AG_FEATURES, parseClcc, cindRanges };
