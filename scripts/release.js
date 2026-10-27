'use strict';

// `npm run release`: installers for this operating system in release/.
//   Linux: .deb and .AppImage   Windows: .exe (NSIS)   macOS: .dmg
// Installers can only be built for the OS they run on (CI builds all three;
// see .github/workflows/release.yml). Extra arguments go to electron-builder.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const TARGETS = { linux: ['--linux', 'deb', 'AppImage'], win32: ['--win', 'nsis'], darwin: ['--mac', 'dmg', 'zip'] };

const targets = TARGETS[process.platform];
if (!targets) {
  console.error(`No installer target for ${process.platform}.`);
  process.exit(1);
}

// Without the activation secret no plan could be activated in the build.
try {
  if (!require('../src/main/activation-secret.json').secret) throw new Error();
} catch {
  console.error('src/main/activation-secret.json is missing: run `npm run setup` in tools/activation (or set ACTIVATION_SECRET in CI).');
  process.exit(1);
}

const bin = (name) => path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
run(bin('vite'), ['build']);
run(bin('electron-builder'), [...targets, '--publish', 'never', ...process.argv.slice(2)]);
