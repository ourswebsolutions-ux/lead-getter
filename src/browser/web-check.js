'use strict';

// Checks a business's public web presence when Maps lists no website: one
// Google web search in a visible tab, reading the knowledge-panel website
// link and the organic result domains.

const { detectBlock } = require('./maps');
const { judgeWebPresence, presenceQuery } = require('./website');

async function readSearchEvidence(page) {
  return page.evaluate(() => {
    const abs = (a) => a.href || '';
    // Knowledge panel "Website" button for the business.
    const panel = document.querySelector('#rhs');
    let knowledgePanelWebsite = '';
    const kpLinks = [
      ...document.querySelectorAll('[data-attrid="visit_official_site"] a, a[data-attrid="visit_official_site"]'),
      ...(panel ? [...panel.querySelectorAll('a')] : []),
    ];
    const site = kpLinks.find((a) => /^website$/i.test((a.textContent || '').trim()) || a.closest('[data-attrid="visit_official_site"]'));
    if (site) knowledgePanelWebsite = abs(site);
    // Organic results: anchors that wrap a result title.
    const results = [...document.querySelectorAll('#search a:has(h3), #rso a:has(h3)')].map(abs);
    return { knowledgePanelWebsite, resultUrls: [...new Set(results)].slice(0, 10), hasResults: Boolean(document.querySelector('#search, #rso')) };
  });
}

// Returns { status, detail } where status is
// 'no_website' | 'possible_website' | 'has_website' | 'unverified' | 'blocked'.
async function checkWebPresence(page, { name, address }) {
  const q = presenceQuery(name, address);
  await page.goto(`https://www.google.com/search?hl=en&q=${encodeURIComponent(q)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  if (await detectBlock(page)) return { status: 'blocked', detail: null };
  await page.waitForSelector('#search, #rso, #botstuff', { timeout: 15_000 }).catch(() => {});
  if (await detectBlock(page)) return { status: 'blocked', detail: null };
  const evidence = await readSearchEvidence(page);
  if (!evidence.hasResults) return { status: 'unverified', detail: 'web search did not load' };
  return judgeWebPresence({ name, ...evidence });
}

module.exports = { checkWebPresence, readSearchEvidence };
