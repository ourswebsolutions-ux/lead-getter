'use strict';

// Lead Finder's side of the Claude integration (runs in the app's main
// process). It answers the MCP server (bridge.js) over the private line
// (link.js) with the app's own tools:
//
// - the assistant's tools (ai/tools.js) and the lead tools for Claude
//   (claude/tools.js), each one a call to the same functions the window uses;
// - every input checked against the tool's schema first;
// - nothing while Lead Finder is locked with its PIN;
// - 'read' and 'config' tools run at once (reading, drafts, recipients,
//   pausing), as in the assistant; 'confirm' tools (sending, starting or
//   stopping campaigns, searches, deleting, settings) only after the user
//   clicks Allow in Lead Finder's own window (confirm()). Claude cannot
//   answer that window: its answer is never taken as a yes.
// - no passwords, keys or sessions: no tool returns them, and there is no
//   database, file or shell access.

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const link = require('./link');

const TEST_CLIENT = 'lead-finder-check';
const MAX_RESULT = 400_000;
const RECENT_KEY = 'claude.recent';
const SEEN_KEY = 'claude.lastSeen';

const CLIENT_NAMES = { 'claude-ai': 'Claude Desktop', 'claude-code': 'Claude Code', [TEST_CLIENT]: 'Lead Finder check' };
const clientLabel = (c) => CLIENT_NAMES[c?.name] || c?.name || 'An MCP app';

const titleOf = (name) => name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

// --- input checks (the JSON Schema subset the tools use) ---------------------------

function check(schema, v, at = 'input') {
  if (!schema || typeof schema !== 'object') return null;
  const t = schema.type;
  if (t === 'object') {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return `${at} must be an object.`;
    const props = schema.properties || {};
    for (const k of schema.required || []) if (v[k] === undefined || v[k] === null) return `${at === 'input' ? '' : `${at}.`}${k} is required.`;
    for (const [k, val] of Object.entries(v)) {
      if (!(k in props)) {
        if (schema.additionalProperties === false) return `Unknown field “${k}”. Allowed: ${Object.keys(props).join(', ') || 'none'}.`;
        continue;
      }
      if (val === null || val === undefined) continue;
      const e = check(props[k], val, k);
      if (e) return e;
    }
    return null;
  }
  if (t === 'string') {
    if (typeof v !== 'string') return `${at} must be text.`;
    if (v.length > (schema.maxLength ?? 20_000)) return `${at} is too long (at most ${schema.maxLength ?? 20_000} characters).`;
    if (schema.enum && !schema.enum.includes(v)) return `${at} must be one of: ${schema.enum.join(', ')}.`;
    if (schema.pattern && !new RegExp(schema.pattern).test(v)) return `${at} is not in the expected form${schema.pattern.includes('\\d{4}-') ? ' (YYYY-MM-DD)' : ''}.`;
    return null;
  }
  if (t === 'integer' || t === 'number') {
    if (typeof v !== 'number' || !Number.isFinite(v) || (t === 'integer' && !Number.isInteger(v))) return `${at} must be ${t === 'integer' ? 'a whole number' : 'a number'}.`;
    if (schema.minimum != null && v < schema.minimum) return `${at} must be at least ${schema.minimum}.`;
    if (schema.maximum != null && v > schema.maximum) return `${at} must be at most ${schema.maximum}.`;
    return null;
  }
  if (t === 'boolean') return typeof v === 'boolean' ? null : `${at} must be true or false.`;
  if (t === 'array') {
    if (!Array.isArray(v)) return `${at} must be a list.`;
    if (v.length > (schema.maxItems ?? 1000)) return `${at} has too many items (at most ${schema.maxItems ?? 1000}).`;
    for (let i = 0; i < v.length; i++) {
      const e = check(schema.items, v[i], `${at}[${i}]`);
      if (e) return e;
    }
    return null;
  }
  return null;
}

class ClaudeHost extends EventEmitter {
  // tools(): the tool list ({ name, kind, description, parameters, run, describe? });
  // isLocked(): the PIN lock is on; onLocked(): show the window;
  // confirm({ summary, tool, client, signal }): resolves true only on the user's Allow;
  // state: { get, set } (app_state).
  constructor({ dataDir, tools, isLocked = () => false, onLocked = () => {}, confirm, state, log = () => {}, platform = process.platform, now = () => Date.now() }) {
    super();
    Object.assign(this, { dataDir, getTools: tools, isLocked, onLocked, confirmFn: confirm, state, log, platform, now });
    this.server = null;
    this.conns = new Map();
    this.seq = 0;
    this.asking = Promise.resolve();
  }

  // --- the tool list ---------------------------------------------------------------

  tools() {
    const seen = new Set();
    return this.getTools().filter((t) => t && t.name && !seen.has(t.name) && seen.add(t.name));
  }

  specs() {
    return this.tools().map((t) => ({
      name: t.name,
      title: t.title || titleOf(t.name),
      kind: t.kind,
      description: t.kind === 'confirm' ? `${t.description.replace(/\s*Needs the user’s confirmation\.?$/, '')} Lead Finder shows the user a window to allow this; it runs only if they click Allow there.` : t.description,
      inputSchema: t.parameters || { type: 'object', properties: {} },
      annotations: { title: t.title || titleOf(t.name), readOnlyHint: t.kind === 'read', destructiveHint: t.kind === 'confirm', idempotentHint: t.kind === 'read', openWorldHint: false },
    }));
  }

  // The list the bridge shows Claude when Lead Finder is closed.
  saveSpecs() {
    try {
      link.writePrivate(path.join(link.dirOf(this.dataDir), link.TOOLS_FILE), JSON.stringify({ at: this.now(), tools: this.specs() }));
    } catch (err) {
      this.log(`claude: tool list not saved: ${err.message}`);
    }
  }

  // --- running a tool ----------------------------------------------------------------

  async call(name, args, { client = null, signal = null } = {}) {
    const tool = this.tools().find((t) => t.name === name);
    if (!tool) return { ok: false, error: `Lead Finder has no tool called ${name}.` };
    const input = args == null ? {} : args;
    const bad = check(tool.parameters || { type: 'object' }, input);
    if (bad) return { ok: false, error: `Not done: ${bad}` };
    if (this.isLocked()) {
      this.onLocked();
      return { ok: false, error: 'Lead Finder is locked with its PIN. Ask the user to unlock it in the Lead Finder window, then try again.' };
    }
    const entry = { tool: name, title: tool.title || titleOf(name), kind: tool.kind, client: clientLabel(client), at: this.now() };
    let result;
    if (tool.kind === 'confirm') {
      const desc = await this.safe(() => (tool.describe ? tool.describe(input) : { ok: true, summary: `${titleOf(name)}.` }));
      if (desc.ok === false) return desc;
      const allowed = await this.ask({ summary: desc.summary, tool: name, client, signal });
      entry.summary = desc.summary;
      if (!allowed) {
        result = { ok: false, allowed: false, error: signal?.aborted ? 'Claude stopped waiting, so this was not done.' : `The user did not allow this in Lead Finder, so nothing was done: ${desc.summary}` };
        this.remember({ ...entry, ok: false, allowed: false });
        return result;
      }
      entry.allowed = true;
    }
    result = await this.safe(() => tool.run(input));
    if (tool.kind === 'confirm' && result.ok !== false) result = { ...result, allowed_by_user: true };
    this.log(`claude: ${name} ${result.ok === false ? `failed: ${String(result.error).slice(0, 160)}` : 'done'}`);
    this.remember({ ...entry, ok: result.ok !== false, error: result.ok === false ? String(result.error).slice(0, 200) : undefined });
    const text = JSON.stringify(result);
    if (text.length > MAX_RESULT) return { ok: false, error: 'The answer is too large. Ask for fewer leads (a smaller limit or a narrower filter).' };
    return result;
  }

  // One window at a time; a request Claude gave up on is not asked.
  ask(q) {
    const run = this.asking.then(async () => {
      if (q.signal?.aborted) return false;
      try {
        return (await this.confirmFn(q)) === true;
      } catch (err) {
        this.log(`claude: confirmation failed: ${err.message}`);
        return false;
      }
    });
    this.asking = run.catch(() => {});
    return run;
  }

  async safe(fn) {
    try {
      const r = await fn();
      return r && typeof r === 'object' ? r : { ok: false, error: 'No result.' };
    } catch (err) {
      return { ok: false, error: String(err?.message || err).slice(0, 300) };
    }
  }

  remember(e) {
    const list = this.recent();
    list.unshift(e);
    this.state.set(RECENT_KEY, list.slice(0, 30));
    if (e.client !== CLIENT_NAMES[TEST_CLIENT]) this.state.set(SEEN_KEY, { client: e.client, at: e.at });
    this.emit('change');
  }

  recent() {
    const v = this.state.get(RECENT_KEY);
    return Array.isArray(v) ? v : [];
  }

  // --- the line ------------------------------------------------------------------------

  get listening() {
    return Boolean(this.server?.listening);
  }

  async start() {
    if (this.server) return;
    const dir = link.dirOf(this.dataDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.key = crypto.randomBytes(32).toString('hex');
    this.pipe = link.pipePath(this.dataDir, this.platform);
    // One Lead Finder per data folder (the app's single-instance lock), so
    // a socket left by a crash can be removed.
    if (this.platform !== 'win32') fs.rmSync(this.pipe, { force: true });
    const server = net.createServer((s) => this.accept(s));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.pipe, () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', (err) => this.log(`claude: line error: ${err.message}`));
    if (this.platform !== 'win32') {
      try {
        fs.chmodSync(this.pipe, 0o600);
      } catch {}
    }
    this.server = server;
    link.writePrivate(path.join(dir, link.LINK_FILE), JSON.stringify({ pipe: this.pipe, key: this.key, pid: process.pid }));
    this.saveSpecs();
    this.emit('change');
  }

  async stop() {
    const server = this.server;
    this.server = null;
    for (const c of this.conns.values()) c.socket.destroy();
    this.conns.clear();
    fs.rmSync(path.join(link.dirOf(this.dataDir), link.LINK_FILE), { force: true });
    if (server) await new Promise((r) => server.close(() => r()));
    if (this.platform !== 'win32' && this.pipe) fs.rmSync(this.pipe, { force: true });
    this.emit('change');
  }

  accept(socket) {
    let conn = null;
    const calls = new Map(); // request id -> AbortController
    const timer = setTimeout(() => !conn && socket.destroy(), 5_000);
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(timer);
      for (const c of calls.values()) c.abort();
      if (conn && this.conns.delete(conn.id)) this.emit('change');
    });
    link.lines(socket, async (msg) => {
      if (!conn) {
        if (msg.type !== 'hello' || !link.sameKey(msg.key, this.key)) {
          link.sendLine(socket, { type: 'hello', ok: false, error: 'Lead Finder did not accept this connection. Open Lead Finder > Settings > AI Integrations > Claude and click Reconnect.' });
          socket.end();
          return;
        }
        clearTimeout(timer);
        const client = { name: String(msg.client?.name || 'unknown').slice(0, 60), version: String(msg.client?.version || '').slice(0, 30) };
        conn = { id: ++this.seq, socket, client, since: this.now(), test: client.name === TEST_CLIENT };
        this.conns.set(conn.id, conn);
        if (!conn.test) this.state.set(SEEN_KEY, { client: clientLabel(client), at: this.now() });
        link.sendLine(socket, { type: 'hello', ok: true });
        this.emit('change');
        return;
      }
      const id = msg.id;
      if (msg.type === 'cancel') return calls.get(id)?.abort();
      if (msg.type === 'list') return link.sendLine(socket, { id, ok: true, tools: this.specs() });
      if (msg.type === 'call') {
        const ac = new AbortController();
        calls.set(id, ac);
        const result = await this.call(String(msg.name || ''), msg.args, { client: conn.client, signal: ac.signal });
        calls.delete(id);
        return link.sendLine(socket, { id, ok: true, result });
      }
      link.sendLine(socket, { id, ok: false, error: 'Unknown request.' });
    });
  }

  // Who uses Lead Finder now (Claude Desktop keeps the server running while it is open).
  status() {
    const live = [...this.conns.values()].filter((c) => !c.test).map((c) => ({ client: clientLabel(c.client), since: c.since }));
    return { listening: this.listening, live, lastSeen: this.state.get(SEEN_KEY) || null, recent: this.recent().slice(0, 12) };
  }
}

module.exports = { ClaudeHost, check, clientLabel, TEST_CLIENT };
