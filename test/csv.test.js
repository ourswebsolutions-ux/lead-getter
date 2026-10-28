'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { leadsToCsv } = require('../src/export/csv');

test('CSV has BOM, header, quoting and Unicode intact', () => {
  const csv = leadsToCsv([
    {
      name: 'Khan "Best" Estate, Lahore',
      phone: '+923001234567',
      phoneStatus: 'valid',
      whatsapp: 'available',
      address: 'گلبرگ، لاہور',
      mapsUrl: 'https://www.google.com/maps/place/x',
      websiteStatus: 'No website found',
      category: 'Software House',
      discoveredAt: '2026-10-20T10:05:00.000Z',
    },
    { name: '=HYPERLINK("x")', phone: '', address: '', mapsUrl: 'u', websiteStatus: 's', discoveredAt: 'bad' },
  ]);
  assert.ok(csv.startsWith('﻿'));
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], 'Business Name,Phone,Phone Status,Address,Google Maps URL,Website Status,WhatsApp,Category,Date Discovered,Source,Facebook Post URL,Facebook Page URL,Contact Name,Post Text,Email,Website,LinkedIn Company URL,LinkedIn Job URL,LinkedIn Post URL,Job Title,Discovery');
  assert.ok(lines[1].startsWith('"Khan ""Best"" Estate, Lahore",+923001234567,Valid,گلبرگ، لاہور,'));
  assert.ok(lines[1].includes(',No website found,Available,Software House,2026-10-20 '));
  assert.ok(lines[2].startsWith(`"'=HYPERLINK(""x"")"`));
  assert.ok(lines[2].includes(',Not listed,'));
  assert.ok(lines[2].includes(',s,Not checked,Uncategorized,'));
  assert.equal(lines[3], '');
});
