'use strict';
// Forgotten PIN in the real Electron app with a real SMTP exchange (local
// mail server): Forgot PIN? -> email to the administrator only -> that PIN
// unlocks and becomes the PIN; email failure is reported.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { unlock, activationEnv, activationConfig, mail } = require('./helpers');

const root = path.join(__dirname, '..', '..');
const shots = process.env.LEAD_FINDER_SCREENSHOTS;

test('Forgot PIN: the administrator gets a new PIN; entering it unlocks and it becomes the PIN', async (t) => {
  const smtp = await mail;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-pinreset-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  const env = { ...process.env, ...activationEnv, LEAD_FINDER_USER_DATA: userData, LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome'), LEAD_FINDER_NO_UPDATES: '1', LEAD_FINDER_TEST_BAILEYS: path.join(__dirname, 'fake-baileys.js') };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = async () => {
    const app = await _electron.launch({ args: [root], cwd: root, env });
    return { app, win: await app.firstWindow() };
  };
  let { app, win } = await launch();
  t.after(async () => {
    smtp.setMode('accept');
    await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  await unlock(win, '1357', { plan: null });
  await app.close();
  ({ app, win } = await launch());
  await win.getByRole('dialog', { name: 'Enter your PIN' }).waitFor();
  // An update shows on the lock screen too, above it, and can be used there.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('update:status', { state: 'available', available: '9.9.9' }));
  const banner = win.locator('.update-banner');
  await banner.waitFor();
  assert.match(await banner.textContent(), /Lead Finder 9\.9\.9 is available/);
  const onTop = await banner.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  });
  assert.equal(onTop, true, 'not hidden behind the lock screen');
  if (shots) await win.screenshot({ path: path.join(shots, 'pin-update.png') });
  await banner.getByRole('button', { name: 'Dismiss' }).click();
  // While locked, only the reset itself is reachable.
  await assert.rejects(win.evaluate(() => window.leadFinder.listLeads({})), /Locked/);

  if (shots) await win.screenshot({ path: path.join(shots, 'pin-unlock.png') });
  await win.getByRole('button', { name: 'Forgot PIN?' }).click();
  const dialog = win.getByRole('dialog', { name: 'Reset your PIN' });
  await dialog.waitFor();
  if (shots) await win.screenshot({ path: path.join(shots, 'pin-reset.png') });
  // Typing does nothing here.
  await win.keyboard.type('1357');
  assert.equal(await dialog.isVisible(), true);

  // Email failure: said, nothing waiting.
  smtp.setMode('auth-fail');
  const before = smtp.messages.length;
  await win.getByRole('button', { name: 'Send reset PIN' }).click();
  await win.waitForFunction(() => /could not be sent/.test(document.querySelector('.lock-error')?.textContent || ''));
  assert.equal(await dialog.isVisible(), true);
  smtp.setMode('accept');
  await win.getByRole('button', { name: 'Send reset PIN' }).click();
  await win.getByRole('dialog', { name: 'Enter your PIN' }).waitFor();
  await win.getByText(/A new PIN was sent to the administrator/).waitFor();
  if (shots) await win.screenshot({ path: path.join(shots, 'pin-sent.png') });
  const m = smtp.messages.at(-1);
  assert.ok(smtp.messages.length > before);
  assert.deepEqual(m.to, [activationConfig.adminEmail], 'to the administrator only');
  const pin = /New PIN: (\d{4})/.exec(m.text)[1];
  assert.match(m.text, new RegExp(`Subject: Lead Finder PIN reset ${pin} for LF-`));
  assert.match(m.text, /Activation ID: LF-/);
  assert.ok(!(await win.content()).includes(`New PIN: ${pin}`), 'the PIN is never shown in the app');

  await win.keyboard.type(pin, { delay: 30 });
  await win.getByRole('heading', { name: 'Lead Finder' }).waitFor();
  await app.close();
  // It is the PIN now, on the next start.
  ({ app, win } = await launch());
  await win.getByRole('dialog', { name: 'Enter your PIN' }).waitFor();
  await win.keyboard.type(pin, { delay: 30 });
  await win.getByRole('heading', { name: 'Lead Finder' }).waitFor();
});
