'use strict';

// Click tracking for email campaigns. Links in a campaign email point to the
// user's own tracking address (server/click-tracker: index.php on their
// website, or a Cloudflare Worker), which records the click and sends the
// reader on to the real page. Lead Finder fetches the clicks every few
// minutes (the computer does not need to be on when someone clicks).
//
// Every link is signed with a key only this Lead Finder and the tracking
// address know, so the address only ever redirects to links it was given
// (it can never be used to send people elsewhere). The key is kept in the
// vault; the server stores it the first time it is paired.

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const STATE_KEY = 'email.tracking';
const VAULT_KEY = 'email.trackingKey';
const POLL_MS = 3 * 60_000;
const OVERLAP_MS = 10 * 60_000; // clicks seen late by the server are fetched again (deduplicated here)
const MAX_LINKS = 25;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g;

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const unescapeHtml = (s) => String(s).replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const newTrackId = () => b64url(crypto.randomBytes(8)); // 11 characters

// The address as typed, made ready to use: https (http only for tests), and a
// folder ends with "/" (a POST to /t would be redirected to /t/ as a GET).
function normalizeBase(raw, { allowInsecure = false } = {}) {
  let s = String(raw || '').trim();
  if (!s) return { ok: false, error: 'Enter your tracking address, e.g. https://yourdomain.com/t/' };
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: 'That is not a web address. Example: https://yourdomain.com/t/' };
  }
  if (u.protocol !== 'https:' && !(allowInsecure && u.protocol === 'http:')) return { ok: false, error: 'The tracking address must start with https:// (links without it are marked as unsafe by email providers).' };
  if (u.search || u.hash) return { ok: false, error: 'Enter the address without ? or # (e.g. https://yourdomain.com/t/).' };
  const last = u.pathname.split('/').pop();
  if (last && !last.includes('.')) u.pathname += '/';
  return { ok: true, base: u.toString() };
}

// Clicks made by link scanners (Outlook Safe Links, security gateways,
// previews), not by a person.
const BOT_UA = /bot\b|crawler|spider|preview|scanner|python|curl|wget|go-http|java\/|okhttp|axios|node-fetch|libwww|httpclient|headless|phantom|barracuda|mimecast|proofpoint|forcepoint|safelinks|microsoft office|ms-office|outlook-ios|googleimageproxy|yahoomailproxy|symantec|trendmicro|sophos|fortiguard|zscaler|cisco|ironport/i;
const isBot = (ua) => !String(ua || '').trim() || BOT_UA.test(String(ua));

class ClickTracker extends EventEmitter {
  // state: { get(key), set(key, value) } (app_state); vault: Vault.
  constructor({ state, vault, fetch = globalThis.fetch, clock = () => Date.now(), pollMs = POLL_MS, allowInsecure = false, log = () => {} }) {
    super();
    Object.assign(this, { state, vault, fetchFn: fetch, clock, pollMs, allowInsecure, log });
    this.timer = null;
    this.polling = null;
  }

  settings() {
    const s = this.state.get(STATE_KEY);
    return s && typeof s === 'object' ? s : {};
  }

  save(patch) {
    this.state.set(STATE_KEY, { ...this.settings(), ...patch });
    this.emit('change');
  }

  // The signing key: in the vault; without a keychain, in app_state (a lost
  // key would make every link sent so far stop working).
  key() {
    return this.vault?.persistent ? this.vault.get(VAULT_KEY) : this.settings().localKey || null;
  }

  ensureKey() {
    let k = this.key();
    if (k) return k;
    k = b64url(crypto.randomBytes(32));
    if (this.vault?.persistent) this.vault.set(VAULT_KEY, k);
    else this.save({ localKey: k });
    return k;
  }

  get active() {
    const s = this.settings();
    return Boolean(s.base && s.connectedAt && this.key());
  }

  status() {
    const s = this.settings();
    return { base: s.base || '', connected: this.active, connectedAt: s.connectedAt || null, lastPollAt: s.lastPollAt || null, lastError: s.lastError || null, clicks: s.clicks || 0 };
  }

  // --- links -------------------------------------------------------------------

  sign(t, u) {
    return crypto.createHmac('sha256', this.key()).update(`${t}|${u}`).digest('base64url').slice(0, 22);
  }

  link(t, url, base = this.settings().base) {
    const u = b64url(Buffer.from(url, 'utf8'));
    return `${base}?t=${t}&u=${u}&s=${this.sign(t, u)}`;
  }

  // The email's links, tracked for one recipient (t). The text that shows
  // stays the same; only where the link goes changes. mailto: links and
  // links to the tracking address itself are left alone.
  rewrite({ text, html }, t) {
    const base = this.settings().base;
    const skip = (url) => url.startsWith(base) || url.length > 1500;
    let n = 0;
    const outHtml = html
      ? String(html).replace(/(<a\b[^>]*?\bhref\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi, (all, pre, q, raw) => {
          const url = unescapeHtml(raw);
          if (skip(url) || n >= MAX_LINKS) return all;
          n++;
          return `${pre}"${escapeAttr(this.link(t, url, base))}"`;
        })
      : html;
    let m = 0;
    const outText = text
      ? String(text).replace(URL_IN_TEXT, (url) => {
          if (skip(url) || m >= MAX_LINKS) return url;
          m++;
          return this.link(t, url, base);
        })
      : text;
    return { text: outText, html: outHtml, links: Math.max(n, m) };
  }

  // --- the tracking address ---------------------------------------------------------

  async post(base, action, fields) {
    const body = new URLSearchParams({ key: this.key(), ...fields });
    let res;
    try {
      res = await this.fetchFn(`${base}?a=${action}`, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw new Error(`the tracking address could not be reached (${err.name === 'TimeoutError' ? 'timed out' : err.cause?.code || err.message})`);
    }
    const type = res.headers.get('content-type') || '';
    if (res.status >= 300 && res.status < 400) throw new Error(`the address redirects to ${res.headers.get('location') || 'another page'}: enter that address instead`);
    if (!type.includes('json')) {
      if (res.status === 404) throw new Error('nothing found at that address: upload index.php to that folder (or check the Worker address)');
      const head = (await res.text().catch(() => '')).slice(0, 200);
      if (/<\?php/.test(head)) throw new Error('the server shows the PHP file instead of running it: this hosting has no PHP, use the Cloudflare Worker instead');
      throw new Error(`the address did not answer like Lead Finder's tracking file (HTTP ${res.status})`);
    }
    const data = await res.json().catch(() => null);
    if (!data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  }

  // Pairs with the tracking address and checks a test click end to end.
  async connect(raw) {
    const n = normalizeBase(raw, { allowInsecure: this.allowInsecure });
    if (!n.ok) return n;
    this.ensureKey();
    try {
      const setup = await this.post(n.base, 'setup', {});
      if (setup.app !== 'lead-finder-clicks') throw new Error('that address is not a Lead Finder tracking file');
      // A test click: the address must send it on to the link.
      const target = 'https://example.com/lead-finder-click-test';
      const res = await this.fetchFn(this.link(`test-${b64url(crypto.randomBytes(3))}`, target, n.base), { redirect: 'manual', headers: { 'User-Agent': 'Lead Finder click test' }, signal: AbortSignal.timeout(20_000) });
      if (!(res.status >= 300 && res.status < 400) || res.headers.get('location') !== target) throw new Error(`a test link did not lead to its page (HTTP ${res.status})`);
      await this.post(n.base, 'poll', { since: String(this.clock() - 60_000) });
    } catch (err) {
      this.save({ lastError: err.message });
      return { ok: false, error: `Not connected: ${err.message}.` };
    }
    this.save({ base: n.base, connectedAt: this.clock(), lastError: null, cursor: this.settings().base === n.base ? this.settings().cursor || 0 : this.clock() - OVERLAP_MS });
    this.log(`click tracking connected: ${new URL(n.base).host}`);
    this.start();
    return { ok: true, status: this.status() };
  }

  // Off: new emails go out with their links as they are. The key is kept, so
  // links already sent keep working and the same address pairs again.
  disconnect() {
    this.save({ connectedAt: null, lastError: null });
    this.stop();
    return { ok: true, status: this.status() };
  }

  // The clicks since the last check; each one goes to onClick (which returns
  // { recorded } for a new human click).
  async poll() {
    if (!this.active) return { ok: false, skipped: true };
    if (this.polling) return this.polling;
    this.polling = (async () => {
      const s = this.settings();
      try {
        const since = Math.max(0, (s.cursor || 0) - OVERLAP_MS);
        const data = await this.post(s.base, 'poll', { since: String(since) });
        let cursor = s.cursor || 0;
        let recorded = 0;
        for (const c of Array.isArray(data.clicks) ? data.clicks : []) {
          if (!c || typeof c.id !== 'string' || typeof c.t !== 'string' || !Number.isFinite(c.at)) continue;
          cursor = Math.max(cursor, c.at);
          const r = this.onClick ? this.onClick({ id: c.id.slice(0, 40), t: c.t.slice(0, 40), url: String(c.u || '').slice(0, 1500), at: c.at, ua: String(c.ua || '').slice(0, 200), bot: isBot(c.ua) }) : null;
          if (r?.recorded) recorded++;
        }
        this.save({ cursor, lastPollAt: this.clock(), lastError: null, clicks: (s.clicks || 0) + recorded });
        return { ok: true, clicks: recorded };
      } catch (err) {
        this.save({ lastPollAt: this.clock(), lastError: err.message });
        this.log(`click tracking: ${err.message}`);
        return { ok: false, error: err.message };
      } finally {
        this.polling = null;
      }
    })();
    return this.polling;
  }

  start() {
    if (this.timer || !this.active) return;
    const first = setTimeout(() => this.poll().catch(() => {}), 10_000);
    first.unref?.();
    this.timer = setInterval(() => this.poll().catch(() => {}), this.pollMs);
    this.timer.unref?.();
    this.first = first;
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.first);
    this.timer = null;
  }
}

module.exports = { ClickTracker, normalizeBase, isBot, newTrackId };
