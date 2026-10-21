'use strict';

// Local SQLite storage. Every checked listing is recorded by its Google Maps
// place key so it is not revisited; only qualified (website-less) rows keep
// phone and address, and only those are shown and exported. Leads carry the
// search category and the local date they were discovered.

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

  transaction(fn) {
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
    if (filter.website === 'without') clauses.push("b.website_status IN ('no_website', 'social_only')");
    else if (filter.website === 'with') clauses.push("b.website_status IN ('has_website', 'possible_website')");
    // Only numbers WhatsApp itself confirmed (not earlier manual marks).
    if (filter.whatsapp === 'available') {
      clauses.push(`b.phone_status = 'valid' AND EXISTS (SELECT 1 FROM whatsapp_checks w2
        WHERE w2.phone = b.phone AND w2.status = 'available' AND w2.method != 'manual')`);
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
    return this.withRetry(() =>
      this.transaction(() => {
        const stmt = this.db.prepare(`UPDATE businesses SET ${TOMBSTONE} WHERE id = ? AND qualified = 1`);
        let n = 0;
        for (const id of list) n += Number(stmt.run(id).changes);
        return n;
      }),
    );
  }

  deleteFiltered(filter = {}) {
    const w = this.where(filter);
    return this.withRetry(() =>
      this.transaction(() => Number(this.db.prepare(`UPDATE businesses AS b SET ${TOMBSTONE} WHERE ${w.sql}`).run(...w.params).changes)),
    );
  }

  // Saves a checked business. Returns { lead, isNewLead } where lead is set
  // when the stored row is a qualified lead.
  save(result, now = new Date().toISOString()) {
    return this.withRetry(() => {
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
      if (existing) {
        const { keyword, ...updateRow } = row;
        this.stmt.update.run(updateRow);
      } else {
        this.stmt.insert.run(row);
      }
      const saved = this.stmt.getLead.get(result.placeKey);
      return {
        lead: saved.qualified ? toLead(saved) : null,
        isNewLead: Boolean(saved.qualified) && !(existing && existing.qualified),
      };
    });
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
    websiteKind: ['has_website', 'possible_website'].includes(row.website_status) ? 'with' : 'without',
    keyword: row.keyword || '',
    categoryId: row.category_id ?? null,
    category: row.category_name || '',
    discoveredAt: row.discovered_at,
    discoveredDate: row.discovered_date || localDate(row.discovered_at),
  };
}

const LEAD_SELECT = `SELECT b.*, c.name AS category_name, w.status AS wa_status, w.checked_at AS wa_checked_at, w.method AS wa_method, w.detail AS wa_detail
  FROM businesses b
  LEFT JOIN categories c ON c.id = b.category_id
  LEFT JOIN whatsapp_checks w ON w.phone = b.phone AND b.phone_status = 'valid'`;

const TOMBSTONE = `qualified = 0, website_status = 'deleted', website_detail = NULL, name = '', phone = NULL, phone_raw = NULL,
  phone_status = NULL, phone_country = NULL, address = NULL, maps_url = ''`;

module.exports = { LeadStore, QUALIFIED_STATUSES, localDate, formatCategory, categoryKey, DATE_RE };
