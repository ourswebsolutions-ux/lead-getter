'use strict';
// The real click tracking Worker (server/click-tracker/worker.js) served on
// a local port, with an in-memory stand-in for Cloudflare KV.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

function memoryKV() {
  const m = new Map();
  return {
    map: m,
    async get(k) {
      return m.has(k) ? m.get(k).value : null;
    },
    async put(k, value, opts = {}) {
      m.set(k, { value: String(value), metadata: opts.metadata ? JSON.parse(JSON.stringify(opts.metadata)) : null });
    },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      const names = [...m.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = names.slice(start, start + limit);
      const done = start + limit >= names.length;
      return { keys: page.map((name) => ({ name, metadata: m.get(name).metadata })), list_complete: done, cursor: done ? undefined : String(start + limit) };
    },
  };
}

async function startTracker() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'click-tracker', 'worker.js'), 'utf8');
  const worker = (await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`)).default;
  const env = { CLICKS: memoryKV() };
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    requests.push({ method: req.method, url: req.url });
    const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    const out = await worker.fetch(request, env);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  return { base, env, requests, clicks: () => [...env.CLICKS.map.entries()].filter(([k]) => k.startsWith('c:')).map(([, v]) => v.metadata), close: () => new Promise((r) => server.close(r)) };
}

module.exports = { startTracker, memoryKV };
