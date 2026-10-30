'use strict';

// Contact datasets from CSV files (RFC 4180; comma, semicolon or tab;
// UTF-8 with or without BOM), mapped by their column names: name or first
// and last name, email, phone, company, website or domain, title, LinkedIn
// profile, address. Used by contact discovery as a local data source.

function parseCsv(text) {
  const src = String(text).replace(/^﻿/, '');
  const firstLine = src.slice(0, src.indexOf('\n') >= 0 ? src.indexOf('\n') : src.length);
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of firstLine) if (ch in counts) counts[ch]++;
  const sep = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

const COLUMNS = {
  name: /^(full ?name|name|contact( name)?|person|lead name|display name)$/,
  first: /^(first ?name|given ?name|first)$/,
  last: /^(last ?name|surname|family ?name|last)$/,
  email: /^(e-?mail( address)?|work e-?mail|business e-?mail|professional e-?mail|email 1|primary e-?mail)$/,
  phone: /^(phone( number)?|mobile( phone)?|direct( phone| dial)?|work phone|telephone|tel|cell|phone 1)$/,
  company: /^(company( name)?|organi[sz]ation|employer|account( name)?|business( name)?)$/,
  website: /^(website|company website|url|web ?site|homepage)$/,
  domain: /^(domain|company domain|email domain)$/,
  title: /^(title|job ?title|position|headline|role)$/,
  linkedin: /^(linkedin( url| profile| profile url)?|person linkedin url|profile url)$/,
  address: /^(address|location|city|country)$/,
};

// Rows as objects with the fields above (only columns it recognises).
function contactRowsFromCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { rows: [], columns: [] };
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[_\s]+/g, ' '));
  const map = {};
  header.forEach((h, i) => {
    for (const [field, re] of Object.entries(COLUMNS)) if (map[field] === undefined && re.test(h)) map[field] = i;
  });
  return {
    columns: Object.keys(map),
    rows: rows.slice(1).map((r) => Object.fromEntries(Object.entries(map).map(([f, i]) => [f, (r[i] || '').trim()]))),
  };
}

module.exports = { parseCsv, contactRowsFromCsv };
