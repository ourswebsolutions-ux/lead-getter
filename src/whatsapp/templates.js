'use strict';

// Outreach message templates: three stages, each with one or more
// variations (rotated between contacts), placeholders, and a fallback text
// for each variation when the name isn't known. Names are never invented: either
// the contact's own WhatsApp name, or one word taken from the business name
// on Google Maps, and only when that word looks like a name.

const PLACEHOLDERS = ['name', 'business'];

const DEFAULT_TEMPLATES = [
  { text: 'Assalam-o-Alaikum {name} bhai.', fallback: 'Assalam-o-Alaikum.' },
  { text: 'Kaise hain aap? Umeed hai aap khairiyat se honge.', fallback: '' },
  { text: 'Kya aap {business} ke naam se real estate ka kaam karte hain, ya kisi aur business se related hain?', fallback: 'Kya aap real estate ka kaam karte hain, ya kisi aur business se related hain?' },
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

// The business name as listed on Google Maps, without the extras listings
// often carry ("Zahid Properties - Best Agency in DHA", "... | Lahore").
// null when nothing usable is left (no Latin letters, or too long).
function cleanBusiness(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.split(/\s+[-–—|:•]\s+|\s*\||\s*\(|,/)[0].replace(/\s+/g, ' ').trim();
  if (!name || name.length > 40 || !/[A-Za-z]{2}/.test(name)) return null;
  return name;
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

const MAX_VARIATIONS = 20;
const MAX_MESSAGES = 10;
const PLACEHOLDER = /\{\s*([A-Za-z_][\w ]*?)\s*\}/g;

// {business_name} and {business name} are other spellings of {business}.
const canonical = (p) => (/^business[ _]name$/i.test(p) ? 'business' : p.toLowerCase());
function usedPlaceholders(text) {
  return [...String(text).matchAll(PLACEHOLDER)].map((m) => canonical(m[1]));
}

// A stage's variations: [{ text, fallback }] (a stage saved by an earlier
// version is one { text, fallback }).
function variationsOf(stage) {
  const list = Array.isArray(stage?.variations) ? stage.variations : stage ? [stage] : [];
  return list.map((v) => ({ text: String(v?.text ?? ''), fallback: String(v?.fallback ?? '') }));
}

// Templates in the current shape: three stages of { variations }.
function normalizeTemplates(list) {
  return (Array.isArray(list) ? list : []).map((t) => ({ variations: variationsOf(t).map((v) => ({ text: v.text.trim(), fallback: v.fallback.trim() })) }));
}

// Problems with a campaign's messages (empty list = fine): message 1 is
// required; more (up to 10) only when the user adds them.
function validateTemplates(list) {
  const errors = [];
  if (!Array.isArray(list) || !list.length) return ['Message 1 is needed.'];
  if (list.length > MAX_MESSAGES) return [`Up to ${MAX_MESSAGES} messages.`];
  list.forEach((stage, i) => {
    const vars = variationsOf(stage);
    if (!vars.length) return errors.push(`Message ${i + 1} needs at least one version.`);
    if (vars.length > MAX_VARIATIONS) errors.push(`Message ${i + 1} has more than ${MAX_VARIATIONS} variations.`);
    vars.forEach((t, j) => validateOne(t, vars.length > 1 ? `Message ${i + 1}, variation ${j + 1}` : `Message ${i + 1}`, errors));
  });
  return errors;
}

function validateOne(t, n, errors) {
  const text = String(t?.text ?? '').trim();
  const fallback = String(t?.fallback ?? '').trim();
  if (!text) errors.push(`${n} is empty.`);
  if (text.length > 1000 || fallback.length > 1000) errors.push(`${n} is too long (1000 characters maximum).`);
  for (const p of [...usedPlaceholders(text), ...usedPlaceholders(fallback)]) {
    if (!PLACEHOLDERS.includes(p)) errors.push(`${n} uses an unknown placeholder {${p}}. Use {name} or {business name}.`);
  }
  for (const p of PLACEHOLDERS) {
    const what = p === 'name' ? 'a known name' : 'a business name';
    if (usedPlaceholders(text).includes(p) && !fallback) errors.push(`${n} uses {${p}}, so it needs a version for contacts without ${what}.`);
    if (usedPlaceholders(fallback).includes(p)) errors.push(`${n}: the second version is used when {${p}} is missing, so it can't use {${p}}.`);
  }
}

// The text to send for one stage. When a placeholder has no value, the
// fallback is used (or the text with that part left out if it has none).
function render(template, { name = null, business = null } = {}) {
  const values = { name, business };
  const text = String(template.text || '');
  const missing = usedPlaceholders(text).some((p) => !values[p]);
  const chosen = missing ? String(template.fallback || '').trim() || null : text;
  const value = (p) => values[canonical(p)] || '';
  // Line breaks and spacing are kept as written (only spaces around a
  // missing value are tidied).
  if (chosen === null) return tidy(text.replace(/[ \t]*\{\s*([A-Za-z_][\w ]*?)\s*\}/g, (_, p) => (value(p) ? ` ${value(p)}` : '')).replace(/[ \t]+([.,!?])/g, '$1'));
  return tidy(chosen.replace(PLACEHOLDER, (_, p) => value(p)));
}

function tidy(s) {
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]{2,}/g, ' ').trimEnd())
    .join('\n')
    .trim();
}

// --- links ---------------------------------------------------------------------

const MAX_LINKS = 10;

// A web address as typed ("example.com/demo" or "https://..."), or null.
function cleanUrl(raw) {
  let s = String(raw || '').trim();
  if (!s || /\s/.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(u.protocol) || !/^[^.]+(\.[^.]+)+$/.test(u.hostname) || /\.$/.test(u.hostname) || u.username || u.password) return null;
  return u.href.length > 500 ? null : u.href;
}

// Links: [{ title, url }] -> { links, errors }.
function validateLinks(list) {
  const errors = [];
  const links = [];
  if (list != null && !Array.isArray(list)) return { links, errors: ['Invalid links.'] };
  (list || []).forEach((l, i) => {
    const title = String(l?.title ?? '').replace(/\s+/g, ' ').trim();
    const url = cleanUrl(l?.url);
    if (!url) errors.push(`Link ${i + 1} is not a valid web address (for example https://example.com).`);
    else if (title.length > 60) errors.push(`Link ${i + 1}: the title is too long (60 characters maximum).`);
    else links.push({ title, url });
  });
  if ((list || []).length > MAX_LINKS) errors.push(`Up to ${MAX_LINKS} links.`);
  return { links, errors };
}

// The message with its links below it, one per line, under their titles.
function withLinks(text, links = []) {
  if (!links.length) return text;
  const block = links.map((l) => (l.title ? `*${l.title}*\n${l.url}` : l.url)).join('\n\n');
  return text ? `${text}\n\n${block}` : block;
}

// Words in an incoming message that mean "don't contact me" (English,
// Roman Urdu and Urdu).
const OPT_OUT = /\b(stop|unsubscribe|opt[ -]?out|remove me|do ?n[o']?t (message|contact|text)|no more messages|not interested)\b|mat (bhej|karo|kare|karen)|message na (karein|karen|karo|kare)|band karo|band kar do|dobara (message|msg) na|nahi chahiye|tang na kar|رابطہ نہ|میسج نہ|مت بھیج|بند کرو/i;

function isOptOut(text) {
  return OPT_OUT.test(String(text || ''));
}

module.exports = { DEFAULT_TEMPLATES, MAX_VARIATIONS, MAX_MESSAGES, MAX_LINKS, extractName, cleanBusiness, pickName, render, validateTemplates, normalizeTemplates, variationsOf, usedPlaceholders, isOptOut, cleanUrl, validateLinks, withLinks };
