'use strict';

// Local SQLite storage. Every checked listing is recorded by its Google Maps
// place key so it is not revisited; only qualified (website-less) rows keep
// phone and address, and only those are shown and exported. Leads carry the
// search category and the local date they were discovered.

const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { normalizePhone, betterPhone, E164 } = require('./phone');

// Statuses that make a business a qualified lead.
const QUALIFIED_STATUSES = new Set(['no_website', 'social_only']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS businesses (
  id             INTEGER PRIMARY KEY,
  place_key      TEXT NOT NULL UNIQUE,
  maps_url       TEXT NOT NULL,
  name           TEXT NOT NULL,
  phone          TEXT,
  address        TEXT,
  website_status TEXT NOT NULL,
  website_detail TEXT,
  qualified      INTEGER NOT NULL DEFAULT 0,
  keyword        TEXT,
  discovered_at  TEXT NOT NULL,
  checked_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS businesses_qualified ON businesses (qualified, discovered_at);
`;

// Schema version 1: categories, plus category and local discovery date on
// each business. Applied once, in a transaction, keeping existing rows.
const CATEGORIES_SCHEMA = `
CREATE TABLE IF NOT EXISTS categories (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  name_key     TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);
`;

const BUSY_RETRIES = 4;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The computer's local calendar date (YYYY-MM-DD) of a timestamp.
function localDate(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Category text: single spaces, first letter of each word capitalised
// ("software  house" -> "Software House"); other letters kept as typed.
function formatCategory(raw) {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w ? w[0].toLocaleUpperCase() + w.slice(1) : w))
    .join(' ');
}

// Duplicate check key: case and spacing differences are ignored.
function categoryKey(raw) {
  return formatCategory(raw).toLocaleLowerCase();
}

function isBusy(err) {
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(String(err?.message || err));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

class LeadStore {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.migrate();
    this.stmt = {
      get: this.db.prepare('SELECT * FROM businesses WHERE place_key = ?'),
      getLead: this.db.prepare(`${LEAD_SELECT} WHERE b.place_key = ?`),
      insert: this.db.prepare(`
        INSERT INTO businesses
          (place_key, maps_url, name, phone, phone_raw, phone_status, phone_country, address, website_status, website_detail,
           qualified, keyword, category_id, discovered_at, discovered_date, checked_at)
        VALUES
          (:place_key, :maps_url, :name, :phone, :phone_raw, :phone_status, :phone_country, :address, :website_status, :website_detail,
           :qualified, :keyword, :category_id, :now, :today, :now)`),
      // A business that becomes a lead now is dated today and filed under
      // this search's category; an existing lead keeps both (a missing
      // category is filled in).
      update: this.db.prepare(`
        UPDATE businesses SET
          maps_url = :maps_url, name = :name, phone = :phone, phone_raw = :phone_raw, phone_status = :phone_status,
          phone_country = :phone_country, address = :address,
          website_status = :website_status, website_detail = :website_detail,
          qualified = :qualified, checked_at = :now,
          category_id = CASE WHEN qualified = 0 AND :qualified = 1 THEN COALESCE(:category_id, category_id)
                             ELSE COALESCE(category_id, :category_id) END,
          discovered_date = CASE WHEN qualified = 0 AND :qualified = 1 THEN :today ELSE discovered_date END,
          discovered_at = CASE WHEN qualified = 0 AND :qualified = 1 THEN :now ELSE discovered_at END
        WHERE place_key = :place_key`),
      adopt: this.db.prepare(`
        UPDATE businesses SET
          place_key = :place_key, maps_url = :maps_url, name = :name, phone = :phone, phone_raw = :phone_raw, phone_status = :phone_status,
          phone_country = :phone_country, address = :address, website_status = :website_status, website_detail = :website_detail,
          keyword = COALESCE(keyword, :keyword), checked_at = :now, category_id = COALESCE(category_id, :category_id)
        WHERE id = :id`),
      categoryByKey: this.db.prepare('SELECT id, name FROM categories WHERE name_key = ?'),
      insertCategory: this.db.prepare('INSERT INTO categories (name, name_key, created_at, last_used_at) VALUES (?, ?, ?, ?)'),
      touchCategory: this.db.prepare('UPDATE categories SET last_used_at = ? WHERE id = ?'),
      categories: this.db.prepare(`
        SELECT c.id, c.name, COUNT(b.id) AS leadCount
        FROM categories c LEFT JOIN businesses b ON b.category_id = c.id AND b.qualified = 1
        GROUP BY c.id ORDER BY c.last_used_at DESC, c.name`),
      uncategorizedCount: this.db.prepare('SELECT COUNT(*) AS n FROM businesses WHERE qualified = 1 AND category_id IS NULL'),
      setWhatsApp: this.db.prepare(`
        INSERT INTO whatsapp_checks (phone, status, method, checked_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(phone) DO UPDATE SET status = excluded.status, method = excluded.method, checked_at = excluded.checked_at`),
      clearWhatsApp: this.db.prepare('DELETE FROM whatsapp_checks WHERE phone = ?'),
      getState: this.db.prepare('SELECT value FROM app_state WHERE key = ?'),
      setState: this.db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    };
  }

  withRetry(fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        return fn();
      } catch (err) {
        if (!isBusy(err) || attempt >= BUSY_RETRIES) throw err;
        sleepSync(250 * (attempt + 1));
      }
    }
  }

  // Versioned, in-order schema upgrades; each runs once in a transaction.
  migrate() {
    this.migrateV1();
    this.migrateV2();
    this.migrateV3();
    this.migrateV4();
    this.migrateV5();
    this.migrateV6();
    this.migrateV7();
    this.migrateV8();
    this.migrateV9();
    this.migrateV10();
    this.migrateV11();
    this.migrateV12();
    this.migrateV13();
    this.migrateV14();
    this.migrateV15();
    this.migrateV16();
    this.migrateV17();
  }

  // Version 17: SMS campaigns. A campaign keeps its message, its sending
  // controls and every recipient (a lead, an imported number or a contact
  // imported for it) with that recipient's own status, so progress survives
  // restarts and nobody gets the same campaign twice.
  migrateV17() {
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 17) return;
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sms_campaigns (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          message TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft',
          reason TEXT,
          device TEXT,
          delay_seconds INTEGER NOT NULL DEFAULT 30,
          per_hour INTEGER NOT NULL DEFAULT 60,
          max_retries INTEGER NOT NULL DEFAULT 2,
          skip_texted INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          finished_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS sms_recipients (
          id INTEGER PRIMARY KEY,
          campaign_id INTEGER NOT NULL,
          kind TEXT NOT NULL,
          ref_id INTEGER,
          phone TEXT NOT NULL,
          name TEXT,
          business TEXT,
          category TEXT,
          city TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          reason TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_at INTEGER,
          sms_id INTEGER,
          body TEXT,
          updated_at INTEGER,
          UNIQUE (campaign_id, phone)
        );
        CREATE INDEX IF NOT EXISTS sms_recipients_queue ON sms_recipients (campaign_id, status, id);
        CREATE INDEX IF NOT EXISTS sms_recipients_sms ON sms_recipients (sms_id);
        PRAGMA user_version = 17;`);
    });
  }

  // Version 16: imported phone numbers in categories of their own (apart
  // from leads), each with its call and SMS status; calls can belong to an
  // imported number; SMS messages sent and received through the phone
  // (Bluetooth MAP); the SMS status of leads, apart from WhatsApp and calls.
  migrateV16() {
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 16) return;
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS number_lists (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS numbers (
          id INTEGER PRIMARY KEY,
          list_id INTEGER NOT NULL REFERENCES number_lists(id) ON DELETE CASCADE,
          phone TEXT NOT NULL,
          phone_raw TEXT,
          valid INTEGER NOT NULL DEFAULT 0,
          name TEXT,
          business TEXT,
          extra TEXT,
          created_at INTEGER NOT NULL,
          call_seen_at INTEGER,
          call_dnc INTEGER NOT NULL DEFAULT 0,
          sms_seen_at INTEGER,
          UNIQUE (list_id, phone)
        );
        CREATE INDEX IF NOT EXISTS numbers_phone ON numbers (phone);
        CREATE TABLE IF NOT EXISTS sms_messages (
          id INTEGER PRIMARY KEY,
          handle TEXT UNIQUE,
          phone TEXT NOT NULL,
          direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
          body TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL,
          error TEXT,
          at INTEGER NOT NULL,
          lead_id INTEGER,
          number_id INTEGER,
          read INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS sms_phone ON sms_messages (phone, at);`);
      const has = (t, col) => this.db.prepare(`SELECT 1 FROM pragma_table_info('${t}') WHERE name = ?`).get(col);
      if (!has('calls', 'number_id')) this.db.exec('ALTER TABLE calls ADD COLUMN number_id INTEGER');
      if (!has('businesses', 'sms_seen_at')) this.db.exec('ALTER TABLE businesses ADD COLUMN sms_seen_at INTEGER');
      this.db.exec('PRAGMA user_version = 16;');
    });
  }

  // Version 15: the call status of each lead, kept apart from its WhatsApp
  // status: call_seen_at is set when an outgoing call to the lead actually
  // started (Call Seen); call_dnc marks a lead not to be called.
  migrateV15() {
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 15) return;
    this.transaction(() => {
      const has = (col) => this.db.prepare("SELECT 1 FROM pragma_table_info('businesses') WHERE name = ?").get(col);
      if (!has('call_seen_at')) this.db.exec('ALTER TABLE businesses ADD COLUMN call_seen_at INTEGER');
      if (!has('call_dnc')) this.db.exec('ALTER TABLE businesses ADD COLUMN call_dnc INTEGER NOT NULL DEFAULT 0');
      this.db.exec('PRAGMA user_version = 15;');
    });
  }

  // Version 14: calls made and received through the Dialer (the phone's
  // SIM). A call keeps the lead's name and business as they were, so its
  // history stays readable after the lead is deleted; no audio is stored.
  migrateV14() {
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 14) return;
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS calls (
          id INTEGER PRIMARY KEY,
          lead_id INTEGER,
          number TEXT NOT NULL DEFAULT '',
          name TEXT,
          business TEXT,
          direction TEXT NOT NULL CHECK (direction IN ('outgoing', 'incoming')),
          status TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          duration INTEGER NOT NULL DEFAULT 0,
          sim TEXT,
          device TEXT,
          detail TEXT
        );
        CREATE INDEX IF NOT EXISTS calls_lead ON calls (lead_id);
        CREATE INDEX IF NOT EXISTS calls_started ON calls (started_at);
        PRAGMA user_version = 14;`);
    });
  }

  // Version 13: which contact provider (a browser extension such as
  // ContactOut) supplied a person's contact details.
  migrateV13() {
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 13) return;
    this.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM pragma_table_info('businesses') WHERE name = 'contact_providers'").get()) this.db.exec('ALTER TABLE businesses ADD COLUMN contact_providers TEXT');
      this.db.exec('PRAGMA user_version = 13;');
    });
  }

  // Version 12: people found on LinkedIn (People search) as leads of their
  // own, and local contact datasets. A person lead keeps the profile
  // address, title, company and every email and phone contact discovery
  // found, each with its status; contact_records holds imported datasets
  // (CSV files) that contact discovery searches.
  migrateV12() {
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 12) return;
    this.transaction(() => {
      const has = (col) => this.db.prepare("SELECT 1 FROM pragma_table_info('businesses') WHERE name = ?").get(col);
      for (const col of ['li_profile_url', 'person_title', 'company_name', 'company_url', 'phones']) if (!has(col)) this.db.exec(`ALTER TABLE businesses ADD COLUMN ${col} TEXT`);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS businesses_profile ON businesses (li_profile_url);
        CREATE TABLE IF NOT EXISTS contact_records (
          id          INTEGER PRIMARY KEY,
          dataset     TEXT NOT NULL,
          name        TEXT,
          name_key    TEXT,
          email       TEXT,
          phone       TEXT,
          company     TEXT,
          company_key TEXT,
          domain      TEXT,
          title       TEXT,
          linkedin    TEXT,
          address     TEXT,
          imported_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS contact_records_name ON contact_records (name_key);
        CREATE INDEX IF NOT EXISTS contact_records_domain ON contact_records (domain);
        CREATE INDEX IF NOT EXISTS contact_records_linkedin ON contact_records (linkedin);
        PRAGMA user_version = 12;`);
    });
  }

  // Version 11: podcast searches and email status. Every podcast found is
  // saved at once with its email discovery pending; each search is recorded
  // (keyword, platforms, when, counts) with every podcast it found (platform,
  // source address, time, new or already saved). Existing podcast leads get
  // their status from what was saved.
  migrateV11() {
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 11) return;
    this.transaction(() => {
      const has = (col) => this.db.prepare("SELECT 1 FROM pragma_table_info('businesses') WHERE name = ?").get(col);
      for (const col of ['email_status', 'artwork_url']) if (!has(col)) this.db.exec(`ALTER TABLE businesses ADD COLUMN ${col} TEXT`);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS searches (
          id          INTEGER PRIMARY KEY,
          kind        TEXT NOT NULL,
          keyword     TEXT NOT NULL,
          platforms   TEXT NOT NULL,
          started_at  TEXT NOT NULL,
          finished_at TEXT,
          state       TEXT NOT NULL DEFAULT 'running',
          stats       TEXT
        );
        CREATE TABLE IF NOT EXISTS search_hits (
          search_id   INTEGER NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
          business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          platform    TEXT NOT NULL,
          source_url  TEXT,
          found_at    TEXT NOT NULL,
          outcome     TEXT NOT NULL,
          rank        INTEGER,
          PRIMARY KEY (search_id, business_id)
        );
        CREATE INDEX IF NOT EXISTS search_hits_business ON search_hits (business_id);
        UPDATE businesses SET email_status = CASE
            WHEN email IS NOT NULL THEN 'found'
            WHEN discovery LIKE 'email: Not checked%' THEN 'failed'
            WHEN discovery LIKE '%could not check%' THEN 'failed'
            ELSE 'none' END
          WHERE place_key LIKE 'pc:%' AND email_status IS NULL;
        PRAGMA user_version = 11;`);
    });
  }

  // Version 10: podcasts as a lead source (Podcast Lead Finder). A podcast
  // lead keeps its Apple Podcasts and RSS feed addresses, its links on other
  // platforms (Spotify, YouTube, Amazon Music, Podcast Index), its host and
  // every public email found (with where); lead_sources also records podcasts.
  migrateV10() {
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 10) return;
    this.transaction(() => {
      const has = (col) => this.db.prepare("SELECT 1 FROM pragma_table_info('businesses') WHERE name = ?").get(col);
      for (const col of ['podcast_url', 'rss_url', 'host_name', 'emails', 'podcast_links']) {
        if (!has(col)) this.db.exec(`ALTER TABLE businesses ADD COLUMN ${col} TEXT`);
      }
      this.db.exec(`
        CREATE TABLE lead_sources_v10 (
          id          INTEGER PRIMARY KEY,
          business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          source      TEXT NOT NULL CHECK (source IN ('facebook', 'linkedin', 'podcast')),
          url         TEXT NOT NULL,
          page_url    TEXT,
          author      TEXT,
          text        TEXT,
          phone       TEXT NOT NULL,
          found_at    TEXT NOT NULL,
          kind        TEXT,
          title       TEXT,
          UNIQUE (source, url, phone)
        );
        INSERT INTO lead_sources_v10 SELECT id, business_id, source, url, page_url, author, text, phone, found_at, kind, title FROM lead_sources;
        DROP TABLE lead_sources;
        ALTER TABLE lead_sources_v10 RENAME TO lead_sources;
        CREATE INDEX IF NOT EXISTS lead_sources_business ON lead_sources (business_id);
        CREATE INDEX IF NOT EXISTS businesses_podcast ON businesses (podcast_url);
        PRAGMA user_version = 10;`);
    });
  }

  // Version 8: the subscription system is gone. Its only local data, the
  // device key it signed requests with, is deleted; nothing else changes.
  // Version 9: LinkedIn as a third lead source. Company leads keep their
  // business email, official website, LinkedIn company/job/post addresses,
  // the job title and how far discovery got; lead_sources also records
  // LinkedIn (and what was found there). Existing data is copied unchanged.
  migrateV9() {
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 9) return;
    this.transaction(() => {
      const has = (col) => this.db.prepare("SELECT 1 FROM pragma_table_info('businesses') WHERE name = ?").get(col);
      for (const col of ['email', 'website_url', 'li_company_url', 'li_job_url', 'li_post_url', 'job_title', 'discovery']) {
        if (!has(col)) this.db.exec(`ALTER TABLE businesses ADD COLUMN ${col} TEXT`);
      }
      this.db.exec(`
        CREATE TABLE lead_sources_v9 (
          id          INTEGER PRIMARY KEY,
          business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          source      TEXT NOT NULL CHECK (source IN ('facebook', 'linkedin')),
          url         TEXT NOT NULL,
          page_url    TEXT,
          author      TEXT,
          text        TEXT,
          phone       TEXT NOT NULL,
          found_at    TEXT NOT NULL,
          kind        TEXT,
          title       TEXT,
          UNIQUE (source, url, phone)
        );
        INSERT INTO lead_sources_v9 (id, business_id, source, url, page_url, author, text, phone, found_at)
          SELECT id, business_id, source, url, page_url, author, text, phone, found_at FROM lead_sources;
        DROP TABLE lead_sources;
        ALTER TABLE lead_sources_v9 RENAME TO lead_sources;
        CREATE INDEX IF NOT EXISTS lead_sources_business ON lead_sources (business_id);
        CREATE INDEX IF NOT EXISTS businesses_li_company ON businesses (li_company_url);
        PRAGMA user_version = 9;`);
    });
  }

  migrateV8() {
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 8) return;
    this.transaction(() => {
      this.db.exec(`DELETE FROM app_state WHERE key = 'device_key'; PRAGMA user_version = 8;`);
    });
  }

  // Version 7: Facebook as a second lead source. A lead keeps the first
  // Facebook post it was found in (and its author), and every post that
  // mentioned the number is recorded in lead_sources.
  migrateV7() {
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 7) return;
    this.transaction(() => {
      const has = (col) => this.db.prepare("SELECT 1 FROM pragma_table_info('businesses') WHERE name = ?").get(col);
      for (const col of ['fb_post_url', 'fb_page_url', 'contact_name', 'description']) {
        if (!has(col)) this.db.exec(`ALTER TABLE businesses ADD COLUMN ${col} TEXT`);
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS lead_sources (
          id          INTEGER PRIMARY KEY,
          business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          source      TEXT NOT NULL CHECK (source IN ('facebook')),
          url         TEXT NOT NULL,
          page_url    TEXT,
          author      TEXT,
          text        TEXT,
          phone       TEXT NOT NULL,
          found_at    TEXT NOT NULL,
          UNIQUE (source, url, phone)
        );
        CREATE INDEX IF NOT EXISTS lead_sources_business ON lead_sources (business_id);
        PRAGMA user_version = 7;`);
    });
  }

  // Version 6: category campaigns (a campaign can follow one lead category
  // and fill its own queue) and automatic retries of failed sends.
  migrateV6() {
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 6) return;
    this.transaction(() => {
      // Columns are only added if missing, so a partly upgraded database
      // still upgrades cleanly.
      const has = (table, col) => this.db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(col);
      if (!has('outreach_campaigns', 'category')) this.db.exec('ALTER TABLE outreach_campaigns ADD COLUMN category TEXT');
      if (!has('outreach_contacts', 'attempts')) this.db.exec('ALTER TABLE outreach_contacts ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
      if (!has('outreach_contacts', 'retry_at')) this.db.exec('ALTER TABLE outreach_contacts ADD COLUMN retry_at INTEGER');
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS outreach_campaigns_category ON outreach_campaigns (category) WHERE category IS NOT NULL;
        PRAGMA user_version = 6;`);
    });
  }

  // Version 5: several outreach campaigns. The existing campaign (settings,
  // status, contacts, progress) becomes "Campaign 1"; every send keeps its
  // record. Sends are not tied to the campaign's lifetime: deleting or
  // resetting a campaign never erases who was contacted.
  migrateV5() {
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 5) return;
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS outreach_campaigns (
          id            INTEGER PRIMARY KEY,
          name          TEXT NOT NULL,
          config        TEXT NOT NULL,
          status        TEXT NOT NULL DEFAULT 'stopped' CHECK (status IN ('stopped', 'running', 'paused')),
          pause_reason  TEXT,
          next_due_at   INTEGER,
          current_phone TEXT,
          failures      INTEGER NOT NULL DEFAULT 0,
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL
        );
        CREATE TABLE outreach_contacts_v5 (
          campaign_id  INTEGER NOT NULL REFERENCES outreach_campaigns(id) ON DELETE CASCADE,
          phone        TEXT NOT NULL,
          lead_id      INTEGER REFERENCES businesses(id) ON DELETE SET NULL,
          name         TEXT,
          stage        INTEGER NOT NULL DEFAULT 0,
          state        TEXT NOT NULL CHECK (state IN ('queued', 'active', 'replied', 'opted_out', 'excluded', 'skipped', 'done', 'failed', 'uncertain')),
          last_sent_at INTEGER,
          added_at     INTEGER NOT NULL,
          updated_at   INTEGER NOT NULL,
          note         TEXT,
          PRIMARY KEY (campaign_id, phone)
        );
        CREATE TABLE outreach_sends_v5 (
          id            INTEGER PRIMARY KEY,
          campaign_id   INTEGER,
          campaign_name TEXT,
          phone         TEXT NOT NULL,
          stage         INTEGER NOT NULL,
          test          INTEGER NOT NULL DEFAULT 0,
          day           TEXT NOT NULL,
          status        TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'failed', 'unknown')),
          wa_id         TEXT,
          error         TEXT,
          created_at    INTEGER NOT NULL,
          sent_at       INTEGER,
          UNIQUE (campaign_id, phone, stage, test)
        );`);
      const hasOld = this.db.prepare('SELECT COUNT(*) n FROM outreach_contacts').get().n + this.db.prepare('SELECT COUNT(*) n FROM outreach_sends').get().n;
      const row = this.db.prepare("SELECT value FROM app_state WHERE key = 'outreach'").get();
      let saved = null;
      try {
        saved = row ? JSON.parse(row.value) : null;
      } catch {}
      if (hasOld || saved) {
        const now = Date.now();
        const status = ['running', 'paused'].includes(saved?.status) ? saved.status : 'stopped';
        const cfg = { ...(saved?.config || {}), name: 'Campaign 1' };
        this.db
          .prepare('INSERT INTO outreach_campaigns (id, name, config, status, pause_reason, next_due_at, current_phone, failures, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run('Campaign 1', JSON.stringify(cfg), status, saved?.pauseReason ?? null, saved?.nextDueAt ?? null, saved?.current ?? null, saved?.failures ?? 0, now, now);
        this.db.exec(`
          INSERT INTO outreach_contacts_v5 (campaign_id, phone, lead_id, name, stage, state, last_sent_at, added_at, updated_at, note)
            SELECT 1, phone, lead_id, name, stage, state, last_sent_at, added_at, updated_at, note FROM outreach_contacts;
          INSERT INTO outreach_sends_v5 (id, campaign_id, campaign_name, phone, stage, test, day, status, wa_id, error, created_at, sent_at)
            SELECT id, 1, 'Campaign 1', phone, stage, test, day, status, wa_id, error, created_at, sent_at FROM outreach_sends;`);
        if (saved?.acknowledgedAt) this.db.prepare("INSERT INTO app_state (key, value) VALUES ('outreach.ack', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(saved.acknowledgedAt));
      }
      this.db.exec(`
        DROP TABLE outreach_contacts;
        ALTER TABLE outreach_contacts_v5 RENAME TO outreach_contacts;
        DROP TABLE outreach_sends;
        ALTER TABLE outreach_sends_v5 RENAME TO outreach_sends;
        CREATE INDEX IF NOT EXISTS outreach_sends_day ON outreach_sends (day, test);
        CREATE INDEX IF NOT EXISTS outreach_sends_wa ON outreach_sends (wa_id);
        CREATE INDEX IF NOT EXISTS outreach_sends_phone ON outreach_sends (phone, test);
        DELETE FROM app_state WHERE key = 'outreach';
        PRAGMA user_version = 5;`);
    });
  }

  // Version 4: WhatsApp chats (message text is stored encrypted with the OS
  // keychain) and the real-estate outreach campaign. Adds tables only;
  // existing data is untouched.
  migrateV4() {
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 4) return;
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS wa_chats (
          jid               TEXT PRIMARY KEY,
          phone             TEXT,
          name              TEXT,
          last_ts           INTEGER,
          last_preview      BLOB,
          last_from_me      INTEGER,
          unread            INTEGER NOT NULL DEFAULT 0,
          avatar            TEXT,
          avatar_checked_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS wa_chats_last ON wa_chats (last_ts);
        CREATE INDEX IF NOT EXISTS wa_chats_phone ON wa_chats (phone);
        CREATE TABLE IF NOT EXISTS wa_chat_messages (
          jid     TEXT NOT NULL,
          id      TEXT NOT NULL,
          from_me INTEGER NOT NULL,
          sender  TEXT,
          ts      INTEGER NOT NULL,
          kind    TEXT NOT NULL,
          body    BLOB,
          status  TEXT,
          PRIMARY KEY (jid, id)
        );
        CREATE INDEX IF NOT EXISTS wa_chat_messages_ts ON wa_chat_messages (jid, ts);
        CREATE TABLE IF NOT EXISTS outreach_contacts (
          phone        TEXT PRIMARY KEY,
          lead_id      INTEGER REFERENCES businesses(id) ON DELETE SET NULL,
          name         TEXT,
          stage        INTEGER NOT NULL DEFAULT 0,
          state        TEXT NOT NULL CHECK (state IN ('queued', 'active', 'replied', 'opted_out', 'excluded', 'done', 'failed', 'uncertain')),
          last_sent_at INTEGER,
          added_at     INTEGER NOT NULL,
          updated_at   INTEGER NOT NULL,
          note         TEXT
        );
        CREATE TABLE IF NOT EXISTS outreach_sends (
          id         INTEGER PRIMARY KEY,
          phone      TEXT NOT NULL,
          stage      INTEGER NOT NULL,
          test       INTEGER NOT NULL DEFAULT 0,
          day        TEXT NOT NULL,
          status     TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'failed', 'unknown')),
          wa_id      TEXT,
          error      TEXT,
          created_at INTEGER NOT NULL,
          sent_at    INTEGER,
          UNIQUE (phone, stage, test)
        );
        CREATE INDEX IF NOT EXISTS outreach_sends_day ON outreach_sends (day, test);
        CREATE INDEX IF NOT EXISTS outreach_sends_wa ON outreach_sends (wa_id);
        CREATE TABLE IF NOT EXISTS outreach_optouts (
          phone  TEXT PRIMARY KEY,
          reason TEXT,
          at     INTEGER NOT NULL
        );
        PRAGMA user_version = 4;`);
    });
  }

  // Version 3: WhatsApp checks may also be 'failed' (with the reason), and
  // messages the user sends are recorded. Existing results are kept.
  migrateV3() {
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 3) return;
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE whatsapp_checks_v3 (
          phone      TEXT PRIMARY KEY,
          status     TEXT NOT NULL CHECK (status IN ('available', 'unavailable', 'failed')),
          method     TEXT NOT NULL,
          detail     TEXT,
          checked_at TEXT NOT NULL
        );
        INSERT INTO whatsapp_checks_v3 (phone, status, method, checked_at)
          SELECT phone, status, method, checked_at FROM whatsapp_checks;
        DROP TABLE whatsapp_checks;
        ALTER TABLE whatsapp_checks_v3 RENAME TO whatsapp_checks;
        CREATE TABLE IF NOT EXISTS whatsapp_messages (
          id          INTEGER PRIMARY KEY,
          business_id INTEGER REFERENCES businesses(id) ON DELETE SET NULL,
          phone       TEXT NOT NULL,
          body        TEXT NOT NULL,
          wa_id       TEXT,
          status      TEXT NOT NULL,
          error       TEXT,
          sent_at     TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS whatsapp_messages_phone ON whatsapp_messages (phone, sent_at);
        PRAGMA user_version = 3;`);
    });
  }

  migrateV1() {
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 1) return;
    this.transaction(() => {
      this.db.exec(CATEGORIES_SCHEMA);
      const cols = new Set(this.db.prepare('PRAGMA table_info(businesses)').all().map((c) => c.name));
      if (!cols.has('category_id')) {
        this.db.exec('ALTER TABLE businesses ADD COLUMN category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL');
      }
      if (!cols.has('discovered_date')) this.db.exec('ALTER TABLE businesses ADD COLUMN discovered_date TEXT');
      // Existing rows: the local date comes from their real discovery time.
      // No category was ever recorded for them, so none is invented.
      const setDate = this.db.prepare('UPDATE businesses SET discovered_date = ? WHERE id = ?');
      for (const r of this.db.prepare('SELECT id, discovered_at FROM businesses WHERE discovered_date IS NULL').all()) {
        setDate.run(localDate(r.discovered_at), r.id);
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS businesses_view ON businesses (qualified, discovered_date, category_id)');
      this.db.exec('PRAGMA user_version = 1');
    });
  }

  // Version 2: international phone numbers (original kept for auditing),
  // per-number WhatsApp status, and the last search for crash recovery.
  migrateV2() {
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 2) return;
    this.transaction(() => {
      const cols = new Set(this.db.prepare('PRAGMA table_info(businesses)').all().map((c) => c.name));
      for (const c of ['phone_raw', 'phone_status', 'phone_country']) {
        if (!cols.has(c)) this.db.exec(`ALTER TABLE businesses ADD COLUMN ${c} TEXT`);
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS whatsapp_checks (
          phone      TEXT PRIMARY KEY,
          status     TEXT NOT NULL CHECK (status IN ('available', 'unavailable')),
          method     TEXT NOT NULL,
          checked_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS businesses_phone ON businesses (phone);`);
      // Existing numbers: keep the stored text as the original and normalise
      // it with the country named in the address.
      const set = this.db.prepare('UPDATE businesses SET phone = ?, phone_raw = ?, phone_status = ?, phone_country = ? WHERE id = ?');
      for (const r of this.db.prepare('SELECT id, phone, address FROM businesses WHERE phone IS NOT NULL AND phone_status IS NULL').all()) {
        const n = normalizePhone(r.phone, { address: r.address });
        set.run(n.phone, n.raw, n.status, n.country, r.id);
      }
      this.db.exec('PRAGMA user_version = 2');
    });
  }

  // Nested calls join the transaction already open.
  transaction(fn) {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  get(placeKey) {
    return this.withRetry(() => this.stmt.get.get(placeKey)) || null;
  }

  // --- categories ---------------------------------------------------------

  // Returns the saved category for this name, creating it if new. Names that
  // differ only in case or spacing are the same category (the first saved
  // spelling is kept, so names stay consistent).
  ensureCategory(raw, now = new Date().toISOString()) {
    const name = formatCategory(raw);
    if (!name) throw new Error('Category is empty');
    const key = categoryKey(name);
    return this.withRetry(() => {
      const existing = this.stmt.categoryByKey.get(key);
      if (existing) {
        this.stmt.touchCategory.run(now, existing.id);
        return { id: existing.id, name: existing.name };
      }
      const r = this.stmt.insertCategory.run(name, key, now, now);
      return { id: Number(r.lastInsertRowid), name };
    });
  }

  listCategories() {
    return this.withRetry(() => ({
      categories: this.stmt.categories.all().map((c) => ({ id: c.id, name: c.name, leadCount: c.leadCount })),
      uncategorized: this.stmt.uncategorizedCount.get().n,
    }));
  }

  // Renames a category. If the new name matches another category (ignoring
  // case/spacing) the two are merged only when `merge` is true; otherwise
  // { conflict } is returned so the caller can ask first.
  renameCategory(id, raw, { merge = false } = {}) {
    const name = formatCategory(raw);
    if (name.length < 2) throw new Error('Category names need at least 2 characters.');
    const key = categoryKey(name);
    return this.withRetry(() =>
      this.transaction(() => {
        const cat = this.db.prepare('SELECT id, name FROM categories WHERE id = ?').get(id);
        if (!cat) throw new Error('That category no longer exists.');
        const other = this.db.prepare('SELECT id, name FROM categories WHERE name_key = ? AND id != ?').get(key, id);
        if (other && !merge) return { conflict: { id: other.id, name: other.name } };
        if (other) {
          const moved = Number(this.db.prepare('UPDATE businesses SET category_id = ? WHERE category_id = ?').run(other.id, id).changes);
          this.db.prepare('DELETE FROM categories WHERE id = ?').run(id);
          return { merged: true, id: other.id, name: other.name, moved };
        }
        this.db.prepare('UPDATE categories SET name = ?, name_key = ? WHERE id = ?').run(name, key, id);
        return { renamed: true, id, name };
      }),
    );
  }

  // Deletes a category; its leads are kept and become Uncategorized.
  deleteCategory(id) {
    return this.withRetry(() =>
      this.transaction(() => {
        const cat = this.db.prepare('SELECT id, name FROM categories WHERE id = ?').get(id);
        if (!cat) throw new Error('That category no longer exists.');
        const leads = Number(this.db.prepare('UPDATE businesses SET category_id = NULL WHERE category_id = ?').run(id).changes);
        this.db.prepare('DELETE FROM categories WHERE id = ?').run(id);
        return { deleted: true, name: cat.name, uncategorized: leads };
      }),
    );
  }

  // Leads that first became leads at or after `iso` (a search's new leads).
  countNewLeadsSince(iso) {
    return this.withRetry(() => this.db.prepare('SELECT COUNT(*) AS n FROM businesses WHERE qualified = 1 AND discovered_at >= ?').get(iso).n);
  }

  // --- leads by filter ---------------------------------------------------------
  // filter: { category: 'all' | 'none' | <id>, date: 'YYYY-MM-DD', from, to }

  where(filter = {}) {
    const clauses = ['b.qualified = 1'];
    const params = [];
    const cat = filter.category ?? 'all';
    if (cat === 'none') clauses.push('b.category_id IS NULL');
    else if (cat !== 'all') {
      clauses.push('b.category_id = ?');
      params.push(Number(cat));
    }
    if (filter.date) {
      clauses.push('b.discovered_date = ?');
      params.push(filter.date);
    }
    if (filter.from) {
      clauses.push('b.discovered_date >= ?');
      params.push(filter.from);
    }
    if (filter.to) {
      clauses.push('b.discovered_date <= ?');
      params.push(filter.to);
    }
    if (filter.before) {
      clauses.push('b.discovered_date < ?');
      params.push(filter.before);
    }
    // Source: found on Google Maps (Facebook leads have a 'fb:' key) and/or
    // in a Facebook post.
    if (filter.source === 'maps') clauses.push("b.place_key NOT LIKE 'fb:%' AND b.place_key NOT LIKE 'li:%' AND b.place_key NOT LIKE 'lp:%' AND b.place_key NOT LIKE 'pc:%'");
    else if (filter.source === 'facebook') clauses.push('b.fb_post_url IS NOT NULL');
    else if (filter.source === 'linkedin') clauses.push('(b.li_company_url IS NOT NULL OR b.li_job_url IS NOT NULL OR b.li_post_url IS NOT NULL OR b.li_profile_url IS NOT NULL)');
    else if (filter.source === 'podcast') clauses.push("b.place_key LIKE 'pc:%'");
    if (filter.website === 'without') clauses.push("b.website_status IN ('no_website', 'social_only')");
    else if (filter.website === 'with') clauses.push("b.website_status IN ('has_website', 'possible_website')");
    // Campaign status: Seen = a campaign message to this number was sent
    // (WhatsApp accepted it: sent, delivered or read). Everything else,
    // including failed or uncertain sends, is Unseen.
    if (filter.campaign === 'seen' || filter.campaign === 'unseen') {
      clauses.push(`${filter.campaign === 'unseen' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM outreach_sends s
        WHERE s.phone = b.phone AND s.test = 0 AND s.status IN ('sent', 'delivered', 'read'))`);
    }
    // Call status (the Dialer): Seen once an outgoing call to the lead started.
    if (filter.call === 'seen') clauses.push('b.call_seen_at IS NOT NULL');
    else if (filter.call === 'unseen') clauses.push('b.call_seen_at IS NULL AND b.call_dnc = 0');
    else if (filter.call === 'dnc') clauses.push('b.call_dnc = 1');
    // Search: business or contact name, or (by digits) the phone number.
    const q = typeof filter.search === 'string' ? filter.search.trim().slice(0, 100) : '';
    if (q) {
      const like = (v) => `%${v.replace(/[\\%_]/g, '\\$&')}%`;
      const digits = q.replace(/\D/g, '');
      clauses.push(`(b.name LIKE ? ESCAPE '\\' OR b.contact_name LIKE ? ESCAPE '\\' OR b.company_name LIKE ? ESCAPE '\\' OR b.email LIKE ? ESCAPE '\\'${digits.length >= 3 ? " OR b.phone LIKE ? ESCAPE '\\' OR b.phone_raw LIKE ? ESCAPE '\\'" : ''})`);
      params.push(like(q), like(q), like(q), like(q));
      if (digits.length >= 3) params.push(like(digits), like(digits));
    }
    // Only these leads (the table checking which new leads match its filter).
    if (Array.isArray(filter.ids)) {
      const ids = filter.ids.filter(Number.isInteger).slice(0, 1000);
      clauses.push(ids.length ? `b.id IN (${ids.map(() => '?').join(', ')})` : '0');
      params.push(...ids);
    }
    // Only numbers WhatsApp itself confirmed (not earlier manual marks).
    if (filter.whatsapp === 'available') {
      clauses.push(`b.phone_status = 'valid' AND EXISTS (SELECT 1 FROM whatsapp_checks w2
        WHERE w2.phone = b.phone AND w2.status = 'available' AND w2.method != 'manual')`);
    }
    // Only numbers WhatsApp itself said have no account (to call or SMS instead).
    if (filter.whatsapp === 'unavailable') {
      clauses.push(`b.phone_status = 'valid' AND EXISTS (SELECT 1 FROM whatsapp_checks w2
        WHERE w2.phone = b.phone AND w2.status = 'unavailable' AND w2.method != 'manual')`);
    }
    return { sql: clauses.join(' AND '), params };
  }

  listLeads(filter = {}) {
    const w = this.where(filter);
    return this.withRetry(() =>
      this.db.prepare(`${LEAD_SELECT} WHERE ${w.sql} ORDER BY b.discovered_at DESC, b.id DESC`).all(...w.params),
    ).map(toLead);
  }

  // Dates that have leads (newest first), honouring the category filter.
  listDates(filter = {}) {
    const w = this.where({ category: filter.category, before: filter.before });
    return this.withRetry(() =>
      this.db
        .prepare(`SELECT b.discovered_date AS date, COUNT(*) AS count FROM businesses b WHERE ${w.sql} GROUP BY b.discovered_date ORDER BY b.discovered_date DESC`)
        .all(...w.params),
    ).map((r) => ({ date: r.date, count: r.count }));
  }

  countLeads(filter = {}) {
    const w = this.where(filter);
    return this.withRetry(() => this.db.prepare(`SELECT COUNT(*) AS n FROM businesses b WHERE ${w.sql}`).get(...w.params).n);
  }

  // Deleted leads leave a minimal marker (place id only, no name or contact
  // details) so later searches do not add the same business again.
  // Categories and other records are untouched.
  deleteLeads(ids) {
    const list = [...new Set(ids.map(Number).filter(Number.isInteger))];
    if (!list.length) return 0;
    return this.withRetry(() => this.transaction(() => this.tombstone(list)));
  }

  deleteFiltered(filter = {}) {
    const w = this.where(filter);
    return this.withRetry(() =>
      this.transaction(() => this.tombstone(this.db.prepare(`SELECT b.id FROM businesses b WHERE ${w.sql}`).all(...w.params).map((r) => r.id))),
    );
  }

  // Inside a transaction. A lead that was found on Facebook also leaves a
  // Facebook marker (a hash of the number, not the number) so Facebook
  // searches do not add it again either.
  tombstone(ids, now = new Date().toISOString()) {
    const get = this.db.prepare('SELECT id, place_key, phone, fb_post_url FROM businesses WHERE id = ? AND qualified = 1');
    const clear = this.db.prepare(`UPDATE businesses SET ${TOMBSTONE} WHERE id = ?`);
    const dropSources = this.db.prepare('DELETE FROM lead_sources WHERE business_id = ?');
    const marker = this.db.prepare(`INSERT INTO businesses (place_key, maps_url, name, website_status, qualified, discovered_at, checked_at)
      VALUES (?, '', '', 'deleted', 0, ?, ?) ON CONFLICT(place_key) DO NOTHING`);
    let n = 0;
    for (const id of ids) {
      const row = get.get(id);
      if (!row) continue;
      if (row.fb_post_url && row.phone && !row.place_key.startsWith('fb:')) marker.run(facebookKey(row.phone), now, now);
      clear.run(id);
      dropSources.run(id);
      n++;
    }
    return n;
  }

  // Saves a checked business. Returns { lead, isNewLead } where lead is set
  // when the stored row is a qualified lead.
  // One transaction: the Google Maps and Facebook workers save side by side,
  // and the check for the same number and the insert or merge are one step.
  save(result, now = new Date().toISOString()) {
    return this.withRetry(() => this.transaction(() => {
      const existing = this.stmt.get.get(result.placeKey);
      let status = result.websiteStatus;
      let detail = result.websiteDetail || null;
      // A failed or inconclusive check never overrides an earlier conclusive one.
      if (existing && status === 'unverified' && existing.website_status !== 'unverified') {
        status = existing.website_status;
        detail = existing.website_detail;
      }
      // A lead is a business the search's website filter selected (callers
      // that pass no isLead keep the original "no website" rule). Once a
      // lead, always a lead (until deleted).
      const wanted = result.isLead ?? QUALIFIED_STATUSES.has(status);
      const qualified = existing?.qualified || wanted ? 1 : 0;
      const address = result.address || existing?.address || null;
      // The better of the newly extracted and the stored number is kept.
      const fresh = normalizePhone(result.phoneRaw ?? result.phone, { address });
      const stored = existing?.phone_raw || existing?.phone
        ? { phone: existing.phone, raw: existing.phone_raw || existing.phone, status: existing.phone_status, country: existing.phone_country }
        : null;
      const ph = qualified ? betterPhone(stored, fresh) || {} : {};
      const row = {
        place_key: result.placeKey,
        maps_url: result.mapsUrl,
        name: result.name || existing?.name || '',
        // Contact details are only kept for leads; fill gaps, never blank out.
        phone: ph.phone ?? null,
        phone_raw: ph.raw ?? null,
        phone_status: ph.status ?? null,
        phone_country: ph.country ?? null,
        address: qualified ? address : null,
        website_status: status,
        website_detail: detail,
        qualified,
        keyword: result.keyword || existing?.keyword || null,
        category_id: result.categoryId ?? null,
        now,
        today: localDate(new Date(now)),
      };
      // The same number found on Facebook first: that lead becomes this
      // listing, keeping its id, date, campaign history and Facebook post.
      // (Or found on LinkedIn first, with the same validated number.)
      const fromFacebook =
        !existing && qualified && ph.status === 'valid'
          ? this.db.prepare('SELECT id FROM businesses WHERE place_key = ? AND qualified = 1').get(facebookKey(ph.phone)) ||
            this.db.prepare("SELECT id FROM businesses WHERE phone = ? AND qualified = 1 AND place_key LIKE 'li:%' ORDER BY id LIMIT 1").get(ph.phone)
          : null;
      if (existing) {
        const { keyword, ...updateRow } = row;
        this.stmt.update.run(updateRow);
      } else if (fromFacebook) {
        const { qualified: _q, today: _t, ...adoptRow } = row;
        this.stmt.adopt.run({ ...adoptRow, id: fromFacebook.id });
      } else {
        this.stmt.insert.run(row);
      }
      const saved = this.stmt.getLead.get(result.placeKey);
      return {
        lead: saved.qualified ? toLead(saved) : null,
        isNewLead: Boolean(saved.qualified) && !(existing && existing.qualified) && !fromFacebook,
      };
    }));
  }

  // --- Facebook -----------------------------------------------------------------

  // Saves a number found in a Facebook post: { phone (E.164), country, raw,
  // name, contactName, postUrl, pageUrl, text, keyword, categoryId }.
  // A number that is already a lead (from Google Maps or Facebook) is not
  // added again: the post is recorded as another source and only empty
  // fields are filled in. Its date, category, campaign history and Seen
  // status stay as they were. A deleted number is not added back.
  // Returns { lead, isNewLead, newSource } or { lead: null, skipped }.
  // r.status 'unverified': a number as written that could not be confirmed
  // (no country, or not valid for it); it is kept for checking with that
  // status, and never used for WhatsApp until a person confirms it.
  saveFacebookLead(r, now = new Date().toISOString()) {
    const unverified = r.status === 'unverified';
    const digits = String(r.phone || '').replace(/\D/g, '');
    if (unverified ? digits.length < 7 || digits.length > 15 : !E164.test(String(r.phone))) {
      throw Object.assign(new Error('Not a phone number that can be saved.'), { code: 'invalid_lead' });
    }
    const key = facebookKey(unverified ? `raw:${digits}` : r.phone);
    const text = r.text ? String(r.text).slice(0, 2000) : null;
    return this.withRetry(() =>
      this.transaction(() => {
        const marker = this.stmt.get.get(key);
        if (marker && !marker.qualified) return { lead: null, skipped: 'deleted' };
        // The same number already a lead: as validated, as written, or (for a
        // number to check) a validated lead ending in its national digits.
        const national = digits.replace(/^0+/, '');
        const existing = (marker && { id: marker.id }) || (unverified
          ? this.db.prepare('SELECT id FROM businesses WHERE qualified = 1 AND place_key NOT LIKE \'lp:%\' AND (phone = ? OR phone_raw = ? OR (phone_status = \'valid\' AND length(?) >= 9 AND phone LIKE \'%\' || ?)) ORDER BY id LIMIT 1').get(r.phone, r.phone, national, national)
          : this.db.prepare("SELECT id FROM businesses WHERE phone = ? AND qualified = 1 AND place_key NOT LIKE 'lp:%' ORDER BY id LIMIT 1").get(r.phone));
        let id;
        if (existing) {
          id = existing.id;
          this.db
            .prepare(
              `UPDATE businesses SET fb_post_url = COALESCE(fb_post_url, ?), fb_page_url = COALESCE(fb_page_url, ?),
                 contact_name = COALESCE(contact_name, ?), description = COALESCE(description, ?),
                 name = CASE WHEN name = '' THEN ? ELSE name END, category_id = COALESCE(category_id, ?)
               WHERE id = ?`,
            )
            .run(r.postUrl, r.pageUrl || null, r.contactName || null, text, r.name || '', r.categoryId ?? null, id);
        } else {
          const ins = this.stmt.insert.run({
            place_key: key,
            maps_url: r.postUrl,
            name: r.name || '',
            phone: r.phone,
            phone_raw: r.raw || r.phone,
            phone_status: unverified ? 'unverified' : 'valid',
            phone_country: r.country || null,
            address: null,
            website_status: 'not_checked',
            website_detail: null,
            qualified: 1,
            keyword: r.keyword || null,
            category_id: r.categoryId ?? null,
            now,
            today: localDate(new Date(now)),
          });
          id = Number(ins.lastInsertRowid);
          this.db
            .prepare('UPDATE businesses SET fb_post_url = ?, fb_page_url = ?, contact_name = ?, description = ? WHERE id = ?')
            .run(r.postUrl, r.pageUrl || null, r.contactName || null, text, id);
        }
        const added = this.db
          .prepare(
            `INSERT INTO lead_sources (business_id, source, url, page_url, author, text, phone, found_at)
             VALUES (?, 'facebook', ?, ?, ?, ?, ?, ?) ON CONFLICT(source, url, phone) DO NOTHING`,
          )
          .run(id, r.postUrl, r.pageUrl || null, r.contactName || null, text, r.phone, now).changes;
        return { lead: toLead(this.db.prepare(`${LEAD_SELECT} WHERE b.id = ?`).get(id)), isNewLead: !existing, newSource: added > 0 };
      }),
    );
  }

  // --- LinkedIn -------------------------------------------------------------------

  // Saves a company found on LinkedIn: { companyName, companyUrl (LinkedIn
  // company page), website, email, phone ({ phone, raw, status, country } or
  // null), address, jobUrl, jobTitle, postUrl, sourceUrl, sourceKind ('job' |
  // 'post' | 'company'), text, discovery, keyword, categoryId }.
  // The same business already a lead (same number, LinkedIn company page,
  // website or email) is not added again: empty fields are filled in and
  // this source is recorded. A deleted company is not added back.
  // Returns { lead, isNewLead, newSource } or { lead: null, skipped }.
  saveLinkedInLead(r, now = new Date().toISOString()) {
    const companyUrl = r.companyUrl || null;
    const name = String(r.companyName || '').trim();
    if (!name && !companyUrl) throw Object.assign(new Error('A LinkedIn lead needs a company.'), { code: 'invalid_lead' });
    const key = `li:${crypto.createHash('sha256').update(companyUrl || `name:${name.toLowerCase()}|${r.sourceUrl || ''}`).digest('hex').slice(0, 32)}`;
    const ph = r.phone && r.phone.phone ? r.phone : null;
    const host = siteHost(r.website);
    const text = r.text ? String(r.text).slice(0, 2000) : null;
    return this.withRetry(() =>
      this.transaction(() => {
        const marker = this.stmt.get.get(key);
        if (marker && !marker.qualified) return { lead: null, skipped: 'deleted' };
        const q = (sql, ...a) => this.db.prepare(sql).get(...a);
        // Deleted leads keep only their public LinkedIn company address.
        if (companyUrl && q('SELECT 1 FROM businesses WHERE qualified = 0 AND li_company_url = ?', companyUrl)) return { lead: null, skipped: 'deleted' };
        const existing =
          (marker && marker.qualified ? marker : null) ||
          (companyUrl && q('SELECT id FROM businesses WHERE qualified = 1 AND li_company_url = ? ORDER BY id LIMIT 1', companyUrl)) ||
          (ph?.status === 'valid' && q("SELECT id FROM businesses WHERE qualified = 1 AND place_key NOT LIKE 'lp:%' AND phone = ? ORDER BY id LIMIT 1", ph.phone)) ||
          (host && q("SELECT id FROM businesses WHERE qualified = 1 AND place_key NOT LIKE 'lp:%' AND (website_url LIKE ? OR website_url LIKE ? OR website_detail = ? OR website_detail LIKE ?) ORDER BY id LIMIT 1", `%://${host}%`, `%://www.${host}%`, host, `${host}/%`)) ||
          (r.email && q("SELECT id FROM businesses WHERE qualified = 1 AND place_key NOT LIKE 'lp:%' AND lower(email) = lower(?) ORDER BY id LIMIT 1", r.email));
        let id;
        if (existing) {
          id = existing.id;
          this.db
            .prepare(
              `UPDATE businesses SET email = COALESCE(email, ?), website_url = COALESCE(website_url, ?), li_company_url = COALESCE(li_company_url, ?),
                 li_job_url = COALESCE(li_job_url, ?), li_post_url = COALESCE(li_post_url, ?), job_title = COALESCE(job_title, ?),
                 description = COALESCE(description, ?), address = COALESCE(address, ?), discovery = COALESCE(?, discovery),
                 name = CASE WHEN name = '' THEN ? ELSE name END, category_id = COALESCE(category_id, ?),
                 website_status = CASE WHEN website_status = 'not_checked' AND ? IS NOT NULL THEN 'has_website' ELSE website_status END,
                 website_detail = CASE WHEN website_status = 'not_checked' AND ? IS NOT NULL THEN ? ELSE website_detail END
               WHERE id = ?`,
            )
            .run(r.email || null, r.website || null, companyUrl, r.jobUrl || null, r.postUrl || null, r.jobTitle || null, text, r.address || null, r.discovery || null, name, r.categoryId ?? null, host, host, host, id);
          // A number fills an empty one only (a validated one replaces a number to check).
          if (ph) {
            this.db
              .prepare(
                `UPDATE businesses SET phone = ?, phone_raw = ?, phone_status = ?, phone_country = ?
                 WHERE id = ? AND (phone IS NULL OR (phone_status != 'valid' AND ? = 'valid'))`,
              )
              .run(ph.phone, ph.raw || ph.phone, ph.status, ph.country || null, id, ph.status);
          }
        } else {
          const ins = this.stmt.insert.run({
            place_key: key,
            maps_url: r.sourceUrl || companyUrl || '',
            name: name || 'Company on LinkedIn',
            phone: ph?.phone ?? null,
            phone_raw: ph ? ph.raw || ph.phone : null,
            phone_status: ph?.status ?? null,
            phone_country: ph?.country ?? null,
            address: r.address || null,
            website_status: host ? 'has_website' : 'not_checked',
            website_detail: host,
            qualified: 1,
            keyword: r.keyword || null,
            category_id: r.categoryId ?? null,
            now,
            today: localDate(new Date(now)),
          });
          id = Number(ins.lastInsertRowid);
          this.db
            .prepare(
              `UPDATE businesses SET email = ?, website_url = ?, li_company_url = ?, li_job_url = ?, li_post_url = ?, job_title = ?,
                 description = ?, discovery = ? WHERE id = ?`,
            )
            .run(r.email || null, r.website || null, companyUrl, r.jobUrl || null, r.postUrl || null, r.jobTitle || null, text, r.discovery || null, id);
        }
        const url = r.sourceUrl || r.jobUrl || r.postUrl || companyUrl;
        const added = url
          ? this.db
              .prepare(
                `INSERT INTO lead_sources (business_id, source, url, page_url, author, text, phone, found_at, kind, title)
                 VALUES (?, 'linkedin', ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source, url, phone) DO NOTHING`,
              )
              .run(id, url, companyUrl, name || null, text, ph?.phone || '', now, r.sourceKind || null, r.jobTitle || null).changes
          : 0;
        return { lead: toLead(this.db.prepare(`${LEAD_SELECT} WHERE b.id = ?`).get(id)), isNewLead: !existing, newSource: added > 0 };
      }),
    );
  }

  // --- LinkedIn people ----------------------------------------------------------

  // Saves a person found with LinkedIn People search and contact discovery:
  // { profileUrl, name, title, headline, company, companyUrl, location,
  // website, email (the best email for the person), emailStatus ('verified'
  // | 'unverified' | 'invalid' | 'none'), emails ([{ email, kind, status,
  // source, reason }]), phone (the person's direct number { phone, raw,
  // status, country } or null), phones ([{ ..., kind: 'direct' |
  // 'company', source }]), discovery, sourceUrl, keyword, categoryId }.
  // One lead per profile, never merged with a business lead (colleagues
  // share a company's website and phone). The same profile found again is
  // updated: newly found emails and phones are added, a verified email
  // replaces an unverified one. A deleted person is not added back.
  // Returns { lead, isNewLead } or { lead: null, skipped }.
  savePersonLead(r, now = new Date().toISOString()) {
    const profileUrl = String(r.profileUrl || '').replace(/\/$/, '');
    const name = String(r.name || '').trim();
    if (!/^https:\/\/www\.linkedin\.com\/in\/[^/?#]+$/.test(profileUrl) || !name) throw Object.assign(new Error('A person lead needs a name and a LinkedIn profile.'), { code: 'invalid_lead' });
    const key = personKey(profileUrl);
    const host = siteHost(r.website);
    const ph = r.phone && r.phone.phone ? r.phone : null;
    const emailList = (r.emails || []).filter((e) => e && e.email).map((e) => ({ email: String(e.email).toLowerCase(), kind: e.kind || 'person', status: e.status || 'unverified', from: e.source || '', reason: e.reason || '' })).slice(0, 30);
    const phoneList = (r.phones || []).filter((x) => x && x.phone).map((x) => ({ phone: x.phone, raw: x.raw || x.phone, status: x.status || 'unverified', country: x.country || null, kind: x.kind || 'company', from: x.source || '' })).slice(0, 20);
    const rank = { verified: 3, unverified: 2, invalid: 1, none: 0 };
    return this.withRetry(() =>
      this.transaction(() => {
        const marker = this.stmt.get.get(key);
        if (marker && !marker.qualified) return { lead: null, skipped: 'deleted' };
        const old = marker ? this.db.prepare('SELECT * FROM businesses WHERE id = ?').get(marker.id) : null;
        // Earlier findings are kept: lists merged, the better email status wins.
        const mergedEmails = mergeBy([...emailList, ...parseJson(old?.emails, [])], 'email', (a, b) => (rank[a.status] >= rank[b.status] ? a : b));
        const mergedPhones = mergeBy([...phoneList, ...parseJson(old?.phones, [])], 'phone', (a, b) => (a.kind === 'direct' || b.kind !== 'direct' ? a : b));
        const keepOld = old && old.email && rank[old.email_status] > rank[r.emailStatus || 'none'];
        const email = keepOld ? old.email : r.email || old?.email || null;
        const emailStatus = keepOld ? old.email_status : r.email ? r.emailStatus || 'unverified' : old?.email ? old.email_status : r.emailStatus || 'none';
        const description = r.headline ? String(r.headline).slice(0, 2000) : null;
        const providers = [...new Set([...(Array.isArray(r.providers) ? r.providers : []), ...String(old?.contact_providers || '').split(',')].filter((x) => /^[a-z]{2,20}$/.test(x)))].join(',') || null;
        let id;
        if (old) {
          id = old.id;
          this.db
            .prepare(
              `UPDATE businesses SET name = ?, person_title = COALESCE(?, person_title), company_name = COALESCE(?, company_name), company_url = COALESCE(?, company_url),
                 address = COALESCE(?, address), website_url = COALESCE(?, website_url), email = ?, email_status = ?, emails = ?, phones = ?,
                 description = COALESCE(?, description), discovery = ?, checked_at = ?, category_id = COALESCE(category_id, ?),
                 website_status = CASE WHEN ? IS NOT NULL THEN 'has_website' ELSE website_status END, website_detail = COALESCE(?, website_detail), contact_providers = ?
               WHERE id = ?`,
            )
            .run(name, r.title || null, r.company || null, r.companyUrl || null, r.location || null, r.website || null, email, emailStatus, JSON.stringify(mergedEmails), JSON.stringify(mergedPhones), description, r.discovery || null, now, r.categoryId ?? null, host, host, providers, id);
          if (ph) {
            this.db
              .prepare(`UPDATE businesses SET phone = ?, phone_raw = ?, phone_status = ?, phone_country = ? WHERE id = ? AND (phone IS NULL OR (phone_status != 'valid' AND ? = 'valid'))`)
              .run(ph.phone, ph.raw || ph.phone, ph.status, ph.country || null, id, ph.status);
          }
        } else {
          const ins = this.stmt.insert.run({
            place_key: key,
            maps_url: profileUrl,
            name,
            phone: ph?.phone ?? null,
            phone_raw: ph ? ph.raw || ph.phone : null,
            phone_status: ph?.status ?? null,
            phone_country: ph?.country ?? null,
            address: r.location || null,
            website_status: host ? 'has_website' : 'not_checked',
            website_detail: host,
            qualified: 1,
            keyword: r.keyword || null,
            category_id: r.categoryId ?? null,
            now,
            today: localDate(new Date(now)),
          });
          id = Number(ins.lastInsertRowid);
          this.db
            .prepare(
              `UPDATE businesses SET li_profile_url = ?, person_title = ?, company_name = ?, company_url = ?, website_url = ?, email = ?, email_status = ?,
                 emails = ?, phones = ?, description = ?, discovery = ?, contact_providers = ? WHERE id = ?`,
            )
            .run(profileUrl, r.title || null, r.company || null, r.companyUrl || null, r.website || null, email, emailStatus, JSON.stringify(mergedEmails), JSON.stringify(mergedPhones), description, r.discovery || null, providers, id);
        }
        this.db
          .prepare(
            `INSERT INTO lead_sources (business_id, source, url, page_url, author, text, phone, found_at, kind, title)
             VALUES (?, 'linkedin', ?, ?, ?, ?, '', ?, 'person', ?) ON CONFLICT(source, url, phone) DO NOTHING`,
          )
          .run(id, profileUrl, r.sourceUrl || null, name, description, now, r.title || null);
        return { lead: toLead(this.db.prepare(`${LEAD_SELECT} WHERE b.id = ?`).get(id)), isNewLead: !old };
      }),
    );
  }

  // A LinkedIn profile already saved as a person lead (or deleted): not opened again.
  hasPersonLead(profileUrl) {
    return Boolean(this.withRetry(() => this.stmt.get.get(personKey(String(profileUrl || '').replace(/\/$/, '')))));
  }

  // --- Local contact datasets --------------------------------------------------

  // Imports contact records (parsed CSV rows: { name, first, last, email,
  // phone, company, website, domain, title, linkedin, address }) as one
  // dataset. Rows without a name or an email are skipped. Returns
  // { imported, skipped }.
  importContactRecords(dataset, rows, now = new Date().toISOString()) {
    const label = String(dataset || 'Contacts').trim().slice(0, 80) || 'Contacts';
    const ins = this.db.prepare(
      `INSERT INTO contact_records (dataset, name, name_key, email, phone, company, company_key, domain, title, linkedin, address, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let imported = 0;
    let skipped = 0;
    this.withRetry(() =>
      this.transaction(() => {
        for (const row of rows.slice(0, 200_000)) {
          const name = String(row.name || [row.first, row.last].filter(Boolean).join(' ')).trim().slice(0, 200);
          const email = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(String(row.email || '').trim()) ? String(row.email).trim().toLowerCase() : '';
          const phone = String(row.phone || '').trim().slice(0, 40);
          if (!name && !email) {
            skipped++;
            continue;
          }
          const domain = siteHost(row.website) || (row.domain ? String(row.domain).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] : '') || (email ? email.split('@')[1] : '');
          const linkedin = (String(row.linkedin || '').match(/linkedin\.com\/in\/([^/?#\s]+)/i) || [])[1];
          ins.run(label, name || null, personNameKey(name) || null, email || null, phone || null, row.company ? String(row.company).slice(0, 200) : null, companyKey(row.company) || null, domain || null, row.title ? String(row.title).slice(0, 200) : null, linkedin ? `https://www.linkedin.com/in/${decodeURIComponent(linkedin)}` : null, row.address ? String(row.address).slice(0, 300) : null, now);
          imported++;
        }
      }),
    );
    return { imported, skipped };
  }

  // Imported datasets: [{ dataset, records, importedAt }].
  contactDatasets() {
    return this.withRetry(() => this.db.prepare('SELECT dataset, COUNT(*) AS records, MAX(imported_at) AS importedAt FROM contact_records GROUP BY dataset ORDER BY importedAt DESC').all());
  }

  deleteContactDataset(dataset) {
    return this.withRetry(() => this.db.prepare('DELETE FROM contact_records WHERE dataset = ?').run(String(dataset)).changes);
  }

  // Records about a person or their company, for contact discovery:
  // [{ match: 'person' | 'company' | 'domain', name, email, phone, address, dataset }].
  //   person:  same LinkedIn profile, or same name at the same company/domain
  //   company: the company's own records (no person name: its general
  //            email and phone), from datasets and from saved business leads
  //   domain:  other people's addresses at the domain (its email format)
  findContactRecords({ name, domain, company, profileUrl } = {}) {
    const nk = personNameKey(name);
    const ck = companyKey(company);
    const d = String(domain || '').toLowerCase();
    const out = [];
    return this.withRetry(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM contact_records WHERE (linkedin IS NOT NULL AND linkedin = ?) OR (name_key IS NOT NULL AND name_key = ?)
             OR (? != '' AND (domain = ? OR domain LIKE ?)) OR (? != '' AND company_key = ?) LIMIT 500`,
        )
        .all(profileUrl || '', nk || '', d, d, `%.${d}`, ck || '', ck || '');
      for (const r of rows) {
        const sameOrg = (d && r.domain && (r.domain === d || r.domain.endsWith(`.${d}`))) || (ck && r.company_key === ck);
        let match = null;
        if (profileUrl && r.linkedin === profileUrl) match = 'person';
        else if (nk && r.name_key === nk && (sameOrg || !d)) match = 'person';
        else if (sameOrg && !r.name_key) match = 'company';
        else if (sameOrg) match = 'domain';
        if (match) out.push({ match, name: r.name, email: r.email, phone: r.phone, address: r.address, dataset: r.dataset });
      }
      // Saved business leads of the same company (its website).
      if (d) {
        const leads = this.db
          .prepare(
            `SELECT email, emails, phone, phone_raw, address FROM businesses WHERE qualified = 1 AND place_key NOT LIKE 'lp:%'
               AND (website_detail = ? OR website_detail LIKE ? OR website_url LIKE ? OR website_url LIKE ?) LIMIT 20`,
          )
          .all(d, `${d}/%`, `%://${d}%`, `%://www.${d}%`);
        for (const l of leads) {
          const emails = new Set([l.email, ...parseEmails(l.emails).map((e) => e.email)].filter(Boolean));
          for (const e of emails) out.push({ match: 'company', email: e, phone: null, address: l.address, dataset: null });
          if (l.phone) out.push({ match: 'company', email: null, phone: l.phone, address: l.address, dataset: null });
        }
        // Other people already found at the domain (its email format).
        for (const p of this.db.prepare("SELECT email FROM businesses WHERE qualified = 1 AND place_key LIKE 'lp:%' AND email_status = 'verified' AND email LIKE ? LIMIT 50").all(`%@${d}`)) {
          out.push({ match: 'domain', email: p.email, phone: null, dataset: null });
        }
      }
      return out;
    });
  }

  // --- Podcasts --------------------------------------------------------------------

  // Saves a podcast (processPodcast's result, plus links { platform: url },
  // keyword, categoryId, artwork, searchId and platform). r.pending: just
  // found, its email not looked for yet (a new lead is saved with email
  // status 'pending'; an existing one keeps what it had). r.searchId records
  // this search's hit (new or already saved). One lead per podcast (its Apple Podcasts id,
  // else its RSS feed, else its first platform link; also matched by any of
  // these): the same podcast found again, on any platform, updates its lead
  // (new platform links are added; a newly found email, website or feed is
  // kept; one found before is never lost to a failed check). A deleted
  // podcast is not added back.
  // Returns { lead, isNewLead } or { lead: null, skipped }.
  savePodcastLead(r, now = new Date().toISOString()) {
    const links = Object.fromEntries(Object.entries(r.links || {}).filter(([k, v]) => /^[a-z]{2,20}$/.test(k) && typeof v === 'string' && /^https?:\/\//.test(v)));
    if (r.appleUrl && !links.apple) links.apple = r.appleUrl;
    const firstLink = Object.values(links)[0];
    const ident = r.id ? `apple:${r.id}` : r.rssUrl ? `rss:${feedIdent(r.rssUrl)}` : firstLink ? `link:${firstLink}` : null;
    if (!ident || !String(r.title || '').trim()) throw Object.assign(new Error('A podcast lead needs a podcast.'), { code: 'invalid_lead' });
    const key = `pc:${crypto.createHash('sha256').update(ident).digest('hex').slice(0, 32)}`;
    const host = siteHost(r.website);
    const ph = r.phone && r.phone.phone ? r.phone : null;
    const emails = Array.isArray(r.emails) && r.emails.length ? JSON.stringify(r.emails.map((e) => ({ email: e.email, kind: e.kind, from: e.from, url: e.url || '' })).slice(0, 30)) : null;
    const text = r.description ? String(r.description).slice(0, 2000) : null;
    return this.withRetry(() =>
      this.transaction(() => {
        const marker = this.stmt.get.get(key);
        if (marker && !marker.qualified) return { lead: null, skipped: 'deleted' };
        const q = (sql, ...a) => this.db.prepare(sql).get(...a);
        const byLink = (url) => q("SELECT id, qualified FROM businesses WHERE place_key LIKE 'pc:%' AND (podcast_url = ? OR podcast_links LIKE ? ESCAPE '\\') ORDER BY qualified DESC, id LIMIT 1", url, `%${JSON.stringify(url).replace(/[\\%_]/g, '\\$&')}%`);
        const existing =
          marker ||
          (r.rssUrl && q("SELECT id, qualified FROM businesses WHERE place_key LIKE 'pc:%' AND rss_url = ? ORDER BY qualified DESC, id LIMIT 1", r.rssUrl)) ||
          Object.values(links).map(byLink).find(Boolean);
        // A deleted podcast (found again under another link) stays deleted.
        if (existing && existing.qualified === 0) return { lead: null, skipped: 'deleted' };
        const known = existing ? parseLinks(q('SELECT podcast_links FROM businesses WHERE id = ?', existing.id)?.podcast_links) : {};
        const allLinks = JSON.stringify({ ...links, ...known });
        // The email status a finished check gives (an email found before is kept).
        const status = r.pending ? null : r.email ? 'found' : EMAIL_STATUS[r.status] || 'none';
        let id;
        if (existing && r.pending) {
          id = existing.id;
          this.db
            .prepare(
              `UPDATE businesses SET podcast_links = ?, podcast_url = COALESCE(podcast_url, ?), rss_url = COALESCE(rss_url, ?), host_name = COALESCE(host_name, ?),
                 description = COALESCE(description, ?), artwork_url = COALESCE(artwork_url, ?), category_id = COALESCE(category_id, ?) WHERE id = ?`,
            )
            .run(allLinks, links.apple || null, r.rssUrl || null, r.host || null, text, r.artwork || null, r.categoryId ?? null, id);
        } else if (existing) {
          id = existing.id;
          this.db
            .prepare(
              `UPDATE businesses SET name = ?, email = COALESCE(?, email), emails = COALESCE(?, emails), website_url = COALESCE(?, website_url),
                 podcast_url = COALESCE(?, podcast_url), rss_url = COALESCE(?, rss_url), host_name = COALESCE(?, host_name),
                 description = COALESCE(?, description), category_id = COALESCE(category_id, ?), checked_at = ?,
                 discovery = CASE WHEN ? IS NOT NULL OR email IS NULL THEN ? ELSE discovery END, podcast_links = ?,
                 website_status = CASE WHEN ? IS NOT NULL THEN 'has_website' ELSE website_status END,
                 website_detail = COALESCE(?, website_detail), artwork_url = COALESCE(artwork_url, ?),
                 email_status = CASE WHEN ? IS NOT NULL THEN 'found' WHEN email IS NOT NULL THEN 'found' ELSE ? END
               WHERE id = ?`,
            )
            .run(r.title, r.email || null, emails, r.website || null, links.apple || null, r.rssUrl || null, r.host || null, text, r.categoryId ?? null, now, r.email || null, r.discovery || null, allLinks, host, host, r.artwork || null, r.email || null, status, id);
          if (ph) {
            this.db
              .prepare('UPDATE businesses SET phone = ?, phone_raw = ?, phone_status = ?, phone_country = ? WHERE id = ? AND phone IS NULL')
              .run(ph.phone, ph.raw || ph.phone, ph.status, ph.country || null, id);
          }
        } else {
          const ins = this.stmt.insert.run({
            place_key: key,
            maps_url: firstLink || r.rssUrl || '',
            name: r.title,
            phone: ph?.phone ?? null,
            phone_raw: ph ? ph.raw || ph.phone : null,
            phone_status: ph?.status ?? null,
            phone_country: ph?.country ?? null,
            address: null,
            website_status: host ? 'has_website' : 'no_website',
            website_detail: host,
            qualified: 1,
            keyword: r.keyword || null,
            category_id: r.categoryId ?? null,
            now,
            today: localDate(new Date(now)),
          });
          id = Number(ins.lastInsertRowid);
          this.db
            .prepare('UPDATE businesses SET email = ?, emails = ?, website_url = ?, podcast_url = ?, rss_url = ?, host_name = ?, description = ?, discovery = ?, podcast_links = ?, artwork_url = ?, email_status = ? WHERE id = ?')
            .run(r.email || null, emails, r.website || null, links.apple || null, r.rssUrl || null, r.host || null, text, r.pending ? null : r.discovery || null, allLinks, r.artwork || null, status || 'pending', id);
        }
        if (r.searchId) {
          this.db
            .prepare('INSERT INTO search_hits (search_id, business_id, platform, source_url, found_at, outcome, rank) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
            .run(r.searchId, id, r.platform || Object.keys(links)[0] || 'unknown', r.sourceUrl || firstLink || r.rssUrl || null, now, existing ? 'duplicate' : 'new', Number.isInteger(r.rank) ? r.rank : null);
        }
        const url = firstLink || r.rssUrl;
        if (url) {
          this.db
            .prepare(
              `INSERT INTO lead_sources (business_id, source, url, page_url, author, text, phone, found_at, kind, title)
               VALUES (?, 'podcast', ?, ?, ?, ?, '', ?, 'podcast', ?) ON CONFLICT(source, url, phone) DO NOTHING`,
            )
            .run(id, url, r.rssUrl || null, r.host || null, text, now, r.title);
        }
        return { lead: toLead(this.db.prepare(`${LEAD_SELECT} WHERE b.id = ?`).get(id)), isNewLead: !existing };
      }),
    );
  }

  // --- Podcast searches and the podcast library ------------------------------------

  startSearch({ kind = 'podcast', keyword, platforms = [] }, now = new Date().toISOString()) {
    return Number(this.withRetry(() => this.db.prepare('INSERT INTO searches (kind, keyword, platforms, started_at) VALUES (?, ?, ?, ?)').run(kind, String(keyword).slice(0, 300), JSON.stringify(platforms), now).lastInsertRowid));
  }

  finishSearch(id, state, stats, now = new Date().toISOString()) {
    this.withRetry(() => this.db.prepare('UPDATE searches SET state = ?, stats = ?, finished_at = ? WHERE id = ?').run(state, JSON.stringify(stats || {}), now, id));
  }

  // Recent podcast searches (newest first), with how many podcasts each found.
  podcastSearches(limit = 30) {
    return this.withRetry(() =>
      this.db
        .prepare(
          `SELECT s.id, s.keyword, s.platforms, s.started_at AS startedAt, s.finished_at AS finishedAt, s.state, s.stats,
             (SELECT COUNT(*) FROM search_hits h JOIN businesses b ON b.id = h.business_id AND b.qualified = 1 WHERE h.search_id = s.id) AS found
           FROM searches s WHERE s.kind = 'podcast' ORDER BY s.id DESC LIMIT ?`,
        )
        .all(limit)
        .map((r) => ({ ...r, platforms: parseJson(r.platforms, []), stats: parseJson(r.stats, {}) })),
    );
  }

  // Podcast leads: { status: 'all' | 'found' | 'none' | 'pending', searchId,
  // platform, search (text), sort: 'found' | 'name' | 'status', dir, page,
  // pageSize, ids } -> { rows, total, counts: { all, found, none, pending } }.
  // Counts are for the same search/platform/text, before the status filter.
  podcastLeads(f = {}) {
    const clauses = ["b.qualified = 1", "b.place_key LIKE 'pc:%'"];
    const params = [];
    if (Number.isInteger(f.searchId)) {
      clauses.push('EXISTS (SELECT 1 FROM search_hits h WHERE h.business_id = b.id AND h.search_id = ?)');
      params.push(f.searchId);
    }
    if (typeof f.platform === 'string' && /^[a-z]{2,20}$/.test(f.platform)) {
      clauses.push('b.podcast_links LIKE ?');
      params.push(`%"${f.platform}":%`);
    }
    const q = typeof f.search === 'string' ? f.search.trim().slice(0, 100) : '';
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      clauses.push("(b.name LIKE ? ESCAPE '\\' OR b.host_name LIKE ? ESCAPE '\\' OR b.email LIKE ? ESCAPE '\\' OR b.website_url LIKE ? ESCAPE '\\')");
      params.push(like, like, like, like);
    }
    if (Array.isArray(f.ids)) {
      const ids = f.ids.filter(Number.isInteger).slice(0, 500);
      clauses.push(ids.length ? `b.id IN (${ids.map(() => '?').join(', ')})` : '0');
      params.push(...ids);
    }
    const base = clauses.join(' AND ');
    const statusSql = { found: "b.email_status = 'found'", pending: "b.email_status = 'pending'", none: "COALESCE(b.email_status, 'none') IN ('none', 'platform', 'failed')" }[f.status];
    const where = statusSql ? `${base} AND ${statusSql}` : base;
    // Best match: the podcast's place in its platform's results for that search.
    const rankSql = Number.isInteger(f.searchId) ? `(SELECT h.rank FROM search_hits h WHERE h.business_id = b.id AND h.search_id = ${Number(f.searchId)})` : null;
    const order = { name: 'b.name COLLATE NOCASE', status: "CASE b.email_status WHEN 'found' THEN 0 WHEN 'pending' THEN 1 WHEN 'failed' THEN 3 ELSE 2 END, b.discovered_at DESC", rank: rankSql ? `${rankSql} IS NULL, ${rankSql}, b.discovered_at DESC` : null, found: 'b.discovered_at' }[f.sort] || 'b.discovered_at';
    const dir = f.dir === 'asc' ? 'ASC' : 'DESC';
    const pageSize = Math.min(Math.max(Number(f.pageSize) || 25, 1), 200);
    const page = Math.max(Number(f.page) || 1, 1);
    return this.withRetry(() => {
      const c = this.db
        .prepare(
          `SELECT COUNT(*) AS total, SUM(b.email_status = 'found') AS found, SUM(b.email_status = 'pending') AS pending,
             SUM(COALESCE(b.email_status, 'none') IN ('none', 'platform', 'failed')) AS none
           FROM businesses b WHERE ${base}`,
        )
        .get(...params);
      const total = this.db.prepare(`SELECT COUNT(*) AS n FROM businesses b WHERE ${where}`).get(...params).n;
      const rows = this.db
        .prepare(
          `${LEAD_SELECT.replace('FROM businesses b', `,
             (SELECT json_group_array(json_object('searchId', h.search_id, 'keyword', s.keyword, 'platform', h.platform, 'sourceUrl', h.source_url, 'foundAt', h.found_at, 'outcome', h.outcome))
                FROM search_hits h JOIN searches s ON s.id = h.search_id WHERE h.business_id = b.id) AS hits_json
           FROM businesses b`)} WHERE ${where} ORDER BY ${order === 'b.discovered_at' ? `b.discovered_at ${dir}` : order.includes(',') ? order : `${order} ${dir}`}, b.id DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, pageSize, (page - 1) * pageSize)
        .map((row) => ({ ...toLead(row), hits: parseJson(row.hits_json, []).sort((a, b) => String(b.foundAt).localeCompare(String(a.foundAt))) }));
      return { rows, total, page, pageSize, counts: { all: c.total || 0, found: c.found || 0, none: c.none || 0, pending: c.pending || 0 } };
    });
  }

  // Ids of the podcast leads matching a library filter (all pages), for
  // "select all matching".
  podcastLeadIds(f = {}) {
    const all = [];
    for (let page = 1; ; page++) {
      const { rows, total } = this.podcastLeads({ ...f, page, pageSize: 200 });
      all.push(...rows.map((r) => r.id));
      if (!rows.length || all.length >= total) return all;
    }
  }

  // Deletes podcast leads only: the given ids (other kinds of leads among
  // them are left alone), or every podcast lead. Like other deletions, a
  // deleted podcast is not added again by later searches. Returns how many.
  deletePodcastLeads({ ids = null, all = false } = {}) {
    return this.withRetry(() =>
      this.transaction(() => {
        let list;
        if (all) list = this.db.prepare("SELECT id FROM businesses WHERE qualified = 1 AND place_key LIKE 'pc:%'").all().map((r) => r.id);
        else {
          const want = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
          list = [];
          for (let i = 0; i < want.length; i += 500) {
            const chunk = want.slice(i, i + 500);
            list.push(...this.db.prepare(`SELECT id FROM businesses WHERE qualified = 1 AND place_key LIKE 'pc:%' AND id IN (${chunk.map(() => '?').join(', ')})`).all(...chunk).map((r) => r.id));
          }
        }
        if (list.length) this.tombstone(list);
        return list.length;
      }),
    );
  }

  // Podcast leads as full leads (for the CSV export): the given ids, or all.
  podcastLeadsForExport({ ids = null, all = false } = {}) {
    if (all) return this.listLeads({ source: 'podcast' });
    const want = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    const out = [];
    for (let i = 0; i < want.length; i += 1000) out.push(...this.listLeads({ source: 'podcast', ids: want.slice(i, i + 1000) }));
    return out;
  }

  // A LinkedIn job or post already recorded as a source (not read again).
  hasLinkedInSource(url) {
    return Boolean(this.withRetry(() => this.db.prepare("SELECT 1 FROM lead_sources WHERE source = 'linkedin' AND url = ? LIMIT 1").get(url)));
  }

  // A post whose numbers were already saved (it is not read again).
  hasFacebookPost(url) {
    return Boolean(this.withRetry(() => this.db.prepare("SELECT 1 FROM lead_sources WHERE source = 'facebook' AND url = ? LIMIT 1").get(url)));
  }

  // Facebook posts of a lead (newest first).
  leadSources(id) {
    return this.withRetry(() =>
      this.db
        .prepare("SELECT source, kind, title, url, page_url AS pageUrl, author, text, phone, found_at AS foundAt FROM lead_sources WHERE business_id = ? ORDER BY found_at DESC, id DESC")
        .all(id),
    );
  }

  // The country most leads' numbers belong to: local numbers in Facebook
  // posts (which carry no address) are read as numbers of this country.
  commonPhoneCountry() {
    return (
      this.withRetry(() =>
        this.db
          .prepare(
            `SELECT phone_country AS c, COUNT(*) AS n FROM businesses
             WHERE qualified = 1 AND phone_status = 'valid' AND phone_country IS NOT NULL
             GROUP BY phone_country ORDER BY n DESC, phone_country LIMIT 1`,
          )
          .get(),
      )?.c || null
    );
  }

  // Validated lead numbers that still need an automatic WhatsApp check:
  // never checked, or a failed check older than `failedBefore`.
  phonesToCheck(limit, failedBefore) {
    return this.withRetry(() =>
      this.db
        .prepare(
          `SELECT b.phone FROM businesses b LEFT JOIN whatsapp_checks w ON w.phone = b.phone
           WHERE b.qualified = 1 AND b.phone_status = 'valid'
             AND (w.phone IS NULL OR w.method = 'manual' OR (w.status = 'failed' AND w.checked_at < ?))
           GROUP BY b.phone ORDER BY MAX(b.discovered_at) DESC LIMIT ?`,
        )
        .all(failedBefore, limit)
        .map((r) => r.phone),
    );
  }

  // Result from the automatic check: 'available' | 'unavailable' | 'failed'.
  setWhatsAppResult(phone, status, method, detail = null, now = new Date().toISOString()) {
    if (!E164.test(String(phone))) throw new Error('Only validated international numbers can be checked.');
    if (!['available', 'unavailable', 'failed'].includes(status)) throw new Error('Unknown WhatsApp status');
    this.withRetry(() =>
      this.db
        .prepare(
          `INSERT INTO whatsapp_checks (phone, status, method, detail, checked_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(phone) DO UPDATE SET status = excluded.status, method = excluded.method, detail = excluded.detail, checked_at = excluded.checked_at`,
        )
        .run(phone, status, method, detail, now),
    );
  }

  whatsappProgress() {
    const row = this.withRetry(() =>
      this.db
        .prepare(
          `SELECT COUNT(DISTINCT b.phone) AS total,
                  COUNT(DISTINCT CASE WHEN w.status IN ('available', 'unavailable') AND w.method != 'manual' THEN b.phone END) AS checked,
                  COUNT(DISTINCT CASE WHEN w.status = 'available' AND w.method != 'manual' THEN b.phone END) AS available,
                  COUNT(DISTINCT CASE WHEN w.status = 'failed' THEN b.phone END) AS failed
           FROM businesses b LEFT JOIN whatsapp_checks w ON w.phone = b.phone
           WHERE b.qualified = 1 AND b.phone_status = 'valid'`,
        )
        .get(),
    );
    return { ...row };
  }

  // --- calls (the Dialer) ---

  addCall({ leadId = null, numberId = null, number = '', name = null, business = null, direction, status, startedAt, sim = null, device = null }) {
    return Number(
      this.withRetry(() =>
        this.db
          .prepare('INSERT INTO calls (lead_id, number_id, number, name, business, direction, status, started_at, sim, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(leadId, numberId, number, name, business, direction, status, startedAt, sim, device).lastInsertRowid,
      ),
    );
  }

  updateCall(id, { status, duration, detail = null, endedAt = null, number, leadId, name, business }) {
    this.withRetry(() =>
      this.db
        .prepare('UPDATE calls SET status = ?, duration = ?, detail = ?, ended_at = ?, number = COALESCE(NULLIF(?, \'\'), number), lead_id = COALESCE(?, lead_id), name = COALESCE(?, name), business = COALESCE(?, business) WHERE id = ?')
        .run(status, Math.max(0, Math.round(duration || 0)), detail, endedAt, number ?? '', leadId ?? null, name ?? null, business ?? null, id),
    );
  }

  // Newest first. search: name, business or number; direction: outgoing |
  // incoming; status: answered | missed | rejected | failed | ...; leadId.
  listCalls({ search = '', direction = '', status = '', leadId = null, limit = 200 } = {}) {
    const where = [];
    const args = [];
    if (leadId) {
      where.push('c.lead_id = ?');
      args.push(Number(leadId));
    }
    if (direction === 'outgoing' || direction === 'incoming') {
      where.push('c.direction = ?');
      args.push(direction);
    }
    if (status === 'not_answered') where.push("c.status IN ('no_answer', 'busy', 'missed')");
    else if (status) {
      where.push('c.status = ?');
      args.push(String(status));
    }
    const q = String(search || '').trim().toLowerCase();
    if (q) {
      const digits = q.replace(/\D/g, '');
      where.push(`(lower(COALESCE(c.name, '')) LIKE ? ESCAPE '\\' OR lower(COALESCE(c.business, '')) LIKE ? ESCAPE '\\'${digits.length >= 3 ? " OR replace(c.number, '+', '') LIKE ?" : ''})`);
      const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      args.push(like, like);
      if (digits.length >= 3) args.push(`%${digits}%`);
    }
    const rows = this.withRetry(() =>
      this.db.prepare(`SELECT c.* FROM calls c ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.started_at DESC, c.id DESC LIMIT ?`).all(...args, Math.min(Math.max(Number(limit) || 200, 1), 2000)),
    );
    return rows.map((r) => ({ id: r.id, leadId: r.lead_id, numberId: r.number_id ?? null, number: r.number, name: r.name, business: r.business, direction: r.direction, status: r.status, startedAt: r.started_at, endedAt: r.ended_at, duration: r.duration, sim: r.sim, device: r.device, detail: r.detail }));
  }

  // Call Seen: an outgoing call to this lead started (only the first time is kept).
  markCallSeen(leadId, at = Date.now()) {
    if (!leadId) return;
    this.withRetry(() => this.db.prepare('UPDATE businesses SET call_seen_at = ? WHERE id = ? AND qualified = 1 AND call_seen_at IS NULL').run(at, leadId));
  }

  setDoNotCall(leadId, on) {
    this.withRetry(() => this.db.prepare('UPDATE businesses SET call_dnc = ? WHERE id = ? AND qualified = 1').run(on ? 1 : 0, leadId));
  }

  // Leads the Auto Dialer may call, oldest first: a valid number, Call
  // Unseen, not marked "do not call", not opted out (WhatsApp opt-outs
  // count too), and not already tried in this run (exclude).
  callableLeads({ exclude = [], limit = 50 } = {}) {
    const ex = [...new Set(exclude.map(Number).filter(Number.isInteger))];
    const rows = this.withRetry(() =>
      this.db
        .prepare(
          `${LEAD_SELECT} WHERE b.qualified = 1 AND b.phone IS NOT NULL AND b.phone != '' AND b.phone_status = 'valid' AND b.call_seen_at IS NULL AND b.call_dnc = 0
             AND NOT EXISTS (SELECT 1 FROM outreach_optouts o WHERE o.phone = b.phone)
             AND ${NOT_CALLED('b.phone')}
             ${ex.length ? `AND b.id NOT IN (${ex.map(() => '?').join(',')})` : ''}
           ORDER BY b.discovered_at ASC, b.id ASC LIMIT ?`,
        )
        .all(...ex, Math.max(1, Math.min(Number(limit) || 50, 5000))),
    );
    return rows.map(toLead);
  }

  // --- imported numbers in categories (apart from leads) ---

  numberLists() {
    return this.withRetry(() =>
      this.db
        .prepare(
          `SELECT l.id, l.name, l.created_at,
             COUNT(n.id) AS total,
             SUM(n.call_seen_at IS NOT NULL) AS called,
             SUM(n.call_seen_at IS NULL AND n.call_dnc = 0) AS unseen,
             SUM(n.call_dnc = 1 OR EXISTS (SELECT 1 FROM outreach_optouts o WHERE o.phone = n.phone)) AS opted_out,
             SUM(n.sms_seen_at IS NOT NULL) AS texted
           FROM number_lists l LEFT JOIN numbers n ON n.list_id = l.id
           GROUP BY l.id ORDER BY l.name COLLATE NOCASE`,
        )
        .all(),
    ).map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, total: r.total, called: r.called || 0, unseen: r.unseen || 0, optedOut: r.opted_out || 0, texted: r.texted || 0 }));
  }

  createNumberList(name) {
    const n = String(name || '').trim().slice(0, 80);
    if (!n) throw new Error('Enter a category name.');
    if (this.db.prepare('SELECT 1 FROM number_lists WHERE name = ?').get(n)) throw new Error(`A category named "${n}" already exists.`);
    return Number(this.db.prepare('INSERT INTO number_lists (name, created_at) VALUES (?, ?)').run(n, Date.now()).lastInsertRowid);
  }

  renameNumberList(id, name) {
    const n = String(name || '').trim().slice(0, 80);
    if (!n) throw new Error('Enter a category name.');
    const other = this.db.prepare('SELECT id FROM number_lists WHERE name = ?').get(n);
    if (other && other.id !== id) throw new Error(`A category named "${n}" already exists.`);
    this.db.prepare('UPDATE number_lists SET name = ? WHERE id = ?').run(n, id);
  }

  // Deletes the category and its numbers (their calls stay in the call log).
  deleteNumberList(id) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM numbers WHERE list_id = ?').run(id);
      this.db.prepare('DELETE FROM number_lists WHERE id = ?').run(id);
    });
  }

  // items: [{ phone, raw, valid, name, business, extra }]. A number already
  // in the category is not added again (its details are kept as they were).
  importNumbers(listId, items, now = Date.now()) {
    if (!this.db.prepare('SELECT 1 FROM number_lists WHERE id = ?').get(listId)) throw new Error('That category no longer exists.');
    const insert = this.db.prepare('INSERT OR IGNORE INTO numbers (list_id, phone, phone_raw, valid, name, business, extra, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const elsewhere = this.db.prepare(`SELECT (SELECT COUNT(*) FROM numbers WHERE phone = ? AND list_id != ?) + (SELECT COUNT(*) FROM businesses WHERE phone = ? AND qualified = 1) AS n`);
    let added = 0;
    let inList = 0;
    let alsoElsewhere = 0;
    this.transaction(() => {
      for (const it of items) {
        const extra = it.extra && Object.keys(it.extra).length ? JSON.stringify(it.extra) : null;
        const r = insert.run(listId, it.phone, it.raw || null, it.valid ? 1 : 0, it.name || null, it.business || null, extra, now);
        if (r.changes) {
          added++;
          if (elsewhere.get(it.phone, listId, it.phone).n) alsoElsewhere++;
        } else inList++;
      }
    });
    return { added, duplicateInCategory: inList, alsoElsewhere };
  }

  // filter: { listId, search, status: called | unseen | dnc | optout | texted, limit, offset }
  listNumbers({ listId = null, search = '', status = '', limit = 200, offset = 0 } = {}) {
    const where = [];
    const args = [];
    if (listId) {
      where.push('n.list_id = ?');
      args.push(Number(listId));
    }
    if (status === 'called') where.push('n.call_seen_at IS NOT NULL');
    else if (status === 'unseen') where.push('n.call_seen_at IS NULL AND n.call_dnc = 0');
    else if (status === 'dnc') where.push('n.call_dnc = 1');
    else if (status === 'optout') where.push('(n.call_dnc = 1 OR EXISTS (SELECT 1 FROM outreach_optouts o WHERE o.phone = n.phone))');
    else if (status === 'texted') where.push('n.sms_seen_at IS NOT NULL');
    const q = String(search || '').trim().toLowerCase();
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      const digits = q.replace(/\D/g, '');
      where.push(`(lower(COALESCE(n.name, '')) LIKE ? ESCAPE '\\' OR lower(COALESCE(n.business, '')) LIKE ? ESCAPE '\\'${digits.length >= 3 ? " OR replace(n.phone, '+', '') LIKE ?" : ''})`);
      args.push(like, like);
      if (digits.length >= 3) args.push(`%${digits}%`);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM numbers n ${w}`).get(...args).n;
    const rows = this.db
      .prepare(
        `SELECT n.*, l.name AS list_name,
           EXISTS (SELECT 1 FROM outreach_optouts o WHERE o.phone = n.phone) AS opted_out,
           (SELECT COUNT(*) FROM numbers d WHERE d.phone = n.phone AND d.id != n.id) + (SELECT COUNT(*) FROM businesses b WHERE b.phone = n.phone AND b.qualified = 1) AS dupes
         FROM numbers n JOIN number_lists l ON l.id = n.list_id ${w}
         ORDER BY n.id ASC LIMIT ? OFFSET ?`,
      )
      .all(...args, Math.min(Math.max(Number(limit) || 200, 1), 2000), Math.max(0, Number(offset) || 0));
    return { total, rows: rows.map(toNumber) };
  }

  numberById(id) {
    const r = this.db.prepare('SELECT n.*, l.name AS list_name, EXISTS (SELECT 1 FROM outreach_optouts o WHERE o.phone = n.phone) AS opted_out, 0 AS dupes FROM numbers n JOIN number_lists l ON l.id = n.list_id WHERE n.id = ?').get(id);
    return r ? toNumber(r) : null;
  }

  // Moves numbers to another category; one already there is left where it was.
  moveNumbers(ids, toListId) {
    const move = this.db.prepare('UPDATE OR IGNORE numbers SET list_id = ? WHERE id = ?');
    let moved = 0;
    this.transaction(() => {
      for (const id of ids) moved += move.run(toListId, id).changes;
    });
    return { moved, skipped: ids.length - moved };
  }

  deleteNumbers(ids) {
    const del = this.db.prepare('DELETE FROM numbers WHERE id = ?');
    this.transaction(() => ids.forEach((id) => del.run(id)));
  }

  setNumberDoNotCall(id, on) {
    this.db.prepare('UPDATE numbers SET call_dnc = ? WHERE id = ?').run(on ? 1 : 0, id);
  }

  markNumberCallSeen(id, at = Date.now()) {
    if (id) this.db.prepare('UPDATE numbers SET call_seen_at = ? WHERE id = ? AND call_seen_at IS NULL').run(at, id);
  }

  // Back to Call Unseen for a whole category (asked for, after confirmation).
  resetNumberListCalls(listId) {
    return this.db.prepare('UPDATE numbers SET call_seen_at = NULL WHERE list_id = ? AND call_seen_at IS NOT NULL').run(listId).changes;
  }

  // Numbers of a category the Auto Dialer may call (as callableLeads).
  callableNumbers({ listId, exclude = [], limit = 50 } = {}) {
    const ex = [...new Set(exclude.map(Number).filter(Number.isInteger))];
    return this.db
      .prepare(
        `SELECT n.*, l.name AS list_name, 0 AS opted_out, 0 AS dupes FROM numbers n JOIN number_lists l ON l.id = n.list_id
         WHERE n.list_id = ? AND n.valid = 1 AND n.call_seen_at IS NULL AND n.call_dnc = 0
           AND NOT EXISTS (SELECT 1 FROM outreach_optouts o WHERE o.phone = n.phone)
           AND ${NOT_CALLED('n.phone')}
           ${ex.length ? `AND n.id NOT IN (${ex.map(() => '?').join(',')})` : ''}
         ORDER BY n.id ASC LIMIT ?`,
      )
      .all(Number(listId), ...ex, Math.max(1, Math.min(Number(limit) || 50, 5000)))
      .map(toNumber);
  }

  // --- opt-outs (shared by WhatsApp and SMS) ---

  isOptedOut(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length < 6) return false;
    return Boolean(this.db.prepare("SELECT 1 FROM outreach_optouts WHERE phone = ? OR replace(phone, '+', '') LIKE ? LIMIT 1").get(String(phone), `%${digits.slice(-9)}`));
  }

  optOut(phone, reason = null) {
    this.db.prepare('INSERT OR IGNORE INTO outreach_optouts (phone, reason, at) VALUES (?, ?, ?)').run(String(phone), reason, Date.now());
  }

  // --- SMS campaigns ---

  createSmsCampaign({ name, message, delaySeconds = 30, perHour = 60, maxRetries = 2, skipTexted = true, device = null }) {
    return Number(
      this.db
        .prepare('INSERT INTO sms_campaigns (name, message, delay_seconds, per_hour, max_retries, skip_texted, device, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(name, message, delaySeconds, perHour, maxRetries, skipTexted ? 1 : 0, device, Date.now()).lastInsertRowid,
    );
  }

  updateSmsCampaign(id, fields) {
    const cols = { name: 'name', message: 'message', status: 'status', reason: 'reason', device: 'device', delaySeconds: 'delay_seconds', perHour: 'per_hour', maxRetries: 'max_retries', skipTexted: 'skip_texted', startedAt: 'started_at', finishedAt: 'finished_at' };
    const sets = [];
    const args = [];
    for (const [k, c] of Object.entries(cols)) {
      if (!(k in fields)) continue;
      sets.push(`${c} = ?`);
      args.push(typeof fields[k] === 'boolean' ? (fields[k] ? 1 : 0) : fields[k]);
    }
    if (sets.length) this.db.prepare(`UPDATE sms_campaigns SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  }

  smsCampaigns() {
    return this.db
      .prepare(
        `SELECT c.*, COUNT(r.id) AS total,
           SUM(r.status = 'pending') AS pending, SUM(r.status = 'sending') AS sending, SUM(r.status = 'submitted') AS submitted,
           SUM(r.status = 'sent') AS sent, SUM(r.status = 'delivered') AS delivered, SUM(r.status = 'failed') AS failed, SUM(r.status = 'skipped') AS skipped
         FROM sms_campaigns c LEFT JOIN sms_recipients r ON r.campaign_id = c.id GROUP BY c.id ORDER BY c.created_at DESC, c.id DESC`,
      )
      .all()
      .map(toCampaign);
  }

  smsCampaign(id) {
    return this.smsCampaigns().find((c) => c.id === id) || null;
  }

  deleteSmsCampaign(id) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM sms_recipients WHERE campaign_id = ?').run(id);
      this.db.prepare('DELETE FROM sms_campaigns WHERE id = ?').run(id);
    });
  }

  // recipients: [{ kind: lead | number | import, refId, phone, name, business, category, city }];
  // a number already in the campaign is not added again.
  addSmsRecipients(campaignId, recipients, now = Date.now()) {
    const ins = this.db.prepare('INSERT OR IGNORE INTO sms_recipients (campaign_id, kind, ref_id, phone, name, business, category, city, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    let added = 0;
    this.transaction(() => {
      for (const r of recipients) added += ins.run(campaignId, r.kind, r.refId ?? null, r.phone, r.name || null, r.business || null, r.category || null, r.city || null, now).changes;
    });
    return { added, duplicates: recipients.length - added };
  }

  removeSmsRecipients(campaignId, ids) {
    const del = this.db.prepare("DELETE FROM sms_recipients WHERE campaign_id = ? AND id = ? AND status IN ('pending', 'skipped', 'failed')");
    let removed = 0;
    this.transaction(() => ids.forEach((id) => (removed += del.run(campaignId, id).changes)));
    return removed;
  }

  smsRecipients(campaignId, { status = '', search = '', limit = 200, offset = 0 } = {}) {
    const where = ['r.campaign_id = ?'];
    const args = [campaignId];
    if (status === 'not_sent') where.push("r.status IN ('pending', 'sending')");
    else if (status) {
      where.push('r.status = ?');
      args.push(status);
    }
    const q = String(search || '').trim().toLowerCase();
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      where.push("(lower(COALESCE(r.name, '')) LIKE ? ESCAPE '\\' OR lower(COALESCE(r.business, '')) LIKE ? ESCAPE '\\' OR r.phone LIKE ?)");
      args.push(like, like, like);
    }
    const w = where.join(' AND ');
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM sms_recipients r WHERE ${w}`).get(...args).n;
    const rows = this.db.prepare(`SELECT r.* FROM sms_recipients r WHERE ${w} ORDER BY r.id ASC LIMIT ? OFFSET ?`).all(...args, Math.min(Math.max(Number(limit) || 200, 1), 2000), Math.max(0, Number(offset) || 0));
    return { total, rows: rows.map(toRecipient) };
  }

  // The next recipient to send to (pending, its retry time reached).
  nextSmsRecipient(campaignId, now = Date.now()) {
    const r = this.db.prepare("SELECT * FROM sms_recipients WHERE campaign_id = ? AND status = 'pending' AND (next_at IS NULL OR next_at <= ?) ORDER BY attempts ASC, id ASC LIMIT 1").get(campaignId, now);
    return r ? toRecipient(r) : null;
  }

  // The earliest retry time of a campaign's waiting recipients (null: none waiting).
  nextSmsRetryAt(campaignId) {
    return this.db.prepare("SELECT MIN(next_at) AS t FROM sms_recipients WHERE campaign_id = ? AND status = 'pending' AND next_at IS NOT NULL").get(campaignId).t ?? null;
  }

  updateSmsRecipient(id, fields) {
    const cols = { status: 'status', reason: 'reason', attempts: 'attempts', nextAt: 'next_at', smsId: 'sms_id', body: 'body' };
    const sets = ['updated_at = ?'];
    const args = [Date.now()];
    for (const [k, c] of Object.entries(cols)) {
      if (!(k in fields)) continue;
      sets.push(`${c} = ?`);
      args.push(fields[k]);
    }
    this.db.prepare(`UPDATE sms_recipients SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  }

  // Recipients follow their message: submitted -> sent -> delivered / failed (as the phone reports).
  syncSmsRecipients() {
    return this.db
      .prepare(
        `UPDATE sms_recipients SET status = (SELECT m.status FROM sms_messages m WHERE m.id = sms_recipients.sms_id), updated_at = ?
         WHERE sms_id IS NOT NULL AND status IN ('submitted', 'sent')
           AND (SELECT m.status FROM sms_messages m WHERE m.id = sms_recipients.sms_id) IN ('sent', 'delivered', 'failed')
           AND (SELECT m.status FROM sms_messages m WHERE m.id = sms_recipients.sms_id) != status`,
      )
      .run(Date.now()).changes;
  }

  // Failed recipients of a campaign go back in the queue (asked for).
  retrySmsFailures(campaignId) {
    return this.db.prepare("UPDATE sms_recipients SET status = 'pending', next_at = NULL, attempts = 0, reason = NULL WHERE campaign_id = ? AND status = 'failed' AND COALESCE(reason, '') NOT LIKE 'Opted out%'").run(campaignId).changes;
  }

  // A text to this number was already sent (any campaign or by hand), last 9 digits.
  textedBefore(phone, exceptSmsId = null) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length < 6) return false;
    return Boolean(this.db.prepare("SELECT 1 FROM sms_messages WHERE direction = 'out' AND status NOT IN ('failed', 'sending') AND replace(phone, '+', '') LIKE ? AND id IS NOT ? LIMIT 1").get(`%${digits.slice(-9)}`, exceptSmsId));
  }

  // Texts handed to the phone in the last hour (for the hourly limit).
  smsSentSince(since) {
    return this.db.prepare("SELECT COUNT(*) AS n FROM sms_messages WHERE direction = 'out' AND status != 'failed' AND at >= ?").get(since).n;
  }

  // --- SMS (through the phone, Bluetooth MAP) ---

  // The lead or imported number with this phone number, for names in conversations.
  contactByPhone(phone) {
    const lead = this.findLeadByPhone(phone);
    if (lead) return { kind: 'lead', id: lead.id, name: lead.kind === 'person' ? lead.name : lead.contactName || lead.name, business: lead.kind === 'person' ? lead.companyName : lead.name };
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length < 7) return null;
    const n = this.db.prepare("SELECT id, name, business FROM numbers WHERE replace(phone, '+', '') LIKE ? ORDER BY id DESC LIMIT 1").get(`%${digits.slice(-9)}`);
    return n ? { kind: 'number', id: n.id, name: n.name || n.business || null, business: n.business || null } : null;
  }

  // A message; one with a MAP handle already saved is not saved twice.
  addSms({ handle = null, phone, direction, body = '', status, error = null, at = Date.now(), leadId = null, numberId = null, read = true }) {
    const r = this.db.prepare('INSERT OR IGNORE INTO sms_messages (handle, phone, direction, body, status, error, at, lead_id, number_id, read) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(handle, phone, direction, body, status, error, at, leadId, numberId, read ? 1 : 0);
    return r.changes ? Number(r.lastInsertRowid) : null;
  }

  updateSms(id, { status, error = null, handle }) {
    this.db.prepare('UPDATE sms_messages SET status = COALESCE(?, status), error = ?, handle = COALESCE(?, handle) WHERE id = ?').run(status ?? null, error, handle ?? null, id);
  }

  // A message sent from Lead Finder that the phone's sent folder now lists:
  // same number (last 9 digits), same text, not matched yet.
  claimSentSms({ phone, body, since, handle }) {
    const tail = String(phone || '').replace(/\D/g, '').slice(-9);
    if (tail.length < 6) return null;
    const row = this.db
      .prepare("SELECT id, phone, status FROM sms_messages WHERE handle IS NULL AND direction = 'out' AND body = ? AND at >= ? AND replace(phone, '+', '') LIKE ? ORDER BY at DESC LIMIT 1")
      .get(body, since, `%${tail}`);
    if (!row) return null;
    this.db.prepare('UPDATE sms_messages SET handle = ? WHERE id = ?').run(handle, row.id);
    return row;
  }

  smsByHandle(handle) {
    return this.db.prepare('SELECT * FROM sms_messages WHERE handle = ?').get(handle) || null;
  }

  markSmsSeen({ leadId, numberId }, at = Date.now()) {
    if (leadId) this.db.prepare('UPDATE businesses SET sms_seen_at = COALESCE(sms_seen_at, ?) WHERE id = ?').run(at, leadId);
    if (numberId) this.db.prepare('UPDATE numbers SET sms_seen_at = COALESCE(sms_seen_at, ?) WHERE id = ?').run(at, numberId);
  }

  // Conversations, newest first: the last message and unread count of each number.
  smsThreads() {
    const rows = this.db
      .prepare(
        `SELECT m.phone, MAX(m.at) AS at, SUM(m.direction = 'in' AND m.read = 0) AS unread, COUNT(*) AS n,
           (SELECT body FROM sms_messages x WHERE x.phone = m.phone ORDER BY x.at DESC, x.id DESC LIMIT 1) AS last,
           (SELECT direction FROM sms_messages x WHERE x.phone = m.phone ORDER BY x.at DESC, x.id DESC LIMIT 1) AS last_dir
         FROM sms_messages m GROUP BY m.phone ORDER BY at DESC LIMIT 500`,
      )
      .all();
    return rows.map((r) => ({ phone: r.phone, at: r.at, unread: r.unread || 0, count: r.n, last: r.last, lastDirection: r.last_dir, contact: this.contactByPhone(r.phone) }));
  }

  smsMessages(phone) {
    return this.db
      .prepare('SELECT * FROM sms_messages WHERE phone = ? ORDER BY at ASC, id ASC LIMIT 2000')
      .all(phone)
      .map((r) => ({ id: r.id, handle: r.handle, phone: r.phone, direction: r.direction, body: r.body, status: r.status, error: r.error, at: r.at, leadId: r.lead_id, numberId: r.number_id, read: Boolean(r.read) }));
  }

  markSmsRead(phone) {
    this.db.prepare("UPDATE sms_messages SET read = 1 WHERE phone = ? AND direction = 'in'").run(phone);
  }

  // The saved lead with this number (the last 9 digits match), for incoming calls.
  findLeadByPhone(number) {
    const digits = String(number || '').replace(/\D/g, '');
    if (digits.length < 7) return null;
    const tail = digits.slice(-9);
    const row = this.withRetry(() => this.db.prepare(`${LEAD_SELECT} WHERE b.qualified = 1 AND replace(replace(replace(b.phone, '+', ''), ' ', ''), '-', '') LIKE ? ORDER BY b.id DESC LIMIT 1`).get(`%${tail}`));
    return row ? toLead(row) : null;
  }

  leadById(id) {
    const row = this.withRetry(() => this.db.prepare(`${LEAD_SELECT} WHERE b.id = ? AND b.qualified = 1`).get(id));
    return row ? toLead(row) : null;
  }

  recordMessage({ businessId, phone, body, waId, status, error }, now = new Date().toISOString()) {
    this.withRetry(() =>
      this.db
        .prepare('INSERT INTO whatsapp_messages (business_id, phone, body, wa_id, status, error, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(businessId ?? null, phone, body, waId ?? null, status, error ?? null, now),
    );
  }

  lastMessageTo(phone) {
    return this.withRetry(() =>
      this.db.prepare("SELECT sent_at AS sentAt, wa_id AS waId FROM whatsapp_messages WHERE phone = ? AND status = 'sent' ORDER BY sent_at DESC LIMIT 1").get(phone),
    ) || null;
  }

  // --- WhatsApp status (per number, cached) ------------------------------
  // status: 'available' | 'unavailable' | null (clear -> "Not checked").
  // Only validated E.164 numbers can carry a status.
  setWhatsAppStatus(phone, status, method = 'manual', now = new Date().toISOString()) {
    if (!E164.test(String(phone))) throw new Error('Only validated international numbers can be checked.');
    return this.withRetry(() => {
      if (status === null) this.stmt.clearWhatsApp.run(phone);
      else if (status === 'available' || status === 'unavailable') this.stmt.setWhatsApp.run(phone, status, method, now);
      else throw new Error('Unknown WhatsApp status');
      return this.listLeads().filter((l) => l.phone === phone);
    });
  }

  // --- small app state (last search, for crash recovery) ----------------------
  getState(key) {
    const row = this.withRetry(() => this.stmt.getState.get(key));
    try {
      return row ? JSON.parse(row.value) : null;
    } catch {
      return null;
    }
  }

  setState(key, value) {
    this.withRetry(() => this.stmt.setState.run(key, JSON.stringify(value)));
  }

  close() {
    this.db.close();
  }
}

function statusText(row) {
  if (row.website_status === 'no_website') return 'No website found';
  if (row.website_status === 'has_website') return row.website_detail ? `Website: ${row.website_detail}` : 'Has website';
  if (row.website_status === 'possible_website') return row.website_detail ? `Possible website: ${row.website_detail}` : 'Possible website';
  if (row.website_status === 'not_checked') return 'Website not checked (found on Facebook)';
  if (row.website_status === 'social_only') {
    return row.website_detail ? `No website (social page only: ${row.website_detail})` : 'No website (social page only)';
  }
  return row.website_status;
}

function toLead(row) {
  return {
    id: row.id,
    placeKey: row.place_key,
    name: row.name,
    phone: row.phone || '',
    phoneRaw: row.phone_raw || '',
    phoneStatus: row.phone_status || (row.phone ? 'unverified' : ''),
    phoneCountry: row.phone_country || '',
    // Green in the UI only for 'available' (a positive, recorded check).
    whatsapp: row.wa_status || 'not_checked',
    whatsappCheckedAt: row.wa_checked_at || '',
    whatsappMethod: row.wa_method || '',
    whatsappDetail: row.wa_detail || '',
    address: row.address || '',
    mapsUrl: row.maps_url,
    websiteStatus: statusText(row),
    websiteDetail: row.website_detail || '',
    websiteKind: ['has_website', 'possible_website'].includes(row.website_status) ? 'with' : row.website_status === 'not_checked' ? 'unknown' : 'without',
    keyword: row.keyword || '',
    categoryId: row.category_id ?? null,
    category: row.category_name || '',
    discoveredAt: row.discovered_at,
    discoveredDate: row.discovered_date || localDate(row.discovered_at),
    // Campaign status: 'seen' once a campaign message was sent to this
    // number; campaignDelivery is the best receipt (sent/delivered/read).
    campaign: row.camp_rank > 0 ? 'seen' : 'unseen',
    // Call status, separate from WhatsApp: 'seen' once an outgoing call
    // started, 'dnc' when the lead must not be called.
    callStatus: row.call_dnc ? 'dnc' : row.call_seen_at ? 'seen' : 'unseen',
    callSeenAt: row.call_seen_at ?? null,
    // SMS status (texts sent through the phone), apart from WhatsApp and calls.
    smsStatus: row.sms_seen_at ? 'seen' : 'unseen',
    // Where the lead was found: Google Maps, a Facebook post and/or LinkedIn.
    source: { fb: 'facebook', li: 'linkedin', lp: 'linkedin', pc: 'podcast' }[String(row.place_key).slice(0, 2)] || 'maps',
    // A person found with LinkedIn People search (not a business).
    kind: String(row.place_key).startsWith('lp:') ? 'person' : 'business',
    sources: [
      ...(/^(fb|li|lp|pc):/.test(String(row.place_key)) ? [] : ['maps']),
      ...(String(row.place_key).startsWith('pc:') ? ['podcast'] : []),
      ...(row.fb_post_url ? ['facebook'] : []),
      ...(row.li_company_url || row.li_job_url || row.li_post_url || row.li_profile_url ? ['linkedin'] : []),
    ],
    email: row.email || '',
    websiteUrl: row.website_url || '',
    linkedinUrl: row.li_company_url || '',
    jobUrl: row.li_job_url || '',
    linkedinPostUrl: row.li_post_url || '',
    jobTitle: row.job_title || '',
    discovery: row.discovery || '',
    podcastUrl: row.podcast_url || '',
    rssUrl: row.rss_url || '',
    podcastHost: row.host_name || '',
    podcastLinks: parseLinks(row.podcast_links),
    emailStatus: row.email_status || (String(row.place_key).startsWith('pc:') ? (row.email ? 'found' : 'none') : ''),
    artworkUrl: row.artwork_url || '',
    profileUrl: row.li_profile_url || '',
    personTitle: row.person_title || '',
    companyName: row.company_name || '',
    companyUrl: row.company_url || '',
    phones: parseJson(row.phones, []),
    // Contact providers that supplied the details (e.g. ['contactout']).
    contactProviders: row.contact_providers ? String(row.contact_providers).split(',') : [],
    emails: parseEmails(row.emails),
    // What contact details the lead has.
    contacts: { phone: Boolean(row.phone), email: Boolean(row.email), website: Boolean(row.website_url || ['has_website', 'possible_website'].includes(row.website_status)) },
    fbPostUrl: row.fb_post_url || '',
    fbPageUrl: row.fb_page_url || '',
    contactName: row.contact_name || '',
    description: row.description || '',
    campaignDelivery: ['', 'sent', 'delivered', 'read'][row.camp_rank || 0] || null,
  };
}

const LEAD_SELECT = `SELECT b.*, c.name AS category_name, w.status AS wa_status, w.checked_at AS wa_checked_at, w.method AS wa_method, w.detail AS wa_detail,
    (SELECT MAX(CASE s.status WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 ELSE 0 END)
       FROM outreach_sends s WHERE s.phone = b.phone AND s.test = 0) AS camp_rank
  FROM businesses b
  LEFT JOIN categories c ON c.id = b.category_id
  LEFT JOIN whatsapp_checks w ON w.phone = b.phone AND b.phone_status = 'valid'`;

function toCampaign(r) {
  return {
    id: r.id,
    name: r.name,
    message: r.message,
    status: r.status,
    reason: r.reason,
    device: r.device,
    delaySeconds: r.delay_seconds,
    perHour: r.per_hour,
    maxRetries: r.max_retries,
    skipTexted: Boolean(r.skip_texted),
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    counts: { total: r.total || 0, pending: (r.pending || 0) + (r.sending || 0), submitted: r.submitted || 0, sent: r.sent || 0, delivered: r.delivered || 0, failed: r.failed || 0, skipped: r.skipped || 0 },
  };
}

function toRecipient(r) {
  return { id: r.id, campaignId: r.campaign_id, kind: r.kind, refId: r.ref_id, phone: r.phone, name: r.name, business: r.business, category: r.category, city: r.city, status: r.status, reason: r.reason, attempts: r.attempts, nextAt: r.next_at, smsId: r.sms_id, body: r.body, updatedAt: r.updated_at };
}

function toNumber(r) {
  let extra = null;
  try {
    extra = r.extra ? JSON.parse(r.extra) : null;
  } catch {}
  return {
    id: r.id,
    listId: r.list_id,
    list: r.list_name,
    phone: r.phone,
    raw: r.phone_raw,
    valid: Boolean(r.valid),
    name: r.name,
    business: r.business,
    extra,
    createdAt: r.created_at,
    callStatus: r.call_dnc ? 'dnc' : r.call_seen_at ? 'seen' : 'unseen',
    callSeenAt: r.call_seen_at,
    smsStatus: r.sms_seen_at ? 'seen' : 'unseen',
    optedOut: Boolean(r.opted_out),
    duplicates: r.dupes || 0,
  };
}

// A phone number no outgoing call has started to (as a lead, an imported
// number or in the call log): the Auto Dialer never calls a number twice.
const NOT_CALLED = (col) => `NOT EXISTS (SELECT 1 FROM calls k WHERE k.number = ${col} AND k.direction = 'outgoing' AND k.status NOT IN ('failed', 'dialing'))
  AND NOT EXISTS (SELECT 1 FROM numbers n2 WHERE n2.phone = ${col} AND (n2.call_seen_at IS NOT NULL OR n2.call_dnc = 1))
  AND NOT EXISTS (SELECT 1 FROM businesses b2 WHERE b2.phone = ${col} AND b2.qualified = 1 AND (b2.call_seen_at IS NOT NULL OR b2.call_dnc = 1))`;

const TOMBSTONE = `qualified = 0, website_status = 'deleted', website_detail = NULL, name = '', phone = NULL, phone_raw = NULL,
  phone_status = NULL, phone_country = NULL, address = NULL, maps_url = '', fb_post_url = NULL, fb_page_url = NULL, contact_name = NULL, description = NULL,
  email = NULL, website_url = NULL, li_job_url = NULL, li_post_url = NULL, job_title = NULL, discovery = NULL,
  host_name = NULL, emails = NULL, person_title = NULL, company_name = NULL, company_url = NULL, phones = NULL, email_status = NULL, contact_providers = NULL,
  call_seen_at = NULL, call_dnc = 0, sms_seen_at = NULL`;

// Email status of a finished check (processPodcast's status).
const EMAIL_STATUS = { found: 'found', platform_only: 'platform', not_found: 'none', incomplete: 'failed', failed: 'failed' };

const personKey = (profileUrl) => `lp:${crypto.createHash('sha256').update(String(profileUrl).toLowerCase()).digest('hex').slice(0, 32)}`;

// Names and companies compared without case, accents, punctuation, titles
// and legal suffixes.
function personNameKey(name) {
  let n = String(name || '').trim();
  // "Doe, Jane" -> "Jane Doe"; "Jane Doe, MBA" -> "Jane Doe".
  const comma = n.match(/^([^,]+),\s*([^,]+)$/);
  if (comma) n = /^(mba|phd|ph\.d\.?|cpa|pmp|cfa|acca|msc|bsc|md|esq|jr|sr|ii|iii)\.?$/i.test(comma[2].trim()) || comma[1].trim().includes(' ') ? comma[1] : `${comma[2]} ${comma[1]}`;
  return n
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)|,.*$/g, ' ')
    .replace(/[^\p{L}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !/^(mr|mrs|ms|dr|prof|mba|phd|jr|sr)$/.test(w))
    .join(' ');
}

function companyKey(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(pvt|private|ltd|limited|llc|inc|incorporated|co|company|corp|corporation|plc|gmbh|llp|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// One entry per key (the first wins unless `pick` prefers the other).
function mergeBy(list, key, pick) {
  const out = new Map();
  for (const x of list) {
    if (!x || !x[key]) continue;
    out.set(x[key], out.has(x[key]) ? pick(out.get(x[key]), x) : x);
  }
  return [...out.values()];
}

function parseJson(text, fallback) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

function parseLinks(json) {
  try {
    const o = JSON.parse(json || '{}');
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

// An RSS feed address compared without scheme, "www." and trailing slash.
function feedIdent(url) {
  return String(url).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
}

function parseEmails(json) {
  try {
    const list = JSON.parse(json || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// A website's host without "www." (for matching the same company), or null.
function siteHost(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase().replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

// Key of a lead found on Facebook: one per number. A hash, so the marker a
// deleted lead leaves behind does not keep the number.
function facebookKey(phone) {
  return `fb:${crypto.createHash('sha256').update(String(phone)).digest('hex').slice(0, 32)}`;
}

module.exports = { LeadStore, QUALIFIED_STATUSES, localDate, formatCategory, categoryKey, facebookKey, DATE_RE };
