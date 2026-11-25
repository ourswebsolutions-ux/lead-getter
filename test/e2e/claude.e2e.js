'use strict';
// Claude in the real app: Settings > AI Integrations > Claude, Claude
// Desktop not found then found, Auto Setup & Connect writing Claude's real
// settings file (other servers kept), the MCP server started exactly from
// that file and driven by the official MCP SDK client as Claude Desktop
// does: lead searches by country and city from the real database, a lead
// in full, a report, Allow / Don't allow for a settings change, the PIN
// lock, Lead Finder closed and opened again, and Disconnect.
// Claude's home folder is a scratch one (LEAD_FINDER_TEST_CLAUDE_HOME; HOME
// for an installed app, LEAD_FINDER_EXE). An installed app shows the real
// Allow window, so that part runs from source only; instead, Claude opening
// Lead Finder when it is closed is checked (the installed program starts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { LeadStore } = require('../../src/database/db');
const { unlock, activationEnv } = require('./helpers');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const root = path.join(__dirname, '..', '..');

function seed(file) {
  const s = new LeadStore(file);
  const c = s.ensureCategory('Commercial Cleaning');
  s.save({ placeKey: '0x1:0x7', mapsUrl: 'https://www.google.com/maps/place/E1', name: 'Evolve Commercial Cleaning Preston', address: 'Unit 4, Church St, Preston PR1 3BQ, United Kingdom', websiteStatus: 'no_website', categoryId: c.id });
  s.save({ placeKey: '0x2:0x7', mapsUrl: 'https://www.google.com/maps/place/E2', name: 'Sparkle Cleaners Lahore', phoneRaw: '03001234567', address: 'Plot 416, Block A1 Gulberg III, Lahore, 54000, Pakistan', websiteStatus: 'no_website', categoryId: c.id });
  s.save({ placeKey: '0x3:0x7', mapsUrl: 'https://www.google.com/maps/place/E3', name: 'Shine Karachi', phoneRaw: '03211234567', address: 'Shahrah-e-Faisal, Karachi, Pakistan', websiteStatus: 'no_website', categoryId: c.id });
  const evolve = s.listLeads({}).find((l) => l.name.startsWith('Evolve'));
  s.saveLeadEmails(evolve.id, { emails: ['hello@evolveclean.co.uk'] });
  s.close();
}

test('Claude Desktop integration in the app, end to end', { timeout: 600_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-claude-e2e-'));
  const userData = path.join(tmp, 'ud');
  const home = path.join(tmp, 'home');
  const answer = path.join(tmp, 'answer');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(answer, 'deny');
  seed(path.join(userData, 'leads.db'));
  const env = { ...process.env, ...activationEnv, LEAD_FINDER_USER_DATA: userData, LEAD_FINDER_NO_UPDATES: '1', LEAD_FINDER_TEST_CLAUDE_HOME: home, LEAD_FINDER_TEST_CLAUDE_CONFIRM: answer };
  delete env.ELECTRON_RUN_AS_NODE;
  const exe = process.env.LEAD_FINDER_EXE;
  if (exe) {
    env.HOME = home;
    delete env.XDG_CONFIG_HOME;
  }
  const launch = () => _electron.launch(exe ? { executablePath: exe, args: [], env } : { args: [root], cwd: root, env });
  let app = await launch();
  const clients = [];
  t.after(async () => {
    for (const c of clients) await c.close().catch(() => {});
    await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  let win = await app.firstWindow();
  await unlock(win);

  const openClaude = async () => {
    await win.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Settings' }).click();
    await win.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'AI Integrations', exact: true }).click();
    await win.getByRole('tab', { name: 'Claude' }).click();
  };
  const pill = () => win.locator('.cl-pill');

  // --- Claude Desktop not installed: clear message, download link, no setup.
  await openClaude();
  await win.getByText('Not found on this computer').waitFor();
  await win.getByRole('button', { name: 'Download Claude' }).waitFor();
  assert.equal(await pill().textContent(), 'Not connected');
  assert.equal(await win.getByRole('button', { name: 'Auto Setup & Connect' }).isDisabled(), true);

  // --- Claude Desktop installed (its settings folder, with the user's own settings and another server).
  const configFile = path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const theirs = { preferences: { quickEntryShortcut: 'off' }, mcpServers: { filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', home] } } };
  fs.writeFileSync(configFile, JSON.stringify(theirs, null, 2));
  await win.getByRole('tab', { name: 'Groq & OpenRouter' }).click();
  await win.getByRole('tab', { name: 'Claude' }).click();
  await win.getByText('Installed on this computer').waitFor();

  // --- Auto Setup & Connect.
  await win.getByRole('button', { name: 'Auto Setup & Connect' }).click();
  await win.getByText('Lead Finder is set up in Claude and checked.').waitFor({ timeout: 60_000 });
  await win.locator('.cl-step', { hasText: /Set up and checked .* tools/ }).waitFor();
  assert.equal(await pill().textContent(), 'Connecting', 'not "Connected" until Claude itself connects');
  await win.getByText('Last step: restart Claude Desktop.').waitFor();
  const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.deepEqual(cfg.preferences, theirs.preferences);
  assert.deepEqual(cfg.mcpServers.filesystem, theirs.mcpServers.filesystem);
  const entry = cfg.mcpServers['lead-finder'];
  assert.equal(entry.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(entry.args[0], path.join(userData, 'claude', 'lead-finder-mcp.cjs'));
  assert.ok(fs.existsSync(entry.args[0]), 'the MCP server file is in the data folder');
  assert.ok(fs.existsSync(entry.command), 'Claude starts an existing program');
  // Repeating it changes nothing and adds no duplicate.
  await win.getByRole('button', { name: 'Reconnect' }).click();
  await win.getByText('Lead Finder is set up in Claude and checked.').or(win.getByText('Lead Finder is connected to Claude.')).waitFor({ timeout: 60_000 });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(configFile, 'utf8')).mcpServers), ['filesystem', 'lead-finder']);

  // --- Claude Desktop starts the server from its settings file.
  const asClaude = async () => {
    const e = JSON.parse(fs.readFileSync(configFile, 'utf8')).mcpServers['lead-finder'];
    const client = new Client({ name: 'claude-ai', version: '0.14.0' });
    // An installed app started by Claude uses this test's data folder.
    const cleanEnv = { ...process.env, ...(exe ? { LEAD_FINDER_USER_DATA: userData, HOME: home } : {}), ...e.env };
    await client.connect(new StdioClientTransport({ command: e.command, args: e.args, env: cleanEnv, stderr: 'pipe' }));
    clients.push(client);
    return client;
  };
  const claude = await asClaude();
  const call = async (name, args = {}) => {
    const r = await claude.callTool({ name, arguments: args });
    return { isError: r.isError, ...JSON.parse(r.content[0].text) };
  };
  const names = (await claude.listTools()).tools.map((x) => x.name);
  for (const n of ['search_leads', 'get_lead', 'lead_report', 'get_status', 'find_leads', 'list_campaigns', 'list_replies', 'read_conversation', 'update_email_campaign', 'start_campaign', 'delete_leads', 'update_settings']) assert.ok(names.includes(n), `${n} is offered`);
  await win.getByText('Claude Desktop connected now').waitFor({ timeout: 20_000 });
  assert.equal(await pill().textContent(), 'Connected');

  const uk = await call('search_leads', { country: 'United Kingdom' });
  assert.deepEqual(uk.leads.map((l) => l.name), ['Evolve Commercial Cleaning Preston']);
  assert.equal(uk.leads[0].city_or_area, 'Preston');
  assert.deepEqual((await call('search_leads', { city: 'Lahore' })).leads.map((l) => l.name), ['Sparkle Cleaners Lahore']);
  assert.deepEqual((await call('search_leads', { country: 'PK', has_email: false })).total, 2);
  const lead = await call('get_lead', { lead_id: uk.leads[0].id });
  assert.equal(lead.lead.email, 'hello@evolveclean.co.uk');
  assert.equal(lead.writing_facts.category, 'Commercial Cleaning');
  const report = await call('lead_report', { category: 'commercial cleaning' });
  assert.deepEqual(report.by_country, { Pakistan: 2, 'United Kingdom': 1 });
  assert.equal(report.with_email, 1);
  const status = await call('get_status');
  assert.equal(status.leads.total, 3);
  assert.ok(!JSON.stringify(status).match(/pass(word)?["']?\s*:/i), 'no passwords');
  const bad = await call('search_leads', { limit: 5000 });
  assert.equal(bad.isError, true);
  assert.match(bad.error, /limit must be at most 100/);

  if (exe) {
    assert.ok(entry.args.includes('--app'), 'Claude can open the installed Lead Finder');
    if (process.env.APPIMAGE_FILE) assert.equal(entry.command, process.env.APPIMAGE_FILE, 'an AppImage is started from its own file, not its temporary folder');
  }

  // --- A settings change: Don't allow, then Allow (from source: the real window cannot be clicked here).
  if (!exe) {
  const notif = async () => (await win.evaluate(() => window.leadFinder.automationGet())).notifications;
  const before = await notif();
  const no = await call('update_settings', { notifications: !before });
  assert.equal(no.isError, true);
  assert.match(no.error, /did not allow/);
  assert.equal(await notif(), before, 'nothing changed');
  fs.writeFileSync(answer, 'allow');
  const yes = await call('update_settings', { notifications: !before });
  assert.equal(yes.allowed_by_user, true);
  assert.equal(await notif(), !before);
  await win.locator('.cl-recent-row', { hasText: 'Update settings' }).first().waitFor();
  await win.locator('.cl-recent-row', { hasText: 'Not allowed' }).first().waitFor();
  }

  // --- Locked with the PIN: Claude gets nothing.
  await win.evaluate(() => window.leadFinder.lockNow());
  const locked = await call('search_leads', {});
  assert.match(JSON.stringify(locked), /locked with its PIN/);
  assert.equal(locked.leads, undefined);
  await win.reload();
  await unlock(win, '1357', { plan: null });

  // --- Lead Finder closed: from source Claude is told; an installed Lead
  // Finder is opened by Claude (locked until the PIN). Opened again: it works again (new key).
  await app.close();
  assert.ok((await claude.listTools()).tools.length > 50, 'the tool list is still there');
  const closed = await call('get_status');
  if (!exe) assert.match(closed.error, /not open on this computer/);
  else {
    assert.match(closed.error, /locked with its PIN/, 'Claude started Lead Finder');
    const pid = JSON.parse(fs.readFileSync(path.join(userData, 'claude', 'link.json'), 'utf8')).pid;
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    process.kill(pid);
    for (let i = 0; i < 80 && alive(); i++) await new Promise((r) => setTimeout(r, 250));
    if (alive()) process.kill(pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 1000));
  }
  app = await launch();
  win = await app.firstWindow();
  await unlock(win, '1357', { plan: null });
  const back = await call('get_status');
  assert.equal(back.leads.total, 3);
  await openClaude();
  assert.equal(await pill().textContent(), 'Connected');

  // --- Disconnect: Lead Finder's entry removed, everything else kept.
  await win.getByRole('button', { name: 'Disconnect' }).click();
  await win.getByText('Lead Finder was removed from Claude.').waitFor();
  assert.equal(await pill().textContent(), 'Not connected');
  const left = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.deepEqual(left.mcpServers, theirs.mcpServers);
  assert.deepEqual(left.preferences, theirs.preferences);
  const gone = await call('get_status');
  assert.match(JSON.stringify(gone), /not open on this computer|did not accept/);
});
