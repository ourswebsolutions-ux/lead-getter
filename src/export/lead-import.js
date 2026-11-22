'use strict';

// Leads from the user's own CSV or Excel (.xlsx) file: the columns are shown,
// the user says which column is which field (a guess from the column names
// is offered), chooses the category, and the rows become leads. A row needs
// a business name, or an email / phone to stand for one. A lead already
// saved with the same phone or email is not added again.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseCsv } = require('./csv-import');
const { readXlsx } = require('./xlsx-read');
const { normalizePhone } = require('../database/phone');

const MAX_ROWS = 20_000;
const MAX_BYTES = 30 * 1024 * 1024;

// Lead fields a column can go into.
const FIELDS = [
  ['name', 'Business name'],
  ['email', 'Email'],
  ['phone', 'Phone / WhatsApp'],
  ['website', 'Website'],
  ['address', 'Address / city'],
  ['contactName', 'Contact person'],
  ['description', 'Notes / description'],
];
const GUESS = {
  name: /^(business|business ?name|company|company ?name|name|shop|store|firm|organi[sz]ation|title)$/i,
  email: /e-?mail/i,
  phone: /phone|mobile|cell|whats ?app|contact ?(no|number)|tel/i,
  website: /web ?site|url|domain|site/i,
  address: /address|city|location|area|town|country|region/i,
  contactName: /contact( name| person)?$|owner|person|manager|first ?name|full ?name/i,
  description: /note|description|about|details|comment|remarks/i,
};

// Reads a CSV or .xlsx file: { ok, columns, rows } (the first row is the header).
function readTable(filePath) {
  const ext = path.extname(String(filePath)).toLowerCase();
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { ok: false, error: 'The file could not be opened.' };
  }
  if (stat.size > MAX_BYTES) return { ok: false, error: 'The file is larger than 30 MB.' };
  let rows;
  try {
    if (ext === '.xlsx') rows = readXlsx(fs.readFileSync(filePath), { maxRows: MAX_ROWS + 1 }).rows;
    else if (ext === '.csv' || ext === '.txt' || ext === '.tsv') rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
    else if (ext === '.xls') return { ok: false, error: 'Old .xls files cannot be read. In Excel, use File > Save As > Excel Workbook (.xlsx) or CSV, then import that.' };
    else return { ok: false, error: 'Choose a CSV or Excel (.xlsx) file.' };
  } catch (err) {
    return { ok: false, error: err.message || 'The file could not be read.' };
  }
  if (rows.length < 2) return { ok: false, error: 'The file has no rows under its header.' };
  const columns = rows[0].map((c, i) => String(c || '').trim() || `Column ${i + 1}`);
  const body = rows.slice(1, MAX_ROWS + 1).map((r) => columns.map((_, i) => String(r[i] ?? '').trim()));
  return { ok: true, columns, rows: body, truncated: rows.length - 1 > MAX_ROWS };
}

// { field: column index } from the column names (each column used once).
function guessMapping(columns) {
  const out = {};
  const used = new Set();
  for (const [field] of FIELDS) {
    const i = columns.findIndex((c, idx) => !used.has(idx) && GUESS[field].test(c));
    if (i >= 0) {
      out[field] = i;
      used.add(i);
    }
  }
  return out;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const cleanWebsite = (v) => {
  const s = String(v || '').trim();
  if (!s || /\s/.test(s) || !/\./.test(s)) return '';
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
};

// Imports the rows into the lead database. store: LeadStore;
// mapping: { field: column index }. Resolves counts.
function importRows(store, rows, mapping, { categoryId = null, source = 'Imported' } = {}) {
  const col = (r, f) => (Number.isInteger(mapping[f]) && mapping[f] >= 0 ? String(r[mapping[f]] ?? '').trim() : '');
  // What is already saved: the same phone or email is not added twice.
  const existing = store.listLeads({});
  const phones = new Set(existing.map((l) => l.phone).filter(Boolean));
  const emails = new Set(existing.flatMap((l) => [l.email, ...(l.emails || []).map((e) => (typeof e === 'string' ? e : e?.email))]).filter(Boolean).map((e) => String(e).toLowerCase()));
  const out = { added: 0, duplicates: 0, skipped: 0, withEmail: 0, withPhone: 0 };
  for (const r of rows) {
    const email = (EMAIL.exec(col(r, 'email'))?.[0] || '').toLowerCase();
    const phoneRaw = col(r, 'phone');
    const name = col(r, 'name') || col(r, 'contactName') || email || phoneRaw;
    if (!name || (!email && !phoneRaw && !col(r, 'name'))) {
      out.skipped++;
      continue;
    }
    const norm = phoneRaw ? normalizePhone(phoneRaw, { address: col(r, 'address') }) : null;
    if ((email && emails.has(email)) || (norm?.phone && phones.has(norm.phone))) {
      out.duplicates++;
      continue;
    }
    const website = cleanWebsite(col(r, 'website'));
    const key = crypto.createHash('sha1').update(`${name.toLowerCase()}|${phoneRaw.replace(/\D/g, '')}|${email}`).digest('hex').slice(0, 24);
    const saved = store.importLead({ placeKey: `im:${key}`, name: name.slice(0, 200), phoneRaw, address: col(r, 'address').slice(0, 300), website, email, contactName: col(r, 'contactName').slice(0, 120), description: col(r, 'description').slice(0, 1000), categoryId, keyword: source });
    if (!saved?.lead) {
      out.skipped++;
      continue;
    }
    if (!saved.isNewLead) {
      out.duplicates++;
      continue;
    }
    out.added++;
    if (email) {
      emails.add(email);
      out.withEmail++;
    }
    if (saved.lead.phone) {
      phones.add(saved.lead.phone);
      out.withPhone++;
    }
  }
  return out;
}

module.exports = { readTable, guessMapping, importRows, FIELDS };
