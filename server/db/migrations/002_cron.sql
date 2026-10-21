-- Hourly database cleanup inside Supabase (pg_cron), independent of the
-- licence server being up. Storage objects are handled by the server's
-- maintenance job, because they must be deleted through the Storage API.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('__SCHEMA__-cleanup-db', '17 * * * *', 'select __SCHEMA__.cleanup_db()');
