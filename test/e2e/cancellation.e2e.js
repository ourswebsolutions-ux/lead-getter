'use strict';
// In the real app: a signed list naming this computer cancels its plan, the
// app says so, and lead collection stops. The Google Maps option is on the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { dkimSign } = require('mailauth/lib/dkim/sign');
const { unlock, activationConfig, activationEnv } = require('./helpers');
const { activationIdFor, readMachineId } = require('../../src/main/activation');
const { newKeys, processCommands } = require('../../tools/activation/cancel-lib');

const root = path.join(__dirname, '..', '..');

test('a cancellation email reaches the app: subscription cancelled, message shown, leads refused', { timeout: 180_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-cancel-e2e-'));
  const shots = process.env.LEAD_FINDER_SHOTS;
  const keys = newKeys();
  const id = activationIdFor(readMachineId());
  const at = Date.now() + 120_000; // after the trial starts in this test
  const message = Buffer.from(`From: admin@example.com\r\nSubject: Subscription Cancellation\r\nMessage-ID: <1@x>\r\n\r\nActivation ID: ${id} (stop)\r\n`);
  const dkim = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const { signatures } = await dkimSign(message, { signatureData: [{ signingDomain: 'example.com', selector: 's1', privateKey: dkim.privateKey.export({ format: 'pem', type: 'pkcs8' }) }] });
  const source = Buffer.concat([Buffer.from(signatures), message]);
  const resolver = async () => [[`v=DKIM1; k=rsa; p=${dkim.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')}`]];
  const { state } = await processCommands({ mailbox: { commands: async () => [{ source, date: new Date(at) }], known: async () => true }, state: null, adminEmail: 'admin@example.com', resolver, privateKey: keys.privateKey, now: at });
  const server = http.createServer((_q, res) => res.end(JSON.stringify(state)));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const env = {
    ...process.env,
    ...activationEnv,
    LEAD_FINDER_ACTIVATION_CONFIG: JSON.stringify({ ...activationConfig, trial: { days: 5, leads: 30 }, cancellations: { url: `http://127.0.0.1:${server.address().port}/c.json`, publicKey: keys.publicKey } }),
    LEAD_FINDER_USER_DATA: path.join(tmp, 'app'),
    LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome'),
    LEAD_FINDER_NO_UPDATES: '1',
    LEAD_FINDER_TEST_DAILY_LEADS: '{}',
    LEAD_FINDER_TEST_TRIAL_FILE: path.join(tmp, 'mark'),
  };
  fs.mkdirSync(env.LEAD_FINDER_USER_DATA);
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [root], cwd: root, env });
  t.after(async () => {
    await app.close().catch(() => {});
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const win = await app.firstWindow();
  await unlock(win, '1357', { plan: null });

  // The option: off by default, and it picks a filter that has websites to read.
  const box = win.getByRole('checkbox', { name: 'Find Emails from Websites' });
  await box.waitFor();
  assert.equal(await box.isChecked(), false);
  assert.equal(await win.locator('#site').inputValue(), 'without');
  await box.check();
  assert.equal(await win.locator('#site').inputValue(), 'all');
  if (shots) await win.screenshot({ path: path.join(shots, 'find-emails.png') });

  // The first check runs a few seconds after the start.
  await win.locator('.plan-pill', { hasText: 'Subscription cancelled' }).waitFor({ timeout: 30_000 });
  const st = await win.evaluate(() => window.leadFinder.activationStatus());
  assert.equal(st.state, 'cancelled');
  assert.ok(st.cancelledAt);
  const res = await app.evaluate(() => globalThis.__leadFinderTest.saveLead({ placeKey: '0x9:0x2', mapsUrl: 'https://www.google.com/maps/place/T9', name: 'Lead 9', phoneRaw: '03002000009', address: 'Lahore, Pakistan', websiteStatus: 'no_website' }));
  assert.deepEqual(res, { isNewLead: false, limitReached: true });
  await win.getByRole('alert').filter({ hasText: 'Your subscription has been cancelled' }).first().waitFor();
  if (shots) await win.screenshot({ path: path.join(shots, 'cancelled.png') });
});
