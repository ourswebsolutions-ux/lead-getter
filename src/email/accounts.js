'use strict';

// Email (SMTP) accounts for email campaigns: several accounts, each with its
// sender name and address, server, login and encryption. Passwords are kept
// in the Vault (OS keychain); the account list in app_state never holds
// them, and nothing here ever returns them.

const crypto = require('node:crypto');
const nodemailer = require('nodemailer');
const { mailError } = require('../main/mailer');

const KEY = 'email.accounts';
const ENCRYPTIONS = ['ssl', 'starttls'];
const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

// The inbox (IMAP) server of a provider, from its SMTP server.
const IMAP_HOSTS = { 'smtp.gmail.com': 'imap.gmail.com', 'smtp.office365.com': 'outlook.office365.com', 'smtp-mail.outlook.com': 'outlook.office365.com', 'smtp.mail.yahoo.com': 'imap.mail.yahoo.com', 'smtp.zoho.com': 'imap.zoho.com', 'smtp.hostinger.com': 'imap.hostinger.com' };
function imapHostFor(smtpHost) {
  const h = String(smtpHost || '').toLowerCase();
  return IMAP_HOSTS[h] || (h.startsWith('smtp.') ? `imap.${h.slice(5)}` : h);
}

const isEmail = (v) => typeof v === 'string' && EMAIL.test(v.trim()) && v.trim().length <= 254;
const clean = (v, max) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

// nodemailer settings for an account (insecure: plain SMTP, tests only).
function transportOptions(account, pass, { allowInsecure = false } = {}) {
  const insecure = allowInsecure && account.encryption === 'none';
  return {
    host: account.host,
    port: Number(account.port),
    secure: !insecure && account.encryption === 'ssl',
    requireTLS: !insecure && account.encryption === 'starttls',
    ignoreTLS: insecure,
    auth: account.username ? { user: account.username, pass } : undefined,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
    logger: false,
    debug: false,
  };
}

class EmailAccounts {
  // store: { getState, setState }; vault: Vault; allowInsecure: tests only;
  // createTransport(options) -> nodemailer transport (replaceable in tests).
  constructor({ store, vault, allowInsecure = false, createTransport = (o) => nodemailer.createTransport(o), now = () => Date.now() }) {
    Object.assign(this, { store, vault, allowInsecure, createTransport, now });
    this.transports = new Map(); // id -> { key, transport }
  }

  raw() {
    const list = this.store.getState(KEY);
    return Array.isArray(list) ? list : [];
  }

  write(list) {
    this.store.setState(KEY, list);
  }

  // For the window and the assistant: no passwords, only whether one is saved.
  list() {
    return this.raw().map((a) => this.public(a));
  }

  public(a) {
    return { id: a.id, name: a.name, senderName: a.senderName, email: a.email, host: a.host, port: a.port, username: a.username, encryption: a.encryption, status: a.status || 'untested', statusDetail: a.statusDetail || '', testedAt: a.testedAt || null, hasPassword: this.vault.has(`smtp:${a.id}`), createdAt: a.createdAt, imapOn: a.imapOn !== false, imapHost: a.imapHost || imapHostFor(a.host), imapPort: a.imapPort || 993, imapStatus: a.imapStatus || null, imapDetail: a.imapDetail || '', imapCheckedAt: a.imapCheckedAt || null };
  }

  get(id) {
    return this.raw().find((a) => a.id === id) || null;
  }

  // Checks and cleans what the user entered: { ok, account, password } | { ok: false, error }.
  validate(input, existing = null) {
    const name = clean(input.name, 60);
    const senderName = clean(input.senderName, 80);
    const email = clean(input.email, 254).toLowerCase();
    const host = clean(input.host, 253).toLowerCase();
    const port = Number(input.port);
    const username = clean(input.username ?? email, 254);
    const encryption = this.allowInsecure && input.encryption === 'none' ? 'none' : String(input.encryption || '').toLowerCase();
    if (!name) return { ok: false, error: 'Give the account a name.' };
    if (!isEmail(email)) return { ok: false, error: 'Enter a valid email address.' };
    if (!HOST.test(host) && !(this.allowInsecure && host === '127.0.0.1')) return { ok: false, error: 'Enter the SMTP server (e.g. smtp.gmail.com).' };
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'Enter the SMTP port (465 for SSL, 587 for STARTTLS).' };
    if (!ENCRYPTIONS.includes(encryption) && encryption !== 'none') return { ok: false, error: 'Choose SSL or STARTTLS (TLS).' };
    if (!username) return { ok: false, error: 'Enter the SMTP username.' };
    const password = typeof input.password === 'string' ? input.password : '';
    if (!existing && !password) return { ok: false, error: 'Enter the SMTP password (an app password for Gmail).' };
    if (password.length > 500) return { ok: false, error: 'The password is too long.' };
    // Replies (unsubscribes) read from the inbox: IMAP over TLS, same login.
    const imapOn = input.imapOn !== false;
    const imapHost = clean(input.imapHost, 253).toLowerCase() || imapHostFor(host);
    const imapPort = Number(input.imapPort) || 993;
    if (imapOn && !HOST.test(imapHost) && !(this.allowInsecure && imapHost === '127.0.0.1')) return { ok: false, error: 'Enter the IMAP server for replies (e.g. imap.gmail.com), or turn reading replies off.' };
    if (imapOn && (!Number.isInteger(imapPort) || imapPort < 1 || imapPort > 65535)) return { ok: false, error: 'Enter the IMAP port (993).' };
    const dup = this.raw().find((a) => a.id !== existing?.id && a.name.toLowerCase() === name.toLowerCase());
    if (dup) return { ok: false, error: `An account named “${name}” already exists.` };
    return { ok: true, account: { name, senderName: senderName || name, email, host, port, username, encryption, imapOn, imapHost, imapPort }, password };
  }

  add(input) {
    if (this.raw().length >= 50) return { ok: false, error: 'Up to 50 email accounts.' };
    const v = this.validate(input || {});
    if (!v.ok) return v;
    const account = { id: crypto.randomBytes(6).toString('hex'), ...v.account, status: 'untested', statusDetail: '', testedAt: null, createdAt: this.now() };
    this.vault.set(`smtp:${account.id}`, v.password);
    this.write([...this.raw(), account]);
    return { ok: true, account: this.public(account), persistent: this.vault.persistent };
  }

  // A blank password keeps the saved one.
  update(id, input) {
    const existing = this.get(id);
    if (!existing) return { ok: false, error: 'That email account no longer exists.' };
    const v = this.validate(input || {}, existing);
    if (!v.ok) return v;
    const changed = ['host', 'port', 'username', 'encryption'].some((k) => existing[k] !== v.account[k]) || Boolean(v.password);
    const account = { ...existing, ...v.account, ...(changed ? { status: 'untested', statusDetail: '', testedAt: null } : {}) };
    if (v.password) this.vault.set(`smtp:${id}`, v.password);
    this.transports.delete(id);
    this.write(this.raw().map((a) => (a.id === id ? account : a)));
    return { ok: true, account: this.public(account) };
  }

  remove(id) {
    if (!this.get(id)) return { ok: false, error: 'That email account no longer exists.' };
    this.vault.delete(`smtp:${id}`);
    this.close(id);
    this.write(this.raw().filter((a) => a.id !== id));
    return { ok: true };
  }

  setImapStatus(id, status, detail = '') {
    this.write(this.raw().map((a) => (a.id === id ? { ...a, imapStatus: status, imapDetail: detail, imapCheckedAt: this.now() } : a)));
  }

  // The login for reading the inbox (main process only): { account, pass } or null.
  inbox(id) {
    const a = this.get(id);
    const pass = a && this.vault.get(`smtp:${id}`);
    if (!a || !pass || a.imapOn === false) return null;
    return { account: { ...a, imapHost: a.imapHost || imapHostFor(a.host), imapPort: a.imapPort || 993 }, pass };
  }

  setStatus(id, status, detail = '') {
    this.write(this.raw().map((a) => (a.id === id ? { ...a, status, statusDetail: detail, testedAt: this.now() } : a)));
  }

  transport(id) {
    const a = this.get(id);
    if (!a) throw Object.assign(new Error('That email account no longer exists.'), { code: 'no_account' });
    const pass = this.vault.get(`smtp:${id}`);
    if (!pass) throw Object.assign(new Error('The password of this email account is not saved on this computer. Edit the account and enter it again.'), { code: 'no_password' });
    const key = JSON.stringify([a.host, a.port, a.username, a.encryption, crypto.createHash('sha256').update(pass).digest('hex')]);
    const cached = this.transports.get(id);
    if (cached?.key === key) return { account: a, transport: cached.transport };
    cached?.transport.close?.();
    const transport = this.createTransport(transportOptions(a, pass, { allowInsecure: this.allowInsecure }));
    this.transports.set(id, { key, transport });
    return { account: a, transport };
  }

  close(id) {
    this.transports.get(id)?.transport.close?.();
    this.transports.delete(id);
  }

  // Connects and logs in (sends nothing). { ok, status, error }.
  async test(id) {
    let t;
    try {
      t = this.transport(id);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    try {
      await t.transport.verify();
      this.setStatus(id, 'ok', 'Connected');
      return { ok: true, account: this.public(this.get(id)) };
    } catch (err) {
      const why = mailError(err);
      this.close(id);
      this.setStatus(id, 'failed', why);
      return { ok: false, error: `Connection failed: ${why}.`, account: this.public(this.get(id)) };
    }
  }

  // Sends one message from the account. Resolves { messageId }.
  async send(id, msg) {
    const { account, transport } = this.transport(id);
    const from = { name: account.senderName || account.name, address: account.email };
    try {
      const info = await transport.sendMail({ from, ...msg });
      if (account.status !== 'ok') this.setStatus(id, 'ok', 'Connected');
      return { messageId: info.messageId || '', accepted: info.accepted || [], rejected: info.rejected || [] };
    } catch (err) {
      const why = mailError(err);
      if (err?.code === 'EAUTH' || why === 'the email server could not be reached') {
        this.close(id);
        this.setStatus(id, 'failed', why);
      }
      const e = new Error(why);
      e.code = err?.code || 'send_failed';
      e.responseCode = err?.responseCode || null;
      throw e;
    }
  }

  dispose() {
    for (const id of [...this.transports.keys()]) this.close(id);
  }
}

module.exports = { EmailAccounts, isEmail, transportOptions, imapHostFor, ENCRYPTIONS };
