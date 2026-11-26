'use strict';

// Tools added for Claude (on top of the assistant's own, ai/tools.js):
// leads searched by country, city, name, email and website, one lead in
// full, and summaries of a list. They only read, through the app's lead
// store (LeadStore.listLeads: the same rows the Leads tab shows).

const { emailOf } = require('../email/campaigns');
const { isVerified } = require('../whatsapp/eligibility');
const { leadFacts } = require('../ai/lead-facts');

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const DAY = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };

// --- countries -------------------------------------------------------------------

const ALIASES = { uk: 'GB', 'great britain': 'GB', britain: 'GB', england: 'GB', scotland: 'GB', wales: 'GB', usa: 'US', america: 'US', 'united states of america': 'US', uae: 'AE', emirates: 'AE', ksa: 'SA', holland: 'NL' };
let names = null;
// ISO code -> English names (from the runtime's own country list).
function countryNames() {
  if (names) return names;
  names = new Map();
  let dn = null;
  try {
    dn = new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {}
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      const name = dn?.of(code);
      if (name && name !== code && !/unknown/i.test(name)) names.set(code, name);
    }
  }
  return names;
}

// "UK", "United Kingdom", "gb" -> { code: 'GB', words: ['united kingdom', 'uk', ...] }
function countryOf(raw) {
  const v = String(raw || '').trim().toLowerCase().replace(/\./g, '');
  if (!v) return null;
  const all = countryNames();
  let code = ALIASES[v] || (v.length === 2 && all.has(v.toUpperCase()) ? v.toUpperCase() : null);
  if (!code) for (const [c, n] of all) if (n.toLowerCase() === v) code = c;
  if (!code) for (const [c, n] of all) if (n.toLowerCase().startsWith(v) && v.length >= 4) code = code || c;
  if (!code) return null;
  const words = new Set([all.get(code).toLowerCase()]);
  for (const [w, c] of Object.entries(ALIASES)) if (c === code) words.add(w);
  if (code === 'US') words.add('united states');
  return { code, name: all.get(code), words: [...words] };
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (text, word) => new RegExp(`(^|[^\\p{L}])${escape(word)}($|[^\\p{L}])`, 'iu').test(text || '');

// The lead's country: from the address's last part, else its phone number's country.
function leadCountry(l) {
  const parts = String(l.address || '').split(',').map((x) => x.trim()).filter(Boolean);
  const last = parts.length > 1 ? parts[parts.length - 1].replace(/[\d-]+/g, '').trim() : '';
  const c = last && countryOf(last);
  if (c) return c.name;
  return l.phoneCountry ? countryNames().get(l.phoneCountry) || l.phoneCountry : null;
}

// The town or city part of a Google Maps address (the part before the
// country, without postcodes): good enough for counting, not an exact city.
function leadPlace(l) {
  const parts = String(l.address || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  let i = parts.length - 1;
  if (countryOf(parts[i].replace(/[\d-]+/g, '').trim())) i--;
  while (i > 0 && /^[\dA-Z\s-]{3,10}$/.test(parts[i]) && /\d/.test(parts[i])) i--; // postcodes
  const place = parts[i]
    .replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/g, '') // UK postcodes
    .replace(/\b\d{3,}(-\d+)?\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return place && place.length <= 60 ? place : null;
}

// --- filters -----------------------------------------------------------------------

const FILTERS = {
  category: { type: 'string', maxLength: 100, description: 'Lead category name (list_categories), or "none" for leads without a category' },
  country: { type: 'string', maxLength: 60, description: 'Country name or ISO code, e.g. "United Kingdom", "UK", "PK" (from the address, else the phone number)' },
  city: { type: 'string', maxLength: 80, description: 'Town, city or area in the address, e.g. "Preston", "Gulberg"' },
  business_name: { type: 'string', maxLength: 100, description: 'Text in the business (or person) name' },
  search: { type: 'string', maxLength: 100, description: 'Text in the name, contact, company, email or phone' },
  email: { type: 'string', maxLength: 120, description: 'Text in the email address, e.g. "@gmail.com" or a domain' },
  has_email: { type: 'boolean', description: 'true: only leads with an email address; false: only leads without one' },
  has_phone: { type: 'boolean', description: 'true: only leads with a phone number; false: only without' },
  has_whatsapp: { type: 'boolean', description: 'Only leads whose number is confirmed on WhatsApp' },
  website: { type: 'string', enum: ['with', 'without'], description: 'Leads with or without a website' },
  website_contains: { type: 'string', maxLength: 120, description: 'Text in the website address, e.g. a domain or ".co.uk"' },
  source: { type: 'string', enum: ['maps', 'facebook', 'linkedin', 'podcast', 'import'], description: 'Where the lead was found' },
  contacted_on_whatsapp: { type: 'boolean', description: 'true: a campaign message went to this number; false: never messaged' },
  from: { ...DAY, description: 'Found on or after this day (YYYY-MM-DD)' },
  to: { ...DAY, description: 'Found on or before this day (YYYY-MM-DD)' },
  lead_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 1000, description: 'Only these leads' },
};

// email: the email service (campaigns); checkEmail(): the app's check of an
// email against its campaign prompt (ai/service.js).
function buildClaudeTools({ store, email = null, checkEmail = null }) {
  function categoryId(name) {
    if (name == null || name === '') return { ok: true, id: null };
    const raw = String(name).trim();
    if (/^(none|uncategori[sz]ed)$/i.test(raw)) return { ok: true, id: 'none' };
    const cats = store.listCategories().categories;
    const low = raw.toLowerCase();
    const hit = cats.find((c) => String(c.id) === raw) || cats.find((c) => c.name.toLowerCase() === low) || cats.find((c) => c.name.toLowerCase().includes(low));
    return hit ? { ok: true, id: hit.id } : { ok: false, error: `There is no lead category called “${raw}”. Categories: ${cats.map((c) => c.name).join(', ') || 'none yet'}.` };
  }

  function leadsFor(a) {
    const cat = categoryId(a.category);
    if (!cat.ok) return cat;
    const f = {};
    if (cat.id != null) f.category = cat.id;
    if (a.from) f.from = a.from;
    if (a.to) f.to = a.to;
    if (a.search) f.search = a.search.trim();
    if (a.website) f.website = a.website;
    if (a.source) f.source = a.source;
    if (a.lead_ids) f.ids = a.lead_ids;
    let country = null;
    if (a.country) {
      country = countryOf(a.country);
      if (!country) return { ok: false, error: `“${a.country}” is not a country name or code Lead Finder knows.` };
    }
    let leads = store.listLeads(f);
    if (f.ids) leads = leads.filter((l) => f.ids.includes(l.id));
    const low = (s) => String(s || '').toLowerCase();
    if (country) leads = leads.filter((l) => l.phoneCountry === country.code || country.words.some((w) => hasWord(l.address, w)));
    if (a.city) leads = leads.filter((l) => hasWord(l.address, a.city.trim()));
    if (a.business_name) leads = leads.filter((l) => low(l.name).includes(low(a.business_name.trim())) || low(l.companyName).includes(low(a.business_name.trim())));
    if (a.email) leads = leads.filter((l) => [l.email, ...(l.emails || []).map((e) => e.email || e)].some((e) => low(e).includes(low(a.email.trim()))));
    if (a.has_email != null) leads = leads.filter((l) => Boolean(emailOf(l)) === a.has_email);
    if (a.has_phone != null) leads = leads.filter((l) => Boolean(l.phone) === a.has_phone);
    if (a.has_whatsapp) leads = leads.filter(isVerified);
    if (a.website_contains) leads = leads.filter((l) => low(l.websiteUrl).includes(low(a.website_contains.trim())));
    if (a.contacted_on_whatsapp != null) leads = leads.filter((l) => (l.campaign === 'seen') === a.contacted_on_whatsapp);
    return { ok: true, leads };
  }

  const row = (l) => ({
    id: l.id,
    name: l.name,
    kind: l.kind,
    contact_name: l.contactName || undefined,
    category: l.category || null,
    city_or_area: leadPlace(l),
    country: leadCountry(l),
    address: l.address || null,
    phone: l.phone || null,
    whatsapp: l.whatsapp === 'available' ? 'yes' : l.whatsapp === 'not_on_whatsapp' ? 'no' : 'not checked',
    email: emailOf(l) || null,
    website: l.websiteUrl || (l.websiteKind === 'with' ? 'yes (address not saved)' : l.websiteKind === 'without' ? 'none' : 'not checked'),
    source: l.source,
    found: l.discoveredDate,
  });

  const count = (list, key) => {
    const m = new Map();
    for (const l of list) {
      const k = key(l) || 'unknown';
      m.set(k, (m.get(k) || 0) + 1);
    }
    return Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));
  };
  const top = (o, n) => Object.fromEntries(Object.entries(o).slice(0, n));

  const EMAIL_TOOLS = email
    ? [
        {
          name: 'emails_to_write',
          kind: 'read',
          title: 'Emails to write',
          description: 'For an email campaign whose AI emails are written by Claude (writer "claude"): the campaign prompt and the next emails to write, up to 25: first emails in sending order and follow-ups, each with the recipient’s email, step (0 = first email), the business facts (lead) and, for a follow-up, the earlier emails and its subject. Write each one yourself following the prompt exactly, using only the given facts (never invent compliments, reviews or website details), then save them with save_written_emails.',
          parameters: obj({ campaign_id: { type: 'integer', minimum: 1, description: 'The email campaign id (list_campaigns)' }, limit: { type: 'integer', minimum: 1, maximum: 25, description: 'How many, 1-25 (default 10)' } }, ['campaign_id']),
          run: (a) => email.campaigns.toWrite(a.campaign_id, { limit: a.limit }),
        },
        {
          name: 'save_written_emails',
          kind: 'config',
          title: 'Save written emails',
          description: 'Saves emails you wrote for a Claude-written campaign (from emails_to_write). Lead Finder makes each ready like its own AI emails (greeting and sign-off exactly as the prompt says) and checks the prompt’s rules (required lines, bullet points, questions, length, the business name); an email that misses one is not saved and its reasons come back: fix it and save it again. Saving sends nothing: the running campaign sends saved emails in its order, with its delays and limits.',
          parameters: obj(
            {
              campaign_id: { type: 'integer', minimum: 1 },
              emails: {
                type: 'array',
                maxItems: 25,
                items: obj({ email: { type: 'string', maxLength: 320, description: 'The recipient’s email (from emails_to_write)' }, step: { type: 'integer', minimum: 0, maximum: 10, description: '0 for the first email, else the follow-up step' }, subject: { type: 'string', maxLength: 250 }, body: { type: 'string', maxLength: 8000, description: 'Plain text, no unsubscribe line (the app adds one)' } }, ['email', 'step', 'body']),
              },
            },
            ['campaign_id', 'emails'],
          ),
          run: (a) => email.campaigns.saveWritten(a.campaign_id, a.emails, checkEmail),
        },
      ]
    : [];

  return [
    ...EMAIL_TOOLS,
    {
      name: 'search_leads',
      kind: 'read',
      title: 'Search leads',
      description: 'Searches the saved leads by country, city/area, category, business name, email, website, phone, WhatsApp, source and day found. Newest first; up to 100 per page (use offset for the next page). Returns each lead’s id, contacts, address, website and status.',
      parameters: obj({ ...FILTERS, offset: { type: 'integer', minimum: 0, description: 'Leads to skip (paging), default 0' }, limit: { type: 'integer', minimum: 1, maximum: 100, description: '1-100, default 25' } }),
      run: (a) => {
        const r = leadsFor(a);
        if (!r.ok) return r;
        const offset = a.offset || 0;
        const limit = a.limit || 25;
        const page = r.leads.slice(offset, offset + limit);
        return { ok: true, total: r.leads.length, offset, shown: page.length, more: offset + page.length < r.leads.length, leads: page.map(row) };
      },
    },
    {
      name: 'get_lead',
      kind: 'read',
      title: 'Lead details',
      description: 'One lead in full: names, every phone and email (with their checks), address, website and social links, LinkedIn/Facebook/podcast details, category, where and when it was found, WhatsApp campaign contact, and writing_facts (exactly what is known about it, to write outreach from).',
      parameters: obj({ lead_id: { type: 'integer', minimum: 1, description: 'The lead id (from search_leads)' } }, ['lead_id']),
      run: (a) => {
        const l = store.listLeads({ ids: [a.lead_id] }).find((x) => x.id === a.lead_id);
        if (!l) return { ok: false, error: `There is no lead with id ${a.lead_id}.` };
        const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null && !(Array.isArray(v) && !v.length)));
        return {
          ok: true,
          lead: clean({
            ...row(l),
            person_title: l.personTitle,
            company: l.companyName,
            company_url: l.companyUrl,
            description: l.description,
            searched_as: l.keyword,
            found_on: l.sources,
            phones: l.phones,
            phone_check: l.phoneStatus,
            whatsapp_checked: l.whatsappCheckedAt,
            emails: l.emails,
            email_check: l.emailStatus,
            website_check: l.websiteStatus,
            listing_links: l.listingLinks,
            google_maps: l.mapsUrl,
            linkedin_company: l.linkedinUrl,
            linkedin_profile: l.profileUrl,
            linkedin_job: l.jobUrl,
            job_title_hiring_for: l.jobTitle,
            facebook_post: l.fbPostUrl,
            facebook_page: l.fbPageUrl,
            podcast: l.podcastUrl,
            podcast_host: l.podcastHost,
            whatsapp_campaign: l.campaignDelivery ? `messaged (${l.campaignDelivery})` : 'never messaged',
            calls: l.callStatus === 'dnc' ? 'do not call' : l.callStatus === 'seen' ? 'called' : 'not called',
          }),
          writing_facts: leadFacts(l, { email: emailOf(l) || undefined }),
        };
      },
    },
    {
      name: 'lead_report',
      kind: 'read',
      title: 'Lead report',
      description: 'A summary of the leads matching a filter: totals, how many have email, phone, WhatsApp or a website, and counts by category, country, city/area, source and month found. Use it to analyse lists and find the best leads to contact.',
      parameters: obj(FILTERS),
      run: (a) => {
        const r = leadsFor(a);
        if (!r.ok) return r;
        const L = r.leads;
        return {
          ok: true,
          total: L.length,
          with_email: L.filter((l) => emailOf(l)).length,
          with_phone: L.filter((l) => l.phone).length,
          on_whatsapp: L.filter(isVerified).length,
          with_website: L.filter((l) => l.websiteKind === 'with').length,
          without_website: L.filter((l) => l.websiteKind === 'without').length,
          contacted_on_whatsapp: L.filter((l) => l.campaign === 'seen').length,
          email_but_no_website: L.filter((l) => emailOf(l) && l.websiteKind === 'without').length,
          by_category: top(count(L, (l) => l.category || 'Uncategorized'), 30),
          by_country: top(count(L, leadCountry), 30),
          by_city_or_area: top(count(L, leadPlace), 30),
          by_source: count(L, (l) => l.source),
          by_month_found: Object.fromEntries(Object.entries(count(L, (l) => String(l.discoveredDate || '').slice(0, 7))).sort((x, y) => (x[0] < y[0] ? 1 : -1)).slice(0, 24)),
        };
      },
    },
  ];
}

module.exports = { buildClaudeTools, countryOf, leadCountry, leadPlace };
