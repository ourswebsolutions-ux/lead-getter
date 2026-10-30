'use strict';
// Imported phone numbers: reading CSV, Excel (a real .xlsx made by
// LibreOffice), TXT and pasted text; column guessing; international format;
// duplicates; number categories in the database (counts, move, delete,
// reset, Call Seen apart from leads and WhatsApp).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readTable, guessMapping, buildItems, normalize, kindOf } = require('../src/numbers/import');
const { LeadStore } = require('../src/database/db');

test('Excel (.xlsx): the first sheet, header names mapped, numbers written out in full', () => {
  const t = readTable(fs.readFileSync(path.join(__dirname, 'fixtures', 'numbers.xlsx')), 'xlsx');
  assert.deepEqual(t.headers, ['Name', 'Company', 'Mobile Number', 'City']);
  assert.equal(t.rows.length, 6);
  assert.deepEqual(t.rows[5], ['Zoë Müller', 'Design & Co', '+44 7911 123456', 'London']);
  const map = guessMapping(t);
  assert.deepEqual(map, { name: 0, business: 1, phone: 2, city: 3 });
  const r = buildItems(t, map, { country: 'PK' });
  assert.deepEqual(r.items.map((i) => i.phone), ['+923001112233', '+923214445566', '+924235761234', '+447911123456']);
  assert.equal(r.duplicates, 1);
  assert.equal(r.invalid, 1);
  assert.equal(r.items[0].name, 'Ali Raza');
  assert.equal(r.items[0].business, 'SEO Hub');
  assert.deepEqual(r.items[0].extra, { city: 'Lahore' });
  assert.equal(r.items[2].mobile, false); // a landline
});

test('CSV with other column names; TXT; pasted lines with names', () => {
  const csv = readTable('Contact Name;Phone Number;Notes\nAli;0300-1234567;met at expo\n', 'csv');
  assert.deepEqual(guessMapping(csv), { name: 0, phone: 1, notes: 2 });
  assert.equal(buildItems(csv, guessMapping(csv), { country: 'PK' }).items[0].phone, '+923001234567');
  const txt = readTable('+92 300 1234567\n0321 4445566   0333 7778889\n\nnot a number\n', 'txt');
  assert.equal(txt.headers, null);
  const items = buildItems(txt, guessMapping(txt), { country: 'PK' }).items.map((i) => i.phone);
  assert.deepEqual(items, ['+923001234567', '+923214445566', '+923337778889']);
  const pasted = readTable('Ali Raza, SEO Hub, 0321 4445566\nSara, Web Works, +44 7911 123456', 'txt');
  const m = guessMapping(pasted);
  assert.equal(m.phone, 2);
  assert.equal(buildItems(pasted, { ...m, name: 0, business: 1 }, { country: 'PK' }).items[1].business, 'Web Works');
  assert.equal(kindOf('a/b/List.XLSX'), 'xlsx');
});

test('numbers: international format when valid; kept but marked when not', () => {
  assert.deepEqual(normalize('0300 1234567', 'PK'), { phone: '+923001234567', raw: '0300 1234567', valid: true, mobile: true });
  assert.equal(normalize('0092 300 1234567', 'GB').phone, '+923001234567');
  assert.equal(normalize('12345', 'PK'), null);
  assert.equal(normalize('1234567890123', 'PK').valid, false);
});

test('categories: import (duplicates once), counts, search, move, delete, reset; statuses apart from leads', () => {
  const s = new LeadStore(':memory:');
  s.save({ placeKey: 'p1', mapsUrl: 'https://www.google.com/maps/place/A', name: 'Acme', keyword: 'k', phone: '+923001112233', websiteStatus: 'no_website' });
  const seo = s.createNumberList('SEO USA');
  const web = s.createNumberList('Web Development');
  assert.throws(() => s.createNumberList('seo usa'), /already exists/);
  const items = [
    { phone: '+923001112233', valid: true, name: 'Ali', business: 'SEO Hub' },
    { phone: '+923214445566', valid: true, name: 'Sara' },
    { phone: '+923337778889', valid: true },
  ];
  assert.deepEqual(s.importNumbers(seo, items), { added: 3, duplicateInCategory: 0, alsoElsewhere: 1 }); // Ali's number is also a lead
  assert.deepEqual(s.importNumbers(seo, items.slice(0, 1)), { added: 0, duplicateInCategory: 1, alsoElsewhere: 0 });
  s.importNumbers(web, [{ phone: '+923214445566', valid: true, name: 'Sara again' }]);
  const rows = s.listNumbers({ listId: seo }).rows;
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.name === 'Sara').duplicates, 1);
  s.markNumberCallSeen(rows[0].id);
  s.setNumberDoNotCall(rows[2].id, true);
  let list = s.numberLists().find((l) => l.id === seo);
  assert.deepEqual({ total: list.total, called: list.called, unseen: list.unseen, optedOut: list.optedOut }, { total: 3, called: 1, unseen: 1, optedOut: 1 });
  assert.deepEqual(s.listNumbers({ listId: seo, status: 'unseen' }).rows.map((r) => r.name), ['Sara']);
  assert.deepEqual(s.listNumbers({ listId: seo, search: 'hub' }).rows.map((r) => r.name), ['Ali']);
  assert.deepEqual(s.listNumbers({ listId: seo, search: '4445' }).rows.map((r) => r.name), ['Sara']);
  // The lead with the same number is unchanged (its own call status, its WhatsApp status).
  assert.equal(s.listLeads()[0].callStatus, 'unseen');
  assert.equal(s.listLeads()[0].campaign, 'unseen');
  // Already called as an imported number: the lead is not auto-called either.
  assert.equal(s.callableLeads().length, 0);
  // Move: a number already in the target category stays where it was.
  assert.deepEqual(s.moveNumbers([rows[1].id, rows[2].id], web), { moved: 1, skipped: 1 });
  assert.equal(s.resetNumberListCalls(seo), 1);
  list = s.numberLists().find((l) => l.id === seo);
  assert.equal(list.called, 0);
  s.deleteNumberList(seo);
  assert.equal(s.numberLists().length, 1);
  assert.equal(s.listNumbers({ listId: seo }).total, 0);
});
