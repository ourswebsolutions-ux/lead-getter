'use strict';

// What the AI may use about a lead when it writes to it: only what the lead
// record has (nothing looked up or guessed), short, without empty fields.
function leadFacts(lead, extra = {}) {
  const pick = (v, n = 300) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined);
  const l = lead || {};
  const d = {
    business_name: pick(l.name) || extra.business || undefined,
    contact_name: pick(l.contactName) || extra.name || undefined,
    person_title: pick(l.personTitle),
    company: pick(l.companyName),
    category: pick(l.category),
    searched_as: pick(l.keyword),
    address: pick(l.address),
    phone: pick(l.phone),
    website: pick(l.websiteUrl) || (lead ? (l.websiteKind === 'with' ? 'has a website' : l.websiteKind === 'without' ? 'no website found' : undefined) : undefined),
    description: pick(l.description, 600),
    job_title_hiring_for: pick(l.jobTitle),
    found_on: pick(l.source),
    ...(extra.email ? { email: extra.email } : {}),
  };
  return Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined));
}

module.exports = { leadFacts };
