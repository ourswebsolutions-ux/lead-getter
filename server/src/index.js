'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./config');
const { Store } = require('./store');
const { Uploads } = require('./uploads');
const { createMailer } = require('./mailer');
const { createApp } = require('./app');
const { AxoraClient } = require('./axora');

try {
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const store = new Store(path.join(config.dataDir, 'subscriptions.db'));
  const storage = new Uploads(path.join(config.dataDir, 'uploads'));
  const mailer = createMailer(config);
  const axora = config.subscriptionApi ? new AxoraClient(config.subscriptionApi) : null;
  const server = createApp({ config, store, storage, mailer, axora });
  server.listen(config.port, config.host, () => {
    console.log(`Lead Finder licence server on http://${config.host}:${config.port} (public URL ${config.publicBaseUrl})`);
    console.log(axora ? `Subscriptions decided by ${config.subscriptionApi.baseUrl}` : 'Subscriptions decided by this server (SUBSCRIPTION_API_TOKEN not set)');
    mailer.verify().then(
      () => console.log('SMTP connection OK'),
      (err) => console.error(`SMTP check failed: ${err.code || ''} ${String(err.message).split('\n')[0]}`),
    );
  });
} catch (err) {
  console.error(`Startup failed: ${String(err.message).split('\n')[0]}`);
  process.exit(1);
}
