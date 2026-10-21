'use strict';

// Automatic updates from GitHub Releases (electron-updater, public repo, no
// token). Checks at launch and every few hours; downloads in the background;
// installs and relaunches by itself, but never while a search is running
// (it waits for the search to finish).
//
//   Windows (NSIS)   silent install, relaunch
//   Linux AppImage   replaces the AppImage, relaunch
//   Linux .deb       dpkg via pkexec/sudo: the system asks for the password
//   macOS            unsigned builds can't be updated in place: the user is
//                    told about the new version and gets a download link
//
// User data lives in the app's userData folder, which installs never touch.

const fs = require('node:fs');
const path = require('node:path');

const RELEASES_URL = 'https://github.com/ourswebsolutions-ux/lead-getter/releases/latest';
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 10_000;
const RESTART_NOTICE_MS = 5_000;

// Network problems are expected (offline, captive portals): retried quietly.
const OFFLINE = /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_CONNECTION|ERR_TIMED_OUT|socket hang up/i;

function packageType(app) {
  if (process.platform !== 'linux') return process.platform;
  if (process.env.APPIMAGE) return 'appimage';
  try {
    return fs.readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8').trim(); // 'deb', written by electron-builder
  } catch {
    return 'unknown';
  }
}

class Updater {
  // isBusy(): true while restarting would interrupt work (a search).
  // send(status): pushes status to the window. log(line): test/diagnostic log.
  constructor({ app, shell, isBusy, send, log = () => {}, loadAutoUpdater = () => require('electron-updater').autoUpdater }) {
    this.app = app;
    this.shell = shell;
    this.isBusy = isBusy;
    this.send = send;
    this.log = log;
    this.loadAutoUpdater = loadAutoUpdater;
    this.type = packageType(app);
    this.manual = process.platform === 'darwin'; // unsigned: notify only
    this.status = { state: 'idle', version: app.getVersion() };
    this.timer = null;
    this.installing = false;
  }

  get supported() {
    return this.app.isPackaged && ['win32', 'darwin', 'appimage', 'deb'].includes(this.type);
  }

  setStatus(next) {
    this.status = { ...this.status, ...next, at: new Date().toISOString() };
    this.log({ event: this.status.state, ...next });
    this.send(this.status);
  }

  start() {
    this.log({ event: 'started', version: this.app.getVersion(), type: this.type });
    if (!this.supported) return this.setStatus({ state: 'unsupported' });
    const u = (this.u = this.loadAutoUpdater());
    u.autoDownload = !this.manual;
    u.autoInstallOnAppQuit = !this.manual;
    u.allowPrerelease = false;
    u.allowDowngrade = false;
    u.logger = { info: (m) => this.log({ event: 'log', m: String(m) }), warn: (m) => this.log({ event: 'warn', m: String(m) }), error: (m) => this.log({ event: 'log-error', m: String(m) }), debug() {} };

    u.on('checking-for-update', () => this.setStatus({ state: 'checking', error: null }));
    u.on('update-not-available', () => this.setStatus({ state: 'current', available: null }));
    u.on('update-available', (info) =>
      this.setStatus(this.manual ? { state: 'available', available: info.version, url: RELEASES_URL } : { state: 'downloading', available: info.version, percent: 0 }),
    );
    u.on('download-progress', (p) => this.setStatus({ state: 'downloading', percent: Math.round(p.percent || 0) }));
    u.on('update-downloaded', (info) => {
      this.setStatus({ state: 'ready', available: info.version });
      this.installWhenIdle();
    });
    u.on('error', (err) => {
      const raw = String(err?.message || err);
      const message = /\b404\b/.test(raw) ? 'no published release could be read (HTTP 404)' : raw.split('\n')[0].trim();
      // The installed version keeps running; the next check retries.
      this.installing = false;
      this.setStatus(OFFLINE.test(message) ? { state: 'offline', error: null } : { state: 'error', error: message });
    });

    setTimeout(() => this.check(), FIRST_CHECK_MS).unref?.();
    this.timer = setInterval(() => this.check(), CHECK_EVERY_MS);
    this.timer.unref?.();
  }

  async check() {
    // Nothing to check while an update is downloading or already downloaded
    // (ready, waiting for a search, restarting).
    if (!this.u || this.installing || ['downloading', 'ready', 'waiting', 'restarting'].includes(this.status.state)) return;
    try {
      await this.u.checkForUpdates();
    } catch (err) {
      // Also reported through the 'error' event; nothing else to do.
      this.log({ event: 'check-failed', m: String(err?.message || err) });
    }
  }

  // Called when a search ends, so a waiting update can go ahead.
  idle() {
    if (this.status.state === 'waiting') this.installWhenIdle();
  }

  installWhenIdle() {
    if (this.manual || this.installing) return;
    if (this.isBusy()) return this.setStatus({ state: 'waiting' });
    this.installing = true;
    this.setStatus({ state: 'restarting' });
    // A short notice in the window, then install and relaunch. The app's
    // normal quit handler closes Chrome automation, WhatsApp and the database.
    setTimeout(() => {
      if (this.isBusy()) {
        this.installing = false;
        return this.setStatus({ state: 'waiting' });
      }
      try {
        this.u.quitAndInstall(true, true);
      } catch (err) {
        this.installing = false;
        this.setStatus({ state: 'error', error: String(err?.message || err) });
      }
      // On Linux the install runs before quitting; if it was refused (e.g.
      // the password prompt was cancelled) the app is still running.
      setTimeout(() => {
        if (this.installing && this.status.state === 'restarting') {
          this.installing = false;
          this.setStatus({ state: 'ready', error: 'The update was not installed. It will be tried again when you quit Lead Finder.' });
        }
      }, 60_000).unref?.();
    }, RESTART_NOTICE_MS);
  }

  openDownload() {
    if (this.status.url) this.shell.openExternal(this.status.url);
    return { ok: Boolean(this.status.url) };
  }
}

// Update log as JSON lines: <userData>/update.log (kept under ~256 KB), or
// LEAD_FINDER_UPDATE_LOG=<file> for tests. For support and diagnostics.
function fileLog(file) {
  if (!file) return () => {};
  return (entry) => {
    try {
      if (fs.statSync(file, { throwIfNoEntry: false })?.size > 256 * 1024) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...entry })}\n`);
    } catch {}
  };
}

module.exports = { Updater, fileLog, packageType, RELEASES_URL };
