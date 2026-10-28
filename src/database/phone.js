'use strict';

// Phone normalisation with libphonenumber (full metadata, so numbers are
// validated against each country's real numbering plan).
//
// The country is never guessed: a number written in international form
// (+.. or 00..) carries its own country code; a local number is only
// normalised when the listing's address names its country. Otherwise the
// original is kept and flagged for verification.

const { parsePhoneNumberFromString, findPhoneNumbersInText, getCountries, getCountryCallingCode } = require('libphonenumber-js/max');

// English country name (as Google Maps writes it with hl=en) -> ISO code.
const COUNTRY_BY_NAME = (() => {
  const map = new Map();
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  for (const code of getCountries()) {
    const name = names.of(code);
    if (name) map.set(name.toLowerCase(), code);
  }
  const aliases = {
    usa: 'US', 'united states of america': 'US', us: 'US', uk: 'GB', 'great britain': 'GB', england: 'GB',
    scotland: 'GB', wales: 'GB', uae: 'AE', 'u.a.e.': 'AE', ksa: 'SA', 'south korea': 'KR', 'north korea': 'KP',
    russia: 'RU', 'czech republic': 'CZ', turkey: 'TR', 'türkiye': 'TR', 'ivory coast': 'CI', 'hong kong': 'HK',
    'پاکستان': 'PK',
  };
  for (const [k, v] of Object.entries(aliases)) map.set(k, v);
  return map;
})();

// Country named at the end of an address ("..., Lahore, 54000, Pakistan").
function countryFromAddress(address) {
  const parts = String(address || '')
    .split(/[,،]/)
    .map((s) => s.trim().replace(/\.$/, '').toLowerCase())
    .filter(Boolean);
  for (let i = parts.length - 1; i >= Math.max(0, parts.length - 2); i--) {
    const code = COUNTRY_BY_NAME.get(parts[i]);
    if (code) return code;
  }
  return null;
}

// Returns { phone, raw, status, country, reason }:
//   status 'valid'      phone is E.164 (+923001234567), validated
//   status 'unverified' phone is the original; country unknown or number
//                       not confirmed valid. Needs checking by a person.
//   status 'invalid'    phone is null; the original is malformed/incomplete
//   status null         no number at all
function normalizePhone(raw, { address } = {}) {
  const original = String(raw ?? '').replace(/^tel:/i, '').replace(/\s+/g, ' ').trim();
  if (!original) return { phone: null, raw: null, status: null, country: null, reason: null };

  // Keep digits and a leading +; "00" is the international call prefix.
  let input = original.replace(/(?!^\+)[^\d]/g, '');
  if (input.startsWith('00')) input = `+${input.slice(2)}`;
  const digits = input.replace(/\D/g, '');
  const result = (status, extra) => ({ phone: null, raw: original, status, country: null, reason: null, ...extra });

  if (input.startsWith('+')) {
    const parsed = parsePhoneNumberFromString(input);
    if (parsed?.isValid()) return result('valid', { phone: parsed.number, country: parsed.country || null });
    if (parsed?.isPossible()) return result('unverified', { phone: original, reason: 'not a valid number for its country code' });
    return result('invalid', { reason: 'incomplete or malformed number' });
  }

  const country = countryFromAddress(address);
  if (!country) {
    // Plausible length, but without a country it cannot be normalised.
    if (digits.length >= 6 && digits.length <= 15) return result('unverified', { phone: original, reason: 'country could not be determined' });
    return result('invalid', { reason: 'incomplete or malformed number' });
  }
  const parsed = parsePhoneNumberFromString(input, country);
  if (parsed?.isValid()) return result('valid', { phone: parsed.number, country: parsed.country || country });
  if (parsed?.isPossible()) return result('unverified', { phone: original, country, reason: `not a valid ${country} number` });
  return result('invalid', { country, reason: `incomplete or malformed for ${country}` });
}

// --- numbers in free text (posts, pages, websites) ------------------------------

// Arabic-Indic and Persian digits as 0-9, so "۰۳۰۰" is read like "0300".
function asciiDigits(text) {
  return String(text || '').replace(/[٠-٩۰-۹]/g, (d) => String((d.charCodeAt(0) & 0xf) % 10));
}

// A run of digits with the separators people write numbers with (spaces,
// dots, hyphens, slashes, brackets), optionally after + or 00. Never crosses
// a line break, so digits from different parts of a page are not joined.
const CANDIDATE = /(?:\+|\b00)?[ \t ]*\(?\d(?:[ \t .()\/-]{0,2}\d){5,17}/g;
const DATE_LIKE = /^(\d{1,4})[\/.-](\d{1,2})[\/.-](\d{1,4})$/;
// Words around a number that make it a price, a count or an id, not a phone.
const BEFORE_NOT_PHONE = /(rs\.?|pkr|inr|usd|aed|sar|eur|gbp|[$€£₹]|price|qty|order|invoice|id|no\.?|#|ref|cnic|ntn|iban|account|a\/c)\s*[:.#-]?\s*$/i;
const AFTER_NOT_PHONE = /^\s*(k\b|m\b|views?|likes?|comments?|shares?|reactions?|members?|followers?|people|rs\b|pkr|rupees|usd|dollars?|%|sq\.?|ft|feet|kg|km|years?|yrs|months?|days?|hours?|mins?|pcs|pieces|units)/i;

// Every phone number in `text` (and tel:/WhatsApp links), as found:
//   status 'valid'       phone is E.164, validated for its country
//   status 'unverified'  looks like a phone number but its country is not
//                        known (no + and no country) or it is not valid
//                        for its country code: phone is the original text,
//                        kept for a person to check, never "fixed"
// Local numbers ("0300 1234567") are read with `country`; when there is
// none, a country shown by the text's own international numbers is used.
// Returns { phones: [{ phone, raw, status, country, reason }], stats:
// { candidates, valid, unverified, rejected, reasons } }.
function findPhones(text, { country = null, links = [], max = 5 } = {}) {
  const plain = asciiDigits(text).replace(/[,;|،]/g, '\n');
  const stats = { candidates: 0, valid: 0, unverified: 0, rejected: 0, reasons: {} };
  const reject = (reason) => {
    stats.rejected++;
    stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
  };
  const found = new Map(); // E.164 or digits -> entry, in order found
  const add = (entry) => {
    const key = entry.status === 'valid' ? entry.phone : `?${entry.raw.replace(/\D/g, '')}`;
    if (found.has(key)) return;
    // An unverified number that is another's valid form is the same number.
    if (entry.status === 'unverified' && [...found.values()].some((f) => f.status === 'valid' && f.phone.endsWith(entry.raw.replace(/\D/g, '').replace(/^0+/, '')))) return;
    found.set(key, entry);
  };

  // Links state the number on purpose: tel: as written, WhatsApp always
  // international.
  for (const href of links) {
    const tel = /^tel:(.+)$/i.exec(href);
    let raw = null;
    let intl = false;
    if (tel) raw = decodeURIComponent(tel[1]);
    else {
      try {
        const u = new URL(href);
        const wa = /^(www\.|api\.)?wa\.me$/i.test(u.hostname) ? u.pathname.slice(1) : /(^|\.)whatsapp\.com$/i.test(u.hostname) ? u.searchParams.get('phone') : null;
        if (wa && wa.replace(/\D/g, '').length >= 8) {
          raw = `+${wa.replace(/\D/g, '')}`;
          intl = true;
        }
      } catch {}
    }
    if (!raw) continue;
    stats.candidates++;
    const r = readCandidate(asciiDigits(raw), intl ? null : country);
    if (r.status) add({ ...r, raw: raw.trim() });
    else reject(r.reason);
  }

  // Candidates in the text, with what surrounds them.
  const matches = [];
  for (const m of plain.matchAll(CANDIDATE)) {
    const raw = m[0].replace(/^[\s (]+/, (s) => (s.includes('(') ? '(' : '')).trim();
    const start = m.index + m[0].indexOf(raw);
    matches.push({ raw, before: plain.slice(Math.max(0, start - 12), start), after: plain.slice(start + raw.length, start + raw.length + 12) });
  }
  // No country given: one shown by the text's international numbers.
  let ctxCountry = country;
  if (!ctxCountry) {
    const counts = {};
    for (const { raw } of matches) {
      if (!/^(\+|00)/.test(raw)) continue;
      const p = parsePhoneNumberFromString(raw.replace(/^00/, '+').replace(/[^\d+]/g, ''));
      if (p?.isValid() && p.country) counts[p.country] = (counts[p.country] || 0) + 1;
    }
    ctxCountry = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }
  for (const { raw, before, after } of matches) {
    stats.candidates++;
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 7) {
      reject('too short');
      continue;
    }
    if (DATE_LIKE.test(raw.replace(/\s/g, '')) && digits.length <= 8) {
      reject('date');
      continue;
    }
    if (BEFORE_NOT_PHONE.test(before)) {
      reject('price or id');
      continue;
    }
    if (AFTER_NOT_PHONE.test(after)) {
      reject('count or amount');
      continue;
    }
    // A number glued to letters ("ABC123456789") is a code, not a phone.
    if (/[a-z]$/i.test(before) || /^[a-z]/i.test(after)) {
      reject('part of a code');
      continue;
    }
    const r = readCandidate(raw, ctxCountry);
    if (r.status) add({ ...r, raw });
    else reject(r.reason);
  }
  // libphonenumber's own text matcher, for layouts the scan above splits.
  if (ctxCountry) {
    for (const m of findPhoneNumbersInText(plain, { defaultCountry: ctxCountry })) {
      if (m.number.isValid()) add({ phone: m.number.number, raw: plain.slice(m.startsAt, m.endsAt).trim(), status: 'valid', country: m.number.country || ctxCountry, reason: null });
    }
  }
  const phones = [...found.values()].slice(0, max);
  for (const p of phones) stats[p.status]++;
  return { phones, stats };
}

// One candidate: { status: 'valid' | 'unverified' | null, phone, country, reason }.
function readCandidate(raw, country) {
  let input = raw.replace(/(?!^\+)[^\d]/g, '');
  if (input.startsWith('00')) input = `+${input.slice(2)}`;
  const digits = input.replace(/\D/g, '');
  if (digits.length < 7) return { status: null, reason: 'too short' };
  if (digits.length > 15) return { status: null, reason: 'too long (an id or count)' };
  const ok = (p) => ({ status: 'valid', phone: p.number, country: p.country || country || null, reason: null });
  if (input.startsWith('+')) {
    const p = parsePhoneNumberFromString(input);
    if (p?.isValid()) return ok(p);
    if (p?.isPossible()) return { status: 'unverified', phone: raw.trim(), country: p.country || null, reason: 'not a valid number for its country code' };
    return { status: null, reason: 'not a phone number' };
  }
  if (country) {
    const p = parsePhoneNumberFromString(input, country);
    if (p?.isValid()) return ok(p);
    // Written in international form without the + ("923001234567").
    if (!input.startsWith('0') && digits.length >= 10) {
      const q = parsePhoneNumberFromString(`+${digits}`);
      if (q?.isValid() && q.country === country) return ok(q);
    }
  }
  // A number someone wrote as a phone ("0300-1234567", "(212) 555 0123") but
  // that can't be confirmed: kept for checking. A bare run of digits that
  // isn't valid anywhere is more likely an id or amount.
  const shaped = /^0\d/.test(digits) || /[\s.()\/-]/.test(raw.trim());
  if (shaped && digits.length >= 9 && digits.length <= 13) {
    return { status: 'unverified', phone: raw.trim(), country: country || null, reason: country ? `not a valid ${country} number` : 'country could not be determined' };
  }
  return { status: null, reason: country ? `not a valid ${country} number` : 'not a phone number' };
}

// Time zones -> country, for the default country of local numbers (the
// language setting is a poor guide: many people in Pakistan use en-US).
const ZONE_COUNTRY = {
  'Asia/Karachi': 'PK', 'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Asia/Dhaka': 'BD', 'Asia/Dubai': 'AE', 'Asia/Riyadh': 'SA',
  'Asia/Qatar': 'QA', 'Asia/Kuwait': 'KW', 'Asia/Bahrain': 'BH', 'Asia/Muscat': 'OM', 'Asia/Kathmandu': 'NP', 'Asia/Colombo': 'LK',
  'Asia/Kabul': 'AF', 'Asia/Tehran': 'IR', 'Europe/Istanbul': 'TR', 'Africa/Cairo': 'EG', 'Africa/Lagos': 'NG', 'Africa/Nairobi': 'KE',
  'Africa/Johannesburg': 'ZA', 'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'Europe/Paris': 'FR', 'Europe/Berlin': 'DE', 'Europe/Madrid': 'ES',
  'Europe/Rome': 'IT', 'Europe/Amsterdam': 'NL', 'Asia/Singapore': 'SG', 'Asia/Kuala_Lumpur': 'MY', 'Asia/Jakarta': 'ID', 'Asia/Manila': 'PH',
  'Asia/Tokyo': 'JP', 'Asia/Shanghai': 'CN', 'Asia/Hong_Kong': 'HK', 'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Pacific/Auckland': 'NZ',
  'America/Toronto': 'CA', 'America/Vancouver': 'CA', 'America/Mexico_City': 'MX', 'America/Sao_Paulo': 'BR',
};

// The country local numbers ("0300 1234567") are read with: the user's
// setting, else the country of most leads, else this computer's time zone,
// else its region setting. null when none is a known country.
function resolvePhoneCountry({ setting = null, common = null, timeZone = null, locale = null } = {}) {
  const known = new Set(getCountries());
  for (const c of [setting, common, ZONE_COUNTRY[timeZone] || (/^America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Detroit)$/.test(timeZone || '') ? 'US' : null), locale]) {
    const code = String(c || '').toUpperCase();
    if (known.has(code)) return code;
  }
  return null;
}

// The countries to choose from: [{ code, name, callingCode }], by name.
function phoneCountries() {
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  return getCountries()
    .map((code) => ({ code, name: names.of(code) || code, callingCode: getCountryCallingCode(code) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const RANK = { valid: 3, unverified: 2, invalid: 1 };

// The more reliable of two normalisation results (a new extraction never
// replaces a validated number with a worse one).
function betterPhone(a, b) {
  return (RANK[b?.status] || 0) > (RANK[a?.status] || 0) ? b : a;
}

const E164 = /^\+[1-9]\d{6,14}$/;

module.exports = { normalizePhone, countryFromAddress, betterPhone, findPhones, asciiDigits, resolvePhoneCountry, phoneCountries, COUNTRY_BY_NAME, E164 };
