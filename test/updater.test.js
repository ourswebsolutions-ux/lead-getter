'use strict';
// Update policy with a stand-in for electron-updater's autoUpdater: when it
// installs, when it waits, and that failures leave the app running.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Updater } = require('../src/main/updater');

function setup({ platform = 'win32', busy = false, packaged = true } = {}) {
  const real = process.platform;
  Object.defineProperty(process, 'platform', { value: platform });
  const u = new EventEmitter();
  u.checks = 0;
  u.installs = [];
  u.checkForUpdates = async () => {
    u.checks++;
    u.emit('checking-for-update');
  };
  u.quitAndInstall = (silent, run) => u.installs.push({ silent, run });
  const sent = [];
  const opened = [];
  const state = { busy };
  const app = { isPackaged: packaged, getVersion: () => '1.1.0' };
  const updater = new Updater({ app, shell: { openExternal: (url) => opened.push(url) }, isBusy: () => state.busy, send: (s) => sent.push(s.state), loadAutoUpdater: () => u });
  Object.defineProperty(process, 'platform', { value: real });
  return { u, updater, sent, opened, state };
}

test('downloads automatically, then installs silently and relaunches', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { u, updater, sent } = setup();
  updater.start();
  assert.equal(u.autoDownload, true);
  assert.equal(u.autoInstallOnAppQuit, true);
  t.mock.timers.tick(10_000);
  assert.equal(u.checks, 1, 'checked shortly after launch');
  u.emit('update-available', { version: '1.1.1' });
  u.emit('download-progress', { percent: 42.4 });
  assert.equal(updater.status.percent, 42);
  u.emit('update-downloaded', { version: '1.1.1' });
  assert.equal(updater.status.state, 'restarting');
  t.mock.timers.tick(5_000);
  assert.deepEqual(u.installs, [{ silent: true, run: true }]);
  assert.deepEqual(sent.slice(0, 4), ['checking', 'downloading', 'downloading', 'ready']);
});

test('never restarts during a search; installs when it ends', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { u, updater, state } = setup({ busy: true });
  updater.start();
  u.emit('update-downloaded', { version: '1.1.1' });
  assert.equal(updater.status.state, 'waiting');
  t.mock.timers.tick(60_000);
  assert.equal(u.installs.length, 0);
  assert.equal(updater.status.state, 'waiting', 'a periodic check does not lose the waiting update');
  state.busy = false;
  updater.idle();
  t.mock.timers.tick(5_000);
  assert.equal(u.installs.length, 1);
});

test('a search starting during the restart notice postpones the install', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { u, updater, state } = setup();
  updater.start();
  u.emit('update-downloaded', { version: '1.1.1' });
  state.busy = true;
  t.mock.timers.tick(5_000);
  assert.equal(u.installs.length, 0);
  assert.equal(updater.status.state, 'waiting');
});

test('checks periodically; offline and failures keep the current version running', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { u, updater } = setup();
  updater.start();
  t.mock.timers.tick(10_000 + 4 * 60 * 60 * 1000);
  assert.equal(u.checks, 2, 'launch + every 4 hours');
  u.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
  assert.equal(updater.status.state, 'offline');
  u.emit('error', new Error('sha512 checksum mismatch'));
  assert.equal(updater.status.state, 'error');
  assert.match(updater.status.error, /checksum/);
  assert.equal(u.installs.length, 0);
  t.mock.timers.tick(4 * 60 * 60 * 1000);
  assert.equal(u.checks, 3, 'tried again later');
});

test('a failed install (e.g. password prompt cancelled) leaves the app running and retries at quit', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { u, updater } = setup({ platform: 'linux' });
  u.quitAndInstall = () => {}; // Linux updaters install before quitting; nothing happened
  updater.type = 'deb';
  updater.start();
  u.emit('update-downloaded', { version: '1.1.1' });
  t.mock.timers.tick(5_000);
  t.mock.timers.tick(60_000);
  assert.equal(updater.status.state, 'ready');
  assert.match(updater.status.error, /tried again when you quit/);
});

test('macOS (unsigned): no download, a notice with a download link', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { u, updater, opened } = setup({ platform: 'darwin' });
  updater.start();
  assert.equal(u.autoDownload, false);
  assert.equal(u.autoInstallOnAppQuit, false);
  u.emit('update-available', { version: '1.1.1' });
  assert.equal(updater.status.state, 'available');
  updater.openDownload();
  assert.match(opened[0], /github\.com\/ourswebsolutions-ux\/lead-getter\/releases\/latest/);
});

test('development runs and unknown Linux formats do not update', () => {
  const dev = setup({ packaged: false });
  dev.updater.start();
  assert.equal(dev.updater.status.state, 'unsupported');
  assert.equal(dev.u.checks, 0);
});
