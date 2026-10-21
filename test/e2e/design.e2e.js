'use strict';
// Phone display, WhatsApp indicator, themes, motion and window sizes in the
// real Electron UI (temporary data; Chrome not involved).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { LeadStore } = require('../../src/database/db');

const root = path.join(__dirname, '..', '..');
const shots = process.env.LEAD_FINDER_SCREENSHOTS;

function seed(file) {
  const s = new LeadStore(file);
  const cat = s.ensureCategory('Real Estate');
  let i = 0;
  const add = (name, phoneRaw, address) =>
    s.save({ placeKey: `0x${++i}:0x7`, mapsUrl: `https://www.google.com/maps/place/D${i}`, name, phoneRaw, address, websiteStatus: i === 2 ? 'social_only' : 'no_website', websiteDetail: i === 2 ? 'facebook.com/abc' : null, categoryId: cat.id });
  add('Al Noor Estate', '0300 1234567', '12 Main Blvd, Gulberg III, Lahore, 54000, Pakistan');
  add('Vehari Landline Co', '0673361621', 'Club Rd, Vehari, Pakistan');
  add('Manhattan Realty', '(212) 555-0123', '350 5th Ave, New York, NY 10118, United States');
  add('No Country Given', '03001234567', 'Gulberg, Lahore');
  add('Broken Number', '0300', 'Model Town, Lahore, Pakistan');
  add('No Phone Listed', '', 'DHA, Lahore, Pakistan');
  s.close();
}

const row = (win, name) => win.locator('tbody tr', { has: win.locator('td.name', { hasText: name }) });

test('phones, WhatsApp indicator, themes, motion and window sizes', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-design-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  seed(path.join(userData, 'leads.db'));
  const env = { ...process.env, LEAD_FINDER_USER_DATA: userData, LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch(process.env.LEAD_FINDER_EXE ? { executablePath: process.env.LEAD_FINDER_EXE, args: [], env } : { args: [root], cwd: root, env });
  t.after(async () => {
    await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  await win.getByRole('heading', { name: /Today's leads/ }).waitFor();
  await win.waitForFunction(() => document.querySelectorAll('tbody tr').length === 6);

  // --- International phone display
  const phoneText = async (name) => (await row(win, name).locator('td.phone-cell').innerText()).replace(/\s+/g, ' ').trim();
  assert.match(await phoneText('Al Noor Estate'), /^\+923001234567/);
  assert.match(await phoneText('Vehari Landline Co'), /^\+92673361621/);
  assert.match(await phoneText('Manhattan Realty'), /^\+12125550123/, 'US keeps +1');
  assert.match(await phoneText('No Country Given'), /^03001234567 Unverified$/);
  assert.match(await phoneText('Broken Number'), /^0300 Invalid$/);
  assert.equal(await phoneText('No Phone Listed'), 'Not listed');

  // --- WhatsApp: green only for a positive automatic result.
  const phone = row(win, 'Al Noor Estate').locator('.phone');
  const color = () => phone.evaluate((el) => getComputedStyle(el).color);
  const normal = await row(win, 'Manhattan Realty').locator('.phone').evaluate((el) => getComputedStyle(el).color);
  assert.equal(await color(), normal, 'well-formed number is not green');
  await app.evaluate(async () => {}, null);
  // Deliver an automatic check result the way the background checker does.
  const db = new LeadStore(path.join(userData, 'leads.db'));
  db.setWhatsAppResult('+923001234567', 'available', 'baileys');
  const updated = db.listLeads({}).filter((l) => l.phone === '+923001234567');
  db.close();
  await app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0].webContents.send('leads:whatsapp', payload), { phone: '+923001234567', leads: updated });
  await win.getByRole('button', { name: 'Send WhatsApp message to Al Noor Estate' }).waitFor();
  await win.waitForTimeout(600); // colour transition
  const green = await row(win, 'Al Noor Estate').locator('.phone').evaluate((el) => getComputedStyle(el).color);
  assert.notEqual(green, normal, 'available is green');
  const [r, g, b] = green.match(/\d+/g).map(Number);
  assert.ok(g > r && g > b, `green tone (${green})`);
  // Invalid/unverified numbers have no WhatsApp action at all.
  assert.equal(await row(win, 'No Country Given').locator('.wa-send').count(), 0);
  assert.equal(await row(win, 'Broken Number').locator('.wa-send').count(), 0);

  // Export carries the normalised phone, its status and WhatsApp result.
  const out = path.join(tmp, 'design.csv');
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, out);
  await win.getByRole('button', { name: /^Export CSV/ }).click();
  await win.locator('.notice.ok').first().waitFor();
  const csv = fs.readFileSync(out, 'utf8');
  assert.match(csv, /Al Noor Estate,\+923001234567,Valid,.*,Available,Real Estate,/);
  assert.match(csv, /Manhattan Realty,\+12125550123,Valid,.*,Not checked,/);
  assert.match(csv, /No Country Given,03001234567,Unverified,/);
  assert.match(csv, /Broken Number,,Invalid \(original: 0300\),/);

  // --- Window sizes: no page-level horizontal overflow, controls reachable.
  const sizes = [
    [1024, 680],
    [1280, 800],
    [1600, 900],
    [1920, 1080],
  ];
  for (const [w, h] of sizes) {
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h]);
    await win.waitForFunction(([w]) => window.innerWidth === w, [w]);
    const m = await win.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      startVisible: (() => {
        const r = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Start Search')).getBoundingClientRect();
        return r.right <= innerWidth && r.bottom <= innerHeight;
      })(),
      tableHeight: document.querySelector('.table-wrap').getBoundingClientRect().height,
    }));
    assert.equal(m.overflow, 0, `no horizontal page scroll at ${w}x${h}`);
    assert.ok(m.startVisible, `Start Search visible at ${w}x${h}`);
    assert.ok(m.tableHeight > 150, `table has room at ${w}x${h} (${m.tableHeight}px)`);
    if (shots) await win.screenshot({ path: path.join(shots, `ui-${w}x${h}.png`) });
  }

  // --- Dark theme follows the system.
  const bg = () => win.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const light = await bg();
  await win.emulateMedia({ colorScheme: 'dark' });
  await win.waitForTimeout(400); // let colour transitions finish
  const dark = await bg();
  assert.notEqual(light, dark);
  assert.ok(dark.match(/\d+/g).slice(0, 3).every((v) => Number(v) < 40), `dark background (${dark})`);
  assert.notEqual(await color(), normal);
  if (shots) await win.screenshot({ path: path.join(shots, 'ui-dark.png') });
  await win.emulateMedia({ colorScheme: 'light' });

  // --- Reduced motion turns animations off.
  await win.emulateMedia({ reducedMotion: 'reduce' });
  const dur = await win.evaluate(() => getComputedStyle(document.querySelector('.view')).animationDuration);
  assert.equal(dur, '0.001s');
  await win.emulateMedia({ reducedMotion: 'no-preference' });

  // --- Live updates stay fast: 250 leads streamed in like a search does.
  await win.getByRole('tab', { name: 'Today' }).click();
  const timing = await app.evaluate(async ({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    const today = (() => {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    })();
    const t0 = Date.now();
    for (let i = 0; i < 250; i++) {
      wc.send('leads:added', {
        id: 10_000 + i, placeKey: `live-${i}`, name: `Live Lead ${i}`, phone: '+923001234567', phoneRaw: '03001234567', phoneStatus: 'valid',
        whatsapp: 'not_checked', address: 'Lahore, Pakistan', mapsUrl: 'https://www.google.com/maps/place/x', websiteStatus: 'No website found',
        categoryId: null, category: '', discoveredAt: new Date().toISOString(), discoveredDate: today,
      });
    }
    return Date.now() - t0;
  });
  const frame = await win.evaluate(
    () =>
      new Promise((resolve) => {
        const start = performance.now();
        let last = start;
        let worst = 0;
        const tick = (now) => {
          worst = Math.max(worst, now - last);
          last = now;
          if (document.querySelectorAll('tbody tr').length >= 256) resolve({ worst, total: now - start });
          else if (now - start > 5000) resolve({ worst, total: now - start, timeout: true });
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  assert.ok(!frame.timeout, 'all live leads rendered');
  assert.ok(frame.total < 2000, `250 live leads rendered in ${Math.round(frame.total)}ms`);
  assert.ok(frame.worst < 250, `longest frame ${Math.round(frame.worst)}ms`);
  console.log(`# live render: send ${timing}ms, rendered in ${Math.round(frame.total)}ms, worst frame ${Math.round(frame.worst)}ms`);

  assert.deepEqual(errors, []);
});
