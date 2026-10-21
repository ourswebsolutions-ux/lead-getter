'use strict';

// `npm run release`: installers for this operating system in release/.
//   Linux: .deb and .AppImage   Windows: .exe (NSIS)   macOS: .dmg
// Installers can only be built for the OS they run on (CI builds all three;
// see .github/workflows/release.yml).
//
// The installed app talks to the hosted licence server, never to a local one:
//   LICENSE_SERVER_URL   https address of the server (default below)
//   LICENSE_PUBLIC_KEY   its public key (default: src/main/license-config.json)
// Extra arguments go to electron-builder.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const DEFAULT_SERVER = 'https://lead-getter-licence.onrender.com';
const TARGETS = { linux: ['--linux', 'deb', 'AppImage'], win32: ['--win', 'nsis'], darwin: ['--mac', 'dmg'] };

const targets = TARGETS[process.platform];
if (!targets) {
  console.error(`No installer target for ${process.platform}.`);
  process.exit(1);
}

const devConfig = require(path.join(root, 'src/main/license-config.json'));
const serverUrl = (process.env.LICENSE_SERVER_URL || DEFAULT_SERVER).replace(/\/+$/, '');
const publicKey = process.env.LICENSE_PUBLIC_KEY || devConfig.publicKey;
if (!/^https:\/\/[^/]+$/.test(serverUrl)) {
  console.error(`LICENSE_SERVER_URL must be an https:// address with no path (got ${serverUrl}).`);
  process.exit(1);
}

const releaseConfig = path.join(root, 'src/main/release-config.json');
fs.writeFileSync(releaseConfig, `${JSON.stringify({ serverUrl, publicKey }, null, 2)}\n`);
console.log(`Licence server for this build: ${serverUrl}`);

const bin = (name) => path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
try {
  run(bin('vite'), ['build']);
  run(bin('electron-builder'), [...targets, '--publish', 'never', ...process.argv.slice(2)]);
} finally {
  fs.rmSync(releaseConfig, { force: true });
}
