'use strict';

// People to email, given as text (typed, pasted, or read from a file): one
// per line as "email, name, business" (name and business optional, in any
// separator: comma, semicolon, tab or |), "Name <email>", or just addresses
// (several on a line are each taken). Header lines and lines without an
// address are ignored.

const { isEmail } = require('./accounts');

const EMAIL_G = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const MAX = 5000;
const COMPANY = /\b(ltd|limited|pvt|private|inc|llc|llp|co|company|corp|corporation|group|properties|property|estate|estates|realty|realtors?|builders?|developers?|agency|traders?|trading|enterprises?|industries|store|shop|mart|solutions|services|studio|marketing|consultants?|clinic|hospital|school|academy|restaurant|hotel|salon|motors|travels?|tours)\b/i;

const clean = (s) => String(s || '').replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);

// -> { list: [{ email, name, business }], invalid } (each address once).
function parseRecipients(text) {
  const seen = new Set();
  const list = [];
  let invalid = 0;
  for (const raw of String(text || '').replace(/ /g, ' ').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const found = [...line.matchAll(EMAIL_G)].map((m) => m[0].replace(/\.+$/, ''));
    if (!found.length) continue;
    const add = (email, name = null, business = null) => {
      const e = email.toLowerCase();
      if (!isEmail(e)) return void invalid++;
      if (seen.has(e) || list.length >= MAX) return;
      seen.add(e);
      list.push({ email: e, name: name || null, business: business || null });
    };
    if (found.length > 1) {
      for (const e of found) add(e);
      continue;
    }
    const email = found[0];
    // "Name <email>"
    const angle = new RegExp(`^(.*?)<\\s*${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*>`).exec(line);
    if (angle) {
      const n = clean(angle[1].replace(/[,;|\t]+$/, ''));
      add(email, COMPANY.test(n) ? null : n, COMPANY.test(n) ? n : null);
      continue;
    }
    const fields = line.split(/[,;\t|]/).map(clean).filter((f) => f && !f.includes(email) && !/@/.test(f));
    let [name = null, business = null] = fields;
    // One field that is clearly a company: the business.
    if (name && !business && COMPANY.test(name)) [name, business] = [null, name];
    add(email, name, business);
  }
  return { list, invalid };
}

// Columns of a table (CSV / Excel) as recipient lines: the email column
// (by name, else the column with the most addresses), a person's name and a
// business, when there are such columns.
function tableToLines(columns, rows) {
  const find = (re) => columns.findIndex((c) => re.test(c));
  let emailCol = find(/e-?mail/i);
  if (emailCol < 0) {
    const counts = columns.map((_, i) => rows.slice(0, 200).filter((r) => /@/.test(r[i] || '')).length);
    const best = Math.max(...counts);
    emailCol = best > 0 ? counts.indexOf(best) : -1;
  }
  if (emailCol < 0) return { ok: false, error: 'No column with email addresses was found in the file.' };
  const nameCol = find(/^(name|full ?name|first ?name|contact|contact ?(name|person)|person|owner|client|customer)$/i);
  const bizCol = find(/business|company|organi[sz]ation|firm|shop|store|brand/i);
  const lines = rows
    .filter((r) => /@/.test(r[emailCol] || ''))
    .map((r) => [r[emailCol], nameCol >= 0 && nameCol !== emailCol ? r[nameCol] : '', bizCol >= 0 && bizCol !== emailCol ? r[bizCol] : ''].map((v) => String(v || '').replace(/[,\n\r]+/g, ' ').trim()).join(', ').replace(/(, )+$/, ''));
  return { ok: true, lines };
}

module.exports = { parseRecipients, tableToLines };
