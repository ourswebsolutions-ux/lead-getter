'use strict';
// Outreach message variations (rotation), links, voice files (each part
// reserved, never sent twice), per-campaign daily limits and the queue
// order, against a real (temporary) database and a scripted WhatsApp.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { LeadStore } = require('../src/database/db');
const { OutreachStore } = require('../src/database/wa-store');
const { Outreach, DEFAULT_CAP } = require('../src/whatsapp/outreach');
const { render, validateTemplates, validateLinks, withLinks, normalizeTemplates, cleanUrl } = require('../src/whatsapp/templates');
const { AudioLibrary } = require('../src/whatsapp/audio-library');

const MIN = 60_000;
const START = Date.parse('2026-10-21T05:00:00Z'); // 10:00 in Pakistan
const fixture = (f) => path.join(__dirname, 'fixtures', 'audio', f);

const VOICES = {
  v1: { id: '0123456789abcdef', name: 'intro.ogg', mime: 'audio/ogg; codecs=opus', size: 100, ptt: true },
  v2: { id: 'fedcba9876543210', name: 'pitch.mp3', mime: 'audio/mpeg', size: 200, ptt: false },
};

function setup({ contacts = 4, campaigns = 1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-outreach-media-'));
  const file = path.join(dir, 'leads.db');
  const db = new LeadStore(file);
  const clock = { t: START };
  const sent = [];
  const transport = {
    failAudio: null,
    hang: null, // a send that never returns (the app is closed during it)
    ready: () => true,
    hasAccount: () => true,
    send: async (phone, text, account) => {
      sent.push({ kind: 'text', phone, text, account, at: clock.t });
      return { id: `WA${sent.length}` };
    },
    sendAudio: async (phone, voice, account) => {
      if (transport.hang === voice.id) return new Promise(() => {});
      if (transport.failAudio === voice.id) throw new Error('Media upload failed');
      sent.push({ kind: 'audio', phone, voice: voice.id, account, at: clock.t });
      return { id: `WA${sent.length}` };
    },
  };
  const make = () =>
    new Outreach({
      store: new OutreachStore(db.db),
      state: { get: (k) => db.getState(k), set: (k, v) => db.setState(k, v) },
      transport,
      audio: { info: (id) => Object.values(VOICES).find((v) => v.id === id) || null },
      details: (c) => ({ business: c.name ? `${c.name} Estate` : null }),
      clock: () => clock.t,
      random: () => 0.5,
      tickMs: 1e9,
    });
  const o = make();
  const ids = [];
  for (let k = 0; k < campaigns; k++) {
    const id = o.create(`Campaign ${k + 1}`).id;
    ids.push(id);
    o.campaign(id).addLeads(Array.from({ length: contacts }, (_, i) => ({ phone: `+9230010${k}${String(i).padStart(4, '0')}`, leadId: null, name: `Name${i}` })));
  }
  return { dir, file, db, o, ids, clock, sent, transport, make };
}

async function run(h, ms, o = h.o) {
  const end = h.clock.t + ms;
  while (h.clock.t < end) {
    await o.tick();
    h.clock.t += 30_000;
  }
}

const three = (first) => [{ variations: first }, { variations: [{ text: 'Kaise hain?', fallback: '' }] }, { variations: [{ text: 'Business?', fallback: '' }] }];

test('templates: variations, {business name}, kept line breaks, links', () => {
  const t = three([{ text: 'Salam {name}!\nKya {business name} active hai?', fallback: 'Salam!\nActive?' }, { text: 'Hi {Name}', fallback: 'Hi' }]);
  assert.deepEqual(validateTemplates(t), []);
  assert.equal(render(t[0].variations[0], { name: 'Ali', business: 'Ali Estate' }), 'Salam Ali!\nKya Ali Estate active hai?');
  assert.equal(render(t[0].variations[0], { name: null, business: 'X' }), 'Salam!\nActive?');
  assert.equal(render({ text: 'A {business_name} B', fallback: '' }, { business: 'Z' }), 'A Z B');
  assert.match(validateTemplates(three([])).join(' '), /Message 1 needs at least one version/);
  assert.match(validateTemplates(three([{ text: 'ok', fallback: '' }, { text: ' ', fallback: '' }])).join(' '), /Message 1, variation 2 is empty/);
  assert.match(validateTemplates(three([{ text: 'Hi {name}', fallback: '' }])).join(' '), /needs a version for contacts without a known name/);
  assert.match(validateTemplates(three([{ text: 'Hi {phone}', fallback: 'Hi' }])).join(' '), /unknown placeholder \{phone\}/);
  // A campaign saved by an earlier version: one text per message.
  assert.deepEqual(normalizeTemplates([{ text: ' a ', fallback: '' }]), [{ variations: [{ text: 'a', fallback: '' }] }]);

  assert.equal(cleanUrl('example.com/demo'), 'https://example.com/demo');
  for (const bad of ['javascript:alert(1)', 'ftp://example.com', 'http://localhost', 'not a link', 'https://user:pw@example.com', '']) assert.equal(cleanUrl(bad), null, bad);
  const { links, errors } = validateLinks([{ title: ' Demo ', url: 'demo.example.com' }, { title: '', url: 'https://b.example.com/x?y=1' }]);
  assert.deepEqual(errors, []);
  assert.deepEqual(links, [{ title: 'Demo', url: 'https://demo.example.com/' }, { title: '', url: 'https://b.example.com/x?y=1' }]);
  assert.match(validateLinks([{ url: 'nope' }]).errors.join(' '), /Link 1 is not a valid web address/);
  assert.equal(withLinks('Hello', links), 'Hello\n\n*Demo*\nhttps://demo.example.com/\n\nhttps://b.example.com/x?y=1');
});

test('variations rotate between contacts: the least used next, never the same twice in a row', async () => {
  const h = setup({ contacts: 7 });
  const c = h.o.campaign(h.ids[0]);
  const cfg = c.configure({ test: false, interval: 1, templates: three([{ text: 'A {name}', fallback: 'A' }, { text: 'B {name}', fallback: 'B' }, { text: 'C {name}', fallback: 'C' }]) });
  assert.ok(cfg.ok, cfg.error);
  c.start({ acknowledge: true });
  await run(h, 7 * 4 * MIN);
  const firsts = h.sent.filter((s) => /^[ABC] /.test(s.text)).map((s) => s.text[0]);
  assert.equal(firsts.length, 7);
  assert.deepEqual(firsts, ['A', 'B', 'C', 'A', 'B', 'C', 'A']);
  for (let i = 1; i < firsts.length; i++) assert.notEqual(firsts[i], firsts[i - 1]);
  // Recorded: which variation and the exact text.
  const rows = c.sends().filter((s) => s.stage === 1);
  assert.deepEqual(rows.map((s) => s.variant).reverse(), [0, 1, 2, 0, 1, 2, 0]);
  assert.match(rows.at(-1).body, /^A Name0$/);
  // One variation: always that one.
  const h2 = setup({ contacts: 2 });
  h2.o.campaign(h2.ids[0]).configure({ test: false, interval: 1 });
  h2.o.campaign(h2.ids[0]).start({ acknowledge: true });
  await run(h2, 10 * MIN);
  assert.ok(h2.sent.filter((s) => s.text.startsWith('Assalam')).length >= 2);
});

test('links go with the chosen message; voice files are sent right after it, in their order', async () => {
  const h = setup({ contacts: 1 });
  const c = h.o.campaign(h.ids[0]);
  const r = c.configure({ test: false, attachStep: 2, links: [{ title: 'Demo', url: 'demo.example.com' }], voices: [VOICES.v1.id, { id: VOICES.v2.id, name: 'renamed-by-window.mp3' }] });
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.snapshot.config.voices, [VOICES.v1, VOICES.v2], 'details come from the saved files, not the window');
  c.start({ acknowledge: true });
  await run(h, 5 * MIN);
  assert.deepEqual(
    h.sent.map((s) => (s.kind === 'text' ? s.text.split('\n')[0] : s.voice)),
    ['Assalam-o-Alaikum Name0 bhai.', 'Kaise hain aap? Umeed hai aap khairiyat se honge.', VOICES.v1.id, VOICES.v2.id, 'Kya aap Name0 Estate ke naam se real estate ka kaam karte hain, ya kisi aur business se related hain?'],
  );
  assert.equal(h.sent[1].text, 'Kaise hain aap? Umeed hai aap khairiyat se honge.\n\n*Demo*\nhttps://demo.example.com/');
  assert.equal(h.sent[0].text, 'Assalam-o-Alaikum Name0 bhai.', 'no links on the other messages');
  const parts = c.sends().filter((s) => s.stage === 2).sort((a, b) => a.part - b.part);
  assert.deepEqual(parts.map((p) => [p.part, p.kind, p.status, p.body]), [[0, 'text', 'sent', h.sent[1].text], [1, 'audio', 'sent', 'intro.ogg'], [2, 'audio', 'sent', 'pitch.mp3']]);
  // The daily count is unique contacts (voice files don't count).
  assert.equal(c.snapshot().today.recipients, 1);
  // Bad settings are refused.
  c.stop();
  assert.match(c.configure({ links: [{ url: 'javascript:alert(1)' }] }).error, /not a valid web address/);
  assert.match(c.configure({ voices: ['00000000000000aa'] }).error, /no longer available/);
  assert.match(c.configure({ attachStep: 4 }).error, /links and voice files go with/);
});

test('a failed voice file is recorded and the next one still goes; nothing is retried twice', async () => {
  const h = setup({ contacts: 1 });
  const c = h.o.campaign(h.ids[0]);
  c.configure({ test: false, attachStep: 1, voices: [VOICES.v1.id, VOICES.v2.id] });
  h.transport.failAudio = VOICES.v1.id;
  const events = [];
  h.o.on('failed', (e) => events.push(e));
  c.start({ acknowledge: true });
  await h.o.tick();
  assert.deepEqual(h.sent.map((s) => s.kind + (s.voice ? `:${s.voice}` : '')), ['text', `audio:${VOICES.v2.id}`]);
  const parts = c.sends().filter((s) => s.stage === 1).sort((a, b) => a.part - b.part);
  assert.deepEqual(parts.map((p) => [p.part, p.status]), [[0, 'sent'], [1, 'failed'], [2, 'sent']]);
  assert.match(events[0].error, /Voice file “intro\.ogg”: Media upload failed/);
  assert.equal(c.snapshot().status, 'running', 'the campaign goes on');
  h.transport.failAudio = null;
  await run(h, 5 * MIN);
  assert.equal(h.sent.filter((s) => s.kind === 'audio').length, 1, 'voice files are not sent again with later messages');
});

test('no voice file is sent twice: a restart in the middle of sending one', async () => {
  const h = setup({ contacts: 1 });
  const c = h.o.campaign(h.ids[0]);
  c.configure({ test: false, attachStep: 1, voices: [VOICES.v1.id, VOICES.v2.id] });
  h.transport.hang = VOICES.v2.id; // the app closes while the second one is being sent
  c.start({ acknowledge: true });
  h.o.tick();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(h.sent.map((s) => s.kind), ['text', 'audio']);
  h.o.dispose();
  // Restart: the interrupted part is "unknown" (may have arrived), never resent.
  h.transport.hang = null;
  h.clock.t += 5 * MIN;
  const o2 = h.make();
  o2.init();
  o2.dispose();
  await run(h, 10 * MIN, o2);
  const audio = h.sent.filter((s) => s.kind === 'audio').map((s) => s.voice);
  assert.deepEqual(audio, [VOICES.v1.id], 'the voice file being sent at the crash is not sent again');
  const part2 = o2.campaign(h.ids[0]).sends().find((s) => s.stage === 1 && s.part === 2);
  assert.equal(part2.status, 'unknown');
  assert.equal(h.sent.filter((s) => s.kind === 'text' && s.text.startsWith('Assalam')).length, 1, 'message 1 not sent again');
});

test('daily limit: 15 by default, any number from 1, per campaign', async () => {
  const h = setup({ contacts: 30, campaigns: 2 });
  const [a, b] = h.ids.map((id) => h.o.campaign(id));
  assert.equal(a.snapshot().config.dailyCap, DEFAULT_CAP);
  assert.equal(DEFAULT_CAP, 15);
  assert.ok(a.configure({ test: false, dailyCap: 25, interval: 1, quietStart: 0, quietEnd: 0 }).ok, 'above 15');
  assert.ok(b.configure({ test: false, dailyCap: 3, interval: 1, quietStart: 0, quietEnd: 0 }).ok);
  assert.match(a.configure({ dailyCap: 0 }).error, /at least 1/);
  a.start({ acknowledge: true, accountId: 'wa-1' });
  b.start({ acknowledge: true, accountId: 'wa-2' });
  await run(h, 8 * 60 * MIN); // the same day
  const people = (acc) => new Set(h.sent.filter((s) => s.account === acc).map((s) => s.phone)).size;
  assert.equal(people('wa-1'), 25, 'campaign A: its own limit (25)');
  assert.equal(people('wa-2'), 3, 'campaign B: its own limit (3)');
  assert.equal(a.snapshot().waiting, 'daily_cap');
  assert.deepEqual(a.snapshot().today, { day: a.snapshot().today.day, recipients: 25, cap: 25 });
});

test('the queue in order: the contact in progress, the next ones, the rest', async () => {
  const h = setup({ contacts: 5 });
  const c = h.o.campaign(h.ids[0]);
  c.configure({ test: false });
  c.exclude('+923001000002');
  c.start({ acknowledge: true });
  await h.o.tick();
  const s = c.snapshot();
  assert.equal(s.current, '+923001000000');
  assert.deepEqual(s.upcoming, ['+923001000001', '+923001000003', '+923001000004'], 'excluded and current contacts are not listed');
});

test('voice files: checked by content, copied as they are, pruned when unused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-audio-'));
  const kv = new Map();
  const lib = new AudioLibrary({ dir: path.join(dir, 'store'), state: { get: (k) => kv.get(k), set: (k, v) => kv.set(k, v) } });
  const ogg = lib.add(fixture('intro-voice.ogg'));
  const mp3 = lib.add(fixture('portfolio-pitch.mp3'));
  assert.ok(ogg.ok && mp3.ok);
  assert.deepEqual([ogg.voice.mime, ogg.voice.ptt], ['audio/ogg; codecs=opus', true]);
  assert.deepEqual([mp3.voice.mime, mp3.voice.ptt], ['audio/mpeg', false]);
  assert.ok(lib.read(mp3.voice.id).data.equals(fs.readFileSync(fixture('portfolio-pitch.mp3'))), 'byte for byte');
  assert.match(lib.dataUrl(ogg.voice.id), /^data:audio\/ogg;base64,T2dnUw/);
  assert.match(lib.add(fixture('demo.wav')).error, /format isn’t supported\. Use MP3, M4A, AAC, Ogg\/Opus or AMR/);
  assert.match(lib.add(fixture('not-really.ogg')).error, /is really MP3: rename it to \.mp3/);
  const empty = path.join(dir, 'empty.mp3');
  fs.writeFileSync(empty, '');
  assert.match(lib.add(empty).error, /is empty/);
  const fake = path.join(dir, 'fake.m4a');
  fs.writeFileSync(fake, 'hello world, not audio');
  assert.match(lib.add(fake).error, /is not a valid M4A file/);
  const big = path.join(dir, 'big.mp3');
  fs.writeFileSync(big, Buffer.alloc(16 * 1024 * 1024 + 1, 0xff));
  assert.match(lib.add(big).error, /larger than 16 MB/);
  assert.match(lib.add(path.join(dir, 'missing.mp3')).error, /could not be opened/);
  // The original can go away: the copy is sent.
  assert.equal(lib.info('nothex'), null);
  assert.equal(lib.prune([ogg.voice.id]), 1);
  assert.equal(lib.info(mp3.voice.id), null);
  assert.ok(lib.info(ogg.voice.id));
});

test('database version 19 keeps earlier sends and adds parts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-v19-'));
  const file = path.join(dir, 'leads.db');
  const s = new LeadStore(file);
  const store = new OutreachStore(s.db);
  const id = store.createCampaign('Old', {}, START);
  store.reserve({ campaignId: id, phone: '+923001234567', stage: 1, test: false, day: '2026-10-21', now: START });
  // As an earlier version left it: no parts.
  s.db.exec('PRAGMA user_version = 18;');
  s.db.exec(`CREATE TABLE old_sends AS SELECT id, campaign_id, campaign_name, phone, stage, test, day, status, wa_id, error, created_at, sent_at FROM outreach_sends;
    DROP TABLE outreach_sends;
    CREATE TABLE outreach_sends (id INTEGER PRIMARY KEY, campaign_id INTEGER, campaign_name TEXT, phone TEXT NOT NULL, stage INTEGER NOT NULL, test INTEGER NOT NULL DEFAULT 0, day TEXT NOT NULL, status TEXT NOT NULL, wa_id TEXT, error TEXT, created_at INTEGER NOT NULL, sent_at INTEGER, UNIQUE (campaign_id, phone, stage, test));
    INSERT INTO outreach_sends SELECT * FROM old_sends; DROP TABLE old_sends;`);
  s.close();
  const up = new LeadStore(file);
  assert.equal(up.db.prepare('PRAGMA user_version').get().user_version, 19);
  const rows = new OutreachStore(up.db).sends({ campaignId: id, test: false });
  assert.deepEqual(rows.map((r) => [r.phone, r.stage, r.part, r.kind]), [['+923001234567', 1, 0, 'text']]);
  // The same stage can't be reserved twice; its parts can, once each.
  const st = new OutreachStore(up.db);
  assert.equal(st.reserve({ campaignId: id, phone: '+923001234567', stage: 1, test: false, day: '2026-10-21' }), null);
  assert.ok(st.reserve({ campaignId: id, phone: '+923001234567', stage: 1, part: 1, kind: 'audio', test: false, day: '2026-10-21' }));
  assert.equal(st.reserve({ campaignId: id, phone: '+923001234567', stage: 1, part: 1, kind: 'audio', test: false, day: '2026-10-21' }), null);
  up.close();
  assert.ok(new DatabaseSync(file));
});
