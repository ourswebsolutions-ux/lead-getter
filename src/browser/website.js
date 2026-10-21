'use strict';

// Website qualification rules. Pure functions, so they are unit-testable
// without a browser.

// Pages that are not an independent business website.
const SOCIAL_HOSTS = [
  'facebook.com', 'fb.com', 'fb.me', 'm.facebook.com', 'instagram.com', 'instagr.am',
  'twitter.com', 'x.com', 'tiktok.com', 'linkedin.com', 'youtube.com', 'youtu.be',
  'pinterest.com', 'snapchat.com', 'threads.net', 'wa.me', 'whatsapp.com', 'api.whatsapp.com',
  'linktr.ee', 't.me', 'telegram.me',
];

// Google-owned listing pages: the Maps listing itself is not a website.
const GOOGLE_LISTING_HOSTS = ['business.site', 'g.page', 'goo.gl', 'maps.app.goo.gl', 'business.google.com'];

// Directories, marketplaces and aggregators that appear in web search
// results for a business but are not its own website.
const DIRECTORY_HOSTS = [
  ...SOCIAL_HOSTS, ...GOOGLE_LISTING_HOSTS,
  'google.com', 'google.com.pk', 'gstatic.com', 'googleusercontent.com', 'blogger.com',
  'wikipedia.org', 'wikimapia.org', 'yelp.com', 'tripadvisor.com', 'foursquare.com',
  'mapquest.com', 'waze.com', 'apple.com', 'bing.com', 'openstreetmap.org', 'mapcarta.com',
  'zameen.com', 'graana.com', 'olx.com.pk', 'olx.com', 'lamudi.pk', 'agency21.com.pk',
  'justdial.com', 'yellowpages.com', 'yellowpages.pk', 'yp.com.pk', 'cybo.com', 'hotfrog.com',
  'brownbook.net', 'kompass.com', 'opendi.com', 'infobel.com', 'trustpilot.com', 'glassdoor.com',
  'indeed.com', 'rozee.pk', 'crunchbase.com', 'dnb.com', 'bizapedia.com', 'manta.com',
  'chamberofcommerce.com', 'cylex.com', 'cylex-pk.com', 'tuugo.pk', 'tuugo.com', 'find-open.com',
  'nicelocal.com', 'wanderlog.com', 'restaurantguru.com', 'foodpanda.pk', 'zomato.com',
  'daraz.pk', 'amazon.com', 'ebay.com', 'pakbiz.com', 'pakbd.com', 'businesslist.pk',
  'zaubacorp.com', 'opencorporates.com', 'quora.com', 'reddit.com', 'medium.com',
  'dawn.com', 'tribune.com.pk', 'propertyguru.com', 'bayut.com', 'dubizzle.com',
];

function hostMatchesList(host, list) {
  return list.some((d) => host === d || host.endsWith(`.${d}`));
}

// Unwraps Google's redirect wrapper (https://www.google.com/url?q=...).
function unwrapUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (/(^|\.)google\.[a-z.]+$/.test(u.hostname) && u.pathname === '/url') {
    const inner = u.searchParams.get('q') || u.searchParams.get('url');
    if (inner) return unwrapUrl(inner);
  }
  return u;
}

function cleanHost(hostname) {
  return hostname.toLowerCase().replace(/^www\./, '');
}

// Classifies the website link shown on a Maps listing.
// kind: 'independent' | 'social' | 'listing' | 'invalid'
function classifyWebsite(raw) {
  const u = unwrapUrl(raw);
  if (!u || !/^https?:$/.test(u.protocol)) return { kind: 'invalid', host: '', url: raw || '' };
  const host = cleanHost(u.hostname);
  const display = `${host}${u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')}`;
  if (hostMatchesList(host, SOCIAL_HOSTS)) return { kind: 'social', host, url: display };
  if (hostMatchesList(host, GOOGLE_LISTING_HOSTS) || /(^|\.)google\.[a-z.]+$/.test(host)) {
    return { kind: 'listing', host, url: display };
  }
  return { kind: 'independent', host, url: display };
}

// Words too generic to tie a domain to a particular business.
const GENERIC_WORDS = new Set(`
the and of for pvt private ltd limited llc inc co company corp corporation group
real estate realestate realty realtors realtor property properties estates agency agencies
associates associate marketing builders builder developers developer development construction
consultants consultant consultancy services service solutions enterprises enterprise traders trading
international intl global center centre office branch shop store mart house home homes
land lands city town society housing scheme phase block sector town plaza tower towers
lahore karachi islamabad rawalpindi pakistan punjab sindh dha bahria gulberg johar
restaurant cafe hotel clinic hospital school college academy institute salon studio
`.trim().split(/\s+/));

function nameTokens(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const SUFFIX_LABELS = new Set(['com', 'net', 'org', 'pk', 'co', 'io', 'info', 'biz', 'uk', 'ae', 'us', 'in', 'edu', 'gov', 'me', 'online', 'site', 'store', 'shop', 'app', 'xyz']);

function domainLabel(host) {
  const labels = host.split('.').filter((l) => !SUFFIX_LABELS.has(l));
  return labels.length ? labels[labels.length - 1].replace(/-/g, '') : '';
}

// Does this domain plausibly belong to the named business? Deliberately
// generous: a match keeps the business out of the leads table.
function hostMatchesName(host, name) {
  const label = domainLabel(cleanHost(host));
  if (label.length < 3) return false;
  const tokens = nameTokens(name);
  const significant = tokens.filter((t) => t.length >= 4 && !GENERIC_WORDS.has(t));
  if (significant.some((t) => label.includes(t))) return true;
  const joined = tokens.join('');
  if (label.length >= 5 && joined.includes(label)) return true;
  const initials = tokens.filter((t) => !['the', 'and', 'of'].includes(t)).map((t) => t[0]).join('');
  return initials.length >= 3 && label === initials;
}

// Decides from the web-search evidence gathered for a business that Maps
// lists without a website. Returns { status, detail }.
function judgeWebPresence({ name, knowledgePanelWebsite, resultUrls }) {
  if (knowledgePanelWebsite) {
    const c = classifyWebsite(knowledgePanelWebsite);
    if (c.kind === 'independent') return { status: 'has_website', detail: c.url };
  }
  for (const raw of resultUrls || []) {
    const u = unwrapUrl(raw);
    if (!u) continue;
    const host = cleanHost(u.hostname);
    if (hostMatchesList(host, DIRECTORY_HOSTS) || /(^|\.)google\.[a-z.]+$/.test(host)) continue;
    if (hostMatchesName(host, name)) return { status: 'possible_website', detail: host };
  }
  return { status: 'no_website', detail: null };
}

// Builds the web-search query: the business name plus its city/area.
function presenceQuery(name, address) {
  const parts = String(address || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !/^\d[\d\s-]*$/.test(s) && !/^pakistan$/i.test(s));
  const locality = parts.length ? parts[parts.length - 1].replace(/\s*\d{5}$/, '') : '';
  return `"${name}"${locality ? ` ${locality}` : ''}`;
}

module.exports = {
  classifyWebsite,
  hostMatchesName,
  judgeWebPresence,
  presenceQuery,
  unwrapUrl,
};
