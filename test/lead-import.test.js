'use strict';
// Leads from the user's own CSV and Excel (.xlsx) files: columns read,
// a guessed mapping, the user's category, no duplicates (same email or
// phone), rows without a business or contact skipped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LeadStore } = require('../src/database/db');
const { readTable, guessMapping, importRows } = require('../src/export/lead-import');

const fixture = (f) => path.join(__dirname, 'fixtures', f);

function store(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-import-'));
  const s = new LeadStore(path.join(dir, 'leads.db'));
  t.after(() => {
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return s;
}

for (const file of ['leads.csv', 'leads.xlsx']) {
  test(`Import from ${file}: mapped columns become leads in the chosen category; duplicates and empty rows skipped`, (t) => {
    const s = store(t);
    const table = readTable(fixture(file));
    assert.ok(table.ok, table.error);
    assert.deepEqual(table.columns, ['Business Name', 'Email Address', 'Mobile', 'Website', 'City', 'Owner']);
    const mapping = guessMapping(table.columns);
    assert.deepEqual(mapping, { name: 0, email: 1, phone: 2, website: 3, address: 4, contactName: 5 });
    const cat = s.ensureCategory('Imported Realty');
    const r = importRows(s, table.rows, mapping, { categoryId: cat.id });
    assert.equal(r.added, 4);
    assert.equal(r.withEmail, 2);
    const leads = s.listLeads({ category: cat.id });
    const zahid = leads.find((l) => l.name === 'Zahid Properties');
    assert.equal(zahid.email, 'zahid@realty.pk');
    assert.equal(zahid.phone, '+923001234567');
    assert.equal(zahid.websiteUrl, 'https://zahid.pk');
    assert.equal(zahid.contactName, 'Zahid Khan');
    assert.equal(zahid.source, 'import');
    assert.equal(leads.find((l) => l.name === 'Noor & Sons "Estate"').phone, '+923007654321', 'a number Excel stored without its 0');
    assert.equal(s.listLeads({ source: 'import' }).length, 4);
    // The same file again: nothing new.
    const again = importRows(s, table.rows, mapping, { categoryId: cat.id });
    assert.equal(again.added, 0);
    assert.equal(again.duplicates, 4, 'already imported');
  });
}

test('Unsupported files are explained', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-imp-'));
  fs.writeFileSync(path.join(dir, 'old.xls'), 'x');
  assert.match(readTable(path.join(dir, 'old.xls')).error, /Save As/);
  fs.writeFileSync(path.join(dir, 'a.csv'), 'only,a,header\n');
  assert.match(readTable(path.join(dir, 'a.csv')).error, /no rows/);
});
