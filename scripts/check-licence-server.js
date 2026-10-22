'use strict';

// Checks that the licence server the app is configured for really answers
// as the Lead Finder licence server:
//   node scripts/check-licence-server.js [server URL]   (npm run check:licence)
// Default URL and public key: src/main/license-config.json (what installers
// use). Steps: /health, the plan list, and one device-signed status request
// whose signed answer must verify with the app's public key (so the server
// also holds the matching signing key). Exit code 0 = usable.

const path = require('node:path');
const { LicenseClient } = require('../src/main/license');

const config = { ...require(path.join(__dirname, '..', 'src', 'main', 'license-config.json')) };
if (process.argv[2]) config.serverUrl = process.argv[2];
if (process.env.LICENSE_PUBLIC_KEY) config.publicKey = process.env.LICENSE_PUBLIC_KEY;

// A throwaway device for this check (in memory; the server only records its
// key, like any other installation's).
const mem = new Map();
const store = { getState: (k) => mem.get(k) ?? null, setState: (k, v) => mem.set(k, v) };
const log = (e) => console.log(`  ${e.event}: ${e.method || ''} ${e.url || ''} ${e.status ? `-> HTTP ${e.status}` : ''} ${e.wwwAuthenticate ? `(asks for login: ${e.wwwAuthenticate})` : ''} ${e.body ? `body: ${e.body.slice(0, 120)}` : e.error || ''}`.replace(/\s+/g, ' '));
const client = new LicenseClient({ store, cipher: null, config, machineId: 'lead-finder-deployment-check', timeoutMs: 30_000, log });

(async () => {
  console.log(`Licence server: ${config.serverUrl}`);
  let ok = true;
  const step = async (name, fn) => {
    try {
      const detail = await fn();
      console.log(`✔ ${name}${detail ? `: ${detail}` : ''}`);
    } catch (err) {
      ok = false;
      console.log(`✘ ${name}: ${err.message}`);
    }
  };
  await step('health', async () => {
    const res = await fetch(client.url('/health'), { signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    if (!res.ok || !/"ok"\s*:\s*true/.test(text)) throw new Error(`HTTP ${res.status}${res.headers.get('www-authenticate') ? ' (asks for a website login)' : ''}: ${text.slice(0, 120)}`);
  });
  await step('plans', async () => (await client.plans()).plans.map((p) => `${p.name} ${p.priceLabel}`).join(', '));
  await step('signed status', async () => {
    const st = await client.status();
    if (['offline', 'misconfigured', 'invalid', 'unconfigured'].includes(st.reason)) throw new Error(st.message);
    return `verified with the app's public key (server time ${st.serverTime})`;
  });
  console.log(ok ? '\nThe licence server is set up correctly.' : '\nThe licence server is NOT usable at this address. Installed apps will not be able to check subscriptions.');
  process.exit(ok ? 0 : 1);
})();
