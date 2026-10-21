'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyWebsite, hostMatchesName, judgeWebPresence, presenceQuery } = require('../src/browser/website');

test('independent website links are recognised', () => {
  assert.equal(classifyWebsite('https://www.abcproperties.pk/').kind, 'independent');
  assert.equal(classifyWebsite('https://www.google.com/url?q=https://abc.com/&sa=U').kind, 'independent');
});

test('social pages and Google listings are not independent websites', () => {
  assert.equal(classifyWebsite('https://www.facebook.com/abcproperties').kind, 'social');
  assert.equal(classifyWebsite('https://m.facebook.com/abc').kind, 'social');
  assert.equal(classifyWebsite('https://instagram.com/abc').kind, 'social');
  assert.equal(classifyWebsite('https://wa.me/923001234567').kind, 'social');
  assert.equal(classifyWebsite('https://abc-realty.business.site/').kind, 'listing');
  assert.equal(classifyWebsite('https://www.google.com/maps/place/abc').kind, 'listing');
  assert.equal(classifyWebsite('javascript:void(0)').kind, 'invalid');
});

test('domain-to-name matching ignores generic words', () => {
  assert.ok(hostMatchesName('alnoorestate.com', 'Al Noor Real Estate'));
  assert.ok(hostMatchesName('www.zahidproperties.com.pk', 'Zahid Properties & Builders'));
  assert.ok(hostMatchesName('pre.com.pk', 'Prime Real Estate'));
  assert.ok(!hostMatchesName('lahorerealestate.com', 'Al Noor Real Estate Lahore'));
  assert.ok(!hostMatchesName('propertiesonline.pk', 'Zahid Properties'));
});

test('web presence: knowledge panel website excludes the business', () => {
  const r = judgeWebPresence({ name: 'Al Noor Estate', knowledgePanelWebsite: 'https://alnoor.pk/', resultUrls: [] });
  assert.equal(r.status, 'has_website');
});

test('web presence: matching organic domain marks possible website', () => {
  const r = judgeWebPresence({
    name: 'Al Noor Estate',
    knowledgePanelWebsite: '',
    resultUrls: ['https://www.zameen.com/agents/alnoor', 'https://www.alnoorestate.com/about'],
  });
  assert.deepEqual(r, { status: 'possible_website', detail: 'alnoorestate.com' });
});

test('web presence: only directories and social pages means no website', () => {
  const r = judgeWebPresence({
    name: 'Al Noor Estate',
    knowledgePanelWebsite: '',
    resultUrls: ['https://www.facebook.com/alnoor', 'https://www.zameen.com/x', 'https://unrelated-news.com/story'],
  });
  assert.equal(r.status, 'no_website');
});

test('presence query uses the business name and locality', () => {
  assert.equal(presenceQuery('Al Noor Estate', '12 Main Blvd, Gulberg III, Lahore, 54000, Pakistan'), '"Al Noor Estate" Lahore');
  assert.equal(presenceQuery('Al Noor Estate', ''), '"Al Noor Estate"');
});
