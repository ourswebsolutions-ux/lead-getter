'use strict';

// Which leads a campaign may message, after the user's filters:
//   - only numbers the automatic WhatsApp check confirmed (green in the lead
//     table); the number's format or country never counts as proof;
//   - one entry per normalized number (E.164), however many lead records
//     share it;
//   - never opted-out numbers;
//   - numbers already messaged in any campaign go to "previously contacted"
//     instead, unless the campaign allows them.

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isVerified(lead) {
  return lead.phoneStatus === 'valid' && /^\+\d{6,15}$/.test(lead.phone || '') && lead.whatsapp === 'available' && lead.whatsappMethod !== 'manual';
}

// filters: { categories: ['12', 'none', ...] (empty = all), from, to
// (YYYY-MM-DD, inclusive, on the date the lead was collected), search }
function matches(lead, { categories = [], from = null, to = null, search = '' } = {}) {
  if (categories.length) {
    const key = lead.categoryId == null ? 'none' : String(lead.categoryId);
    if (!categories.includes(key)) return false;
  }
  const day = lead.discoveredDate || '';
  if (from && DATE.test(from) && day < from) return false;
  if (to && DATE.test(to) && day > to) return false;
  const q = String(search || '').trim().toLowerCase();
  if (q) {
    const digits = q.replace(/\D/g, '');
    const hay = `${lead.name || ''} ${lead.category || ''} ${lead.address || ''}`.toLowerCase();
    if (!hay.includes(q) && !(digits.length >= 3 && (lead.phone || '').includes(digits))) return false;
  }
  return true;
}

// leads: LeadStore.listLeads() rows; store: OutreachStore;
// campaign: { id, config: { allowPrevious } }.
function eligibleContacts({ leads, store, campaign, filters = {} }) {
  const allowPrevious = Boolean(campaign?.config?.allowPrevious);
  const inCampaign = new Set(campaign ? store.contacts(campaign.id).map((c) => c.phone) : []);
  const history = new Map(store.history().map((h) => [h.phone, h]));
  const counts = { matching: 0, verified: 0, eligible: 0, previous: 0, optedOut: 0, notVerified: 0 };
  const eligible = [];
  const previous = [];
  const seen = new Set();
  for (const l of leads) {
    if (!matches(l, filters)) continue;
    counts.matching++;
    if (!isVerified(l)) {
      counts.notVerified++;
      continue;
    }
    if (seen.has(l.phone)) continue; // same number, another lead record
    seen.add(l.phone);
    counts.verified++;
    const entry = { id: l.id, name: l.name, phone: l.phone, category: l.category || null, categoryId: l.categoryId ?? null, date: l.discoveredDate || null, inCampaign: inCampaign.has(l.phone) };
    if (store.isOptedOut(l.phone)) {
      counts.optedOut++;
      continue;
    }
    const h = history.get(l.phone);
    if (h) {
      counts.previous++;
      previous.push({ ...entry, history: h, selectable: allowPrevious });
      if (!allowPrevious) continue;
    }
    counts.eligible++;
    eligible.push({ ...entry, previous: Boolean(h) });
  }
  return { eligible, previous, counts, allowPrevious };
}

module.exports = { eligibleContacts, isVerified, matches };
