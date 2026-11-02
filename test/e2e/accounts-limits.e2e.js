'use strict';
// Several WhatsApp accounts and parallel campaigns, and the Monthly plan's
// daily lead allowance, in the real Electron app with a scripted WhatsApp
// (test/e2e/fake-baileys.js: each new link is a different number).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { LeadStore } = require('../../src/database/db');
const { unlock, activationEnv } = require('./helpers');

const root = path.join(__dirname, '..', '..');
const shots = process.env.LEAD_FINDER_SCREENSHOTS;

const sends = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.text) : []);

function envFor(tmp, extra = {}) {
  const env = {
    ...process.env,
    ...activationEnv,
    LEAD_FINDER_USER_DATA: path.join(tmp, 'app'),
    LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome'),
    LEAD_FINDER_NO_UPDATES: '1',
    LEAD_FINDER_TEST_BAILEYS: path.join(__dirname, 'fake-baileys.js'),
    LEAD_FINDER_TEST_BAILEYS_LOG: path.join(tmp, 'wa-sent.log'),
    LEAD_FINDER_TEST_DAILY_LEADS: '{}', // the shipped allowances; enables the test lead hook
    ...extra,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

async function launch(env, plan) {
  const app = await _electron.launch({ args: [root], cwd: root, env });
  const win = await app.firstWindow();
  await unlock(win, '1357', { plan });
  return { app, win };
}

test('two WhatsApp accounts: Real Estate and Garments campaigns in parallel, own intervals', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-accounts-e2e-'));
  fs.mkdirSync(path.join(tmp, 'app'));
  const s = new LeadStore(path.join(tmp, 'app', 'leads.db'));
  let i = 0;
  for (const [cat, list] of [
    ['Real Estate', [['Zahid Properties', '03001234567'], ['Best Realty', '03007654321']]],
    ['Garments', [['Noor Textiles', '03211112223'], ['Sana Garments', '03214445556']]],
  ]) {
    const c = s.ensureCategory(cat);
    for (const [name, phoneRaw] of list) s.save({ placeKey: `0x${++i}:0x9`, mapsUrl: `https://www.google.com/maps/place/A${i}`, name, phoneRaw, address: 'Lahore, Pakistan', websiteStatus: 'no_website', categoryId: c.id });
  }
  for (const p of ['+923001234567', '+923007654321', '+923211112223', '+923214445556']) s.setWhatsAppResult(p, 'available', 'baileys');
  s.close();
  const log = path.join(tmp, 'wa-sent.log');
  const env = envFor(tmp, { LEAD_FINDER_TEST_BAILEYS_NUMBERS: '923001234567,923007654321,923211112223,923214445556' });
  let { app, win } = await launch(env, 'lifetime');
  t.after(async () => {
    await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));

  await win.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Outreach' }).click();
  const out = win.locator('.outreach');
  const accounts = out.getByRole('region', { name: 'WhatsApp accounts' }).or(out.locator('[aria-label="WhatsApp accounts"]'));
  const row = (n) => accounts.locator('.wa-account').nth(n);

  // --- The first account, then a second one: each with its own state.
  await win.evaluate(() => window.leadFinder.whatsappConnect());
  await row(0).filter({ hasText: '+923000000001' }).waitFor({ timeout: 20_000 });
  assert.match(await row(0).innerText(), /Disconnect/);
  await accounts.getByRole('button', { name: '+ Add account' }).click();
  await row(1).filter({ hasText: '+923000000002' }).waitFor({ timeout: 20_000 });
  assert.equal(await accounts.locator('.wa-dot.tone-ok').count(), 2);

  // Disconnect / reconnect one: the other stays connected.
  await row(1).getByRole('button', { name: 'Disconnect' }).click();
  await row(1).getByRole('button', { name: 'Reconnect' }).waitFor();
  assert.match(await row(0).innerText(), /Disconnect/, 'the first account is still connected');
  await row(1).getByRole('button', { name: 'Reconnect' }).click();
  await row(1).getByRole('button', { name: 'Disconnect' }).waitFor({ timeout: 20_000 });
  assert.match(await row(1).innerText(), /\+923000000002/, 'the same number after reconnecting');

  // --- Default interval for new campaigns: 30 minutes, editable.
  const defInterval = accounts.getByLabel('Default interval (minutes)');
  assert.equal(await defInterval.inputValue(), '30');
  await defInterval.fill('20');
  await defInterval.press('Enter');
  await win.locator('.toast').filter({ hasText: '20 minutes between contacts' }).waitFor();
  assert.equal((await win.evaluate(() => window.leadFinder.outreachDefaultInterval())).interval, 20);

  // Both campaigns live, sending now, each with its own interval.
  const pkHour = (new Date().getUTCHours() + 5) % 24;
  const cats = (await win.evaluate(() => window.leadFinder.listCategories())).categories;
  const catId = Object.fromEntries(cats.map((c) => [c.name, String(c.id)]));
  const ids = {};
  for (const cat of ['Real Estate', 'Garments']) ids[cat] = (await win.evaluate((c) => window.leadFinder.outreachCategoryCampaign(c), catId[cat])).id;
  assert.ok(ids['Real Estate'] && ids.Garments, JSON.stringify(ids));
  const st0 = await win.evaluate((id) => window.leadFinder.outreachState(id), ids.Garments);
  assert.equal(st0.config.interval, 20, 'a new campaign starts with the default interval');
  for (const [cat, interval] of [['Real Estate', 30], ['Garments', 5]]) {
    const r = await win.evaluate(([id, cfg]) => window.leadFinder.outreachConfigure(id, cfg), [ids[cat], { interval, test: false, quietStart: (pkHour + 6) % 24, quietEnd: (pkHour + 10) % 24 }]);
    assert.ok(r.ok, JSON.stringify(r));
  }

  // --- Real Estate ON: the account is asked for; the first one is chosen.
  const catRow = (name) => out.getByRole('list', { name: 'Category campaigns' }).getByRole('listitem').filter({ hasText: name });
  const ack = win.getByRole('dialog', { name: 'Start live outreach' });
  const pick = win.getByRole('dialog', { name: 'Choose WhatsApp account' });
  const startWith = async (cat, label) => {
    await catRow(cat).getByRole('switch', { name: `${cat} campaign` }).click();
    await pick.waitFor();
    await pick.locator('.account-option').filter({ hasText: label }).getByRole('radio').check();
    await pick.getByRole('button', { name: 'Start' }).click();
    if (await ack.isVisible().catch(() => false) || (await ack.waitFor({ timeout: 3000 }).then(() => true, () => false))) {
      await ack.getByRole('checkbox').check();
      await ack.getByRole('button', { name: 'Start sending' }).click();
    }
    await win.waitForFunction((n) => [...document.querySelectorAll('.campaign-list li')].some((li) => li.textContent.includes(n) && li.querySelector('[role=switch]')?.getAttribute('aria-checked') === 'true'), cat);
  };
  await startWith('Real Estate', '+923000000001');

  // Garments: the first account is in use (shown, cannot be chosen).
  await catRow('Garments').getByRole('switch', { name: 'Garments campaign' }).click();
  await pick.waitFor();
  const taken = pick.locator('.account-option').filter({ hasText: '+923000000001' });
  assert.match(await taken.innerText(), /used by Real Estate/);
  assert.ok(await taken.getByRole('radio').isDisabled());
  assert.ok(await pick.locator('.account-option').filter({ hasText: '+923000000002' }).getByRole('radio').isChecked(), 'the free account is chosen');
  await pick.getByRole('button', { name: 'Cancel' }).click();
  // The backend refuses it too.
  const refused = await win.evaluate((c) => window.leadFinder.outreachSetCategory(c, true, true, 'primary'), catId.Garments);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /already used by the campaign “Real Estate”/);
  await startWith('Garments', '+923000000002');

  // --- Both send at once, each from its own account.
  const first = async () => {
    for (let k = 0; k < 30; k++) {
      const l = sends(log);
      if (l.some((e) => e.from === '923000000001') && l.some((e) => e.from === '923000000002')) return l;
      await new Promise((r) => setTimeout(r, 500));
    }
    return sends(log);
  };
  const l = await first();
  const re = l.filter((e) => e.from === '923000000001');
  const ga = l.filter((e) => e.from === '923000000002');
  assert.equal(re.length, 1, JSON.stringify(l));
  assert.equal(ga.length, 1, JSON.stringify(l));
  assert.ok(['923001234567@s.whatsapp.net', '923007654321@s.whatsapp.net'].includes(re[0].jid), 'Real Estate leads from account 1');
  assert.ok(['923211112223@s.whatsapp.net', '923214445556@s.whatsapp.net'].includes(ga[0].jid), 'Garments leads from account 2');
  assert.ok(Math.abs(re[0].at - ga[0].at) < 10_000, 'started in parallel, not one after the other');
  assert.match(await catRow('Real Estate').innerText(), /Test Account\b/);
  assert.match(await catRow('Garments').innerText(), /Test Account 2/);

  // --- Replies end each sequence; the next contact follows each campaign's own interval.
  await app.evaluate((_e, a) => globalThis.__fakeWAs['923000000001'].incoming(a.re, 'Walaikum assalam'), { re: re[0].jid.split('@')[0] });
  await app.evaluate((_e, a) => globalThis.__fakeWAs['923000000002'].incoming(a.ga, 'Ji bolain'), { ga: ga[0].jid.split('@')[0] });
  const settle = async (id) => {
    for (let k = 0; k < 90; k++) {
      const st = await win.evaluate((x) => window.leadFinder.outreachState(x), id);
      if (st.current === null && st.contacts.some((c) => c.state === 'replied')) return st;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return win.evaluate((x) => window.leadFinder.outreachState(x), id);
  };
  const [reSt, gaSt] = await Promise.all([settle(ids['Real Estate']), settle(ids.Garments)]);
  const reGap = (reSt.nextDueAt - re[0].at) / 60_000;
  const gaGap = (gaSt.nextDueAt - ga[0].at) / 60_000;
  assert.ok(Math.abs(reGap - 30) < 0.1, `Real Estate next contact in ${reGap} minutes`);
  assert.ok(Math.abs(gaGap - 5) < 0.1, `Garments next contact in ${gaGap} minutes`);
  assert.equal(sends(log).length, 2, 'nothing else sent');
  if (shots) await win.screenshot({ path: path.join(shots, 'outreach-accounts.png') });

  // --- Restart: both still running on their accounts; nothing re-sent.
  await app.close();
  ({ app, win } = await launch(env, 'lifetime'));
  for (const [cat, acc] of [['Real Estate', 'primary'], ['Garments', null]]) {
    const st = await win.evaluate((x) => window.leadFinder.outreachState(x), ids[cat]);
    assert.equal(st.status, 'running', cat);
    if (acc) assert.equal(st.config.accountId, acc);
    else assert.match(st.config.accountId, /^[a-f0-9]{8}$/);
  }
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(sends(log).length, 2, 'nothing re-sent after the restart');
  assert.deepEqual(errors, []);
});

test('Monthly plan: 100 unique leads a day across sources; the 101st is blocked; duplicates use nothing', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-limits-e2e-'));
  fs.mkdirSync(path.join(tmp, 'app'));
  const env = envFor(tmp);
  let { app, win } = await launch(env, 'monthly');
  t.after(async () => {
    await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const save = (n, extra = {}) => app.evaluate((_e, a) => globalThis.__leadFinderTest.saveLead({ placeKey: `0x${a.n}:0x1`, mapsUrl: `https://www.google.com/maps/place/L${a.n}`, name: `Lead ${a.n}`, phoneRaw: `0300${String(1000000 + a.n)}`, address: 'Lahore, Pakistan', websiteStatus: 'no_website', ...a.extra }), { n, extra });
  const chip = win.getByLabel('Leads today');

  for (let n = 1; n <= 99; n++) assert.ok((await save(n)).isNewLead);
  await chip.filter({ hasText: '99 / 100 today' }).waitFor();

  // Switching tabs does not reset the count.
  const ws = win.getByRole('navigation', { name: 'Workspace' });
  await ws.getByRole('button', { name: 'Outreach' }).click();
  await ws.getByRole('button', { name: 'Leads' }).click();
  await chip.filter({ hasText: '99 / 100 today' }).waitFor();

  // A duplicate (the same business again) uses nothing.
  const dup = await save(5);
  assert.equal(dup.isNewLead, false);
  assert.equal(dup.limitReached, false);
  assert.equal((await app.evaluate(() => globalThis.__leadFinderTest.quota())).used, 99);

  // The 100th: saved. The 101st: refused, not saved; the plans open.
  assert.ok((await save(100)).isNewLead);
  const r101 = await save(101);
  assert.deepEqual(r101, { isNewLead: false, limitReached: true });
  const msg = 'You have reached your daily limit of 100 leads. Upgrade your plan to find more leads.';
  const panel = win.getByRole('dialog', { name: 'Subscription' });
  await panel.waitFor();
  assert.match(await panel.locator('.sub-notice').innerText(), new RegExp(msg.replace(/\./g, '\\.')));
  const plans = await panel.getByRole('radiogroup', { name: 'Plan' }).innerText();
  assert.match(plans, /Monthly[\s\S]*PKR 4,500/);
  assert.match(plans, /6 Months[\s\S]*PKR 15,000/);
  assert.match(plans, /Lifetime[\s\S]*PKR 50,000/);
  await panel.getByRole('button', { name: 'Close' }).click();
  await win.getByRole('alert').filter({ hasText: msg }).waitFor();
  await win.getByRole('button', { name: 'Upgrade Plan' }).click();
  await panel.getByRole('radiogroup', { name: 'Plan' }).waitFor();
  await panel.getByRole('button', { name: 'Close' }).click();
  await chip.filter({ hasText: '100 / 100 today' }).waitFor();

  // A search cannot start, and a duplicate still saves (it uses nothing).
  const search = await win.evaluate(() => window.leadFinder.startSearch('plumber', 'Plumbers', 'all', false, 'Lahore'));
  assert.equal(search.ok, false);
  assert.equal(search.error, msg);
  assert.equal((await save(7, { name: 'Lead 7 (updated)' })).isNewLead, false);

  // A restart does not reset it.
  await app.close();
  ({ app, win } = await launch(env, 'monthly'));
  await win.getByLabel('Leads today').filter({ hasText: '100 / 100 today' }).waitFor();
  assert.equal((await save(102)).limitReached, true);
});
