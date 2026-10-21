'use strict';

// Supabase Storage through its REST API, with the secret (service) key —
// used only by this server. Payment screenshots live in a private bucket.

const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = ['image/png', 'image/jpeg', 'image/webp'];

class StorageClient {
  constructor({ url, secretKey, bucket, fetchImpl = globalThis.fetch }) {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(bucket)) throw new Error('Invalid bucket name');
    this.base = `${url.replace(/\/$/, '')}/storage/v1`;
    this.bucket = bucket;
    this.headers = { apikey: secretKey, authorization: `Bearer ${secretKey}` };
    this.fetch = fetchImpl;
  }

  async call(method, p, { body, type, json } = {}) {
    const res = await this.fetch(`${this.base}${p}`, {
      method,
      headers: { ...this.headers, ...(type ? { 'content-type': type } : {}), ...(json ? { 'content-type': 'application/json' } : {}) },
      body: json ? JSON.stringify(json) : body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Storage ${method} ${p.split('/').slice(0, 3).join('/')} failed: ${res.status} ${text.slice(0, 120)}`);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  // Creates the private bucket if missing (idempotent).
  async ensureBucket() {
    const res = await this.fetch(`${this.base}/bucket/${this.bucket}`, { headers: this.headers, signal: AbortSignal.timeout(30_000) });
    if (res.ok) return false;
    await this.call('POST', '/bucket', { json: { id: this.bucket, name: this.bucket, public: false, file_size_limit: MAX_BYTES, allowed_mime_types: TYPES } });
    return true;
  }

  async upload(objectPath, data, type) {
    await this.call('POST', `/object/${this.bucket}/${objectPath}`, { body: data, type });
  }

  async download(objectPath) {
    const res = await this.call('GET', `/object/authenticated/${this.bucket}/${objectPath}`);
    return Buffer.from(await res.arrayBuffer());
  }

  // Deletes exactly the listed objects (never a prefix or the bucket).
  async remove(paths) {
    if (!paths.length) return [];
    if (paths.some((p) => typeof p !== 'string' || !p.startsWith('applications/') || p.includes('..'))) throw new Error('Refusing to delete an unexpected path');
    const res = await this.call('DELETE', `/object/${this.bucket}`, { json: { prefixes: paths } });
    return (await res.json()).map((o) => o.name);
  }

  // Test helper only: deletes the listed objects, then the (test) bucket.
  // Refuses any bucket that is not a test bucket.
  async dropTestBucket(objectNames) {
    if (!/^lf-test-[0-9a-f]{8}$/.test(this.bucket)) throw new Error('refusing to drop a non-test bucket');
    for (let i = 0; i < objectNames.length; i += 100) {
      await this.call('DELETE', `/object/${this.bucket}`, { json: { prefixes: objectNames.slice(i, i + 100) } });
    }
    await this.call('DELETE', `/bucket/${this.bucket}`);
  }
}

module.exports = { StorageClient };
