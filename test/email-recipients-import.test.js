'use strict';
// People to email, imported as text or from a file: parsed in every common
// form, saved as leads when new, added to a campaign (also a running one);
// unsubscribed and duplicate addresses handled.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseRecipients, tableToLines } = require('../src/email/recipients-import');
const { createEmail } = require('../src/email/service');
const { LeadStore } = require('../src/database/db');
const { Vault } = require('../src/main/vault');

test('Recipients from text: "email, name, business", "Name <email>", bare addresses, several on a line', () => {
  const { list, invalid } = parseRecipients(
    [
      'Email, Name, Company',
      'client@company.com',
      'ahmed@gmail.com, Ahmed Khan, Khan Traders',
      'Sara <Sara@BrightHomes.pk>',
      'Zahid Properties <info@zahid.pk>',
      'info@noor.pk; Noor Estate',
      'a@x.pk b@y.pk',
      'CLIENT@company.com, again',
      'bad@x',
    ].join('\n'),
  );
  assert.deepEqual(list, [
    { email: 'client@company.com', name: null, business: null },
    { email: 'ahmed@gmail.com', name: 'Ahmed Khan', business: 'Khan Traders' },
    { email: 'sara@brighthomes.pk', name: 'Sara', business: null },
    { email: 'info@zahid.pk', name: null, business: 'Zahid Properties' },
    { email: 'info@noor.pk', name: null, business: 'Noor Estate' },
    { email: 'a@x.pk', name: null, business: null },
    { email: 'b@y.pk', name: null, business: null },
  ]);
  assert.equal(invalid, 0, '"bad@x" is not an address at all');
  const t = tableToLines(['Client', 'E-mail', 'Company'], [['Ali', 'ali@x.pk', 'Axora'], ['No mail', '', 'X']]);
  assert.deepEqual(t.lines, ['ali@x.pk, Ali, Axora']);
  assert.deepEqual(tableToLines(['A', 'B'], [['x', 'zz@q.pk']]).lines, ['zz@q.pk']);
  assert.equal(tableToLines(['A'], [['x']]).ok, false);
});

test('Import people to email: new contacts saved as leads, added to a new or running campaign, duplicates and unsubscribes handled', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-rcpt-'));
  const store = new LeadStore(path.join(dir, 'leads.db'));
  t.after(() => {
    email.campaigns.dispose();
    email.accounts.dispose();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  store.save({ placeKey: '0x1:0x7', mapsUrl: 'https://www.google.com/maps/place/Z1', name: 'Zahid Properties', address: 'DHA, Lahore', websiteStatus: 'no_website' });
  const zahid = store.listLeads({})[0];
  store.saveLeadEmails(zahid.id, { emails: ['zahid@realty.pk'] });
  const vault = new Vault({ store, key: 'secrets', cipher: null });
  var email = createEmail({ store, vault, files: null, canSend: async () => true, allowInsecure: true });

  assert.equal(email.importRecipients('no addresses here', { name: 'X' }).ok, false);
  assert.match(email.importRecipients('a@b.pk', {}).error, /name/);
  const r = email.importRecipients('ahmed@gmail.com, Ahmed Khan, Khan Traders\nzahid@realty.pk\nclient@company.com', { name: 'My clients' });
  assert.ok(r.ok, r.error);
  assert.equal(r.added, 3);
  assert.equal(r.newLeads, 2, 'Zahid was already a lead');
  assert.equal(store.listLeads({}).length, 3);
  const imported = store.listLeads({ source: 'import' });
  assert.deepEqual(imported.map((l) => l.email).sort(), ['ahmed@gmail.com', 'client@company.com']);
  const snap = email.campaigns.snapshot(r.campaignId);
  const ahmed = snap.recipients.find((x) => x.email === 'ahmed@gmail.com');
  assert.equal(ahmed.name, 'Ahmed');
  assert.equal(ahmed.business, 'Khan Traders');
  const bare = snap.recipients.find((x) => x.email === 'client@company.com');
  assert.equal(bare.business, null, 'no business made up from the address');

  // Again, plus one unsubscribed: nobody twice; into the same campaign even while it runs.
  email.campaigns.optOut('stop@x.pk');
  email.campaigns.db.prepare("UPDATE email_campaigns SET status = 'running' WHERE id = ?").run(r.campaignId);
  const again = email.importRecipients('client@company.com\nstop@x.pk\nnew@y.pk, Bilal', { id: r.campaignId });
  assert.ok(again.ok, again.error);
  assert.equal(again.added, 1);
  assert.equal(again.already, 1);
  assert.equal(again.optedOut, 1);
  assert.equal(email.campaigns.snapshot(r.campaignId).recipients.find((x) => x.email === 'new@y.pk').business, null, 'a person’s name is not a business');

  // Into a category campaign's waiting list: at the top, sent before the
  // leads already waiting; an address already waiting moves up too.
  const cat = store.ensureCategory('Real Estate');
  for (const [i, e] of ['w1@re.pk', 'w2@re.pk', 'w3@re.pk'].entries()) {
    store.save({ placeKey: `0x2:${i}`, mapsUrl: `https://www.google.com/maps/place/W${i}`, name: `Wait ${i}`, address: 'Lahore', websiteStatus: 'no_website', categoryId: cat.id });
    store.saveLeadEmails(store.listLeads({}).find((l) => l.name === `Wait ${i}`).id, { emails: [e] });
  }
  const cc = email.campaigns.categoryCampaign(String(cat.id), 'Real Estate');
  email.campaigns.syncQueue(email.campaigns.row(cc.id), true);
  const c = email.campaigns.row(cc.id);
  assert.deepEqual(email.campaigns.nextRecipients(c, Date.now(), 10).map((x) => x.email), ['w1@re.pk', 'w2@re.pk', 'w3@re.pk']);
  const top = email.importRecipients('vip@client.pk, Vip Client\nw3@re.pk', { id: cc.id });
  assert.ok(top.ok, top.error);
  assert.equal(top.added, 1);
  assert.equal(top.movedUp, 1);
  assert.equal(top.already, 0);
  const order = email.campaigns.nextRecipients(c, Date.now(), 10).map((x) => x.email);
  assert.deepEqual(order, ['w3@re.pk', 'vip@client.pk', 'w1@re.pk', 'w2@re.pk']);
  assert.equal(email.campaigns.nextRecipient(c, Date.now()).email, 'w3@re.pk');
  // The list shows them in that order, marked.
  const waiting = email.campaigns.snapshot(cc.id).recipients.filter((x) => x.state === 'queued');
  assert.deepEqual(waiting.map((x) => x.email), order);
  assert.deepEqual(waiting.map((x) => x.priority), [1, 1, 0, 0]);
});
