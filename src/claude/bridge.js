'use strict';

// Lead Finder's MCP server for Claude Desktop (official MCP SDK, stdio).
//
// Claude Desktop starts it from its claude_desktop_config.json entry (made
// by Settings > AI Integrations > Claude):
//   <Lead Finder's own program> <data>/claude/lead-finder-mcp.cjs --data <data> --app <program>
// with ELECTRON_RUN_AS_NODE=1, so no separate Node.js is needed.
//
// It holds no data and no tools of its own: every list and call goes to the
// running Lead Finder app over its private line (link.js), where the app's
// own functions answer, the PIN lock applies, and sending, deleting or
// settings changes wait for the user's "Allow" in Lead Finder's window.
// When Lead Finder is closed, a tool call opens it.
//
// Bundled into one file (scripts/build-mcp.js); logs go to stderr only
// (stdout is the MCP channel).

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const link = require('./link');

const VERSION = typeof __LF_VERSION__ === 'string' ? __LF_VERSION__ : '0.0.0'; // eslint-disable-line no-undef
const HELLO_TIMEOUT = 5_000;
const START_WAIT = 60_000;
const CALL_TIMEOUT = 10 * 60_000;

const NOT_RUNNING = 'Lead Finder is not open on this computer and could not be started. Open Lead Finder, then ask again.';

const INSTRUCTIONS = `Lead Finder is the user's lead-generation app on this computer: leads found on Google Maps, Facebook, LinkedIn and podcasts, with WhatsApp and email campaigns, an Inbox of replies, and lead searches.
- Use these tools for every fact about the user's leads, campaigns and replies; never invent numbers, names or results.
- search_leads filters by country, city, category, name, email, website and more; get_lead shows one lead in full; lead_report summarises a list.
- To write outreach for a lead, read it with get_lead (its writing_facts are exactly what is known about it) and write from those facts only. Campaign texts can be saved with update_email_campaign / update_whatsapp_campaign; nothing is sent by preparing.
- Email campaigns can have each email written by Claude (update_email_campaign: ai_write true, writer "claude"; the body is the user's prompt). Then: emails_to_write gives the next emails with each business's facts; write every one following the prompt exactly, and save them with save_written_emails (fix and save again any it refuses). Keep going in batches when the user asks for all of them. Only emails Claude has written are sent.
- Tools that send messages, start or stop campaigns, start searches, delete or change settings show a window in Lead Finder: they run only if the user clicks Allow there. If the result says the user did not allow it, nothing was done.
- Lead Finder may be locked with its PIN: then ask the user to unlock it in the Lead Finder window.`;

const log = (...a) => process.stderr.write(`[lead-finder-mcp] ${a.join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argOf = (argv, name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};

// The line to the app: connected on first use, again after it drops.
class AppLine {
  constructor({ dataDir, appPath, client }) {
    Object.assign(this, { dataDir, appPath, client });
    this.socket = null;
    this.opening = null;
    this.pending = new Map();
    this.seq = 0;
    this.launchedAt = 0;
  }

  // Connected now, or null (Lead Finder closed, or the key is not valid).
  async tryConnect() {
    const info = link.readLink(this.dataDir);
    if (!info) return null;
    return new Promise((resolve) => {
      const s = net.connect(info.pipe);
      let done = false;
      const finish = (v, why) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (!v) {
          if (why) log(why);
          s.destroy();
        }
        resolve(v);
      };
      const timer = setTimeout(() => finish(null, 'Lead Finder did not answer.'), HELLO_TIMEOUT);
      s.on('error', () => finish(null));
      s.on('close', () => {
        finish(null);
        if (this.socket === s) this.dropped();
      });
      link.lines(s, (msg) => {
        if (!done) {
          if (msg.type === 'hello' && msg.ok) {
            this.socket = s;
            finish(s);
          } else {
            this.refusal = typeof msg.error === 'string' ? msg.error : null;
            finish(null, `Lead Finder refused the connection: ${msg.error || 'unknown reason'}`);
          }
          return;
        }
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        p.resolve(msg);
      });
      s.on('connect', () => link.sendLine(s, { type: 'hello', key: info.key, client: this.client(), bridge: VERSION }));
    });
  }

  dropped() {
    this.socket = null;
    for (const [, p] of this.pending) p.resolve({ ok: false, error: 'Lead Finder closed while working on this. It may not have finished: check in Lead Finder, then ask again.' });
    this.pending.clear();
  }

  // Lead Finder's program is started (once in two minutes at most) when it is closed.
  launch() {
    if (!this.appPath || Date.now() - this.launchedAt < 120_000) return false;
    if (!fs.existsSync(this.appPath)) {
      log(`Lead Finder's program is not at ${this.appPath}`);
      return false;
    }
    this.launchedAt = Date.now();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      const child = spawn(this.appPath, [], { detached: true, stdio: 'ignore', env, cwd: path.dirname(this.appPath) });
      child.on('error', (err) => log(`Lead Finder could not be started: ${err.message}`));
      child.unref();
      log('Lead Finder was closed: starting it.');
      return true;
    } catch (err) {
      log(`Lead Finder could not be started: ${err.message}`);
      return false;
    }
  }

  async connected({ start = false } = {}) {
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (!this.opening) {
      this.opening = (async () => {
        this.refusal = null;
        let s = await this.tryConnect();
        if (!s && !this.refusal && start && this.launch()) {
          const until = Date.now() + START_WAIT;
          while (!s && !this.refusal && Date.now() < until) {
            await sleep(1000);
            s = await this.tryConnect();
          }
        }
        return s;
      })().finally(() => {
        this.opening = null;
      });
    }
    return this.opening;
  }

  async request(msg, { start = false, signal, timeout = CALL_TIMEOUT } = {}) {
    const s = await this.connected({ start });
    if (!s) return { ok: false, error: this.refusal || NOT_RUNNING };
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'Lead Finder took too long to answer.' });
      }, timeout);
      const onAbort = () => link.sendLine(s, { type: 'cancel', id });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(m);
        },
      });
      link.sendLine(s, { ...msg, id });
    });
  }
}

// The tools Lead Finder wrote down last time, for when it is closed.
function cachedTools(dataDir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(link.dirOf(dataDir), link.TOOLS_FILE), 'utf8'));
    return Array.isArray(v.tools) ? v.tools : [];
  } catch {
    return [];
  }
}

const mcpTool = (t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations });

function createServer({ dataDir, appPath }) {
  const server = new Server({ name: 'lead-finder', title: 'Lead Finder', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  const client = () => {
    const c = server.getClientVersion();
    return { name: c?.name || 'unknown', version: c?.version || '' };
  };
  const line = new AppLine({ dataDir, appPath, client });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Listing never opens Lead Finder (Claude lists tools each time it starts).
    const r = await line.request({ type: 'list' }, { timeout: 15_000 });
    const tools = r.ok && Array.isArray(r.tools) ? r.tools : cachedTools(dataDir);
    return { tools: tools.map(mcpTool) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = String(req.params.name || '');
    const args = req.params.arguments ?? {};
    const token = req.params._meta?.progressToken;
    // While a window waits for the user's answer in Lead Finder, Claude is
    // told it is still going (so it does not give up on it).
    let n = 0;
    const beat = token != null ? setInterval(() => extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++n, message: 'Working in Lead Finder' } }).catch(() => {}), 10_000) : null;
    try {
      const r = await line.request({ type: 'call', name, args }, { start: true, signal: extra.signal });
      const result = r.ok ? r.result : { ok: false, error: r.error || 'Lead Finder could not do this.' };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: result?.ok === false };
    } finally {
      if (beat) clearInterval(beat);
    }
  });
  return { server, line };
}

async function main(argv = process.argv) {
  const dataDir = argOf(argv, '--data');
  if (!dataDir) {
    log('Missing --data (Lead Finder writes this in Claude Desktop’s settings).');
    process.exit(2);
  }
  const { server } = createServer({ dataDir, appPath: argOf(argv, '--app') });
  await server.connect(new StdioServerTransport());
  // Claude Desktop closing its end ends this process.
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));
  log(`ready (Lead Finder ${VERSION})`);
}

if (require.main === module) {
  main().catch((err) => {
    log(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { createServer, AppLine, INSTRUCTIONS, main };
