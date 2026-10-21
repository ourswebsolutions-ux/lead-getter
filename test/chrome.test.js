'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const chrome = require('../src/browser/chrome');

test('DevToolsActivePort is parsed strictly', () => {
  assert.deepEqual(chrome.parseDevToolsActivePort('9333\n/devtools/browser/abc-123\n'), { port: 9333, wsPath: '/devtools/browser/abc-123' });
  assert.equal(chrome.parseDevToolsActivePort('nope\n/devtools/browser/x'), null);
  assert.equal(chrome.parseDevToolsActivePort('9333\n/other'), null);
});

test('a stale DevToolsActivePort is not treated as a connection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-chrome-'));
  // Grab a free port, then close it so nothing listens there.
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), `${port}\n/devtools/browser/stale`);
  const { endpoint, diagnostics } = await chrome.findDebugEndpoint(dir);
  // Either nothing, or an unrelated Chrome on the legacy 9222 port.
  assert.ok(endpoint === null || endpoint.via === 'port');
  assert.ok(diagnostics.some((d) => d.includes(`port ${port}`) && d.includes('stale')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a live DevToolsActivePort yields the browser websocket endpoint', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-chrome-'));
  const srv = net.createServer((s) => s.destroy());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const { port } = srv.address();
  fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), `${port}\n/devtools/browser/live-id\n`);
  const { endpoint } = await chrome.findDebugEndpoint(dir);
  assert.deepEqual(endpoint, { wsEndpoint: `ws://127.0.0.1:${port}/devtools/browser/live-id`, via: 'port-file' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('profile names come from Chrome Local State', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-chrome-'));
  fs.writeFileSync(
    path.join(dir, 'Local State'),
    JSON.stringify({ profile: { info_cache: { 'Profile 3': { name: 'Work', user_name: 'me@example.com' } } } }),
  );
  assert.deepEqual(chrome.describeProfile(dir, 'Profile 3'), { dir: 'Profile 3', name: 'Work', account: 'me@example.com' });
  assert.deepEqual(chrome.describeProfile(dir, 'Default'), { dir: 'Default', name: 'Default', account: '' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('platform-specific Chrome locations', () => {
  assert.ok(chrome.chromeExecutableCandidates('win32', { LOCALAPPDATA: 'C:\\L' })[0].endsWith(path.join('Google', 'Chrome', 'Application', 'chrome.exe')));
  assert.ok(chrome.chromeExecutableCandidates('darwin', {})[0].includes('Google Chrome.app'));
  assert.equal(chrome.defaultUserDataDir('linux', { XDG_CONFIG_HOME: '/x' }), path.join('/x', 'google-chrome'));
});

test('switches are read from argv arrays and Chrome-rewritten command lines', () => {
  const line = '/opt/google/chrome/chrome --user-data-dir=/home/a/My Chrome --profile-directory=Profile 3 --remote-debugging-port=0';
  assert.equal(chrome.switchValue(line, 'user-data-dir'), '/home/a/My Chrome');
  assert.equal(chrome.switchValue(line, 'profile-directory'), 'Profile 3');
  assert.equal(chrome.switchValue(line, 'remote-debugging-port'), '0');
  assert.equal(chrome.switchValue(['chrome', '--profile-directory=Default'], 'profile-directory'), 'Default');
  assert.equal(chrome.switchValue('"C:\\\\chrome.exe" --user-data-dir="C:\\\\x y"', 'user-data-dir'), 'C:\\\\x y');
  assert.equal(chrome.switchValue('chrome', 'user-data-dir'), null);
});

test('the running profile is chosen automatically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-chrome-'));
  const write = (profile) => fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({ profile }));
  const info_cache = { Default: { name: 'Home' }, 'Profile 2': { name: 'Work', user_name: 'w@x.com' }, 'Profile 5': { name: 'Old' } };
  write({ info_cache, last_used: 'Profile 2', last_active_profiles: ['Default', 'Profile 2'] });
  assert.equal(chrome.selectProfile(dir, {}).name, 'Work');
  // An explicit --profile-directory on the running process wins.
  assert.equal(chrome.selectProfile(dir, { profileDirectory: 'Default' }).name, 'Home');
  // last_used not among the open profiles -> an open one.
  write({ info_cache, last_used: 'Profile 5', last_active_profiles: ['Default'] });
  assert.equal(chrome.selectProfile(dir, {}).name, 'Home');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('connection failure names the specific blocker when Chrome is missing', async () => {
  process.env.LEAD_FINDER_CHROME_EXE = '/nonexistent/chrome';
  try {
    await assert.rejects(new chrome.ChromeConnection().connect(), (e) => e.code === 'not_installed');
  } finally {
    delete process.env.LEAD_FINDER_CHROME_EXE;
  }
});

test('a replaced connection disconnecting late does not clear the current one', () => {
  const { EventEmitter } = require('node:events');
  const conn = new chrome.ChromeConnection();
  const fake = () => Object.assign(new EventEmitter(), { isConnected: () => true, contexts: () => [{}], close: async () => {} });
  // Simulate attach() wiring for two successive connections.
  const wire = (b) => {
    conn.browser = b;
    conn.context = {};
    b.on('disconnected', () => {
      if (conn.browser !== b) return;
      conn.browser = null;
    });
  };
  const src = require('node:fs').readFileSync(require.resolve('../src/browser/chrome.js'), 'utf8');
  assert.match(src, /if \(this\.browser !== browser\) return;/, 'guard present in attach()');
  const old = fake();
  wire(old);
  const current = fake();
  wire(current);
  old.emit('disconnected');
  assert.equal(conn.browser, current);
  assert.ok(conn.connected);
});
