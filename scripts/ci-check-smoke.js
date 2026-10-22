'use strict';

// Checks an installed app's smoke report (LEAD_FINDER_SMOKE_TEST) in CI.
//   node scripts/ci-check-smoke.js <report.json> shipped   (as installed)
//   node scripts/ci-check-smoke.js <report.json> server    (pointed at the CI licence server)
// shipped: the app starts, and uses exactly the licence address in
//   src/main/license-config.json; what that address answers is printed
//   (the release workflow checks the production server separately).
// server: plans load and a signed status verifies.

const fs = require('node:fs');
const path = require('node:path');

const [file, mode] = process.argv.slice(2);
const expected = require(path.join(__dirname, '..', 'src', 'main', 'license-config.json')).serverUrl;
let r;
try {
  r = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`No smoke report (${err.message}): the installed app did not start or did not finish.`);
  process.exit(1);
}
const lic = r.licence || {};
console.log(JSON.stringify({ ok: r.ok, error: r.error, version: r.version, packaged: r.packaged, licence: lic }, null, 2));
const fail = (msg) => {
  console.error(`FAILED: ${msg}`);
  process.exit(1);
};
if (!r.ok) fail(`the installed app's checks failed (${r.error || 'see report'})`);
if (!r.packaged) fail('not a packaged build');
if (lic.shippedServerUrl !== expected) fail(`the build carries licence address ${lic.shippedServerUrl}, expected ${expected}`);
if (mode === 'shipped') {
  if (lic.serverUrl !== expected || lic.source !== 'license-config.json') fail(`the installed app uses ${lic.serverUrl} (${lic.source}), expected ${expected} from license-config.json`);
  console.log(Array.isArray(lic.plans) ? `Production licence server: ${lic.plans.length} plans, status ${lic.status}.` : `Production licence server not usable yet: ${lic.plansError}`);
} else if (mode === 'server') {
  if (!Array.isArray(lic.plans) || lic.plans.length !== 3) fail(`plans did not load: ${lic.plansError}`);
  if (['offline', 'misconfigured', 'invalid', 'unconfigured'].includes(lic.status)) fail(`status: ${lic.status} (${lic.statusMessage})`);
  console.log('Installed app + licence server: plans and signed status OK.');
} else fail('mode must be "shipped" or "server"');
