'use strict';

// RFC 4180 CSV with a UTF-8 byte order mark so spreadsheet apps (Excel in
// particular) read Urdu and other non-Latin text correctly.

const HEADER = [
  'Business Name', 'Phone', 'Phone Status', 'Address', 'Google Maps URL', 'Website Status', 'WhatsApp', 'Category', 'Date Discovered', 'Source',
  'Facebook Post URL', 'Facebook Page URL', 'Contact Name', 'Post Text',
  'Email', 'Website', 'LinkedIn Company URL', 'LinkedIn Job URL', 'LinkedIn Post URL', 'Job Title', 'Discovery',
  'Podcast Host', 'Apple Podcasts URL', 'RSS Feed URL', 'All Emails', 'Podcast Platforms', 'Search Keyword', 'Email Status',
  'LinkedIn Profile URL', 'Person Title', 'Company', 'All Phones', 'Contact Provider',
];

const PLATFORM_TEXT = { apple: 'Apple Podcasts', spotify: 'Spotify', youtube: 'YouTube', amazon: 'Amazon Music', podcastindex: 'Podcast Index', website: 'Website' };
const EMAIL_STATUS_TEXT = {
  found: 'Email found', none: 'No public email', platform: 'Platform address only', failed: 'Could not check', pending: 'Discovery pending',
  // People (contact discovery).
  verified: 'Verified', unverified: 'Unverified', invalid: 'Invalid',
};
const PROVIDER_TEXT = { contactout: 'ContactOut' };
const SOURCE_TEXT = { maps: 'Google Maps', facebook: 'Facebook', linkedin: 'LinkedIn', podcast: 'Podcast' };

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
      // A lead found only on Facebook or LinkedIn has no Maps listing.
      l.source === 'facebook' || l.source === 'linkedin' || l.source === 'podcast' ? '' : l.mapsUrl,
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
      l.email || '',
      l.websiteUrl || '',
      l.linkedinUrl || '',
      l.jobUrl || '',
      l.linkedinPostUrl || '',
      l.jobTitle || '',
      l.discovery || '',
      l.podcastHost || '',
      l.podcastUrl || '',
      l.rssUrl || '',
      // Every email found, with where (hosting-platform addresses marked).
      (l.emails || []).map((e) => `${e.email}${e.kind === 'platform' ? ' (hosting platform)' : e.kind === 'company' && l.kind === 'person' ? ' (company)' : ''}${l.kind === 'person' && e.status ? ` (${e.status})` : ''} [${e.from}]`).join('; '),
      // The podcast on each platform it was found on.
      Object.entries(l.podcastLinks || {}).map(([k, u]) => `${PLATFORM_TEXT[k] || k}: ${u}`).join('; '),
      l.keyword || '',
      // A person without any email found says so (business leads leave it empty).
      EMAIL_STATUS_TEXT[l.emailStatus] || (l.kind === 'person' ? 'No email found' : ''),
      l.profileUrl || '',
      l.personTitle || '',
      l.companyName || '',
      (l.phones || []).map((p) => `${p.phone} (${p.kind === 'direct' ? 'direct' : 'company'}, ${p.status === 'valid' ? 'valid' : 'unverified'}) [${p.from}]`).join('; '),
      (l.contactProviders || []).map((k) => PROVIDER_TEXT[k] || k).join(', '),
    ]);
  }
  return '﻿' + rows.map((r) => r.map(escapeCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { leadsToCsv, escapeCell, formatDate, HEADER };
