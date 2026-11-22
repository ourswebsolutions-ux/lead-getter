// Lead Finder click tracking as a Cloudflare Worker (free plan is enough).
//
// 1. Cloudflare dashboard > Storage & Databases > KV > Create a namespace
//    (any name, e.g. lead-finder-clicks).
// 2. Workers & Pages > Create > Worker > Deploy, then Edit code: paste this
//    file in place of the code and Deploy.
// 3. The Worker > Settings > Bindings > Add > KV namespace: variable name
//    CLICKS, the namespace from step 1. Deploy again.
// 4. Optional (best for inbox delivery): Settings > Domains & Routes > add a
//    custom domain of yours, e.g. go.yourdomain.com.
// 5. In Lead Finder (Outreach > Email > Click tracking) enter the Worker's
//    address and press Connect.
//
// The same protocol as index.php: GET ?t&u&s (a click, then a redirect to a
// link signed by your Lead Finder), POST ?a=setup and ?a=poll with key=...
// Clicks are kept 60 days; no IP addresses or cookies are stored.

const KEEP_SECONDS = 60 * 24 * 3600;
const HEADERS = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' };

const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8' } });
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function fromB64url(s) {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}
async function sign(key, text) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text))).slice(0, 22);
}
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export default {
  async fetch(request, env) {
    if (!env.CLICKS) return json(500, { ok: false, error: 'the KV namespace is not bound as CLICKS (Worker > Settings > Bindings)' });
    const url = new URL(request.url);
    const a = url.searchParams.get('a');

    if (a === 'setup' || a === 'poll') {
      if (request.method !== 'POST') return json(405, { ok: false, error: 'POST only' });
      const form = await request.formData().catch(() => null);
      const given = String(form?.get('key') || '');
      if (given.length < 32 || given.length > 128) return json(400, { ok: false, error: 'bad key' });
      let key = await env.CLICKS.get('key');
      if (!key) {
        if (a !== 'setup') return json(403, { ok: false, error: 'not paired' });
        await env.CLICKS.put('key', given);
        key = given;
      }
      if (!same(key, given)) return json(403, { ok: false, error: 'paired with another Lead Finder: delete the "key" entry in the KV namespace to pair again' });
      if (a === 'setup') return json(200, { ok: true, app: 'lead-finder-clicks', version: 1 });
      const since = Number(form.get('since')) || 0;
      const clicks = [];
      let cursor;
      for (let page = 0; page < 10; page++) {
        const r = await env.CLICKS.list({ prefix: 'c:', cursor, limit: 1000 });
        for (const k of r.keys) if (k.metadata && k.metadata.at >= since) clicks.push(k.metadata);
        if (r.list_complete) break;
        cursor = r.cursor;
      }
      clicks.sort((x, y) => x.at - y.at);
      return json(200, { ok: true, clicks: clicks.slice(-5000), now: Date.now() });
    }

    const t = url.searchParams.get('t') || '';
    const u = url.searchParams.get('u') || '';
    const s = url.searchParams.get('s') || '';
    const key = await env.CLICKS.get('key');
    const target = fromB64url(u);
    const valid = key && /^[A-Za-z0-9_-]{4,40}$/.test(t) && target && /^https?:\/\//i.test(target) && same(await sign(key, `${t}|${u}`), s);
    if (!valid) return new Response('Link not found.', { status: 404, headers: { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });

    if (request.method === 'GET') {
      const at = Date.now();
      const id = `${String(at).padStart(13, '0')}-${b64url(crypto.getRandomValues(new Uint8Array(4)))}`;
      // The click is the key's metadata (at most 1024 bytes), so a poll needs only list() calls.
      const click = { id, t, u: target.slice(0, 500), at, ua: (request.headers.get('User-Agent') || '').slice(0, 150) };
      await env.CLICKS.put(`c:${id}`, '', { expirationTtl: KEEP_SECONDS, metadata: click });
    }
    return new Response(null, { status: 302, headers: { ...HEADERS, Location: target } });
  },
};
