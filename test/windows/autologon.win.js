'use strict';
// Windows only, as an administrator (GitHub's Windows runner): automatic
// sign-in really set in Windows and removed again. Run: node test/windows/autologon.win.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const al = require('../../src/main/windows-autologon');

(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-autologon-'));
  const user = os.userInfo().username;
  const before = await al.status();
  console.log('before', before);
  assert.equal(before.supported, true);
  // Characters that break naive quoting.
  const password = `Lf "test" $x 'y' %PATH% ü ${crypto.randomBytes(6).toString('hex')}`;
  const on = await al.enable({ user, password }, { base });
  console.log('enable', { ok: on.ok, error: on.error });
  assert.equal(on.ok, true, on.error);
  const st = await al.status();
  console.log('after enable', st);
  assert.equal(st.enabled, true);
  assert.equal(st.user, user);
  assert.equal(st.domain, os.hostname());
  assert.equal(st.plainTextPassword, false, 'no DefaultPassword in the registry');
  assert.equal(await al.readSecretForTest(), password, 'the LSA secret is exactly the password');
  assert.deepEqual(fs.readdirSync(path.join(base, 'autologon')), [], 'hand-over files deleted');
  const off = await al.disable({ base, restorePasswordLess: on.passwordLessBefore ?? '' });
  assert.equal(off.ok, true, off.error);
  const st2 = await al.status();
  console.log('after disable', st2);
  assert.equal(st2.enabled, false);
  assert.equal(await al.readSecretForTest(), '<none>', 'the secret is removed');
  // Wrong input never reaches Windows.
  assert.match((await al.enable({ user: '', password: 'x' }, { base })).error, /user name/);
  assert.match((await al.enable({ user, password: '' }, { base })).error, /password/);
  console.log('Windows automatic sign-in: all checks passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
