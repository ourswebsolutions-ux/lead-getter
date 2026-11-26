'use strict';
// A local stand-in for the Anthropic API (POST /v1/messages, GET
// /v1/models/:id), for tests with the official SDK. `reply(body, req)`
// returns { status, json } or a Messages API response object; every request
// is recorded (body, headers, path).

const http = require('node:http');

function message(content, { model = 'claude-opus-5-5', stop = null, usage = { input_tokens: 10, output_tokens: 20 } } = {}) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  return { id: `msg_${Math.random().toString(36).slice(2, 10)}`, type: 'message', role: 'assistant', model, content: blocks, stop_reason: stop || (blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'), stop_sequence: null, usage };
}

async function startAnthropic(reply) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const send = (status, json) => {
        res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_test' });
        res.end(JSON.stringify(json));
      };
      const key = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (key !== 'sk-ant-test-key-0000000000000000') return send(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      const m = /^\/v1\/models\/([^/?]+)/.exec(req.url);
      if (req.method === 'GET' && m) return send(200, { type: 'model', id: decodeURIComponent(m[1]), display_name: 'Claude', created_at: '2026-01-01T00:00:00Z' });
      if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
        const body = JSON.parse(raw || '{}');
        calls.push({ body, headers: req.headers, path: req.url });
        try {
          const out = await reply(body, req, calls.length);
          if (out && out.status) return send(out.status, out.json);
          return send(200, out);
        } catch (err) {
          return send(500, { type: 'error', error: { type: 'api_error', message: err.message } });
        }
      }
      send(404, { type: 'error', error: { type: 'not_found_error', message: 'not found' } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

const KEY = 'sk-ant-test-key-0000000000000000';
module.exports = { startAnthropic, message, KEY };
