'use strict';

// Secrets (SMTP passwords, the Groq API key) encrypted with the OS keychain
// (Electron safeStorage: Keychain, DPAPI, libsecret/kwallet) and kept in
// app_state as one encrypted blob. Without a keychain they are kept in
// memory for this session only (never written in plain text).
// Values never leave the main process: callers get them only to use them.

class Vault {
  // store: { getState, setState }; key: app_state key; cipher: { encrypt, decrypt } | null.
  constructor({ store, key, cipher }) {
    Object.assign(this, { store, key, cipher });
    this.memory = null;
  }

  get persistent() {
    return Boolean(this.cipher);
  }

  all() {
    if (!this.cipher) return { ...(this.memory || {}) };
    const saved = this.store.getState(this.key);
    if (!saved?.enc) return {};
    try {
      return JSON.parse(this.cipher.decrypt(Buffer.from(saved.enc, 'base64')));
    } catch {
      return {}; // e.g. a database copied from another computer
    }
  }

  write(all) {
    if (!this.cipher) {
      this.memory = all;
      return;
    }
    this.store.setState(this.key, { enc: this.cipher.encrypt(JSON.stringify(all)).toString('base64') });
  }

  get(name) {
    const v = this.all()[name];
    return typeof v === 'string' ? v : null;
  }

  has(name) {
    return Boolean(this.get(name));
  }

  set(name, value) {
    const all = this.all();
    if (value == null || value === '') delete all[name];
    else all[name] = String(value);
    this.write(all);
  }

  delete(name) {
    this.set(name, null);
  }
}

module.exports = { Vault };
