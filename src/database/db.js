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
    if (filter.source === 'maps') clauses.push("b.place_key NOT LIKE 'fb:%' AND b.place_key NOT LIKE 'li:%' AND b.place_key NOT LIKE 'pc:%'");
    else if (filter.source === 'facebook') clauses.push('b.fb_post_url IS NOT NULL');
    else if (filter.source === 'linkedin') clauses.push('(b.li_company_url IS NOT NULL OR b.li_job_url IS NOT NULL OR b.li_post_url IS NOT NULL)');
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
    // Search: business or contact name, or (by digits) the phone number.
    const q = typeof filter.search === 'string' ? filter.search.trim().slice(0, 100) : '';
    if (q) {
      const like = (v) => `%${v.replace(/[\\%_]/g, '\\$&')}%`;
      const digits = q.replace(/\D/g, '');
      clauses.push(`(b.name LIKE ? ESCAPE '\\' OR b.contact_name LIKE ? ESCAPE '\\'${digits.length >= 3 ? " OR b.phone LIKE ? ESCAPE '\\' OR b.phone_raw LIKE ? ESCAPE '\\'" : ''})`);
      params.push(like(q), like(q));
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
          ? this.db.prepare('SELECT id FROM businesses WHERE qualified = 1 AND (phone = ? OR phone_raw = ? OR (phone_status = \'valid\' AND length(?) >= 9 AND phone LIKE \'%\' || ?)) ORDER BY id LIMIT 1').get(r.phone, r.phone, national, national)
          : this.db.prepare('SELECT id FROM businesses WHERE phone = ? AND qualified = 1 ORDER BY id LIMIT 1').get(r.phone));
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
          (ph?.status === 'valid' && q('SELECT id FROM businesses WHERE qualified = 1 AND phone = ? ORDER BY id LIMIT 1', ph.phone)) ||
          (host && q("SELECT id FROM businesses WHERE qualified = 1 AND (website_url LIKE ? OR website_url LIKE ? OR website_detail = ? OR website_detail LIKE ?) ORDER BY id LIMIT 1", `%://${host}%`, `%://www.${host}%`, host, `${host}/%`)) ||
          (r.email && q('SELECT id FROM businesses WHERE qualified = 1 AND lower(email) = lower(?) ORDER BY id LIMIT 1', r.email));
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
    // Where the lead was found: Google Maps, a Facebook post and/or LinkedIn.
    source: { fb: 'facebook', li: 'linkedin', pc: 'podcast' }[String(row.place_key).slice(0, 2)] || 'maps',
    sources: [
      ...(/^(fb|li|pc):/.test(String(row.place_key)) ? [] : ['maps']),
      ...(String(row.place_key).startsWith('pc:') ? ['podcast'] : []),
      ...(row.fb_post_url ? ['facebook'] : []),
      ...(row.li_company_url || row.li_job_url || row.li_post_url ? ['linkedin'] : []),
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

const TOMBSTONE = `qualified = 0, website_status = 'deleted', website_detail = NULL, name = '', phone = NULL, phone_raw = NULL,
  phone_status = NULL, phone_country = NULL, address = NULL, maps_url = '', fb_post_url = NULL, fb_page_url = NULL, contact_name = NULL, description = NULL,
  email = NULL, website_url = NULL, li_job_url = NULL, li_post_url = NULL, job_title = NULL, discovery = NULL,
  host_name = NULL, emails = NULL`;

// Email status of a finished check (processPodcast's status).
const EMAIL_STATUS = { found: 'found', platform_only: 'platform', not_found: 'none', incomplete: 'failed', failed: 'failed' };

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
