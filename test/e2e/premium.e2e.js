'use strict';
// Themes, agent card, completion card, category management and the ambient
// background in the real Electron UI. Search status/summaries are delivered
// over the app's own IPC channels to exercise the UI states; the real search
// pipeline is covered by the session tests and the real-Chrome runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { LeadStore } = require('../../src/database/db');
const { unlock } = require('./helpers');

const root = path.join(__dirname, '..', '..');
const shots = process.env.LEAD_FINDER_SCREENSHOTS;

function seed(file) {
  const s = new LeadStore(file);
  const re = s.ensureCategory('Real Estate');
  const sw = s.ensureCategory('Software House');
  s.ensureCategory('Software Houses');
  s.save({ placeKey: '0x1:0x1', mapsUrl: 'https://www.google.com/maps/place/A', name: 'Al Noor Estate', phoneRaw: '03001234567', address: 'Lahore, Pakistan', websiteStatus: 'no_website', categoryId: re.id });
  s.save({ placeKey: '0x2:0x2', mapsUrl: 'https://www.google.com/maps/place/B', name: 'Code Craft', phoneRaw: '03211234567', address: 'Lahore, Pakistan', websiteStatus: 'no_website', categoryId: sw.id });
  s.setWhatsAppResult('+923001234567', 'available', 'baileys');
  s.close();
}

async function launch(env) {
  const app = await _electron.launch(process.env.LEAD_FINDER_EXE ? { executablePath: process.env.LEAD_FINDER_EXE, args: [], env } : { args: [root], cwd: root, env });
  const win = await app.firstWindow();
  await unlock(win);
  return { app, win };
}

const send = (app, channel, payload) =>
  app.evaluate(({ BrowserWindow }, [c, p]) => BrowserWindow.getAllWindows()[0].webContents.send(c, p), [channel, payload]);

test('themes, agent card, completion card, categories and background', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-premium-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  seed(path.join(userData, 'leads.db'));
  const env = { ...process.env, LEAD_FINDER_USER_DATA: userData, LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome') };
  delete env.ELECTRON_RUN_AS_NODE;
  let { app, win } = await launch(env);
  t.after(async () => {
    await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  await win.emulateMedia({ colorScheme: 'light' });

  // --- Theme toggle: switches, readable green in both, persists after restart.
  const theme = () => win.evaluate(() => document.documentElement.dataset.theme);
  const bg = () => win.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const green = () => win.locator('.phone.wa-available').evaluate((el) => getComputedStyle(el).color);
  assert.equal(await theme(), 'light');
  const lightBg = await bg();
  const lightGreen = await green();
  await win.getByRole('button', { name: 'Switch to dark mode' }).click();
  assert.equal(await theme(), 'dark');
  await win.waitForTimeout(450); // colour cross-fade
  const darkBg = await bg();
  const darkGreen = await green();
  assert.notEqual(lightBg, darkBg);
  assert.notEqual(lightGreen, darkGreen, 'green tuned per theme');
  // Contrast of the WhatsApp green against the panel in both themes (WCAG AA for text >= 4.5).
  const contrast = await win.evaluate(() => {
    const lum = (c) => {
      const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const fg = getComputedStyle(document.querySelector('.phone.wa-available')).color;
    const panel = getComputedStyle(document.querySelector('.panel')).backgroundColor;
    const [a, b] = [lum(fg), lum(panel)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  });
  assert.ok(contrast >= 4.5, `dark-mode green contrast ${contrast.toFixed(2)}`);
  if (shots) await win.screenshot({ path: path.join(shots, 'premium-dark.png') });
  await app.close();
  ({ app, win } = await launch(env));
  assert.equal(await theme(), 'dark', 'theme persisted across restart');
  await win.getByRole('button', { name: 'Switch to light mode' }).click();
  assert.equal(await theme(), 'light');

  // --- Agent card: headlines follow real events, never ahead of them.
  const headline = () => win.locator('.agent-headline').textContent();
  await send(app, 'search:status', { state: 'connecting', phase: 'connection', step: 'connecting', message: 'Connecting to Chrome', keyword: 'k', processed: 0, leads: 0 });
  await win.locator('.agent-card').waitFor();
  assert.equal(await headline(), 'Your agent is online');
  await win.waitForFunction(() => document.querySelector('.agent-headline')?.textContent === 'Initializing Chrome connection…');
  // Still connecting: "now working" must not appear yet.
  await win.waitForTimeout(1200);
  assert.equal(await headline(), 'Initializing Chrome connection…');
  // Real timing: "connected" and the first search step arrive back to back.
  await app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    wc.send('search:status', { state: 'connecting', phase: 'connection', step: 'connected', message: 'Connected to Chrome profile "Ali"' });
    wc.send('search:status', { state: 'running', phase: 'search', step: 'searching', message: 'Opening Google Maps' });
    wc.send('search:status', { state: 'running', phase: 'search', step: 'searching', message: 'Entering keyword' });
  });
  await win.waitForFunction(() => document.querySelector('.agent-headline')?.textContent === 'Your agent is now working');
  await win.waitForFunction(() => document.querySelector('.agent-headline')?.textContent === 'Searching for potential clients…');
  await send(app, 'search:status', { state: 'running', step: 'analyzing', message: 'Opening listing: X' });
  await win.waitForFunction(() => document.querySelector('.agent-headline')?.textContent === 'Analyzing business listings…');
  await send(app, 'search:status', { state: 'running', step: 'qualifying', message: 'Checking website status: X', leads: 3 });
  await win.waitForFunction(() => document.querySelector('.agent-headline')?.textContent === 'Finding businesses without websites…');
  assert.equal((await win.locator('.agent-count b').textContent()).trim(), '3');
  if (shots) await win.screenshot({ path: path.join(shots, 'premium-agent.png') });
  // Errors end the card without any success message.
  await send(app, 'search:status', { state: 'error', phase: 'connection', message: 'Chrome connection not allowed yet.' });
  await win.locator('.agent-card').waitFor({ state: 'detached' });
  assert.equal(await win.locator('.celebration').count(), 0, 'no completion card on error');

  // --- Completion card: shows exactly the counts it is given (from the DB).
  await send(app, 'search:status', { state: 'done', phase: 'search', message: 'Search finished: no more results' });
  await send(app, 'search:summary', { outcome: 'done', newLeads: 24, processed: 61, alreadySaved: 3, started: true });
  const card = win.locator('.celebration');
  await card.waitFor();
  assert.match(await card.innerText(), /Search completed!/);
  assert.match(await card.innerText(), /Congratulations! You found 24 potential clients today\./);
  assert.match(await card.innerText(), /New leads\s*24\s*Listings processed\s*61\s*Already saved\s*3/);
  assert.equal(await win.locator('canvas.confetti').count(), 1, 'restrained confetti when there are new leads');
  if (shots) await win.screenshot({ path: path.join(shots, 'premium-celebration.png') });
  await card.getByRole('button', { name: 'Close' }).click();
  await send(app, 'search:status', { state: 'stopped', phase: 'search', message: 'Search stopped' });
  await send(app, 'search:summary', { outcome: 'stopped', newLeads: 1, processed: 5, alreadySaved: 0, started: true });
  await card.waitFor();
  assert.match(await card.innerText(), /Search stopped/);
  assert.match(await card.innerText(), /1 qualified lead saved successfully\./);
  assert.equal(await win.locator('canvas.confetti').count(), 0, 'no confetti for a stopped search');
  await card.getByRole('button', { name: 'Close' }).click();
  await send(app, 'search:summary', { outcome: 'done', newLeads: 0, processed: 9, alreadySaved: 9, started: true });
  await card.waitFor();
  assert.match(await card.innerText(), /No new businesses without a website this time\./);
  assert.equal(await win.locator('canvas.confetti').count(), 0);
  await card.getByRole('button', { name: 'Close' }).click();

  // --- Category management: rename, merge after confirmation, delete keeps leads.
  const answer = (response) => app.evaluate(({ dialog }, r) => (dialog.showMessageBox = async () => ({ response: r })), response);
  const manage = async () => {
    if (!(await win.getByRole('dialog', { name: 'Manage categories' }).count())) await win.getByRole('button', { name: 'Manage categories' }).click();
  };
  const options = () => win.getByLabel('Show category').locator('option').allTextContents();
  await manage();
  await win.getByRole('button', { name: 'Rename Real Estate' }).click();
  await win.getByLabel('New name for Real Estate').fill('property   dealers');
  await win.getByRole('button', { name: 'Save name' }).click();
  await win.waitForFunction(() => [...document.querySelectorAll('.toolbar select option')].some((o) => o.textContent.startsWith('Property Dealers')));
  assert.equal((await win.locator('td.name', { hasText: 'Al Noor Estate' }).locator('xpath=..').locator('td').nth(5).innerText()).trim(), 'Property Dealers');
  // Rename onto an existing name: cancel keeps both, confirm merges.
  await manage();
  await answer(1);
  await win.getByRole('button', { name: 'Rename Software Houses' }).click();
  await win.getByLabel('New name for Software Houses').fill('software house');
  await win.getByRole('button', { name: 'Save name' }).click();
  await win.waitForTimeout(300);
  assert.equal((await options()).filter((o) => /^Software House/.test(o)).length, 2);
  await answer(0);
  await win.getByRole('button', { name: 'Save name' }).click();
  await win.waitForFunction(() => [...document.querySelectorAll('.toolbar select option')].filter((o) => o.textContent.startsWith('Software House')).length === 1);
  // Delete: leads stay, as Uncategorized.
  await manage();
  await answer(0);
  await win.getByRole('button', { name: 'Delete category Property Dealers' }).click();
  await win.waitForFunction(() => [...document.querySelectorAll('.toolbar select option')].some((o) => o.textContent.startsWith('Uncategorized (1)')));
  assert.equal(await win.locator('tbody tr').count(), 2, 'no leads deleted');

  // --- Background: behind content, never intercepts input.
  const hit = await win.evaluate(() => {
    const r = document.querySelector('.search input').getBoundingClientRect();
    return document.elementFromPoint(r.left + 20, r.top + 10)?.id;
  });
  assert.equal(hit, 'kw');
  const edgeHit = await win.evaluate(() => document.elementFromPoint(4, innerHeight - 4)?.className || '');
  assert.ok(!/ambient/.test(edgeHit), 'ambient layer ignores the pointer');
  assert.equal(await win.evaluate(() => getComputedStyle(document.querySelector('.ambient')).pointerEvents), 'none');

  // Idle CPU of the renderer with the background running.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
  const cpu = async () => {
    await app.evaluate(({ app: a }) => a.getAppMetrics());
    await win.waitForTimeout(3000);
    const m = await app.evaluate(({ app: a }) => a.getAppMetrics());
    return m.find((p) => p.type === 'Tab')?.cpu.percentCPUUsage ?? 0;
  };
  const idle = await cpu();
  console.log(`# renderer idle CPU with background: ${idle.toFixed(1)}%`);
  assert.ok(idle < 12, `idle renderer CPU ${idle.toFixed(1)}%`);
  // During a search the background runs at its higher rate; still light.
  await send(app, 'search:status', { state: 'running', phase: 'search', step: 'analyzing', message: 'Opening listing: X' });
  await win.locator('.agent-card').waitFor();
  const busy = await cpu();
  console.log(`# renderer CPU during a search (background + agent card): ${busy.toFixed(1)}%`);
  assert.ok(busy < 20, `renderer CPU while searching ${busy.toFixed(1)}%`);
  await send(app, 'search:status', { state: 'stopped', phase: 'search', message: 'Search stopped' });
  await win.locator('.agent-card').waitFor({ state: 'detached' });

  // Hidden/unfocused window: the canvas loop stops.
  await win.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal(await win.evaluate(() => window.__ambient.isRunning()), false);
  await win.evaluate(() => window.dispatchEvent(new Event('focus')));
  // Reduced motion: no continuous motion.
  await win.emulateMedia({ reducedMotion: 'reduce' });
  await win.waitForTimeout(100);
  assert.equal(await win.evaluate(() => window.__ambient.isRunning()), false, 'canvas stopped under reduced motion');
  assert.equal(await win.evaluate(() => getComputedStyle(document.querySelector('.glow-a')).animationName), 'none');
  await win.emulateMedia({ reducedMotion: 'no-preference' });

  if (shots) await win.screenshot({ path: path.join(shots, 'premium-light.png') });
  assert.deepEqual(errors, []);
});
