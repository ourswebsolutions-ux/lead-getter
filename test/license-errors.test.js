'use strict';
// How the app reports licence-server problems, and which server installers
// use. Regression tests for "Subscription server error (401)" in the
// installed app: the address answered with another website's login prompt,
// and the app called that "could not be reached".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LicenseClient } = require('../src/main/license');

const config = require('../src/main/license-config.json');

function client(respond, log = []) {
  const mem = new Map();
  const store = { getState: (k) => mem.get(k) ?? null, setState: (k, v) => mem.set(k, v) };
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url: String(url), headers: init.headers || {} });
    return respond(String(url), init);
  };
  const c = new LicenseClient({ store, cipher: null, config: { serverUrl: 'https://example.test/lead-getter', publicKey: config.publicKey }, fetchImpl, machineId: 'test-machine', log: (e) => log.push(e) });
  return { c, seen, log };
}

// What the subscription website answers for any path it protects.
const websiteLogin = () => new Response('Authorization required.', { status: 401, headers: { 'content-type': 'text/plain; charset=utf-8', 'www-authenticate': 'Basic realm="Axora Subscriptions", charset="UTF-8"' } });

test('a website login prompt at the licence address is reported as a misconfigured address, not as a network problem', async () => {
  const { c, seen, log } = client(websiteLogin);
  await assert.rejects(c.plans(), (err) => {
    assert.equal(err.code, 'misconfigured');
    assert.match(err.message, /answered HTTP 401 and asked for a website login: the Lead Finder licence server is not installed there/);
    assert.doesNotMatch(err.message, /could not be reached|internet connection/);
    return true;
  });
  const st = await c.status();
  assert.equal(st.reason, 'misconfigured');
  assert.equal(st.allowed, false);
  assert.equal(st.canSearch, false);
  // The requests went to the configured address, under its path.
  assert.deepEqual(seen.map((s) => s.url.split('?')[0]), ['https://example.test/lead-getter/api/plans', 'https://example.test/lead-getter/api/license']);
  // Diagnostics: address, status, the login challenge and a piece of the body;
  // never the device signature or key.
  assert.equal(log.length, 2);
  assert.deepEqual(
    { url: log[0].url, status: log[0].status, wwwAuthenticate: log[0].wwwAuthenticate, body: log[0].body },
    { url: 'https://example.test/lead-getter/api/plans', status: 401, wwwAuthenticate: 'Basic realm="Axora Subscriptions", charset="UTF-8"', body: 'Authorization required.' },
  );
  const logged = JSON.stringify(log);
  const sig = seen[1].headers['x-lf-sig'];
  assert.ok(sig && !logged.includes(sig), 'the request signature is never logged');
  assert.ok(!logged.includes(seen[1].headers['x-lf-key']), 'the device key is never logged');
});

test('no answer at all is a connection problem', async () => {
  const { c, log } = client(async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  });
  await assert.rejects(c.plans(), (err) => err.code === 'offline' && /could not be reached/.test(err.message));
  assert.equal((await c.status()).reason, 'offline');
  assert.equal(log[0].event, 'network-error');
  assert.equal(log[0].error, 'ENOTFOUND');
});

test('the licence server’s own refusals and failures keep their meaning', async () => {
  let answer = () => Response.json({ error: 'Request time is out of range. Check the computer clock.' }, { status: 401 });
  const { c } = client(() => answer());
  let st = await c.status();
  assert.equal(st.reason, 'offline');
  assert.equal(st.message, 'Request time is out of range. Check the computer clock.');
  answer = () => Response.json({ error: 'Server error' }, { status: 503 });
  st = await c.status();
  assert.match(st.message, /had a problem \(HTTP 503\)/);
  answer = () => Response.json({ error: 'The application could not be sent for approval (email failed). Please try again later.' }, { status: 502 });
  st = await c.status();
  assert.match(st.message, /email failed/, 'a specific message from the server is kept');
  // A 200 that isn't the plan list (e.g. a website's page or JSON).
  answer = () => Response.json({ hello: 'world' });
  await assert.rejects(c.plans(), (err) => err.code === 'misconfigured' && /did not return the plan list/.test(err.message));
  answer = () => new Response('<html>Welcome</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  await assert.rejects(c.plans(), (err) => err.code === 'misconfigured');
});

test('the real plan list still loads', async () => {
  const { c } = client(() => Response.json({ plans: [{ id: 'monthly', name: 'Monthly', priceLabel: 'PKR 3,000' }], paymentMethods: [] }));
  assert.deepEqual((await c.plans()).plans.map((p) => p.priceLabel), ['PKR 3,000']);
});

test('installers use the production licence address; only the dev launcher points at the local server', () => {
  assert.match(config.serverUrl, /^https:\/\/[^/]+\/lead-getter$/, 'https, with the /lead-getter path');
  assert.doesNotMatch(config.serverUrl, /127\.0\.0\.1|localhost/);
  assert.match(config.publicKey, /^MCowBQYDK2VwAyEA[A-Za-z0-9+/=]{44}$/, 'an Ed25519 public key (no private key or token)');
  assert.deepEqual(Object.keys(config).sort(), ['publicKey', 'serverUrl'], 'nothing else (no tokens) is shipped');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  assert.match(main, /process\.env\.LEAD_FINDER_LICENSE_URL \|\| file\.serverUrl/, 'an installed app uses license-config.json unless explicitly overridden');
  const dev = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'dev.js'), 'utf8');
  assert.match(dev, /LEAD_FINDER_LICENSE_URL: licenseUrl/, 'npm run dev points the app at the licence server it started');
  // No admin credential of the subscription website anywhere in the app.
  for (const dir of ['src/main', 'src/renderer', 'src/preload']) {
    for (const f of fs.readdirSync(path.join(__dirname, '..', dir))) {
      const text = fs.readFileSync(path.join(__dirname, '..', dir, f), 'utf8');
      assert.doesNotMatch(text, /SUBSCRIPTION_API_TOKEN|ADMIN_API_TOKEN|Authorization:\s*Bearer/i, `${dir}/${f}`);
    }
  }
});
