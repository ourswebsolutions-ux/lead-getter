'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhone, countryFromAddress } = require('../src/database/phone');
const { LeadStore } = require('../src/database/db');

const PK = { address: '12 Main Blvd, Gulberg III, Lahore, 54000, Pakistan' };

test('Pakistani local numbers become +92 E.164 when the address says Pakistan', () => {
  assert.equal(normalizePhone('03001234567', PK).phone, '+923001234567');
  assert.equal(normalizePhone('0300 1234567', PK).phone, '+923001234567');
  assert.equal(normalizePhone('0673361621', PK).phone, '+92673361621', 'landline with trunk 0');
  assert.equal(normalizePhone('042 111 222 333', PK).phone, '+9242111222333', 'UAN');
  const r = normalizePhone('0300-1234567', PK);
  assert.equal(r.status, 'valid');
  assert.equal(r.country, 'PK');
  assert.equal(r.raw, '0300-1234567', 'original kept');
});

test('international forms (+ and 00) keep their own country code', () => {
  assert.equal(normalizePhone('+92 300 1234567', PK).phone, '+923001234567');
  assert.equal(normalizePhone('00923001234567', {}).phone, '+923001234567');
  const us = normalizePhone('+1 (212) 555-0123', PK); // address says Pakistan, number says US
  assert.equal(us.phone, '+12125550123');
  assert.equal(us.country, 'US');
  assert.equal(normalizePhone('+44 20 7946 0958', {}).phone, '+442079460958');
  assert.equal(normalizePhone('tel:+971 50 123 4567', {}).country, 'AE');
});

test('local numbers use the country in the address, never a default', () => {
  assert.equal(normalizePhone('(212) 555-0123', { address: '350 5th Ave, New York, NY 10118, United States' }).phone, '+12125550123');
  assert.equal(normalizePhone('020 7946 0958', { address: '10 Downing St, London SW1A 2AA, UK' }).phone, '+442079460958');
  // Unknown country: kept as typed, flagged, not given +92.
  const unknown = normalizePhone('03001234567', { address: 'Gulberg, Lahore' });
  assert.equal(unknown.status, 'unverified');
  assert.equal(unknown.phone, '03001234567');
  assert.match(unknown.reason, /country/);
});

test('invalid, incomplete or ambiguous numbers are not presented as verified', () => {
  const short = normalizePhone('0300', PK);
  assert.equal(short.status, 'invalid');
  assert.equal(short.phone, null);
  assert.equal(short.raw, '0300');
  assert.equal(normalizePhone('12345', PK).status, 'invalid');
  assert.equal(normalizePhone('+92 12', {}).status, 'invalid');
  assert.equal(normalizePhone('call us', PK).status, 'invalid');
  // Right length for Pakistan but not a real Pakistani number range.
  const odd = normalizePhone('01234567890', PK);
  assert.notEqual(odd.status, 'valid');
  assert.deepEqual(normalizePhone('', PK), { phone: null, raw: null, status: null, country: null, reason: null });
});

test('country is read from the end of the address only', () => {
  assert.equal(countryFromAddress('Office 5, Pakistan Chowk, Karachi, Pakistan'), 'PK');
  assert.equal(countryFromAddress('Shop 2, Dubai Mall, Dubai, United Arab Emirates'), 'AE');
  assert.equal(countryFromAddress('Pakistan Chowk, Karachi'), null);
  assert.equal(countryFromAddress(''), null);
});

const lead = (extra) => ({ placeKey: '0x1:0x1', mapsUrl: 'u', name: 'A', address: 'Lahore, Pakistan', websiteStatus: 'no_website', ...extra });

test('a later extraction never replaces a validated number with a worse one', () => {
  const s = new LeadStore(':memory:');
  s.save(lead({ phoneRaw: '03001234567' }));
  s.save(lead({ phoneRaw: '0300' }));
  const [l] = s.listLeads();
  assert.equal(l.phone, '+923001234567');
  assert.equal(l.phoneStatus, 'valid');
});

test('WhatsApp status: per number, only validated numbers, green only for a recorded "available"', () => {
  const s = new LeadStore(':memory:');
  s.save(lead({ phoneRaw: '03001234567' }));
  s.save(lead({ placeKey: '0x2:0x2', name: 'B', phoneRaw: '0300 1234567' })); // same number
  s.save(lead({ placeKey: '0x3:0x3', name: 'C', phoneRaw: '03001234567', address: 'Lahore' })); // unverified
  assert.ok(s.listLeads().every((l) => l.whatsapp === 'not_checked'), 'a well-formed number is not "available"');
  s.setWhatsAppStatus('+923001234567', 'available', 'manual');
  const byName = Object.fromEntries(s.listLeads().map((l) => [l.name, l.whatsapp]));
  assert.deepEqual(byName, { A: 'available', B: 'available', C: 'not_checked' });
  s.setWhatsAppStatus('+923001234567', 'unavailable');
  assert.ok(s.listLeads().filter((l) => l.name !== 'C').every((l) => l.whatsapp === 'unavailable'));
  s.setWhatsAppStatus('+923001234567', null);
  assert.ok(s.listLeads().every((l) => l.whatsapp === 'not_checked'));
  assert.throws(() => s.setWhatsAppStatus('03001234567', 'available'), /validated international/);
  assert.throws(() => s.setWhatsAppStatus('+923001234567', 'maybe'), /Unknown/);
});
