'use strict';
// A bridge in the real app: Lead Finder without Bluetooth of its own finds a
// bridge on the network (no address typed), pairs it with the code shown on
// both sides, shows its Bluetooth, phone and connection, calls through it
// with the call's voice both ways (played and recorded by the window: fake
// media devices here), and reconnects by itself when the bridge comes back.
// The bridge runs the scripted phone (test/fixtures/bridge-for-test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { _electron } = require('playwright-core');
const { unlock, activationEnv } = require('./helpers');

const root = path.join(__dirname, '..', '..');

function startBridge(dir, udpPort) {
  const child = spawn(process.execPath, [path.join(root, 'test', 'fixtures', 'bridge-for-test.js'), dir, String(udpPort)], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.log = '';
  child.stdout.on('data', (d) => (child.log += d));
  child.stderr.on('data', (d) => (child.log += d));
  return child;
}

test('Bridge: found on the network, paired, a call with two-way audio, reconnected after it restarts', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-bridge-e2e-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  const udpPort = 41000 + (process.pid % 15000);
  let bridge = startBridge(path.join(tmp, 'bridge'), udpPort);
  const env = { ...process.env, ...activationEnv, LEAD_FINDER_USER_DATA: userData, LEAD_FINDER_NO_UPDATES: '1', LEAD_FINDER_NO_LOCAL_BT: '1', LEAD_FINDER_DISCOVERY_PORT: String(udpPort) };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [root, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], cwd: root, env });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  t.after(async () => {
    await app.close().catch(() => {});
    bridge.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  await unlock(win);

  await win.getByRole('button', { name: 'Dialer' }).click();
  const source = win.getByRole('region', { name: 'Bluetooth source' });
  assert.equal(await source.getByRole('switch', { name: 'Automatic device discovery' }).getAttribute('aria-checked'), 'true');
  // Found by itself; paired once with the same code on both sides.
  await source.getByRole('button', { name: 'Pair Test bridge' }).click({ timeout: 15_000 });
  const pair = win.getByRole('dialog', { name: 'Pair bridge' });
  const code = (await pair.locator('.dl-code').innerText()).trim();
  assert.match(code, /^\d{6}$/);
  await pair.getByRole('button', { name: 'Codes match' }).click();
  await source.getByText('Linux laptop (bridge)').waitFor({ timeout: 15_000 });
  assert.match(bridge.log, new RegExp(`Code: ${code}`)); // the bridge showed the same code
  assert.match(await source.innerText(), /On · hands-free ready/);
  assert.match(await source.innerText(), /No phone connected/);
  assert.match(await source.innerText(), /Connection/);

  // The phone, through the bridge's Bluetooth.
  const phone = win.getByRole('region', { name: 'Phone' });
  await phone.getByRole('button', { name: 'Find phone' }).click();
  await phone.getByRole('button', { name: 'Connect Test Phone' }).click();
  await win.getByRole('dialog', { name: 'Pair phone' }).getByRole('button', { name: 'Codes match' }).click();
  await phone.locator('.dl-pill').filter({ hasText: 'Connected' }).waitFor();
  await source.getByText('Test Phone connected').waitFor({ timeout: 10_000 });

  // A call: the voice comes here and the microphone goes to the bridge.
  const dialPad = win.getByRole('region', { name: 'Dial pad' });
  await dialPad.getByLabel('Phone number').fill('+92 300 7654321');
  await win.getByRole('button', { name: 'Call', exact: true }).click();
  await dialPad.locator('.dl-state').filter({ hasText: 'Connected' }).waitFor();
  await source.getByText(/Two-way audio verified/).waitFor({ timeout: 15_000 });
  await dialPad.getByRole('button', { name: 'End call' }).click();
  await dialPad.locator('.dl-state').filter({ hasText: /Answered/ }).waitFor();

  // The bridge goes away: Lead Finder says so; it comes back: reconnected without pairing again.
  bridge.kill();
  await source.getByText(/Searching the network|Reconnecting/).waitFor({ timeout: 15_000 });
  bridge = startBridge(path.join(tmp, 'bridge'), udpPort);
  await source.getByText('Linux laptop (bridge)').waitFor({ timeout: 20_000 });
  assert.equal(await win.getByRole('dialog', { name: 'Pair bridge' }).count(), 0);
  assert.deepEqual(errors, []);
});
