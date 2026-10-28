'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LeadStore } = require('../src/database/db');

const base = { placeKey: '0x1:0x2', mapsUrl: 'https://www.google.com/maps/place/A', name: 'A Estate', keyword: 'k' };

test('qualified lead is stored once; duplicates update instead of inserting', () => {
  const s = new LeadStore(':memory:');
  const first = s.save({ ...base, phone: '', address: 'Lahore', websiteStatus: 'no_website' });
  assert.ok(first.isNewLead);
  const second = s.save({ ...base, phone: '+923001234567', address: '', websiteStatus: 'no_website' });
  assert.ok(!second.isNewLead);
  const leads = s.listLeads();
  assert.equal(leads.length, 1);
  assert.equal(leads[0].phone, '+923001234567'); // missing field filled
  assert.equal(leads[0].address, 'Lahore'); // not blanked out
});

test('businesses with websites are recorded but never listed, and keep no contact data', () => {
  const s = new LeadStore(':memory:');
  const r = s.save({ ...base, phone: '123456', address: 'x', websiteStatus: 'has_website', websiteDetail: 'a.com' });
  assert.equal(r.lead, null);
  assert.equal(s.listLeads().length, 0);
  const row = s.get(base.placeKey);
  assert.equal(row.phone, null);
  assert.equal(row.address, null);
});

test('an inconclusive re-check does not demote a verified lead', () => {
  const s = new LeadStore(':memory:');
  s.save({ ...base, websiteStatus: 'no_website' });
  const r = s.save({ ...base, websiteStatus: 'unverified', websiteDetail: 'website check failed' });
  assert.ok(r.lead);
  assert.equal(s.listLeads().length, 1);
});

test('leads persist after the database is closed and reopened', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-db-'));
  const file = path.join(dir, 'leads.db');
  const a = new LeadStore(file);
  a.save({ ...base, name: 'اسٹیٹ ایجنسی', websiteStatus: 'social_only', websiteDetail: 'facebook.com/x' });
  a.close();
  const b = new LeadStore(file);
  const leads = b.listLeads();
  b.close();
  assert.equal(leads.length, 1);
  assert.equal(leads[0].name, 'اسٹیٹ ایجنسی');
  assert.match(leads[0].websiteStatus, /social page only: facebook\.com\/x/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('version 8 removes the old subscription device key and nothing else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-v8-'));
  const file = path.join(dir, 'leads.db');
  let s = new LeadStore(file);
  s.save({ placeKey: '0x8:0x8', mapsUrl: 'https://www.google.com/maps/place/K', name: 'Kept Lead', phoneRaw: '+923001234567', address: 'Lahore, Pakistan', websiteStatus: 'no_website' });
  s.setState('lastSearch', { keyword: 'kept' });
  s.setState('outreach.ack', 123);
  s.db.prepare("INSERT INTO outreach_sends (campaign_id, campaign_name, phone, stage, test, day, status, created_at, sent_at) VALUES (1, 'C', '+923001234567', 0, 0, '2026-10-25', 'read', 1, 1)").run();
  // As an earlier version left it: the licence device key, version 7.
  s.setState('device_key', { publicKey: 'x', privateKey: 'y', encrypted: false });
  s.db.exec('PRAGMA user_version = 7');
  s.close();
  s = new LeadStore(file);
  assert.equal(s.db.prepare('PRAGMA user_version').get().user_version, 9);
  assert.equal(s.getState('device_key'), null, 'the subscription key is gone');
  assert.deepEqual([s.getState('lastSearch'), s.getState('outreach.ack')], [{ keyword: 'kept' }, 123], 'other settings stay');
  assert.deepEqual(s.listLeads().map((l) => [l.name, l.campaign]), [['Kept Lead', 'seen']], 'leads and campaign history stay');
  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
