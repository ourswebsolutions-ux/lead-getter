'use strict';
// A licence server store for tests: SQLite file and uploads folder in a
// temporary directory, removed afterwards.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../server/src/store');
const { Uploads } = require('../server/src/uploads');

function testLicenseStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-licence-'));
  const store = new Store(path.join(dir, 'subscriptions.db'));
  return {
    dir,
    store,
    storage: new Uploads(path.join(dir, 'uploads')),
    drop() {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { testLicenseStore };
