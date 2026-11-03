'use strict';
// Outreach with message variations, links and voice files, in the real
// Electron app with a scripted WhatsApp (test/e2e/fake-baileys.js): editing,
// previews, See more, live progress, what reaches WhatsApp, two campaigns at
// once, and a restart (nothing sent twice).
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
const audio = (f) => path.join(__dirname, '..', 'fixtures', 'audio', f);
const log = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.text || e.audio) : []);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const RE = [
  ['Zahid Properties', '03001234567'],
  ['Saad Estate Agency', '03001112223'],
  ['Kamran Builders', '03002223334'],
  ['Usman Realtors', '03003334445'],
  ['Bilal Property Hub', '03004445556'],
];
const GA = [['Noor Textiles', '03211112223']];

test('outreach: message variations, links, voice files, previews, live progress, two campaigns, restart', { timeout: 900_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-outreach-media-'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData);
  const s = new LeadStore(path.join(userData, 'leads.db'));
  let i = 0;
  for (const [cat, list] of [['Real Estate', RE], ['Garments', GA]]) {
    const c = s.ensureCategory(cat);
    for (const [name, phoneRaw] of list) {
      const { lead } = s.save({ placeKey: `0x${++i}:0x5`, mapsUrl: `https://www.google.com/maps/place/M${i}`, name, phoneRaw, address: 'Lahore, Pakistan', websiteStatus: 'no_website', categoryId: c.id });
      s.setWhatsAppResult(lead.phone, 'available', 'baileys');
    }
  }
  s.close();
  const wa = path.join(tmp, 'wa.log');
  const env = {
    ...process.env,
    ...activationEnv,
    LEAD_FINDER_USER_DATA: userData,
    LEAD_FINDER_CHROME_EXE: path.join(tmp, 'no-chrome'),
    LEAD_FINDER_NO_UPDATES: '1',
    LEAD_FINDER_TEST_BAILEYS: path.join(__dirname, 'fake-baileys.js'),
    LEAD_FINDER_TEST_BAILEYS_LOG: wa,
    LEAD_FINDER_TEST_BAILEYS_NUMBERS: [...RE, ...GA].map(([, p]) => `92${p.slice(1)}`).join(','),
    LEAD_FINDER_TEST_AUDIO_PICK: [audio('intro-voice.ogg'), audio('portfolio-pitch.mp3'), audio('demo.wav'), audio('not-really.ogg')].join(path.delimiter),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = async () => {
    const app = await _electron.launch({ args: [root], cwd: root, env });
    const win = await app.firstWindow();
    await unlock(win);
    await win.setViewportSize({ width: 1440, height: 940 }).catch(() => {});
    return { app, win };
  };
  let { app, win } = await launch();
  t.after(async () => {
    await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  const shot = (name) => shots && win.screenshot({ path: path.join(shots, `${name}.png`) });

  await win.evaluate(() => window.leadFinder.whatsappConnect());
  await win.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Outreach' }).click();
  const out = win.locator('.outreach');
  const accounts = out.locator('[aria-label="WhatsApp accounts"]');
  await accounts.locator('.wa-account').first().filter({ hasText: '+923000000001' }).waitFor({ timeout: 20_000 });
  const catRow = (name) => out.getByRole('list', { name: 'Category campaigns' }).getByRole('listitem').filter({ hasText: name });
  await catRow('Real Estate').locator('.campaign-item').click();
  await out.getByRole('heading', { name: 'Real Estate', exact: true }).waitFor();
  const tab = (name) => out.getByRole('tab', { name: new RegExp(`^${name}`) }).click();

  // --- Account details open from the compact list.
  await accounts.getByRole('button', { name: /details$/ }).first().click();
  const accDialog = win.getByRole('dialog', { name: /WhatsApp account/ });
  await accDialog.waitFor();
  assert.match(await accDialog.innerText(), /\+923000000001[\s\S]*Test Account/);
  await accDialog.getByRole('button', { name: 'Close' }).click();

  // --- Messages: only message 1 at first (required); nothing else until added.
  await tab('Messages');
  const step1 = out.getByRole('region', { name: 'Message 1' });
  await step1.waitFor();
  assert.equal(await out.locator('.or-step').count(), 1, 'message 1 only');
  assert.equal(await out.getByRole('region', { name: 'Links' }).count(), 0, 'no empty links section');
  assert.equal(await out.getByRole('region', { name: 'Voice files' }).count(), 0, 'no empty voice section');
  assert.equal(await step1.getByRole('button', { name: 'Remove message 1' }).count(), 0, 'message 1 cannot be removed');
  // Variations of message 1, {business name}, line breaks kept.
  await step1.getByRole('button', { name: 'Add variation to message 1' }).click();
  await step1.getByRole('button', { name: 'Add variation to message 1' }).click();
  await step1.getByLabel('Message 1B', { exact: true }).fill('Salam {name}!\nKya {business name} abhi bhi active hai?');
  await step1.getByLabel('Message 1B without a name').fill('Salam!\nKya aapka business abhi bhi active hai?');
  await step1.getByLabel('Message 1C', { exact: true }).fill('Hello {name}, hope you are well.');
  await step1.getByLabel('Message 1C without a name').fill('Hello, hope you are well.');
  await step1.getByRole('button', { name: 'Add variation to message 1' }).click();
  await step1.getByRole('button', { name: 'Delete message 1D' }).click();
  assert.equal(await step1.locator('.or-var').count(), 3);
  await step1.locator('.or-var-preview').nth(1).filter({ hasText: 'Kya Zahid Properties abhi bhi active hai?' }).waitFor();
  assert.match(await step1.locator('.or-var-preview').nth(1).innerText(), /^Salam Zahid!\nKya Zahid Properties/);
  // Messages 2 and 3, added by hand; an added message can be removed again.
  const adds = out.getByRole('group', { name: 'Add to the campaign' });
  await adds.getByRole('button', { name: 'Add Message' }).click();
  await out.getByRole('region', { name: 'Message 2' }).getByLabel('Message 2', { exact: true }).fill('Kaise hain aap? Umeed hai aap khairiyat se honge.');
  await adds.getByRole('button', { name: 'Add Message' }).click();
  await out.getByRole('region', { name: 'Message 3' }).getByRole('button', { name: 'Remove message 3' }).click();
  assert.equal(await out.locator('.or-step').count(), 2, 'removed: hidden again');
  await adds.getByRole('button', { name: 'Add Message' }).click();
  const step3 = out.getByRole('region', { name: 'Message 3' });
  await step3.getByLabel('Message 3', { exact: true }).fill('Kya aap {business name} ke naam se real estate ka kaam karte hain, ya kisi aur business se related hain?');
  await step3.getByLabel('Message 3 without a name').fill('Kya aap real estate ka kaam karte hain, ya kisi aur business se related hain?');
  await shot('outreach-messages');

  // --- Links: the section appears with the first one and goes when the last is removed.
  await adds.getByRole('button', { name: 'Add Link' }).click();
  const links = out.getByRole('region', { name: 'Links' });
  await links.getByRole('button', { name: 'Remove link 1' }).click();
  assert.equal(await links.count(), 0, 'no empty links section');
  await adds.getByRole('button', { name: 'Add Link' }).click();
  await links.getByLabel('Link 1 title').fill('Website demo');
  await links.getByLabel('Link 1 address').fill('not a link');
  await links.locator('.or-link-err').filter({ hasText: 'No spaces' }).waitFor();
  await links.getByLabel('Link 1 address').fill('demo.example.com/real-estate');
  await adds.getByRole('button', { name: 'Add Link' }).click();
  await links.getByLabel('Link 2 title').fill('Portfolio');
  await links.getByLabel('Link 2 address').fill('https://example.com/portfolio');
  assert.equal(await links.locator('.or-link-err').count(), 0);
  // --- Voice files: checked by content; the section appears with them.
  await adds.getByRole('button', { name: 'Add Voice' }).click();
  const voices = out.getByRole('region', { name: 'Voice files' });
  await voices.locator('.or-voice-list li').nth(1).waitFor();
  assert.equal(await voices.locator('.or-voice-list li').count(), 2, 'Ogg/Opus and MP3 accepted');
  const why = await voices.getByRole('alert').allInnerTexts();
  assert.ok(why.some((e) => /demo\.wav.*isn’t supported/.test(e)), why.join(' | '));
  assert.ok(why.some((e) => /not-really\.ogg.*is really MP3/.test(e)), why.join(' | '));
  assert.match(await voices.innerText(), /intro-voice\.ogg[\s\S]*OPUS[\s\S]*voice note[\s\S]*portfolio-pitch\.mp3[\s\S]*MP3[\s\S]*audio file/);
  // The player reads the saved copy.
  await voices.getByRole('button', { name: 'Play portfolio-pitch.mp3' }).click();
  await voices.locator('audio[aria-label="Play portfolio-pitch.mp3"]').waitFor();
  assert.match(await voices.locator('audio').first().getAttribute('src'), /^data:audio\/mpeg;base64,/);
  // They go with message 1 here, so the test sees them at once.
  await links.getByLabel('Attachments go with').selectOption('1');
  await shot('outreach-attachments');

  // --- Settings: daily limit above 15 (no fixed maximum), interval 1 minute, live, sending now.
  await tab('Settings');
  await out.getByLabel('Daily limit').fill('40');
  await out.getByLabel('Interval (minutes)', { exact: true }).fill('1');
  const pkHour = (new Date().getUTCHours() + 5) % 24;
  await out.getByLabel('Sending hours from').selectOption(String((pkHour + 10) % 24));
  await out.getByLabel('Sending hours to').selectOption(String((pkHour + 6) % 24));
  await out.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Live' }).click();
  await shot('outreach-settings');
  await win.getByRole('region', { name: 'Unsaved changes' }).getByRole('button', { name: 'Save settings' }).click();
  await win.locator('.toast').filter({ hasText: 'Campaign settings saved.' }).waitFor();
  const reId = (await win.evaluate(() => window.leadFinder.outreachOverview())).campaigns.find((c) => c.name === 'Real Estate').id;
  const state = (id) => win.evaluate((x) => window.leadFinder.outreachState(x), id);
  let st = await state(reId);
  assert.equal(st.config.dailyCap, 40);
  assert.equal(st.config.attachStep, 1, 'links and voice files go with message 1');
  assert.equal(st.config.templates[0].variations.length, 3);
  assert.deepEqual(st.config.links, [{ title: 'Website demo', url: 'https://demo.example.com/real-estate' }, { title: 'Portfolio', url: 'https://example.com/portfolio' }]);
  assert.deepEqual(st.config.voices.map((v) => [v.name, v.mime, v.ptt]), [['intro-voice.ogg', 'audio/ogg; codecs=opus', true], ['portfolio-pitch.mp3', 'audio/mpeg', false]]);

  // --- Overview: previews (two, then See more; a click shows everything).
  await tab('Overview');
  const prev = out.getByRole('region', { name: 'Message previews' });
  await prev.locator('.or-prev').first().filter({ hasText: 'Website demo' }).waitFor();
  assert.equal(await prev.locator('.or-prev').count(), 2);
  await prev.getByRole('button', { name: /See more \(3 more\)/ }).click();
  assert.equal(await prev.locator('.or-prev').count(), 5, '3 variations of message 1 + messages 2 and 3');
  await prev.getByRole('button', { name: 'Preview message 1B' }).click();
  const pm = win.getByRole('dialog', { name: 'Message preview' });
  await pm.waitFor();
  const pmText = await pm.innerText();
  assert.match(pmText, /Salam Zahid!\nKya Zahid Properties abhi bhi active hai\?\n\n\*Website demo\*\nhttps:\/\/demo\.example\.com\/real-estate\n\n\*Portfolio\*\nhttps:\/\/example\.com\/portfolio/);
  assert.match(pmText, /intro-voice\.ogg[\s\S]*portfolio-pitch\.mp3/);
  await wait(400);
  await shot('outreach-preview');
  await pm.getByRole('button', { name: 'Close' }).click();

  // --- Garments: its own account, its own campaign, at the same time.
  await accounts.getByRole('button', { name: 'Add account' }).click();
  const acc2 = win.getByRole('dialog', { name: /WhatsApp account/ });
  await acc2.getByText('+923000000002').waitFor({ timeout: 20_000 });
  await acc2.getByRole('button', { name: 'Close' }).click();
  const gaId = (await win.evaluate((c) => window.leadFinder.outreachCategoryCampaign(c), String((await win.evaluate(() => window.leadFinder.listCategories())).categories.find((c) => c.name === 'Garments').id))).id;
  const gaCfg = await win.evaluate(([id, h]) => window.leadFinder.outreachConfigure(id, { test: false, interval: 1, quietStart: (h + 6) % 24, quietEnd: (h + 10) % 24, attachStep: 1, links: [{ title: '', url: 'https://example.com/garments' }] }), [gaId, pkHour]);
  assert.ok(gaCfg.ok, gaCfg.error);

  // --- Start both: account picker, acknowledgement once.
  const pick = win.getByRole('dialog', { name: 'Choose WhatsApp account' });
  await catRow('Real Estate').getByRole('switch', { name: 'Real Estate campaign' }).click();
  await pick.locator('.account-option').filter({ hasText: '+923000000001' }).getByRole('radio').check();
  await pick.getByRole('button', { name: 'Start' }).click();
  const ack = win.getByRole('dialog', { name: 'Start live outreach' });
  await ack.getByRole('checkbox').check();
  await ack.getByRole('button', { name: 'Start sending' }).click();
  await catRow('Garments').getByRole('switch', { name: 'Garments campaign' }).click();
  await pick.locator('.account-option').filter({ hasText: '+923000000002' }).getByRole('radio').check();
  await pick.getByRole('button', { name: 'Start' }).click();

  // Each sends message 1 with its links, then the voice files (Real Estate).
  for (let k = 0; k < 40 && log(wa).length < 4; k++) await wait(500);
  const sent = log(wa);
  const re = sent.filter((e) => e.from === '923000000001');
  const ga = sent.filter((e) => e.from === '923000000002');
  assert.equal(re.length, 3, JSON.stringify(sent));
  assert.equal(ga.length, 1, JSON.stringify(sent));
  assert.equal(re[0].jid, '923001234567@s.whatsapp.net', 'the oldest lead first');
  assert.equal(re[0].text, 'Assalam-o-Alaikum Zahid bhai.\n\n*Website demo*\nhttps://demo.example.com/real-estate\n\n*Portfolio*\nhttps://example.com/portfolio');
  assert.deepEqual([re[1].audio.mimetype, re[1].audio.ptt, re[1].audio.bytes, re[1].audio.head], ['audio/ogg; codecs=opus', true, fs.statSync(audio('intro-voice.ogg')).size, 'OggS']);
  assert.deepEqual([re[2].audio.mimetype, re[2].audio.ptt, re[2].audio.bytes], ['audio/mpeg', false, fs.statSync(audio('portfolio-pitch.mp3')).size]);
  assert.match(ga[0].text, /^Assalam-o-Alaikum( Noor bhai)?\.\n\nhttps:\/\/example\.com\/garments$/);
  assert.ok(Math.abs(re[0].at - ga[0].at) < 10_000, 'in parallel');

  // --- Live progress: now sending, next two, See more with the rest.
  await catRow('Real Estate').locator('.campaign-item').click();
  await tab('Overview');
  const liveBox = out.getByRole('region', { name: 'Live progress' });
  await liveBox.getByRole('list', { name: 'Currently sending' }).filter({ hasText: '+923001234567' }).waitFor();
  assert.match(await liveBox.getByRole('list', { name: 'Currently sending' }).innerText(), /Zahid[\s\S]*Real Estate[\s\S]*Sending · 1\/3/);
  const nextList = liveBox.getByRole('list', { name: 'Next recipients' });
  assert.equal(await nextList.locator('li').count(), 2);
  assert.match(await nextList.innerText(), /\+923001112223[\s\S]*\+923002223334/);
  await liveBox.getByRole('button', { name: 'See more (2 more)' }).click();
  assert.equal(await nextList.locator('li').count(), 4);
  // Sent: two shown, the rest behind See more; a click shows the whole message.
  const sentBox = out.getByRole('region', { name: 'Sent messages' });
  await sentBox.locator('tr').nth(1).waitFor();
  assert.equal(await sentBox.locator('tr').count(), 2);
  await sentBox.getByRole('button', { name: 'See more (1 more)' }).click();
  assert.equal(await sentBox.locator('tr').count(), 3);
  await sentBox.locator('tr').filter({ hasText: 'Assalam' }).click();
  await win.getByRole('dialog', { name: 'Message preview' }).getByText('https://example.com/portfolio').waitFor();
  await win.getByRole('dialog', { name: 'Message preview' }).getByRole('button', { name: 'Close' }).click();
  await wait(300);
  await shot('outreach-overview');
  if (shots) {
    await win.emulateMedia({ colorScheme: 'dark' });
    await wait(400);
    await shot('outreach-overview-dark');
    await win.emulateMedia({ colorScheme: 'light' });
  }

  // --- Zahid replies: recorded, his messages 2 and 3 still go (30-60 s
  // apart); then the next contact, with another variation.
  await app.evaluate(() => globalThis.__fakeWAs['923000000001'].incoming('923001234567', 'Ji, bataein'));
  for (let k = 0; k < 400 && log(wa).filter((e) => e.from === '923000000001').length < 8; k++) await wait(1000);
  const re2 = log(wa).filter((e) => e.from === '923000000001');
  assert.equal(re2.length, 8, JSON.stringify(re2));
  assert.deepEqual(re2.slice(3, 5).map((e) => e.jid), ['923001234567@s.whatsapp.net', '923001234567@s.whatsapp.net'], 'Zahid still gets messages 2 and 3');
  for (const k of [3, 4]) assert.ok((re2[k].at - re2[k - (k === 3 ? 3 : 1)].at) / 1000 >= 30, 'at least 30 s after the previous message');
  assert.equal(re2[5].jid, '923001112223@s.whatsapp.net');
  assert.match(re2[5].text, /^Salam Saad!\nKya Saad Estate Agency abhi bhi active hai\?\n\n\*Website demo\*/, 'variation B for the second contact');
  await liveBox.getByRole('list', { name: 'Currently sending' }).filter({ hasText: '+923001112223' }).waitFor();

  // --- Restart: progress is kept, nothing is sent twice.
  const before = log(wa).length;
  const saved = await state(reId);
  await app.close();
  ({ app, win } = await launch());
  st = await state(reId);
  assert.equal(st.status, 'running');
  assert.equal(st.current, '+923001112223');
  assert.deepEqual(st.contacts.map((c) => [c.phone, c.state, c.stage]), saved.contacts.map((c) => [c.phone, c.state, c.stage]));
  await wait(4000);
  assert.equal(log(wa).length, before, 'nothing re-sent after the restart');
  assert.deepEqual(errors, []);
});
