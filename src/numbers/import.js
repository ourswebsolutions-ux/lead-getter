'use strict';

// Phone numbers imported from a file or pasted text into a number category:
// CSV, Excel (.xlsx, first sheet), TXT, or text with one or more numbers per
// line. Columns are mapped by their names (phone, name, business, …) and
// can be mapped by hand; numbers are put in international format with the
// app's phone country when they are valid; duplicates in the file are
// counted once.

const zlib = require('node:zlib');
const { parsePhoneNumberFromString } = require('libphonenumber-js/max');
const { parseCsv } = require('../export/csv-import');

const FIELDS = ['phone', 'name', 'business', 'category', 'email', 'city', 'notes'];
const GUESS = {
  phone: /^(phone|mobile|cell|tel|telephone|number|phone ?number|mobile ?number|contact ?number|whatsapp|ph|msisdn)$/i,
  name: /^(name|full ?name|contact|contact ?name|person|first ?name)$/i,
  business: /^(business|company|business ?name|company ?name|organi[sz]ation|shop|firm)$/i,
  category: /^(category|type|industry|niche|sector)$/i,
  email: /^(e-?mail|email ?address)$/i,
  city: /^(city|town|location|area)$/i,
  notes: /^(notes?|comments?|remarks?)$/i,
};

// --- .xlsx (a zip of XML files): the first worksheet as rows of text ---

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('This is not an Excel (.xlsx) file.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    files.set(name, () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const unxml = (s) =>
  String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

const colIndex = (ref) => [...ref.replace(/\d+$/, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

// A number cell holds e.g. 923001234567 or 9.23001234567E+11: written out in full.
const numberText = (v) => (/e/i.test(v) && Number.isFinite(Number(v)) ? BigInt(Math.round(Number(v))).toString() : v);

function readXlsx(buf) {
  const files = unzip(buf);
  const read = (n) => (files.has(n) ? files.get(n)() : null);
  const shared = [...(read('xl/sharedStrings.xml') || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unxml(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '')));
  const workbook = read('xl/workbook.xml') || '';
  const rels = read('xl/_rels/workbook.xml.rels') || '';
  const firstSheet = /<sheet\b[^>]*r:id="([^"]+)"/.exec(workbook)?.[1];
  const target = firstSheet && new RegExp(`<Relationship\\b[^>]*Id="${firstSheet}"[^>]*Target="([^"]+)"`).exec(rels)?.[1];
  const sheetPath = target ? (target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`) : 'xl/worksheets/sheet1.xml';
  const sheet = read(sheetPath) || read('xl/worksheets/sheet1.xml');
  if (!sheet) throw new Error('The Excel file has no worksheet.');
  const rows = [];
  for (const r of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="(\w+)"/.exec(attrs)?.[1];
      const inner = c[2] || '';
      let v = '';
      if (type === 's') v = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1])] ?? '';
      else if (type === 'inlineStr') v = unxml(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] || '');
      else v = numberText(unxml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] || ''));
      row[ref ? colIndex(ref) : row.length] = String(v).trim();
    }
    rows.push(Array.from(row, (x) => x ?? ''));
  }
  return rows.filter((r) => r.some((x) => x));
}

// --- tables ---

// A table from a file (by its extension) or pasted text: { headers, rows }.
// headers is null when the first row holds data (numbers) rather than titles.
function readTable(input, kind) {
  let rows;
  if (kind === 'xlsx') rows = readXlsx(Buffer.isBuffer(input) ? input : Buffer.from(input));
  else {
    const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
    if (kind === 'csv') rows = parseCsv(text);
    else {
      // TXT or pasted: CSV-like lines when they have separators; otherwise one number (or more) per line.
      const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
      const separated = lines.filter((l) => /[,;\t]/.test(l)).length > lines.length / 2;
      const numbersIn = (l) => l.split(/\s{2,}|\t|[;,|]/).flatMap((piece) => piece.match(/\+?\d[\d\s().-]{5,}\d/g) || []);
      rows = separated ? parseCsv(lines.join('\n')) : lines.flatMap((l) => (numbersIn(l).length ? numbersIn(l) : [l.trim()]).map((n) => [n.trim()]));
    }
  }
  rows = rows.map((r) => r.map((c) => String(c ?? '').trim())).filter((r) => r.some(Boolean));
  if (!rows.length) return { headers: null, rows: [] };
  const looksLikeData = rows[0].some((c) => (c.match(/\d/g) || []).length >= 7);
  return looksLikeData ? { headers: null, rows } : { headers: rows[0], rows: rows.slice(1) };
}

// Field -> column index, guessed from the headers (or the column with the most phone numbers).
function guessMapping({ headers, rows }) {
  const width = Math.max(headers?.length || 0, ...rows.slice(0, 50).map((r) => r.length));
  const map = {};
  if (headers) {
    headers.forEach((h, i) => {
      for (const f of FIELDS) if (map[f] == null && GUESS[f].test(h.trim())) map[f] = i;
    });
  }
  if (map.phone == null) {
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < width; i++) {
      const score = rows.slice(0, 100).filter((r) => ((r[i] || '').match(/\d/g) || []).length >= 7).length;
      if (score > bestScore) [best, bestScore] = [i, score];
    }
    if (best >= 0) map.phone = best;
  }
  return map;
}

// A number in international format when it is valid for its country (or the default country).
function normalize(raw, country) {
  const text = String(raw || '').trim();
  const digits = text.replace(/[^\d+]/g, '');
  if ((digits.match(/\d/g) || []).length < 6) return null;
  const p = parsePhoneNumberFromString(text, country || undefined) || (digits.startsWith('00') ? parsePhoneNumberFromString(`+${digits.slice(2)}`) : null);
  if (p?.isValid()) return { phone: p.number, raw: text, valid: true, mobile: ['MOBILE', 'FIXED_LINE_OR_MOBILE'].includes(p.getType()) };
  return { phone: digits.replace(/(?!^)\+/g, ''), raw: text, valid: false, mobile: false };
}

// The rows to save: { items, invalid, duplicates, total }.
function buildItems({ headers, rows }, mapping, { country = null } = {}) {
  const at = (r, f) => (mapping[f] != null ? (r[mapping[f]] || '').trim() : '');
  const seen = new Set();
  const items = [];
  let invalid = 0;
  let duplicates = 0;
  for (const r of rows) {
    const n = normalize(at(r, 'phone'), country);
    if (!n) {
      invalid++;
      continue;
    }
    if (seen.has(n.phone)) {
      duplicates++;
      continue;
    }
    seen.add(n.phone);
    const extra = {};
    if (headers) {
      headers.forEach((h, i) => {
        if (h && !Object.values(mapping).includes(i) && r[i]) extra[h.slice(0, 40)] = r[i].slice(0, 300);
      });
    }
    for (const f of ['category', 'email', 'city', 'notes']) if (at(r, f)) extra[f] = at(r, f).slice(0, 300);
    items.push({ ...n, name: at(r, 'name').slice(0, 120) || null, business: at(r, 'business').slice(0, 160) || null, extra });
  }
  return { items, invalid, duplicates, total: rows.length };
}

const kindOf = (file) => {
  const ext = String(file).toLowerCase().split('.').pop();
  return ext === 'xlsx' ? 'xlsx' : ext === 'csv' ? 'csv' : 'txt';
};

module.exports = { readTable, readXlsx, guessMapping, buildItems, normalize, kindOf, FIELDS };
