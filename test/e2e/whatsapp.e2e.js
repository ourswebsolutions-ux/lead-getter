'use strict';
// WhatsApp integration in the real Electron app: linking reaches a real QR
// code from WhatsApp's servers (nothing is scanned, so no account is
// linked), status display, the composer, and the send guards.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { _electron, chromium } = require('playwright-core');
const { LeadStore } = require('../../src/database/db');
const { unlock, activationEnv } = require('./helpers');

const root = path.join(__dirname, '..', '..');
const shots = process.env.LEAD_FINDER_SCREENSHOTS;

function seed(file) {
  const s = new LeadStore(file);
  const cat = s.ensureCategory('Real Estate');
  let i = 0;
  const add = (name, phoneRaw) => s.save({ placeKey: `0x${++i}:0x5`, mapsUrl: `https://www.google.com/maps/place/W${i}`, name, phoneRaw, address: 'Lahore, Pakistan', websiteStatus: 'no_website', categoryId: cat.id });
  add('Green Estate', '03001234567');
  add('Grey Estate', '03007654321');
  add('Failed Estate', '03009999999');
  add('Manual Estate', '03211234567');
  add('Pending Estate', '03331234567');
  s.setWhatsAppResult('+923001234567', 'available', 'baileys');
  s.setWhatsAppResult('+923007654321', 'unavailable', 'baileys');
  s.setWhatsAppResult('+923009999999', 'failed', 'baileys', 'WhatsApp did not answer in time');
  s.setWhatsAppStatus('+923211234567', 'available', 'manual'); // from the old manual flow
  s.close();
}

test('WhatsApp: real QR linking, statuses, composer and send guards', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-wa-e2e-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  seed(path.join(userData, 'leads.db'));
  const env = { ...process.env, ...activationEnv, LEAD_FINDER_USER_DATA: userData, LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch(process.env.LEAD_FINDER_EXE ? { executablePath: process.env.LEAD_FINDER_EXE, args: [], env } : { args: [root], cwd: root, env });
  t.after(async () => {
    await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const win = await app.firstWindow();
  await unlock(win);
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  await win.getByRole('heading', { name: /Today's leads/ }).waitFor();
  await win.waitForFunction(() => document.querySelectorAll('tbody tr').length === 5);
  const cell = (name) => win.locator('tbody tr', { has: win.locator('td.name', { hasText: name }) }).locator('td.phone-cell');

  // --- Statuses: only a positive automatic result is green.
  assert.equal(await cell('Green Estate').locator('.phone.wa-available').count(), 1);
  assert.equal(await cell('Green Estate').getByRole('button', { name: 'Send WhatsApp message to Green Estate' }).count(), 1);
  // Only colour signals WhatsApp: other numbers show just the number, no labels or icons.
  for (const [n, num] of [['Grey Estate', '+923007654321'], ['Failed Estate', '+923009999999'], ['Manual Estate', '+923211234567'], ['Pending Estate', '+923331234567']]) {
    assert.equal((await cell(n).innerText()).trim(), num, `${n}: number only`);
    assert.equal(await cell(n).locator('svg, button, .chip').count(), 0, `${n}: no icon or label`);
  }
  assert.equal((await cell('Green Estate').innerText()).trim(), '+923001234567', 'green number has no extra text');
  assert.equal(await cell('Green Estate').locator('svg, .chip').count(), 0, 'green number has no icon');
  for (const n of ['Grey Estate', 'Failed Estate', 'Manual Estate', 'Pending Estate']) {
    assert.equal(await cell(n).locator('.wa-available, .wa-send').count(), 0, `${n} not green`);
  }

  // --- No session secrets ever reach the renderer.
  const snap = await win.evaluate(() => window.leadFinder.whatsappState());
  assert.deepEqual(Object.keys(snap).sort(), ['account', 'error', 'progress', 'qr', 'secure', 'state']);
  assert.deepEqual(snap.progress, { total: 5, checked: 2, available: 1, failed: 1 });
  // Playwright's dev launch uses a mock keychain (--password-store=basic);
  // without a real keychain the app must refuse to store a session. (A
  // packaged build gets the real keychain even under Playwright.)
  if (snap.secure) assert.notEqual(snap.state, 'unavailable');
  else {
    assert.equal(snap.state, 'unavailable');
    assert.match(snap.error, /No secure system keychain/);
  }

  // --- Send guards in the main process.
  const leads = await win.evaluate(() => window.leadFinder.listLeads({}));
  const id = (name) => leads.find((l) => l.name === name).id;
  for (const n of ['Grey Estate', 'Failed Estate', 'Manual Estate', 'Pending Estate']) {
    const r = await win.evaluate((i) => window.leadFinder.whatsappSend(i, 'Hello'), id(n));
    assert.deepEqual(r, { ok: false, error: 'This number has not been confirmed on WhatsApp.' }, n);
  }
  assert.match((await win.evaluate((i) => window.leadFinder.whatsappSend(i, '   '), id('Green Estate'))).error, /Write a message/);
  assert.match((await win.evaluate((i) => window.leadFinder.whatsappSend(i, 'Hello'), id('Green Estate'))).error, /not connected/);

  // --- Composer opens from the green number; nothing is sent without a connection.
  await cell('Green Estate').getByRole('button', { name: 'Send WhatsApp message to Green Estate' }).click();
  const dlg = win.getByRole('dialog', { name: 'Message Green Estate' });
  await dlg.waitFor();
  assert.match(await dlg.innerText(), /\+923001234567/);
  await dlg.getByLabel('Message').fill('Hello from Lead Finder');
  assert.ok(await dlg.getByRole('button', { name: 'Send' }).isDisabled(), 'Send disabled while WhatsApp is not connected');
  assert.match(await dlg.innerText(), /WhatsApp is not connected/);
  if (shots) await win.screenshot({ path: path.join(shots, 'wa-composer.png') });
  await win.keyboard.press('Escape');
  await dlg.waitFor({ state: 'detached' });

  // --- Without a real keychain, linking is refused with an explanation.
  if (!snap.secure) {
    await win.getByRole('button', { name: 'WhatsApp unavailable' }).click();
    const panel = win.getByRole('dialog', { name: 'WhatsApp connection' });
    await panel.waitFor();
    assert.match(await panel.innerText(), /No secure system keychain/);
    assert.equal(await panel.getByRole('button', { name: 'Link WhatsApp' }).count(), 0);
    await win.keyboard.press('Escape');
  }

  assert.deepEqual(errors, []);
});

const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

// A normal launch (real OS keychain), driven over the DevTools protocol:
// WhatsApp issues a real QR code; nothing is scanned, so nothing is linked.
test('WhatsApp linking with the real keychain reaches a real QR code', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-wa-real-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  seed(path.join(userData, 'leads.db'));
  const port = await freePort();
  const env = { ...process.env, ...activationEnv, LEAD_FINDER_USER_DATA: userData, LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome') };
  delete env.ELECTRON_RUN_AS_NODE;
  const exe = process.env.LEAD_FINDER_EXE;
  const proc = exe
    ? spawn(exe, [`--remote-debugging-port=${port}`], { env, stdio: 'ignore' })
    : spawn(require('electron'), [root, `--remote-debugging-port=${port}`], { cwd: root, env, stdio: 'ignore' });
  t.after(async () => {
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1500));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  let browser;
  for (let i = 0; i < 40 && !browser; i++) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
    if (!browser) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(browser, 'connected to the app');
  let win;
  for (let i = 0; i < 40 && !win; i++) {
    win = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith('devtools'));
    if (!win) await new Promise((r) => setTimeout(r, 250));
  }
  await unlock(win);
  await win.getByRole('heading', { name: /Today's leads/ }).waitFor();
  const snap = await win.evaluate(() => window.leadFinder.whatsappState());
  assert.equal(snap.secure, true, 'real OS keychain in a normal launch');
  await win.getByRole('button', { name: /WhatsApp (off|not linked)/ }).click();
  const panel = win.getByRole('dialog', { name: 'WhatsApp connection' });
  assert.match(await panel.innerText(), /not an official WhatsApp API/);
  await panel.getByRole('button', { name: 'Link WhatsApp' }).click();
  const qr = panel.getByRole('img', { name: 'WhatsApp linking QR code' });
  await qr.waitFor({ timeout: 45_000 });
  assert.match(await qr.getAttribute('src'), /^data:image\/png;base64,/);
  assert.equal(await qr.evaluate((img) => img.naturalWidth > 100), true, 'QR image decoded');
  assert.equal((await win.evaluate(() => window.leadFinder.whatsappState())).state, 'qr');
  if (shots) await win.screenshot({ path: path.join(shots, 'wa-qr.png') });
  await panel.getByRole('button', { name: 'Cancel' }).click();
  await win.getByRole('button', { name: 'WhatsApp off' }).waitFor();
  // Nothing linked; anything stored is encrypted.
  const dir = path.join(userData, 'whatsapp-session');
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    assert.ok(!fs.readFileSync(path.join(dir, f)).toString('latin1').includes('noiseKey'), `${f} encrypted`);
  }
  await browser.close();
});
