'use strict';

// RFC 4180 CSV with a UTF-8 byte order mark so spreadsheet apps (Excel in
// particular) read Urdu and other non-Latin text correctly.

const HEADER = ['Business Name', 'Phone', 'Phone Status', 'Address', 'Google Maps URL', 'Website Status', 'WhatsApp', 'Category', 'Date Discovered', 'Source', 'Facebook Post URL', 'Facebook Page URL', 'Contact Name', 'Post Text'];

const SOURCE_TEXT = { maps: 'Google Maps', facebook: 'Facebook' };

// Cells that a spreadsheet would evaluate as a formula get a leading
// apostrophe. Phone numbers such as "+92 300 1234567" are left alone.
function neutralizeFormula(value) {
  if (/^[=@\t\r]/.test(value) || /^[+-](?![\d\s().-]+$)/.test(value)) return `'${value}`;
  return value;
}

function escapeCell(value) {
  const text = neutralizeFormula(value == null ? '' : String(value));
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Phone column: the E.164 number when validated, else the original text;
// Phone Status says which, so an unverified number is never mistaken for a
// verified one.
function phoneStatusText(l) {
  if (l.phoneStatus === 'valid') return 'Valid';
  if (l.phoneStatus === 'unverified') return 'Unverified';
  if (l.phoneStatus === 'invalid') return `Invalid (original: ${l.phoneRaw})`;
  return l.phone ? 'Unverified' : 'Not listed';
}

const WHATSAPP_TEXT = { available: 'Available', unavailable: 'Unavailable', failed: 'Check failed' };

function leadsToCsv(leads) {
  const rows = [HEADER];
  for (const l of leads) {
    rows.push([
      l.name,
      l.phone,
      phoneStatusText(l),
      l.address,
      // A lead found only on Facebook has no Maps listing.
      l.source === 'facebook' ? '' : l.mapsUrl,
      l.websiteStatus,
      // Earlier manual marks are not a confirmed result.
      (l.whatsappMethod !== 'manual' && WHATSAPP_TEXT[l.whatsapp]) || 'Not checked',
      l.category || 'Uncategorized',
      formatDate(l.discoveredAt),
      (l.sources || ['maps']).map((x) => SOURCE_TEXT[x]).join(' + '),
      l.fbPostUrl || '',
      l.fbPageUrl || '',
      l.contactName || '',
      l.description || '',
    ]);
  }
  return '﻿' + rows.map((r) => r.map(escapeCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { leadsToCsv, escapeCell, formatDate, HEADER };
