'use strict';

// Phone normalisation with libphonenumber (full metadata, so numbers are
// validated against each country's real numbering plan).
//
// The country is never guessed: a number written in international form
// (+.. or 00..) carries its own country code; a local number is only
// normalised when the listing's address names its country. Otherwise the
// original is kept and flagged for verification.

const { parsePhoneNumberFromString, getCountries } = require('libphonenumber-js/max');

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

const RANK = { valid: 3, unverified: 2, invalid: 1 };

// The more reliable of two normalisation results (a new extraction never
// replaces a validated number with a worse one).
function betterPhone(a, b) {
  return (RANK[b?.status] || 0) > (RANK[a?.status] || 0) ? b : a;
}

const E164 = /^\+[1-9]\d{6,14}$/;

module.exports = { normalizePhone, countryFromAddress, betterPhone, E164 };
