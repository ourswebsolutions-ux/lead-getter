'use strict';
// The Outreach screen is a fixed frame: the page never scrolls; the campaign
// list (and each section) scrolls inside its own container.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { LeadStore } = require('../../src/database/db');
const { unlock, activationEnv } = require('./helpers');
const root = path.join(__dirname, '..', '..');
test('Outreach: fixed layout, the campaign list scrolls inside its card', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-scroll-'));
  fs.mkdirSync(path.join(tmp, 'app'));
  const s = new LeadStore(path.join(tmp, 'app', 'leads.db'));
  for (let i = 0; i < 25; i++) {
    const c = s.ensureCategory(`Category ${String(i + 1).padStart(2, '0')}`);
    for (let j = 0; j < 8; j++) s.save({ placeKey: `0x${i}${j}:0x1`, mapsUrl: `https://www.google.com/maps/place/S${i}${j}`, name: `Biz ${i}-${j}`, phoneRaw: `0300${String(1000000 + i * 10 + j)}`, address: 'Lahore, Pakistan', websiteStatus: 'no_website', categoryId: c.id });
  }
  s.close();
  const env = { ...process.env, ...activationEnv, LEAD_FINDER_USER_DATA: path.join(tmp, 'app'), LEAD_FINDER_CHROME_EXE: path.join(tmp, 'x'), LEAD_FINDER_NO_UPDATES: '1', LEAD_FINDER_TEST_BAILEYS: path.join(__dirname, 'fake-baileys.js') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [root], cwd: root, env });
  const win = await app.firstWindow();
  await unlock(win);
  await win.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Outreach' }).click();
  await win.locator('.or-item').first().waitFor();
  assert.equal(await win.locator('.or-item').count(), 25);
  await win.locator('.or-item').first().locator('.campaign-item').click();
  await win.getByRole('tab', { name: /^Contacts/ }).click();
  await win.waitForTimeout(500);
  const m = await win.evaluate(() => {
    const el = (s) => document.querySelector(s);
    const list = el('.or-campaigns-scroll');
    list.scrollTop = 400;
    return { docScroll: document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight, outreachScroll: el('.outreach').scrollHeight - el('.outreach').clientHeight, list: [list.scrollHeight, list.clientHeight, list.scrollTop], viewport: innerHeight, side: el('.or-side').getBoundingClientRect().bottom };
  });
  assert.ok(m.docScroll <= 0, 'the page does not scroll');
  assert.ok(m.outreachScroll <= 0, 'the Outreach screen does not scroll');
  assert.ok(m.list[0] > m.list[1] && m.list[2] > 0, `the campaign list scrolls by itself: ${JSON.stringify(m.list)}`);
  assert.ok(m.side <= m.viewport, 'the sidebar fits the window');
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
