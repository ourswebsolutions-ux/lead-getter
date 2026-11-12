'use strict';
// The WhatsApp assistant in the real app, with the test WhatsApp: the admin
// number set in Settings, an unused category offered on WhatsApp, answered
// on WhatsApp, the campaign started live; commands; power off by WhatsApp.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { LeadStore } = require('../../src/database/db');
const { unlock, activationEnv } = require('./helpers');

const root = path.join(__dirname, '..', '..');
const ADMIN = '923211234567';

function seed(file) {
  const s = new LeadStore(file);
  const cat = s.ensureCategory('Shoes Shops');
  s.save({ placeKey: '0x1:0x9', mapsUrl: 'https://www.google.com/maps/place/S1', name: 'Bata Shoes', phoneRaw: '03001234567', address: 'Lahore, Pakistan', websiteStatus: 'no_website', categoryId: cat.id });
  s.save({ placeKey: '0x2:0x9', mapsUrl: 'https://www.google.com/maps/place/S2', name: 'Servis Shoes', phoneRaw: '03007654321', address: 'Lahore, Pakistan', websiteStatus: 'no_website', categoryId: cat.id });
  s.setWhatsAppResult('+923001234567', 'available', 'baileys');
  s.setWhatsAppResult('+923007654321', 'available', 'baileys');
  s.close();
}

test('WhatsApp assistant: admin from Settings, unused category on WhatsApp, commands, power off', { timeout: 300_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-assistant-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  seed(path.join(userData, 'leads.db'));
  const log = path.join(tmp, 'wa-sent.log');
  const env = { ...process.env, ...activationEnv, LEAD_FINDER_USER_DATA: userData, LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome'), LEAD_FINDER_NO_UPDATES: '1', LEAD_FINDER_TEST_BAILEYS: path.join(__dirname, 'fake-baileys.js'), LEAD_FINDER_TEST_BAILEYS_LOG: log, LEAD_FINDER_TEST_BAILEYS_NUMBERS: '923001234567,923007654321' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [root], cwd: root, env });
  t.after(async () => {
    await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const win = await app.firstWindow();
  await unlock(win);
  const toAdmin = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.text && e.jid.startsWith(ADMIN)).map((e) => e.text) : []);
  const reply = async (n, re) => {
    for (let i = 0; i < 100; i++) {
      const got = toAdmin();
      if (got.length > n && re.test(got.at(-1))) return got.at(-1);
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`no reply matching ${re}; got: ${JSON.stringify(toAdmin().slice(-2))}`);
  };
  const admin = async (text, re) => {
    const n = toAdmin().length;
    await app.evaluate((_, a) => globalThis.__fakeWA.incoming(a.from, a.text), { from: ADMIN, text });
    return reply(n, re);
  };
  // WhatsApp linked (test account).
  for (let i = 0; i < 50 && !(await win.evaluate(() => window.leadFinder.waAccounts())).some((a) => a.state === 'open'); i++) await new Promise((r) => setTimeout(r, 200));

  // Before an admin number is set, nobody's messages are commands.
  await app.evaluate((_, a) => globalThis.__fakeWA.incoming(a, 'status'), ADMIN);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(toAdmin().length, 0, 'no admin yet: no reply');

  // The admin number, in Settings > Background.
  await win.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Settings' }).click();
  const field = win.getByRole('textbox', { name: 'Admin WhatsApp number' });
  await field.fill(`+${ADMIN}`);
  await win.getByRole('button', { name: 'Save' }).click();
  await win.waitForFunction((n) => document.querySelector('[aria-label="Admin WhatsApp number"]')?.value === n, ADMIN);

  // Offered by itself: the unused category, for the idle account.
  const offer = await reply(0, /leads in "Shoes Shops"[\s\S]*not been used in a campaign/);
  assert.match(offer, /2 leads/);
  assert.match(await admin('haan', /Use .* for this campaign\?/), /Use/);
  assert.match(await admin('yes', /What message should the campaign send\?/), /message/);
  assert.match(await admin('Assalam-o-Alaikum {name}, hum shoe shops ke liye websites banate hain.', /Please confirm:/), /Leads: Shoes Shops/);
  assert.match(await admin('kuch aur', /Please reply YES or NO/), /YES or NO/);
  await admin('yes', /Started/);

  // Commands.
  assert.match(await admin('campaigns', /Campaigns:/), /Shoes Shops.*running/);
  assert.match(await admin('accounts', /WhatsApp accounts:/), /running a campaign/);
  assert.match(await admin('pause', /Paused 1 campaign/), /resume/);
  assert.match(await admin('resume', /Resumed 1 campaign/), /Resumed/);
  assert.match(await admin('status', /Lead Finder status/), /Campaigns: 1 running/);
  // Another number: ignored.
  const before = toAdmin().length;
  await app.evaluate(() => globalThis.__fakeWA.incoming('923331112222', 'power off'));
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(toAdmin().length, before);

  // Power off: asked first; NO keeps it; YES closes Lead Finder.
  await admin('power off', /Are you sure you want to shut down Lead Finder and this computer\?/);
  await admin('no', /keeps running/);
  await admin('power off', /Are you sure/);
  const exited = new Promise((r) => app.process().once('exit', r));
  await admin('yes', /Shutting down Lead Finder and the computer/);
  await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('Lead Finder did not close')), 20_000))]);
  // The campaign was paused for the shutdown (it continues at the next start).
  const s = new LeadStore(path.join(userData, 'leads.db'));
  const row = s.db.prepare("SELECT status, pause_reason FROM outreach_campaigns WHERE name LIKE 'Shoes%'").get();
  s.close();
  assert.ok(row, 'the campaign exists');
  assert.deepEqual([row.status, row.pause_reason], ['paused', 'shutdown']);
  assert.match(fs.readFileSync(path.join(userData, 'automation.log'), 'utf8'), /computer shutdown requested \(not done: not the installed app\)/, 'the computer would be shut down by the installed app');
});
