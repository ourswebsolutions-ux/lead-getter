'use strict';
// The Dialer in the real app, with a scripted Hands-Free phone standing in
// for the Bluetooth helper (test/fixtures/fake-bt-helper.py; its numbers
// ending in 0 ring without being answered): pair, the phone and the SIM it
// calls on, a call from the keypad (ringing, answered, timer, keypad tones,
// audio moved, mute, end), Recent calls (only the last two), Call Seen in
// the Leads table (apart from WhatsApp), Do not call, and the Auto Dialer:
// not answered -> next lead, landline skipped, answered -> stops and waits,
// ended by the user -> 1 minute wait, switched off -> no further call.
// Real Bluetooth, SIM and audio: test/integration/dialer-live.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { unlock, activationEnv } = require('./helpers');

const root = path.join(__dirname, '..', '..');

const LEADS = [
  ['Acme Plumbing', '+923001234567'], // answers
  ['Bright Dental', '+923214455660'], // not answered
  ['Corner Shop', '+924235761234'], // a landline: skipped by the Auto Dialer
  ['Echo Traders', '+923005556667'], // answers
  ['Gamma Foods', '+923008889990'], // rings; ended by the user
  ['Hotel Lahore', '+923009990001'], // never called (the Auto Dialer is switched off first)
];

test('Dialer: SIM, call, Recent calls, Call Seen, Do not call, Auto Dialer', async (t) => {
  const { LeadStore } = require('../../src/database/db');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-dialer-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  const seed = new LeadStore(path.join(userData, 'leads.db'));
  LEADS.forEach(([name, phone], i) => seed.save({ placeKey: `p${i}`, mapsUrl: `https://www.google.com/maps/place/${i}`, name, keyword: 'shops', phone, websiteStatus: 'no_website', discoveredAt: new Date(Date.now() - (LEADS.length - i) * 60_000).toISOString() }));
  seed.close();
  const env = { ...process.env, ...activationEnv, LEAD_FINDER_USER_DATA: userData, LEAD_FINDER_NO_UPDATES: '1', LEAD_FINDER_BT_HELPER: path.join(root, 'test', 'fixtures', 'fake-bt-helper.py') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [root], cwd: root, env });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  win.on('dialog', (d) => d.accept());
  t.after(async () => {
    await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  await unlock(win);
  const lead = async (name) => (await win.evaluate(() => window.leadFinder.listLeads({ category: 'all' }))).find((l) => l.name === name);

  await win.getByRole('button', { name: 'Dialer' }).click();
  const phone = win.getByRole('region', { name: 'Phone' });
  await phone.getByText('No phone connected').waitFor();
  assert.equal(await win.getByRole('button', { name: 'Call', exact: true }).isDisabled(), true);
  // The Auto Dialer cannot start without the phone.
  assert.equal(await win.getByRole('switch', { name: 'Auto Dialer' }).isDisabled(), true);

  // Find and pair (the passkey is confirmed here and on the phone); Hands-Free connects.
  await phone.getByRole('button', { name: 'Find phone' }).click();
  await phone.getByRole('button', { name: 'Connect Test Phone' }).click();
  const pair = win.getByRole('dialog', { name: 'Pair phone' });
  await pair.getByText('123456').waitFor();
  await pair.getByRole('button', { name: 'Codes match' }).click();
  await phone.locator('.dl-pill').filter({ hasText: 'Connected' }).waitFor();
  // The SIM the phone calls on, as Hands-Free reports it.
  const sim = phone.getByLabel('SIM for calls');
  assert.match(await sim.innerText(), /calls go out on\s+Jazz/i);
  assert.match(await sim.innerText(), /\+923270583075/);
  assert.match(await sim.innerText(), /default SIM for calls/);
  await sim.getByRole('button', { name: 'Check the SIM again' }).click();
  assert.match(await phone.innerText(), /60%/);

  // A call from the keypad.
  const pad = win.getByRole('group', { name: 'Keypad' });
  for (const k of '0300') await pad.getByRole('button', { name: k === '0' ? /^0/ : k, exact: k !== '0' }).click();
  const dialPad = win.getByRole('region', { name: 'Dial pad' });
  assert.equal(await dialPad.getByLabel('Phone number').inputValue(), '0300');
  await dialPad.getByLabel('Phone number').fill('+92 300 7654321');
  await win.getByRole('button', { name: 'Call', exact: true }).click();
  await dialPad.locator('.dl-state').filter({ hasText: 'Connected' }).waitFor(); // answered at the other end
  await dialPad.locator('.dl-timer').waitFor();
  assert.match(await dialPad.innerText(), /Jazz/); // the SIM in use
  await dialPad.getByRole('button', { name: 'Keypad' }).click();
  await win.getByRole('group', { name: 'Keypad' }).getByRole('button', { name: '5', exact: true }).click();
  await win.getByLabel('Tones sent').filter({ hasText: '5' }).waitFor();
  await dialPad.getByRole('button', { name: 'Move the call audio to the phone' }).click();
  await dialPad.getByRole('button', { name: 'Move the call audio to this computer' }).waitFor();
  assert.equal(await dialPad.getByRole('button', { name: 'Mute' }).isDisabled(), true);
  await dialPad.getByRole('button', { name: 'Move the call audio to this computer' }).click();
  await dialPad.getByRole('button', { name: 'Mute' }).click();
  await dialPad.getByRole('button', { name: 'Unmute' }).waitFor();
  await dialPad.getByRole('button', { name: 'End call' }).click();
  await dialPad.locator('.dl-state').filter({ hasText: /Answered/ }).waitFor();

  // One click on a lead's Call button: the Dialer opens with the lead and calls; the lead becomes Call Seen.
  await win.getByRole('button', { name: 'Leads', exact: true }).click();
  const acmeRow = win.locator('tbody tr').filter({ hasText: 'Acme Plumbing' });
  await acmeRow.getByRole('button', { name: /Call Unseen: Acme Plumbing/ }).waitFor();
  await acmeRow.getByRole('button', { name: 'Call Acme Plumbing' }).click();
  await dialPad.locator('.dl-state').filter({ hasText: 'Connected' }).waitFor();
  assert.match(await dialPad.innerText(), /Acme Plumbing/);
  await dialPad.getByRole('button', { name: 'End call' }).click();
  const acme = await lead('Acme Plumbing');
  assert.equal(acme.callStatus, 'seen');
  assert.equal(acme.campaign, 'unseen'); // the WhatsApp status is separate and untouched
  assert.equal(acme.phone, '+923001234567');

  // Recent calls: the last two only.
  const recent = win.getByRole('region', { name: 'Recent calls' });
  await recent.locator('li').filter({ hasText: 'Acme Plumbing' }).waitFor();
  assert.equal(await recent.locator('li').count(), 2);
  assert.match(await recent.innerText(), /Outgoing/);
  assert.match(await recent.innerText(), /Jazz/);
  assert.match(await recent.innerText(), /Answered/);

  // Leads table: Call Seen shows; the filter; Do not call.
  await win.getByRole('button', { name: 'Leads', exact: true }).click();
  await acmeRow.getByRole('button', { name: /Call Seen: Acme Plumbing/ }).waitFor();
  await win.getByLabel('Show call status').selectOption('seen');
  await win.locator('tbody tr').filter({ hasText: 'Bright Dental' }).waitFor({ state: 'detached' });
  assert.equal(await win.locator('tbody tr').count(), 1);
  await win.getByLabel('Show call status').selectOption('all');
  const hotelRow = win.locator('tbody tr').filter({ hasText: 'Hotel Lahore' });
  await hotelRow.getByRole('button', { name: /Call Unseen: Hotel Lahore/ }).click(); // confirmed in the dialog
  await hotelRow.getByRole('button', { name: /Do not call: Hotel Lahore/ }).waitFor();
  await hotelRow.getByRole('button', { name: /Do not call: Hotel Lahore/ }).click(); // allowed again
  await hotelRow.getByRole('button', { name: /Call Unseen: Hotel Lahore/ }).waitFor();

  // Auto Dialer (calling hours off for the test; the shortest gap).
  await win.getByRole('button', { name: 'Dialer' }).click();
  await win.evaluate(() => window.leadFinder.autoDialSettings({ hours: { on: false }, gapSeconds: 5 }));
  const auto = win.getByRole('region', { name: 'Auto Dialer' });
  await auto.getByText(/4 leads ready/).waitFor(); // Bright, Echo, Gamma, Hotel (Acme called, Corner is a landline)
  await auto.getByRole('switch', { name: 'Auto Dialer' }).click();
  // Bright Dental: not answered -> the next lead after the gap (Corner Shop's landline is skipped).
  await auto.getByText('Bright Dental').first().waitFor();
  await auto.getByText(/Next call in/).waitFor({ timeout: 20_000 });
  await auto.locator('.dl-auto-log').getByText('Bright Dental').waitFor();
  // Echo Traders answers: dialling stops; after the call it waits for the user.
  await dialPad.getByText('Echo Traders').waitFor({ timeout: 20_000 });
  await dialPad.locator('.dl-state').filter({ hasText: 'Connected' }).waitFor();
  assert.match(await auto.innerText(), /Answered/);
  await dialPad.getByRole('button', { name: 'End call' }).click();
  await auto.getByText('The last call was answered: continue when you are ready').waitFor();
  await new Promise((r) => setTimeout(r, 6000)); // it really waits: no call after the gap
  assert.equal((await win.evaluate(() => window.leadFinder.dialerHistory({ limit: 1 })))[0].business, 'Echo Traders');
  assert.equal((await lead('Gamma Foods')).callStatus, 'unseen');
  // Continue: Gamma Foods rings; the user ends it -> the next call waits 1 minute.
  await auto.getByRole('button', { name: 'Continue' }).click();
  await dialPad.getByText('Gamma Foods').waitFor({ timeout: 20_000 });
  await dialPad.locator('.dl-state').filter({ hasText: 'Ringing' }).waitFor();
  await dialPad.getByRole('button', { name: 'End call' }).click();
  await auto.getByText(/Next call in (59|60)s/).waitFor();
  // Switched off while waiting: no further call.
  await auto.getByRole('switch', { name: 'Auto Dialer' }).click();
  await auto.getByText('Off', { exact: true }).waitFor();
  const st = await win.evaluate(() => window.leadFinder.autoDialState());
  assert.equal(st.status, 'off');
  assert.equal(st.nextAt, null);
  for (const [name, want] of [['Bright Dental', 'seen'], ['Corner Shop', 'unseen'], ['Echo Traders', 'seen'], ['Gamma Foods', 'seen'], ['Hotel Lahore', 'unseen']]) assert.equal((await lead(name)).callStatus, want, name);
  const calls = await win.evaluate(() => window.leadFinder.dialerHistory({ limit: 20 }));
  assert.deepEqual(calls.slice(0, 3).map((c) => [c.business, c.status]), [['Gamma Foods', 'cancelled'], ['Echo Traders', 'answered'], ['Bright Dental', 'no_answer']]);
  assert.equal(await recent.locator('li').count(), 2);
  assert.deepEqual(errors, []);
});
