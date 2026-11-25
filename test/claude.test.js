'use strict';

// Claude integration: Claude Desktop's settings file (kept as it is apart
// from Lead Finder's entry), the private line, input checks, the PIN lock,
// Allow / Don't allow, the lead tools, and the real MCP server (the bundled
// file) driven by the official MCP SDK client, as Claude Desktop does.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFileSync } = require('node:child_process');

const desktop = require('../src/claude/desktop');
const link = require('../src/claude/link');
const { ClaudeHost, check } = require('../src/claude/host');
const { buildClaudeTools, countryOf, leadPlace } = require('../src/claude/tools');
const { LeadStore } = require('../src/database/db');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lf-claude-'));
const BUNDLE = path.join(__dirname, '..', 'dist', 'claude', link.BRIDGE_FILE);
const entry = (dir) => ({ command: '/opt/Lead Finder/lead-finder', args: [path.join(dir, 'claude', link.BRIDGE_FILE), '--data', dir, '--app', '/opt/Lead Finder/lead-finder'], env: { ELECTRON_RUN_AS_NODE: '1' } });

function memState() {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) };
}

test('settings file locations: macOS, Linux, Windows classic and Microsoft Store', () => {
  const home = tmp();
  assert.deepEqual(desktop.locations({ platform: 'darwin', home, env: {} }).configs, [path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')]);
  assert.deepEqual(desktop.locations({ platform: 'linux', home, env: {} }).configs, [path.join(home, '.config', 'Claude', 'claude_desktop_config.json')]);
  assert.deepEqual(desktop.locations({ platform: 'linux', home, env: { XDG_CONFIG_HOME: '/x' } }).configs, [path.join('/x', 'Claude', 'claude_desktop_config.json')]);
  const local = path.join(home, 'Local');
  fs.mkdirSync(path.join(local, 'Packages', 'Claude_pzs8sxrjxfjjc'), { recursive: true });
  fs.mkdirSync(path.join(local, 'Packages', 'Microsoft.Something_1'), { recursive: true });
  const w = desktop.locations({ platform: 'win32', home, env: { APPDATA: path.join(home, 'Roaming'), LOCALAPPDATA: local } });
  assert.deepEqual(w.configs, [path.join(home, 'Roaming', 'Claude', 'claude_desktop_config.json'), path.join(local, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json')]);
  const d = desktop.detect({ platform: 'win32', home, env: { APPDATA: path.join(home, 'Roaming'), LOCALAPPDATA: local } });
  assert.equal(d.installed, true); // the Store package
  assert.equal(desktop.detect({ platform: 'linux', home: tmp(), env: {} }).installed, false);
});

test('setup keeps every other Claude setting and server, avoids duplicates, keeps a backup', () => {
  const dir = tmp();
  const file = path.join(dir, 'Claude', 'claude_desktop_config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = { globalShortcut: 'Ctrl+Space', preferences: { menuBarEnabled: true }, mcpServers: { filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/u'] }, 'Lead Finder old': { command: '/old/lead-finder', args: ['/old/claude/lead-finder-mcp.cjs', '--data', '/old'] } } };
  fs.writeFileSync(file, JSON.stringify(before));
  const e = entry('/data');
  const r = desktop.install([file], e);
  assert.deepEqual(r, [{ file, ok: true, changed: true }]);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.globalShortcut, 'Ctrl+Space');
  assert.deepEqual(after.preferences, before.preferences);
  assert.deepEqual(after.mcpServers.filesystem, before.mcpServers.filesystem);
  assert.deepEqual(after.mcpServers['lead-finder'], e);
  assert.equal(after.mcpServers['Lead Finder old'], undefined, 'an older Lead Finder entry under another name is replaced, not duplicated');
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.lead-finder-backup`, 'utf8')), before);
  // Again: nothing to change.
  assert.equal(desktop.install([file], e)[0].changed, false);
  assert.deepEqual(desktop.inspect([file], e), [{ file, state: 'current' }]);
  assert.equal(desktop.inspect([file], { ...e, command: '/moved' })[0].state, 'outdated');
  // Removing keeps the rest.
  assert.equal(desktop.uninstall([file])[0].changed, true);
  const removed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(removed.mcpServers), ['filesystem']);
  assert.equal(removed.globalShortcut, 'Ctrl+Space');
  assert.equal(desktop.inspect([file], e)[0].state, 'missing');
});

test('a missing settings file is created; a broken one is never touched', () => {
  const dir = tmp();
  const fresh = path.join(dir, 'new', 'Claude', 'claude_desktop_config.json');
  assert.equal(desktop.install([fresh], entry('/d'))[0].ok, true);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(fresh, 'utf8')).mcpServers), ['lead-finder']);
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{ "mcpServers": { "x": 1, } ');
  const r = desktop.install([broken], entry('/d'))[0];
  assert.equal(r.ok, false);
  assert.match(r.error, /mistake/);
  assert.equal(fs.readFileSync(broken, 'utf8'), '{ "mcpServers": { "x": 1, } ');
  assert.equal(fs.existsSync(`${broken}.lead-finder-backup`), false);
});

test('input checks follow each tool’s schema', () => {
  const s = { type: 'object', properties: { id: { type: 'integer', minimum: 1 }, ch: { type: 'string', enum: ['a', 'b'] }, day: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, ids: { type: 'array', items: { type: 'integer' }, maxItems: 2 }, on: { type: 'boolean' } }, required: ['id'], additionalProperties: false };
  assert.equal(check(s, { id: 3 }), null);
  assert.match(check(s, {}), /id is required/);
  assert.match(check(s, { id: 1.5 }), /whole number/);
  assert.match(check(s, { id: 0 }), /at least 1/);
  assert.match(check(s, { id: 1, ch: 'c' }), /one of: a, b/);
  assert.match(check(s, { id: 1, day: '25/11/2026' }), /YYYY-MM-DD/);
  assert.match(check(s, { id: 1, ids: [1, 2, 3] }), /too many/);
  assert.match(check(s, { id: 1, ids: [1, 'x'] }), /ids\[1\] must be a whole number/);
  assert.match(check(s, { id: 1, on: 'yes' }), /true or false/);
  assert.match(check(s, { id: 1, sql: 'DROP TABLE' }), /Unknown field “sql”/);
  assert.match(check(s, []), /must be an object/);
  assert.match(check({ type: 'object', properties: { t: { type: 'string' } } }, { t: 'x'.repeat(20_001) }), /too long/);
});

function hostWith({ locked = false, answer = true, dataDir = tmp() } = {}) {
  const ran = [];
  const asked = [];
  const tools = [
    { name: 'get_status', kind: 'read', description: 'Status.', parameters: { type: 'object', properties: {}, additionalProperties: false }, run: () => ({ ok: true, leads: 3 }) },
    { name: 'pause_campaign', kind: 'config', description: 'Pause.', parameters: { type: 'object', properties: { campaign_id: { type: 'integer' } }, required: ['campaign_id'], additionalProperties: false }, run: (a) => (ran.push(['pause', a.campaign_id]), { ok: true }) },
    { name: 'start_campaign', kind: 'confirm', description: 'Starts sending. Needs the user’s confirmation.', parameters: { type: 'object', properties: { campaign_id: { type: 'integer' } }, required: ['campaign_id'], additionalProperties: false }, describe: (a) => ({ ok: true, summary: `Start campaign ${a.campaign_id}: 40 emails.` }), run: (a) => (ran.push(['start', a.campaign_id]), { ok: true, started: true }) },
  ];
  let isLocked = locked;
  const host = new ClaudeHost({
    dataDir,
    tools: () => tools,
    isLocked: () => isLocked,
    onLocked: () => asked.push('window'),
    confirm: async (q) => {
      asked.push(q.summary);
      return typeof answer === 'function' ? answer(q) : answer;
    },
    state: memState(),
  });
  return { host, ran, asked, unlock: () => (isLocked = false), dataDir };
}

test('tools: read and prepare run at once; sending only after Allow; nothing while locked', async () => {
  const a = hostWith({ answer: false });
  assert.deepEqual(await a.host.call('get_status', {}), { ok: true, leads: 3 });
  assert.deepEqual(await a.host.call('pause_campaign', { campaign_id: 4 }), { ok: true });
  const denied = await a.host.call('start_campaign', { campaign_id: 4 }, { client: { name: 'claude-ai' } });
  assert.equal(denied.ok, false);
  assert.equal(denied.allowed, false);
  assert.match(denied.error, /did not allow this in Lead Finder, so nothing was done: Start campaign 4/);
  assert.deepEqual(a.ran, [['pause', 4]]);
  assert.deepEqual(a.asked, ['Start campaign 4: 40 emails.']);
  assert.match((await a.host.call('start_campaign', { campaign_id: 'all' })).error, /campaign_id must be a whole number/);
  assert.match((await a.host.call('run_sql', {})).error, /no tool called run_sql/);
  assert.equal(a.asked.length, 1, 'bad input is refused before anyone is asked');
  const recent = a.host.status().recent;
  assert.equal(recent[0].tool, 'start_campaign');
  assert.equal(recent[0].allowed, false);
  assert.equal(recent[0].client, 'Claude Desktop');

  const b = hostWith({ answer: true });
  const ok = await b.host.call('start_campaign', { campaign_id: 7 });
  assert.deepEqual(ok, { ok: true, started: true, allowed_by_user: true });
  assert.deepEqual(b.ran, [['start', 7]]);

  const c = hostWith({ locked: true });
  const r = await c.host.call('get_status', {});
  assert.match(r.error, /locked with its PIN/);
  assert.deepEqual(c.asked, ['window']);
  c.unlock();
  assert.equal((await c.host.call('get_status', {})).ok, true);

  // Claude gave up waiting: the window is not shown and nothing runs.
  const d = hostWith({ answer: true });
  const ac = new AbortController();
  ac.abort();
  assert.match((await d.host.call('start_campaign', { campaign_id: 1 }, { signal: ac.signal })).error, /stopped waiting/);
  assert.deepEqual(d.ran, []);
  assert.deepEqual(d.asked, []);
});

test('tool list for Claude: titles, hints, the Allow note', () => {
  const { host } = hostWith();
  const specs = host.specs();
  const start = specs.find((t) => t.name === 'start_campaign');
  assert.equal(start.annotations.destructiveHint, true);
  assert.equal(start.annotations.readOnlyHint, false);
  assert.match(start.description, /^Starts sending\. Lead Finder shows the user a window to allow this; it runs only if they click Allow there\.$/);
  assert.equal(specs.find((t) => t.name === 'get_status').annotations.readOnlyHint, true);
  assert.equal(specs.find((t) => t.name === 'pause_campaign').title, 'Pause campaign');
});

test('the private line: wrong key refused, right key lists and calls', async (t) => {
  const { host, dataDir } = hostWith({ answer: false });
  await host.start();
  t.after(() => host.stop());
  const info = link.readLink(dataDir);
  assert.ok(info.key.length >= 64);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dataDir, 'claude', 'link.json')).mode & 0o077, 0, 'link.json is private');
  const talk = (key, msgs) =>
    new Promise((resolve) => {
      const s = net.connect(info.pipe);
      const got = [];
      link.lines(s, (m) => {
        got.push(m);
        if (got.length === msgs.length) {
          s.destroy();
          resolve(got);
        }
      });
      s.on('close', () => resolve(got));
      s.on('connect', () => msgs.forEach((m) => link.sendLine(s, m)));
    });
  const bad = await talk('nope', [{ type: 'hello', key: 'nope', client: { name: 'x' } }, { id: 1, type: 'list' }]);
  assert.equal(bad[0].ok, false);
  assert.equal(bad.length, 1, 'nothing answered without the key');
  const good = await talk(info.key, [{ type: 'hello', key: info.key, client: { name: 'claude-ai', version: '1' } }, { id: 1, type: 'list' }, { id: 2, type: 'call', name: 'get_status', args: {} }]);
  assert.equal(good[0].ok, true);
  assert.deepEqual(good[1].tools.map((x) => x.name), ['get_status', 'pause_campaign', 'start_campaign']);
  assert.deepEqual(good[2].result, { ok: true, leads: 3 });
  assert.equal(host.status().lastSeen.client, 'Claude Desktop');
  // The tool list is kept for when Lead Finder is closed.
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'claude', 'tools.json'), 'utf8')).tools.length, 3);
});

test('lead tools: country, city, name, email, website; one lead in full; a report', () => {
  const db = new LeadStore(':memory:');
  const cat = db.ensureCategory('Cleaning');
  let n = 0;
  const add = (name, address, { phone = null, email = null, site = 'no_website', url = null } = {}) => {
    n++;
    db.save({ placeKey: `0x${n}:0xa`, mapsUrl: `https://www.google.com/maps/place/A${n}`, name, phoneRaw: phone, address, websiteStatus: site, websiteUrl: url, categoryId: cat?.id ?? null });
    const l = db.listLeads({}).find((x) => x.name === name);
    if (email) db.saveLeadEmails(l.id, { emails: [email] });
    return l;
  };
  add('Evolve Commercial Cleaning Preston', 'Unit 4, Church St, Preston PR1 3BQ, United Kingdom', { email: 'hello@evolveclean.co.uk' });
  add('Sparkle Lahore', 'Plot 416, Block A1 Gulberg III, Lahore, 54000, Pakistan', { phone: '+923001234567', email: 'info@sparkle.pk' });
  add('Shine Karachi', 'Shahrah-e-Faisal, Karachi, Pakistan', { phone: '+923211234567' });
  const tools = Object.fromEntries(buildClaudeTools({ store: db }).map((t) => [t.name, t]));

  assert.deepEqual(countryOf('UK').code, 'GB');
  assert.equal(countryOf('pakistan').code, 'PK');
  assert.equal(countryOf('Narnia'), null);
  assert.equal(leadPlace({ address: 'Unit 4, Church St, Preston PR1 3BQ, United Kingdom' }), 'Preston');
  assert.equal(leadPlace({ address: 'Plot 416, Block A1 Gulberg III, Lahore, 54000, Pakistan' }), 'Lahore');

  const uk = tools.search_leads.run({ country: 'UK' });
  assert.deepEqual(uk.leads.map((l) => l.name), ['Evolve Commercial Cleaning Preston']);
  assert.equal(uk.leads[0].country, 'United Kingdom');
  assert.equal(uk.leads[0].city_or_area, 'Preston');
  assert.deepEqual(tools.search_leads.run({ country: 'PK', has_email: false }).leads.map((l) => l.name), ['Shine Karachi']);
  assert.deepEqual(tools.search_leads.run({ city: 'lahore' }).leads.map((l) => l.name), ['Sparkle Lahore']);
  assert.deepEqual(tools.search_leads.run({ email: '.co.uk' }).leads.map((l) => l.name), ['Evolve Commercial Cleaning Preston']);
  assert.deepEqual(tools.search_leads.run({ business_name: 'shine' }).leads.map((l) => l.name), ['Shine Karachi']);
  assert.equal(tools.search_leads.run({ limit: 1 }).more, true);
  assert.match(tools.search_leads.run({ country: 'Narnia' }).error, /not a country/);

  const id = uk.leads[0].id;
  const full = tools.get_lead.run({ lead_id: id });
  assert.equal(full.lead.email, 'hello@evolveclean.co.uk');
  assert.equal(full.writing_facts.business_name, 'Evolve Commercial Cleaning Preston');
  assert.equal(full.writing_facts.email, 'hello@evolveclean.co.uk');
  assert.match(tools.get_lead.run({ lead_id: 9999 }).error, /no lead with id 9999/);

  assert.equal(tools.search_leads.run({ category: 'cleaning' }).total, 3);
  const rep = tools.lead_report.run({});
  assert.equal(rep.total, 3);
  assert.equal(rep.with_email, 2);
  assert.deepEqual(rep.by_country, { Pakistan: 2, 'United Kingdom': 1 });
  assert.equal(rep.by_city_or_area.Preston, 1);
  assert.equal(rep.email_but_no_website, 2);
  assert.deepEqual(rep.by_category, { Cleaning: 3 });
});

test('the real MCP server (bundled), driven by the MCP SDK client like Claude Desktop', async (t) => {
  if (!fs.existsSync(BUNDLE)) execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-mcp.js')], { stdio: 'ignore' });
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const a = hostWith({ answer: (q) => !/campaign 13/.test(q.summary) });
  await a.host.start();
  t.after(() => a.host.stop());
  const connect = async (dataDir) => {
    const client = new Client({ name: 'claude-ai', version: '0.14.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [BUNDLE, '--data', dataDir], stderr: 'pipe' }));
    return client;
  };
  const client = await connect(a.dataDir);
  t.after(() => client.close());
  assert.equal(client.getServerVersion().name, 'lead-finder');
  assert.match(client.getInstructions(), /clicks Allow/);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name), ['get_status', 'pause_campaign', 'start_campaign']);
  assert.equal(tools[2].annotations.destructiveHint, true);
  const r = await client.callTool({ name: 'get_status', arguments: {} });
  assert.equal(r.isError, false);
  assert.deepEqual(JSON.parse(r.content[0].text), { ok: true, leads: 3 });
  const live = a.host.status().live;
  assert.equal(live.length, 1);
  assert.equal(live[0].client, 'Claude Desktop');
  const allowed = await client.callTool({ name: 'start_campaign', arguments: { campaign_id: 12 } });
  assert.equal(JSON.parse(allowed.content[0].text).allowed_by_user, true);
  const refused = await client.callTool({ name: 'start_campaign', arguments: { campaign_id: 13 } });
  assert.equal(refused.isError, true);
  assert.match(JSON.parse(refused.content[0].text).error, /did not allow/);
  const invalid = await client.callTool({ name: 'pause_campaign', arguments: { campaign_id: '5; rm -rf /' } });
  assert.equal(invalid.isError, true);
  assert.deepEqual(a.ran, [['start', 12]]);

  // Lead Finder closed: the tools Claude saw last are still listed, calls say so.
  await a.host.stop();
  assert.deepEqual((await client.listTools()).tools.map((x) => x.name), ['get_status', 'pause_campaign', 'start_campaign']);
  const closed = await client.callTool({ name: 'get_status', arguments: {} });
  assert.equal(closed.isError, true);
  assert.match(JSON.parse(closed.content[0].text).error, /not open on this computer/);
  // Lead Finder opened again (a new key): the server reconnects by itself.
  await a.host.start();
  const again = await client.callTool({ name: 'get_status', arguments: {} });
  assert.equal(again.isError, false);
});

test('the self-check starts the server the way Claude does and needs Lead Finder to answer', async (t) => {
  if (!fs.existsSync(BUNDLE)) execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-mcp.js')], { stdio: 'ignore' });
  const a = hostWith();
  const e = { command: process.execPath, args: [BUNDLE, '--data', a.dataDir], env: { ELECTRON_RUN_AS_NODE: '1' } };
  const down = await desktop.selfTest(e, { clientName: 'lead-finder-check' });
  assert.equal(down.ok, false);
  assert.match(down.error, /not open/);
  await a.host.start();
  t.after(() => a.host.stop());
  const up = await desktop.selfTest(e, { clientName: 'lead-finder-check' });
  assert.equal(up.ok, true);
  assert.equal(up.tools, 3);
  assert.equal(a.host.status().live.length, 0, 'the check is not counted as Claude');
  const missing = await desktop.selfTest({ ...e, command: '/no/such/program' }, { clientName: 'x' });
  assert.equal(missing.ok, false);
});
