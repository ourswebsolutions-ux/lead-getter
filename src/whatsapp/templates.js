'use strict';

// Outreach message templates: three stages, placeholders, and a fallback text
// for each stage when the name isn't known. Names are never invented: either
// the contact's own WhatsApp name, or one word taken from the business name
// on Google Maps, and only when that word looks like a name.

const PLACEHOLDERS = ['name', 'business'];

const DEFAULT_TEMPLATES = [
  { text: 'Assalam-o-Alaikum {name} bhai.', fallback: 'Assalam-o-Alaikum.' },
  { text: 'Kaise hain aap? Umeed hai aap khairiyat se honge.', fallback: '' },
  { text: 'Kya aap real estate ka kaam karte hain, ya kisi aur business se related hain?', fallback: '' },
];

// Words that describe a business rather than name it.
const GENERIC = new Set(
  `real estate estates property properties realty realtor realtors builder builders developer developers construction constructions
   associate associates marketing group groups consultant consultants consultancy agency agencies agent agents service services
   enterprise enterprises trader traders trading investment investments housing house homes home land lands plot plots
   and co company pvt ltd private limited international int solutions solution network center centre office offices dealer dealers
   mart hub zone point plaza city town society societies phase block sector scheme estate's property's the a an of in at for
   best top new old super prime royal golden green blue city's town's lahore karachi islamabad rawalpindi faisalabad multan peshawar
   pakistan dha bahria gulberg johar model defence defense cantt road street avenue apartments apartment tower towers mall
   closed open shop store`.split(/\s+/),
);
// Honorifics/prefixes skipped before the name itself ("Al Noor" -> "Noor").
const PREFIX = new Set(['al', 'el', 'm/s', 'ms', 'mr', 'mrs', 'haji', 'hajji', 'mian', 'sheikh', 'shaikh', 'ch', 'chaudhry', 'chaudhary', 'rana', 'malik', 'syed', 'sayed', 'mirza', 'hafiz', 'dr', 'engr', 'eng']);

function titleCase(w) {
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

// One safe first word from a name, or null. Latin letters only (the
// templates are Roman Urdu), 3-15 letters, not a generic business word.
function extractName(raw) {
  if (typeof raw !== 'string') return null;
  const words = raw
    .replace(/[|()[\]{}"“”.,:;!?/\\]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  for (const w of words) {
    const lw = w.toLowerCase();
    if (PREFIX.has(lw)) continue;
    if (GENERIC.has(lw)) return null; // the name part is over (or never started)
    if (!/^[A-Za-z][A-Za-z'-]{2,14}$/.test(w)) return null;
    return titleCase(w);
  }
  return null;
}

// The best name for a contact, with where it came from.
// sources: { contactName (saved in the phone), pushName (their own WhatsApp
// name), businessName (Google Maps) }.
function pickName({ contactName, pushName, businessName } = {}) {
  for (const [source, value] of [
    ['contact', contactName],
    ['whatsapp', pushName],
    ['business', businessName],
  ]) {
    const name = extractName(value);
    if (name) return { name, source };
  }
  return { name: null, source: null };
}

function usedPlaceholders(text) {
  return [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}

// Problems with a set of three templates (empty list = fine).
function validateTemplates(list) {
  const errors = [];
  if (!Array.isArray(list) || list.length !== 3) return ['Three messages are needed.'];
  list.forEach((t, i) => {
    const n = `Message ${i + 1}`;
    const text = String(t?.text ?? '').trim();
    const fallback = String(t?.fallback ?? '').trim();
    if (!text) errors.push(`${n} is empty.`);
    if (text.length > 1000 || fallback.length > 1000) errors.push(`${n} is too long (1000 characters maximum).`);
    for (const p of [...usedPlaceholders(text), ...usedPlaceholders(fallback)]) {
      if (!PLACEHOLDERS.includes(p)) errors.push(`${n} uses an unknown placeholder {${p}}. Use {name} or {business}.`);
    }
    if (usedPlaceholders(text).includes('name') && !fallback) errors.push(`${n} uses {name}, so it needs a version for contacts without a known name.`);
    if (usedPlaceholders(fallback).includes('name')) errors.push(`${n}: the version without a name can't use {name}.`);
  });
  return errors;
}

// The text to send for one stage. When a placeholder has no value, the
// fallback is used (or the text with that part left out if it has none).
function render(template, { name = null, business = null } = {}) {
  const values = { name, business };
  const text = String(template.text || '');
  const missing = usedPlaceholders(text).some((p) => !values[p]);
  const chosen = missing ? String(template.fallback || '').trim() || null : text;
  if (chosen === null) return text.replace(/\s*\{(\w+)\}/g, (_, p) => (values[p] ? ` ${values[p]}` : '')).replace(/\s+([.,!?])/g, '$1').trim();
  return chosen.replace(/\{(\w+)\}/g, (_, p) => values[p] || '').replace(/\s+/g, ' ').trim();
}

// Words in an incoming message that mean "don't contact me" (English,
// Roman Urdu and Urdu).
const OPT_OUT = /\b(stop|unsubscribe|opt[ -]?out|remove me|do ?n[o']?t (message|contact|text)|no more messages|not interested)\b|mat (bhej|karo|kare|karen)|message na (karein|karen|karo|kare)|band karo|band kar do|dobara (message|msg) na|nahi chahiye|tang na kar|رابطہ نہ|میسج نہ|مت بھیج|بند کرو/i;

function isOptOut(text) {
  return OPT_OUT.test(String(text || ''));
}

module.exports = { DEFAULT_TEMPLATES, extractName, pickName, render, validateTemplates, usedPlaceholders, isOptOut };
