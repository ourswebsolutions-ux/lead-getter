'use strict';

// Checks an installed app's smoke report (LEAD_FINDER_SMOKE_TEST) in CI: the
// packaged app started, showed its lock screen, loaded its modules, and its
// own program ran Claude's MCP server, which reached it.
//   node scripts/ci-check-smoke.js <report.json>

const fs = require('node:fs');

const [file] = process.argv.slice(2);
let r;
try {
  r = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`No smoke report (${err.message}): the installed app did not start or did not finish.`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: r.ok, error: r.error, version: r.version, packaged: r.packaged, lockScreen: r.lockScreen, modules: r.modules, claude: r.claude }, null, 2));
const fail = (msg) => {
  console.error(`FAILED: ${msg}`);
  process.exit(1);
};
if (!r.ok) fail(`the installed app's checks failed (${r.error || 'see report'})`);
if (!r.packaged) fail('not a packaged build');
if (r.claude && !r.claude.ok) fail(`Claude's MCP server did not reach the app (${r.claude.error})`);
console.log(`Installed app: started, lock screen shown, modules loaded, ${r.claude?.skipped ? `Claude MCP server check skipped (${r.claude.skipped})` : 'Claude MCP server reached it'}.`);
