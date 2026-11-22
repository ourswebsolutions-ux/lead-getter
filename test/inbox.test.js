'use strict';
// The Inbox: only leads who replied; one conversation per lead and channel;
// our campaign message shown first; the same reply never added twice; and
// email replies reach it from the reply watcher (the admin's emailed answer
// is handed on separately).
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { Inbox } = require('../src/main/inbox');
const { ReplyWatcher } = require('../src/email/replies');

test('Inbox: threads per lead and channel, the campaign message first, duplicates ignored, answers recorded, unread counts', () => {
  const inbox = new Inbox({ db: new DatabaseSync(':memory:') });
  const seen = [];
  inbox.on('incoming', (e) => seen.push(e));
  const a = inbox.incoming({ channel: 'email', address: 'Zahid@Realty.pk', name: 'Zahid Properties', campaignName: 'RE', subject: 'Re: Website', text: 'Price kya hai?', extId: '<m1@x>', sent: 'Website for Zahid Properties\n\nHello...' });
  assert.ok(a.isNew);
  assert.equal(inbox.incoming({ channel: 'email', address: 'zahid@realty.pk', text: 'Price kya hai?', extId: '<m1@x>' }), null, 'the same email again (inbox read twice)');
  inbox.incoming({ channel: 'email', address: 'zahid@realty.pk', text: 'Aur demo?', extId: '<m2@x>' });
  inbox.incoming({ channel: 'whatsapp', address: '+923001234567', name: 'Ali Garments', text: 'Haan batao' });
  assert.equal(seen.length, 3);
  const threads = inbox.threads();
  assert.equal(threads.length, 2);
  assert.equal(threads[0].channel, 'whatsapp', 'latest first');
  const msgs = inbox.messages(a.thread.id);
  assert.deepEqual(msgs.map((m) => [m.direction, m.via]), [['out', 'campaign'], ['in', 'lead'], ['in', 'lead']]);
  assert.equal(inbox.unreadCount(), 3);
  inbox.markRead(a.thread.id);
  assert.equal(inbox.unreadCount(), 1);
  inbox.outgoing(a.thread.id, 'Demo bhej raha hoon', { via: 'admin-whatsapp' });
  assert.equal(inbox.messages(a.thread.id).at(-1).via, 'admin-whatsapp');
});

test('Reply watcher: replies go to the Inbox with their text (quoted text left out), unsubscribe requests too; other senders are handed on', async () => {
  const replies = [];
  const others = [];
  const accounts = { inbox: () => ({ account: {}, pass: 'x' }), setImapStatus: () => {} };
  const campaigns = { sentAddresses: () => new Set(['zahid@realty.pk', 'noor@estate.pk']), recordReply: () => ({ first: true }) };
  const m = new Map();
  const w = new ReplyWatcher({
    accounts,
    campaigns,
    state: { get: (k) => m.get(k), set: (k, v) => m.set(k, v) },
    onReply: (r) => replies.push(r),
    onOther: (r) => others.push(r),
    openInbox: async function* () {
      yield { from: 'zahid@realty.pk', subject: 'Re: Website', text: 'Price kya hai?\n\nOn Mon, Ali wrote:\n> Hello', messageId: '<1>' };
      yield { from: 'noor@estate.pk', subject: 'unsubscribe', text: '', messageId: '<2>' };
      yield { from: 'boss@axora.pk', subject: 'Re: [#4] Email reply', text: 'Demo bhej do', messageId: '<3>' };
    },
  });
  await w.check('acc1');
  assert.deepEqual(replies.map((r) => [r.from, r.text, r.messageId, r.unsubscribe]), [['zahid@realty.pk', 'Price kya hai?', '<1>', false], ['noor@estate.pk', 'unsubscribe', '<2>', true]]);
  assert.deepEqual(others.map((r) => [r.from, r.subject]), [['boss@axora.pk', 'Re: [#4] Email reply']]);
});
