'use strict';
// The Dialer against a real phone over native Bluetooth Hands-Free (nothing
// installed on the phone), real BlueZ and real audio: the same modules the
// app uses, without the window.
//
//   node test/integration/dialer-live.js <phone address> [--call <number>] [--answer] [--seconds <s>]
//
// Without --call it connects, prints what the phone reports (operator, own
// number, signal, battery, features) and waits for incoming calls (--answer
// answers them from here). --call places ONE call to that number and ends
// it after --seconds (default: when it ends on either side). Nothing is
// dialled without --call. Ctrl+C ends a call and exits. Call history goes to
// a test database (~/.cache/lead-finder-dialer-live), not the app's.
// Close the Lead Finder window first: only one program can be the Hands-Free unit.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Bluetooth } = require('../../src/dialer/bluetooth');
const { CallAudio } = require('../../src/dialer/audio');
const { Dialer } = require('../../src/dialer/dialer');
const handover = require('../../src/dialer/pipewire-hfp');
const { LeadStore } = require('../../src/database/db');

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const address = (args.find((a) => /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i.test(a)) || '').toUpperCase();
const callNumber = opt('--call');
const answer = args.includes('--answer');
const seconds = Number(opt('--seconds') || 0);
if (!address) {
  console.error('usage: node test/integration/dialer-live.js <phone address> [--call <number>] [--answer] [--seconds <s>]');
  process.exit(2);
}

const dir = path.join(os.homedir(), '.cache', 'lead-finder-dialer-live');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const store = new LeadStore(path.join(dir, 'calls.db'));
const audio = new CallAudio();
const bluetooth = new Bluetooth();
const dialer = new Dialer({ bluetooth, audio, store, handover });

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);
let last = '';
let shown = false;
let endTimer = null;
const lines = [];
bluetooth.on('data', (m) => lines.push(m.line));
bluetooth.on('sco_up', () => log('VOICE LINK UP (call audio on this computer)'));
bluetooth.on('sco_down', (m) => log(`VOICE LINK DOWN (${m.reason})`));

dialer.on('state', (s) => {
  const c = s.call;
  const call = c ? `${c.direction} ${c.state}${c.status ? `/${c.status}` : ''} ${c.number || ''} audio=${c.audio?.state}${c.audio?.error ? ` (${c.audio.error})` : ''}${c.muted ? ' muted' : ''}` : 'no call';
  const line = `role=${s.hfRole} link=${s.link}${s.linkError ? ` (${s.linkError})` : ''}${s.pairing ? ` PAIRING ${s.pairing.passkey}` : ''} | ${call}`;
  if (line !== last) log(line);
  last = line;
  if (s.link === 'ready' && !shown) {
    shown = true;
    log('PHONE', JSON.stringify(s.phone));
    if (callNumber) {
      log(`Calling ${callNumber}…`);
      dialer.call(callNumber).then((r) => log('dial result', JSON.stringify(r)));
    } else log('Waiting for incoming calls (Ctrl+C to stop).');
  }
  if (c?.state === 'active' && seconds && !endTimer) {
    endTimer = setTimeout(() => {
      log(`Ending the call after ${seconds}s, from the computer…`);
      dialer.hangup().then((r) => log('hangup result', JSON.stringify(r)));
    }, seconds * 1000);
  }
});
dialer.on('incoming', (c) => {
  log(`INCOMING CALL from ${c.number || 'hidden number'}${c.business ? ` (${c.business})` : ''}`);
  if (answer) setTimeout(() => dialer.answer().then((r) => log('answer result', JSON.stringify(r))), 2000);
});
dialer.on('ended', (c) => {
  log('ENDED', JSON.stringify({ number: c.number, direction: c.direction, status: c.status, talkSeconds: c.duration, error: c.error }));
  log('HISTORY', JSON.stringify(store.listCalls({ limit: 2 })));
  log('AT LINES FROM THE PHONE', JSON.stringify(lines.slice(-25)));
  clearTimeout(endTimer);
  endTimer = null;
  if (callNumber) setTimeout(finish, 500);
});

async function finish() {
  if (dialer.s.call && dialer.s.call.state !== 'ended') await dialer.hangup().catch(() => {});
  dialer.stop();
  store.close();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', finish);

(async () => {
  await dialer.start();
  await new Promise((r) => setTimeout(r, 1500));
  if (dialer.s.hfRole === 'pipewire') {
    log('PipeWire has the Hands-Free role: handing it over (WirePlumber setting)…');
    log('take over', JSON.stringify(await dialer.takeHandsFree()));
  }
  const d = dialer.s.devices.find((x) => x.address === address);
  log('device', JSON.stringify(d ? { name: d.name, paired: d.paired, connected: d.connected } : 'not known'));
  log('connect', JSON.stringify(await dialer.connect(address)));
})().catch((err) => {
  console.error('[failed]', err);
  process.exit(1);
});
