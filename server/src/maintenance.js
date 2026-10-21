'use strict';

// Controlled cleanup and usage monitoring. Every step has explicit
// conditions and per-run caps, is logged to maintenance_log, and never
// touches pending applications, licences, devices, trials or customer
// records. Set MAINTENANCE_DRY_RUN=1 to only report what would be removed.

const MB = 1024 * 1024;
const DAY = 86_400_000;

async function runMaintenance({ store, storage, mailer, config, now = () => new Date(), logger = console }) {
  const t = now();
  const report = {};
  const dry = Boolean(config.maintenance?.dryRun);
  const cap = config.maintenance?.maxDeletesPerRun ?? 200;

  const step = async (job, fn) => {
    try {
      report[job] = await fn();
      await store.log(job, true, report[job], t.toISOString()).catch(() => {});
    } catch (err) {
      report[job] = { error: String(err.message).split('\n')[0] };
      logger.error(`[maintenance] ${job} failed: ${report[job].error}`);
      await store.log(job, false, report[job], t.toISOString()).catch(() => {});
    }
  };

  // 1. Database: replay records, spent/expired links, old logs (same
  //    function pg_cron runs hourly).
  await step('cleanup_db', () => (dry ? { dryRun: true } : store.cleanupDb(t.toISOString())));

  // 2. Payment screenshots of approved/cancelled applications, after the
  //    retention period. The application row, plan, dates, message and the
  //    screenshot's size and SHA-256 stay as the payment reference.
  await step('screenshot_retention', async () => {
    const before = new Date(t.getTime() - config.retention.screenshotDays * DAY).toISOString();
    const due = await store.screenshotsDue(before, cap);
    if (dry || !due.length) return { due: due.length, deleted: 0, dryRun: dry || undefined };
    // A Storage error throws (and nothing is marked). Objects that were
    // already gone count as removed: there is nothing left to delete.
    const removed = await storage.remove(due.map((d) => d.screenshot_path));
    const marked = await store.markScreenshotsDeleted(due.map((d) => d.id), t.toISOString());
    return { due: due.length, objectsRemoved: removed.length, marked };
  });

  // 3. Orphaned uploads (no application refers to them), older than a day.
  await step('orphan_uploads', async () => {
    const orphans = await store.orphanObjects(storage.bucket, new Date(t.getTime() - DAY).toISOString(), cap);
    if (dry || !orphans.length) return { found: orphans.length, deleted: 0, dryRun: dry || undefined };
    const removed = await storage.remove(orphans);
    return { found: orphans.length, deleted: removed.length };
  });

  // 4. Usage against the plan limits; email when crossing a threshold.
  await step('usage', async () => {
    const u = await store.usage();
    const out = {
      dbMB: +(u.dbBytes / MB).toFixed(1),
      storageMB: +(u.storageBytes / MB).toFixed(1),
      dbPercent: Math.round((u.dbBytes / (config.usage.dbLimitMB * MB)) * 100),
      storagePercent: Math.round((u.storageBytes / (config.usage.storageLimitMB * MB)) * 100),
      alerts: [],
    };
    for (const [kind, pct, used, limit] of [
      ['database', out.dbPercent, out.dbMB, config.usage.dbLimitMB],
      ['storage', out.storagePercent, out.storageMB, config.usage.storageLimitMB],
    ]) {
      const level = [...config.usage.alertPercents].sort((a, b) => b - a).find((p) => pct >= p) || 0;
      const prev = await store.alertLevel(kind);
      // Alert when a higher threshold is reached, or weekly while above one.
      const stale = prev && t.getTime() - new Date(prev.sent_at).getTime() > 7 * DAY;
      if (level && (!prev || level > prev.level || stale)) {
        if (dry) {
          out.alerts.push(`${kind}:${level}% (dry run, not sent)`);
          continue;
        }
        await mailer.send({
          to: config.adminEmail,
          subject: `Lead Finder: Supabase ${kind} at ${pct}% of the Free Plan limit`,
          text:
            `Supabase ${kind} usage is ${used} MB of ${limit} MB (${pct}%).\n\n` +
            `Automatic cleanup already removes expired links and screenshots older than ${config.retention.screenshotDays} days after a decision. ` +
            `If usage keeps growing, shorten SCREENSHOT_RETENTION_DAYS or upgrade the Supabase plan. Pending applications, subscriptions and customer records are never deleted automatically.`,
        });
        await store.setAlertLevel(kind, level, t.toISOString());
        out.alerts.push(`${kind}:${level}%`);
      } else if (!level && prev && !dry) {
        await store.setAlertLevel(kind, 0, t.toISOString());
      }
    }
    return out;
  });

  logger.log?.(`[maintenance] ${JSON.stringify(report)}`);
  return report;
}

module.exports = { runMaintenance };
