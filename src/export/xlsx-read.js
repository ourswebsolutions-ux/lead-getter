'use strict';

// Reads the first sheet of an Excel .xlsx file into rows of text, with
// Node's own zlib (an .xlsx file is a zip of XML parts). Enough for lead
// lists: shared and inline strings, numbers, booleans; formulas give their
// cached value. Old .xls files (a different, binary format) are not read.

const zlib = require('node:zlib');

const MAX_ENTRY = 64 * 1024 * 1024;

// The files in a zip: { name -> Buffer } for the wanted names.
function unzip(buf, want) {
  // End of central directory: the last 0x06054b50 record.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('This is not an .xlsx file (or it is damaged).');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('The .xlsx file is damaged.');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    if (size > MAX_ENTRY) throw new Error('The .xlsx file is too large.');
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + csize);
    out[name] = method === 0 ? Buffer.from(data) : method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY }) : null;
    if (!out[name]) throw new Error('The .xlsx file uses a compression this app cannot read.');
  }
  return out;
}

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : XML_ENT[e.toLowerCase()]));
// The text of a string item (<si> / <is>): every <t>, rich-text runs included.
const textOf = (xml) => [...String(xml).matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join('');

function colIndex(ref) {
  const letters = /^[A-Z]+/i.exec(ref || '')?.[0]?.toUpperCase() || 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// { rows: string[][] } of the first sheet.
function readXlsx(buf, { maxRows = 50_000 } = {}) {
  const parts = unzip(buf, (n) => n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const wb = parts['xl/workbook.xml']?.toString('utf8');
  if (!wb) throw new Error('This is not an Excel workbook.');
  // The first sheet's file, through the workbook's relationships.
  const rid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb)?.[1];
  const rels = parts['xl/_rels/workbook.xml.rels']?.toString('utf8') || '';
  const target = rid && new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1];
  const sheetName = target ? `xl/${target.replace(/^\/?xl\//, '').replace(/^\//, '')}` : 'xl/worksheets/sheet1.xml';
  const sheet = (parts[sheetName] || parts['xl/worksheets/sheet1.xml'])?.toString('utf8');
  if (!sheet) throw new Error('The workbook has no sheet to read.');
  const shared = [...(parts['xl/sharedStrings.xml']?.toString('utf8') || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const rows = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const inner = cm[2] || '';
      const ref = /\br="([A-Z]+\d+)"/i.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] || 'n';
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let val = '';
      if (type === 's') val = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') val = textOf(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] || '');
      else if (type === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else if (v != null) val = unxml(v);
      // Long numbers (phones) stored as numbers: written out in full.
      if (type === 'n' && /e\+?\d+$/i.test(val) && Number.isFinite(Number(val))) val = BigInt(Math.round(Number(val))).toString();
      row[ref ? colIndex(ref) : row.length] = val;
    }
    for (let i = 0; i < row.length; i++) if (row[i] == null) row[i] = '';
    if (row.some((c) => String(c).trim())) rows.push(row);
    if (rows.length >= maxRows) break;
  }
  return { rows };
}

module.exports = { readXlsx, unzip, colIndex };
