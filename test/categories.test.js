'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { LeadStore, formatCategory, categoryKey, localDate } = require('../src/database/db');

let n = 0;
const lead = (extra) => ({ placeKey: `0x${++n}:0x1`, mapsUrl: `https://www.google.com/maps/place/B${n}`, name: `Biz ${n}`, phone: '0300', address: 'Lahore', websiteStatus: 'no_website', ...extra });
// Timestamps at local noon of a given local date, so the date is unambiguous.
const at = (ymd) => new Date(`${ymd}T12:00:00`).toISOString();

test('categories are title-cased and de-duplicated ignoring case and spaces', () => {
  assert.equal(formatCategory('  software   house '), 'Software House');
  assert.equal(formatCategory('HVAC services'), 'HVAC Services');
  assert.equal(categoryKey('Software  HOUSE'), categoryKey('software house'));
  const s = new LeadStore(':memory:');
  const a = s.ensureCategory('software house');
  const b = s.ensureCategory('SOFTWARE   House');
  const c = s.ensureCategory('Real Estate');
  assert.equal(a.id, b.id);
  assert.equal(b.name, 'Software House');
  assert.notEqual(a.id, c.id);
  assert.deepEqual(s.listCategories().categories.map((x) => x.name).sort(), ['Real Estate', 'Software House']);
});

function seeded() {
  const s = new LeadStore(':memory:');
  const sw = s.ensureCategory('Software House');
  const re = s.ensureCategory('Real Estate');
  s.save(lead({ categoryId: sw.id }), at('2026-10-19'));
  s.save(lead({ categoryId: sw.id }), at('2026-10-20'));
  s.save(lead({ categoryId: re.id }), at('2026-10-20'));
  s.save(lead({ categoryId: re.id }), at('2026-10-21'));
  s.save(lead({ categoryId: sw.id }), at('2026-10-21'));
  s.save(lead({ categoryId: sw.id, websiteStatus: 'has_website' }), at('2026-10-21')); // not a lead
  return { s, sw, re };
}

test('leads carry category and local discovery date and filter by both', () => {
  const { s, sw, re } = seeded();
  assert.equal(s.listLeads().length, 5);
  assert.equal(s.listLeads({ category: sw.id }).length, 3);
  assert.equal(s.listLeads({ date: '2026-10-20' }).length, 2);
  assert.deepEqual(s.listLeads({ category: re.id, date: '2026-10-21' }).map((l) => [l.category, l.discoveredDate]), [['Real Estate', '2026-10-21']]);
  assert.equal(s.listLeads({ from: '2026-10-19', to: '2026-10-20' }).length, 3);
  assert.equal(s.listLeads({ before: '2026-10-21' }).length, 3, 'past = before today');
  assert.equal(s.listLeads({ category: 'none' }).length, 0);
  assert.deepEqual(s.listDates({ category: sw.id }), [
    { date: '2026-10-21', count: 1 },
    { date: '2026-10-20', count: 1 },
    { date: '2026-10-19', count: 1 },
  ]);
  assert.deepEqual(s.listCategories().categories.find((c) => c.id === sw.id).leadCount, 3);
});

test('an existing lead keeps its category and date when found again in another search', () => {
  const s = new LeadStore(':memory:');
  const sw = s.ensureCategory('Software House');
  const it = s.ensureCategory('IT Company');
  const l = lead({ categoryId: sw.id });
  s.save(l, at('2026-10-19'));
  s.save({ ...l, categoryId: it.id }, at('2026-10-21'));
  const [only] = s.listLeads();
  assert.equal(only.category, 'Software House');
  assert.equal(only.discoveredDate, '2026-10-19');
  assert.equal(s.listLeads().length, 1, 'no duplicate lead');
});

test('delete one, selected, and all filtered leads; categories and other records stay', () => {
  const { s, sw, re } = seeded();
  const all = s.listLeads();
  assert.equal(s.deleteLeads([all[0].id]), 1);
  assert.equal(s.listLeads().length, 4);
  const two = s.listLeads({ category: sw.id }).map((l) => l.id).slice(0, 2);
  assert.equal(s.deleteLeads(two), 2);
  assert.equal(s.deleteFiltered({ category: re.id, date: '2026-10-20' }), 1);
  const left = s.listLeads();
  assert.equal(left.length, 1);
  assert.equal(left[0].category, 'Real Estate');
  assert.equal(s.listCategories().categories.length, 2, 'categories kept');
  // The non-lead business row is untouched.
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM businesses WHERE website_status = 'has_website'").get().n, 1);
  // Deleted rows keep only a marker: no name or contact details.
  const gone = s.db.prepare("SELECT * FROM businesses WHERE website_status = 'deleted'").all();
  assert.equal(gone.length, 4);
  assert.ok(gone.every((r) => r.name === '' && r.phone === null && r.address === null && r.qualified === 0));
});

test('a failed bulk delete rolls back completely', () => {
  const { s } = seeded();
  const before = s.listLeads().length;
  const orig = s.db.prepare.bind(s.db);
  let calls = 0;
  s.db.prepare = (sql) => {
    const st = orig(sql);
    if (!/SET qualified = 0/.test(sql)) return st;
    return { run: (...a) => (++calls === 2 ? (() => { throw new Error('disk I/O error'); })() : st.run(...a)) };
  };
  assert.throws(() => s.deleteLeads(s.listLeads().map((l) => l.id)), /disk I\/O/);
  s.db.prepare = orig;
  assert.equal(s.listLeads().length, before);
});

test('migration keeps existing leads, dates them from their real discovery time, and invents no category', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-mig-'));
  const file = path.join(dir, 'leads.db');
  // A database in the previous (version 0) format.
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE businesses (id INTEGER PRIMARY KEY, place_key TEXT NOT NULL UNIQUE, maps_url TEXT NOT NULL, name TEXT NOT NULL,
    phone TEXT, address TEXT, website_status TEXT NOT NULL, website_detail TEXT, qualified INTEGER NOT NULL DEFAULT 0, keyword TEXT,
    discovered_at TEXT NOT NULL, checked_at TEXT NOT NULL)`);
  const ins = old.prepare('INSERT INTO businesses (place_key, maps_url, name, phone, address, website_status, qualified, keyword, discovered_at, checked_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  ins.run('0xa:0x1', 'https://www.google.com/maps/place/Old', 'خان اسٹیٹ', '03001234567', 'Gulberg, Lahore, Pakistan', 'no_website', 1, 'Real Estate Lahore', at('2026-10-18'), at('2026-10-18'));
  ins.run('0xb:0x1', 'https://www.google.com/maps/place/Web', 'Web Co', null, null, 'has_website', 0, 'x', at('2026-10-18'), at('2026-10-18'));
  old.close();

  const s = new LeadStore(file);
  const [l] = s.listLeads();
  assert.equal(l.name, 'خان اسٹیٹ');
  assert.equal(l.phone, '+923001234567');
  assert.equal(l.phoneRaw, '03001234567', 'original kept');
  assert.equal(l.phoneStatus, 'valid');
  assert.equal(l.discoveredDate, '2026-10-18');
  assert.equal(l.categoryId, null);
  assert.equal(s.listCategories().uncategorized, 1);
  assert.equal(s.db.prepare('PRAGMA user_version').get().user_version, 11);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM businesses').get().n, 2);
  s.close();
  // Re-opening does not migrate again or change anything.
  const again = new LeadStore(file);
  assert.equal(again.listLeads().length, 1);
  again.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('localDate uses the computer timezone', () => {
  assert.equal(localDate(new Date(2026, 9, 21, 0, 30)), '2026-10-21');
});

test('rename a category; a clash asks before merging; merge moves leads and keeps them', () => {
  const s = new LeadStore(':memory:');
  const a = s.ensureCategory('software house');
  const b = s.ensureCategory('IT Company');
  s.save(lead({ categoryId: a.id }), at('2026-10-20'));
  s.save(lead({ categoryId: b.id }), at('2026-10-20'));
  assert.deepEqual(s.renameCategory(a.id, 'software   houses'), { renamed: true, id: a.id, name: 'Software Houses' });
  assert.equal(s.listLeads({ category: a.id })[0].category, 'Software Houses', 'leads show the new name');
  const clash = s.renameCategory(a.id, 'it company');
  assert.deepEqual(clash, { conflict: { id: b.id, name: 'IT Company' } });
  assert.equal(s.listCategories().categories.length, 2, 'nothing changed before confirming');
  const merged = s.renameCategory(a.id, 'it company', { merge: true });
  assert.equal(merged.merged, true);
  assert.equal(merged.moved, 1);
  assert.deepEqual(s.listCategories().categories.map((c) => [c.name, c.leadCount]), [['IT Company', 2]]);
  assert.equal(s.listLeads().length, 2, 'no leads lost');
  assert.throws(() => s.renameCategory(b.id, ' x '), /at least 2/);
});

test('deleting a category keeps its leads as Uncategorized', () => {
  const s = new LeadStore(':memory:');
  const a = s.ensureCategory('Real Estate');
  s.save(lead({ categoryId: a.id }), at('2026-10-20'));
  s.save(lead({ categoryId: a.id }), at('2026-10-21'));
  assert.deepEqual(s.deleteCategory(a.id), { deleted: true, name: 'Real Estate', uncategorized: 2 });
  assert.equal(s.listLeads().length, 2);
  assert.ok(s.listLeads().every((l) => l.categoryId === null));
  assert.equal(s.listCategories().uncategorized, 2);
  assert.throws(() => s.deleteCategory(a.id), /no longer exists/);
});

test('new-lead count for a search comes from the database', () => {
  const s = new LeadStore(':memory:');
  s.save(lead({}), '2026-10-21T08:00:00.000Z'); // before the search
  const startedAt = '2026-10-21T09:00:00.000Z';
  const again = lead({});
  s.save(again, '2026-10-21T09:05:00.000Z');
  s.save(again, '2026-10-21T09:06:00.000Z'); // same business found twice
  s.save(lead({ websiteStatus: 'has_website' }), '2026-10-21T09:07:00.000Z'); // not a lead
  assert.equal(s.countNewLeadsSince(startedAt), 1);
});
