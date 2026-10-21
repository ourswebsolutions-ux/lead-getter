'use strict';

// Axora Subscription Management API (subscription.axorawebsolutions.com,
// docs/API.md there). Its routes need the site's admin API token, so they are
// called only from this server; the desktop app never sees the token. The
// app's Device ID (case-sensitive) is the user ID there.

class AxoraUnavailable extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

class AxoraClient {
  constructor({ baseUrl, token, timeoutMs = 10_000, fetchImpl = globalThis.fetch }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async call(method, path, body) {
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new AxoraUnavailable(`subscription website unreachable (${err.name === 'TimeoutError' ? 'timeout' : err.cause?.code || err.message})`, 'unreachable');
    }
    let data = null;
    try {
      data = await res.json();
    } catch {}
    if (res.ok) return data;
    const code = data?.error?.code || `http_${res.status}`;
    // Errors about this request (not about the website being down) are
    // returned to the caller; everything else means "unavailable".
    if ([400, 404, 409].includes(res.status)) return { error: { status: res.status, code, message: data?.error?.message || '' } };
    throw new AxoraUnavailable(`subscription website answered ${res.status} ${code}`, code);
  }

  // The user's subscription, or null when the Device ID is not registered.
  // `search` also matches ID prefixes and emails, so only an exact ID counts.
  async subscription(deviceId) {
    const data = await this.call('GET', `/users?search=${encodeURIComponent(deviceId)}`);
    if (data?.error || !Array.isArray(data?.users)) throw new AxoraUnavailable('subscription website gave an unexpected answer', 'bad_response');
    const user = data.users.find((u) => u.id === deviceId);
    if (!user) return null;
    const s = user.subscription || {};
    return { effectiveStatus: s.effectiveStatus, expiresAt: s.expiresAt ?? null, email: user.email };
  }

  // Adds the device as a website user. The website creates every new user
  // 'inactive'; nothing here activates it. Never deletes or changes an
  // existing user. Result state:
  //   registered    created now (user: the new, inactive user)
  //   exists        this Device ID is already registered
  //   email_in_use  the email belongs to another Device ID (left untouched)
  //   invalid       the website rejected the ID or email (validation_failed)
  async register(deviceId, email) {
    const out = await this.call('POST', '/users', { id: deviceId, email });
    if (!out?.error) return { state: 'registered', user: out.user };
    const known = { user_exists: 'exists', email_exists: 'email_in_use', validation_failed: 'invalid' }[out.error.code];
    if (!known) throw new AxoraUnavailable(`subscription website refused the registration (${out.error.code})`, out.error.code);
    return { state: known, message: out.error.message };
  }

  // Used by the email Approve button (an administrator's decision):
  // registers the device if needed, then activates it until expiresAt
  // (null = lifetime).
  async activate(deviceId, email, expiresAt) {
    const reg = await this.register(deviceId, email);
    if (reg.state === 'email_in_use' || reg.state === 'invalid') return { error: { code: reg.state === 'invalid' ? 'validation_failed' : 'email_exists', message: reg.message } };
    return this.call('PATCH', `/users/${encodeURIComponent(deviceId)}/subscription`, { status: 'active', expiresAt });
  }
}

module.exports = { AxoraClient, AxoraUnavailable };
