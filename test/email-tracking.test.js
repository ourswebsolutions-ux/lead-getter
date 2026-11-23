'use strict';
// Click tracking: links signed and rewritten for each recipient, the real
// Worker (served locally) records a click and redirects, Lead Finder fetches
// the clicks and shows who clicked; scanners, duplicates and forged links
// are not counted.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { startSmtp } = require('./fake-smtp');
const { startTracker } = require('./fake-tracker');
const { EmailAccounts } = require('../src/email/accounts');
const { EmailCampaigns, compose } = require('../src/email/campaigns');
const { EmailVerification } = require('../src/email/verification');
const { startMx, testEngine } = require('./fake-mx');
const { ClickTracker, normalizeBase, isBot } = require('../src/email/tracking');
const { Vault } = require('../src/main/vault');

function memState() {
  const m = new Map();
  return { getState: (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setState: (k, v) => m.set(k, JSON.stringify(v)), raw: m };
}
const cipher = { encrypt: (t) => Buffer.from(String(t), 'utf8').reverse(), decrypt: (b) => Buffer.from(b).reverse().toString('utf8') };
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const LEADS = [
  { id: 1, name: 'Zahid Properties', contactName: 'Zahid Khan', email: 'zahid@realty.pk', categoryId: 1, kind: 'business' },
  { id: 2, name: 'Noor Estate', email: 'info@noor.pk', categoryId: 1, kind: 'business' },
];

function trackerFor(state, vault, extra = {}) {
  return new ClickTracker({ state: { get: (k) => state.getState(k), set: (k, v) => state.setState(k, v) }, vault, allowInsecure: true, pollMs: 3_600_000, ...extra });
}

// The tracked links in a sent email (text part: plain "&"; HTML: "&amp;").
const linksIn = (raw) => [...raw.matchAll(/(http:\/\/127\.0\.0\.1:\d+\/)\?t=([\w-]+)&(?:amp;)?u=([\w-]+)&(?:amp;)?s=([\w-]+)/g)].map((m) => ({ href: `${m[1]}?t=${m[2]}&u=${m[3]}&s=${m[4]}`, t: m[2], url: Buffer.from(m[3], 'base64url').toString('utf8') }));

test('Tracking address: https only, a folder gets its "/"', () => {
  assert.equal(normalizeBase('yourdomain.com/t').base, 'https://yourdomain.com/t/');
  assert.equal(normalizeBase('https://yourdomain.com/t/index.php').base, 'https://yourdomain.com/t/index.php');
  assert.equal(normalizeBase('https://clicks.ali.workers.dev').base, 'https://clicks.ali.workers.dev/');
  assert.equal(normalizeBase('http://yourdomain.com/t/').ok, false);
  assert.equal(normalizeBase('http://127.0.0.1:9/', { allowInsecure: true }).ok, true);
  assert.equal(normalizeBase('https://x.com/t/?a=1').ok, false);
  assert.equal(normalizeBase('').ok, false);
  assert.ok(isBot('') && isBot('python-requests/2.31') && isBot('Mozilla/5.0 (compatible; Barracuda Sentinel)'));
  assert.ok(!isBot(BROWSER));
});

test('Links rewritten for one recipient: shown text kept, mailto and duplicates of the address left alone', () => {
  const state = memState();
  const tr = trackerFor(state, new Vault({ store: state, key: 's', cipher }));
  tr.ensureKey();
  tr.save({ base: 'https://axora.pk/t/', connectedAt: 1 });
  const msg = compose({ subject: 'Hi', body: 'See https://axora.pk/demo?x=1&y=2 and <a href="mailto:a@b.pk">mail</a>' }, {});
  const html = compose({ subject: 'Hi', body: '<p><a href="https://axora.pk/price?a=1&amp;b=2">Prices</a> <a href="mailto:a@b.pk">mail</a></p>' }, {});
  const out = tr.rewrite(msg, 'abc123');
  assert.match(out.text, /See https:\/\/axora\.pk\/t\/\?t=abc123&u=[\w-]+&s=[\w-]{22} and/);
  const u = /u=([\w-]+)/.exec(out.text)[1];
  assert.equal(Buffer.from(u, 'base64url').toString(), 'https://axora.pk/demo?x=1&y=2');
  const h = tr.rewrite(html, 'abc123').html;
  assert.match(h, /<a href="https:\/\/axora\.pk\/t\/\?t=abc123&amp;u=[\w-]+&amp;s=[\w-]+">Prices<\/a>/, 'the link text is unchanged');
  assert.equal(Buffer.from(/u=([\w-]+)/.exec(h)[1], 'base64url').toString(), 'https://axora.pk/price?a=1&b=2', 'entities decoded before signing');
  assert.match(h, /href="mailto:a@b\.pk"/);
  assert.equal(tr.rewrite(out, 'abc123').text, out.text, 'a tracked link is not tracked twice');
});

test('Click tracking end to end: connect, tracked email, a click redirects and is fetched; scanners, duplicates and forged links not counted', async (t) => {
  const smtp = await startSmtp();
  const srv = await startTracker();
  t.after(async () => {
    await smtp.close();
    await srv.close();
  });
  const state = memState();
  const db = new DatabaseSync(':memory:');
  const vault = new Vault({ store: state, key: 'secrets', cipher });
  const accounts = new EmailAccounts({ store: state, vault, allowInsecure: true });
  const time = { now: Date.now() - 120_000 }; // sent two minutes ago: a click now is a person's
  const campaigns = new EmailCampaigns({ db, accounts, leads: () => LEADS, clock: () => time.now, tickMs: 60_000 });
  const tracker = trackerFor(state, vault);
  tracker.onClick = (c) => campaigns.recordClick(c);
  campaigns.tracker = tracker;
  // Verification against a local mail server (every test mailbox exists).
  const mx = await startMx({ exists: (e) => !e.includes('nouser') });
  campaigns.verification = new EmailVerification({ db, state: { get: (k) => state.getState(k), set: (k, v) => state.setState(k, v) }, makeEngine: testEngine(mx), clock: () => time.now });
  t.after(async () => {
    tracker.stop();
    campaigns.dispose();
    accounts.dispose();
    campaigns.verification.stop();
    await mx.close();
  });

  // Not connected: links go out as they are.
  const acc = accounts.add({ name: 'SMTP', senderName: 'Axora', email: 'sender@example.com', host: '127.0.0.1', port: smtp.port, username: 'sender@example.com', password: 'pw', encryption: 'none' }).account;
  const c = campaigns.create({ name: 'Offer' });
  campaigns.update(c.id, { accountId: acc.id, subject: 'Websites for {business}', body: 'Hello {name},\n\nOur demo: https://axora.pk/demo\n\nAli', delaySeconds: 10 });
  assert.equal(campaigns.summary(c.id).tracking, false);

  // Connected (pairing + a test click through the real Worker).
  const bad = await tracker.connect('http://127.0.0.1:1/');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /could not be reached/);
  const r = await tracker.connect(srv.base);
  assert.ok(r.ok, r.error);
  assert.equal(tracker.status().connected, true);
  assert.ok(!JSON.stringify(tracker.status()).includes(tracker.key()), 'the key is never shown');
  assert.ok(![...state.raw.values()].some((v) => v.includes(tracker.key())), 'the key is only in the vault (encrypted)');
  assert.equal(campaigns.summary(c.id).tracking, true);

  campaigns.addLeads(c.id, {});
  assert.ok((await campaigns.start(c.id)).ok);
  await campaigns.tick();
  time.now += 11_000;
  await campaigns.tick();
  assert.equal(smtp.messages.length, 2);
  const zahidMail = smtp.messages.find((m) => m.to.includes('zahid@realty.pk'));
  const links = linksIn(zahidMail.text);
  assert.equal(links.length, 2, 'text and HTML parts');
  assert.equal(links[0].url, 'https://axora.pk/demo');
  assert.match(zahidMail.text, />https:\/\/axora\.pk\/demo<\/a>/, 'the reader still sees the real address');
  const noorT = linksIn(smtp.messages.find((m) => m.to.includes('info@noor.pk')).text)[0].t;
  assert.notEqual(links[0].t, noorT, 'each recipient has their own links');

  // A person clicks: sent on to the page, and counted once fetched.
  const click = await fetch(links[0].href, { redirect: 'manual', headers: { 'User-Agent': BROWSER } });
  assert.equal(click.status, 302);
  assert.equal(click.headers.get('location'), 'https://axora.pk/demo');
  await fetch(links[1].href, { redirect: 'manual', headers: { 'User-Agent': BROWSER } }); // a second click
  // A link scanner, and a forged link (another address, same signature): not counted / refused.
  await fetch(linksIn(smtp.messages.find((m) => m.to.includes('info@noor.pk')).text)[0].href, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Barracuda Sentinel)' } });
  const forged = links[0].href.replace(/u=[\w-]+/, `u=${Buffer.from('https://evil.example/').toString('base64url')}`);
  const no = await fetch(forged, { redirect: 'manual', headers: { 'User-Agent': BROWSER } });
  assert.equal(no.status, 404, 'never redirects to a link it was not given');
  assert.equal(srv.clicks().filter((x) => !x.t.startsWith('test-')).length, 3);

  const p = await tracker.poll();
  assert.ok(p.ok, p.error);
  assert.equal(p.clicks, 2);
  const s = campaigns.summary(c.id);
  assert.equal(s.clicks, 1, 'one person clicked');
  const snap = campaigns.snapshot(c.id);
  const z = snap.recipients.find((x) => x.email === 'zahid@realty.pk');
  assert.ok(z.clickedAt);
  assert.equal(z.clicks, 2);
  assert.equal(snap.recipients.find((x) => x.email === 'info@noor.pk').clickedAt, null, 'the scanner is not counted');
  assert.ok(snap.log.some((l) => /zahid@realty\.pk clicked https:\/\/axora\.pk\/demo/.test(l.text)));
  assert.deepEqual(campaigns.clickers(c.id).map((x) => x.email), ['zahid@realty.pk']);

  // Fetched again (the overlap): nothing counted twice.
  assert.equal((await tracker.poll()).clicks, 0);
  assert.equal(campaigns.snapshot(c.id).recipients.find((x) => x.email === 'zahid@realty.pk').clicks, 2);

  // Opened by a scanner seconds after delivery: not counted.
  assert.equal(campaigns.recordClick({ id: 'x1', t: noorT, url: 'https://axora.pk/demo', at: time.now + 3_000, ua: BROWSER, bot: false }).recorded, false);

  // Turned off: the next emails keep their links as they are; the campaign switch too.
  tracker.disconnect();
  assert.equal(campaigns.summary(c.id).tracking, false);
  const off = compose(campaigns.row(c.id), {});
  assert.match(off.text, /https:\/\/axora\.pk\/demo/);

  // Pairing is kept by the server: another Lead Finder (another key) cannot take it over.
  const other = trackerFor(memState(), new Vault({ store: memState(), key: 's2', cipher }));
  const taken = await other.connect(srv.base);
  assert.equal(taken.ok, false);
  assert.match(taken.error, /paired with another Lead Finder/);
  // The same one pairs again.
  assert.ok((await tracker.connect(srv.base)).ok);
});

test('Campaign switch "Track link clicks" off: links untouched even when tracking is on; test emails tracked into the history', async (t) => {
  const smtp = await startSmtp();
  const srv = await startTracker();
  t.after(async () => {
    await smtp.close();
    await srv.close();
  });
  const state = memState();
  const vault = new Vault({ store: state, key: 'secrets', cipher });
  const accounts = new EmailAccounts({ store: state, vault, allowInsecure: true });
  const campaigns = new EmailCampaigns({ db: new DatabaseSync(':memory:'), accounts, leads: () => LEADS, tickMs: 60_000 });
  const tracker = trackerFor(state, vault);
  tracker.onClick = (c) => campaigns.recordClick(c);
  campaigns.tracker = tracker;
  t.after(() => {
    campaigns.dispose();
    accounts.dispose();
  });
  assert.ok((await tracker.connect(srv.base)).ok);
  const acc = accounts.add({ name: 'SMTP', email: 'sender@example.com', host: '127.0.0.1', port: smtp.port, username: 'sender@example.com', password: 'pw', encryption: 'none' }).account;
  const c = campaigns.create({ name: 'Offer' });
  campaigns.update(c.id, { accountId: acc.id, subject: 'Hi', body: 'Demo: https://axora.pk/demo' });

  assert.ok((await campaigns.sendTest(c.id, 'me@example.com')).ok);
  const testLink = linksIn(smtp.messages[0].text)[0];
  assert.match(testLink.t, /^test-\d+$/);
  await fetch(testLink.href, { redirect: 'manual', headers: { 'User-Agent': BROWSER } });
  await tracker.poll();
  assert.ok(campaigns.snapshot(c.id).log.some((l) => /Test email: link clicked/.test(l.text)));
  assert.equal(campaigns.summary(c.id).clicks, 0, 'a test click is not a lead’s click');

  campaigns.update(c.id, { trackClicks: false });
  assert.equal(campaigns.summary(c.id).tracking, false);
  assert.ok((await campaigns.sendTest(c.id, 'me@example.com')).ok);
  assert.equal(linksIn(smtp.messages[1].text).length, 0);
  assert.match(smtp.messages[1].text, /Demo: https:\/\/axora\.pk\/demo/);
});
