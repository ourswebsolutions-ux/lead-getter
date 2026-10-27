'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./config');
const { Store } = require('./store');
const { createMailer } = require('./mailer');
const { createApp } = require('./app');

try {
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const store = new Store(path.join(config.dataDir, 'subscriptions.db'));
  const mailer = createMailer(config);
  const server = createApp({ config, store, mailer });
  server.listen(config.port, config.host, () => {
    console.log(`Lead Finder licence server on http://${config.host}:${config.port} (public URL ${config.publicBaseUrl}, daily allowances in ${config.timezone})`);
    mailer.verify().then(
      () => console.log('SMTP connection OK'),
      (err) => console.error(`SMTP check failed: ${err.code || ''} ${String(err.message).split('\n')[0]}`),
    );
  });
} catch (err) {
  console.error(`Startup failed: ${String(err.message).split('\n')[0]}`);
  process.exit(1);
}
