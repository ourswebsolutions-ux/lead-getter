'use strict';

const { loadConfig } = require('./config');
const { PgStore } = require('./db');
const { StorageClient } = require('./storage');
const { createMailer } = require('./mailer');
const { createApp } = require('./app');
const { runMaintenance } = require('./maintenance');

(async () => {
  const config = loadConfig();
  const store = new PgStore({ connectionString: config.supabase.dbUrl, ca: config.supabase.dbCa, schema: config.supabase.schema });
  const storage = new StorageClient({ url: config.supabase.url, secretKey: config.supabase.secretKey, bucket: config.supabase.bucket });

  // Schema and bucket are created/updated idempotently on start.
  let applied;
  try {
    applied = await store.migrate({ cron: config.supabase.cron });
  } catch (err) {
    if (!config.supabase.cron || !/cron/i.test(err.message)) throw err;
    console.error(`pg_cron could not be scheduled (${err.message.split('\n')[0]}); the server's maintenance job still runs the cleanup.`);
    applied = await store.migrate({ cron: false });
  }
  if (applied.length) console.log(`Database migrations applied: ${applied.join(', ')}`);
  if (await storage.ensureBucket()) console.log(`Created private Storage bucket "${config.supabase.bucket}"`);

  const mailer = createMailer(config);
  const server = createApp({ config, store, storage, mailer });
  server.listen(config.port, config.host, () => {
    console.log(`Lead Finder licence server on http://${config.host}:${config.port} (public URL ${config.publicBaseUrl})`);
    mailer.verify().then(
      () => console.log('SMTP connection OK'),
      (err) => console.error(`SMTP check failed: ${err.code || ''} ${String(err.message).split('\n')[0]}`),
    );
  });

  // Cleanup + usage check shortly after start, then every few hours.
  const maintain = () => runMaintenance({ store, storage, mailer, config }).catch((err) => console.error(`[maintenance] ${err.message}`));
  setTimeout(maintain, 30_000).unref();
  setInterval(maintain, config.maintenance.intervalHours * 3_600_000).unref();
})().catch((err) => {
  console.error(`Startup failed: ${String(err.message).split('\n')[0]}`);
  process.exit(1);
});
