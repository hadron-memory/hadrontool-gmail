/**
 * Watch renewal worker.
 *
 * Gmail watches live ≤7 days. Every RENEWAL_INTERVAL the worker re-watches
 * rows expiring inside the lookahead window (re-watching supersedes the old
 * watch server-side and must NOT fast-forward the history cursor — see
 * ensureWatch). A DEAD GRANT (connection_unauthorized) is not retried —
 * withConnection has already marked the connection ERROR, and churning the
 * token endpoint with a dead grant helps nobody. Each watch is isolated:
 * one bad row never aborts the pass.
 *
 * The tick also SWEEPS pending history for every active watch — Pub/Sub
 * pushes are acked before processing, so a delta that failed mid-pass has no
 * redelivery; the sweep (and the cursor, which only advances on success)
 * closes that gap even for mailboxes that go quiet.
 *
 * Finally the tick prunes the dedupe + idempotency ledgers — both grow per
 * processed message / mutating call and are useless after the retention
 * window.
 */
import type { Db } from '../db.js';
import { ConnectionUnauthorizedError } from '../errors.js';
import type { EventForwarder } from '../events/forwarder.js';
import { processConnectionHistory } from '../history.js';
import { logError, logInfo } from '../logger.js';
import type { GmailProvider } from '../providers/gmail/types.js';
import { ensureWatch } from '../watches.js';

const RENEWAL_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
const LOOKAHEAD_MS = 24 * 60 * 60 * 1000; // re-watch what expires within 24h (7-day watch life)
const LEDGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // prune dedupe/idempotency rows after 7 days

/** Re-watch every mailbox whose watch expires inside the lookahead window. */
export async function renewExpiringWatches(db: Db, provider: GmailProvider): Promise<void> {
  const cutoff = new Date(Date.now() + LOOKAHEAD_MS);
  const expiring = await db.watch.findMany({
    where: { expiresAt: { lt: cutoff }, connection: { deletedAt: null, status: 'ACTIVE' } },
    include: { connection: true },
  });
  if (expiring.length === 0) return;
  logInfo(`renewing ${expiring.length} expiring watch(es)`);

  for (const watch of expiring) {
    try {
      await ensureWatch(db, provider, watch.connectionId);
      logInfo(`re-watched mailbox ${watch.connection.mailboxEmail}`);
    } catch (err) {
      if (err instanceof ConnectionUnauthorizedError) {
        // withConnection already marked the connection ERROR; re-watching
        // with the same dead grant would just churn until the user reconnects.
        logError(`grant dead for ${watch.connection.mailboxEmail} — skipping re-watch until reconnect`);
        continue;
      }
      logError(`re-watch failed for ${watch.connection.mailboxEmail}`, err);
    }
  }
}

/** Sweep pending history deltas for every active watch (failure-isolated). */
export async function sweepHistory(db: Db, provider: GmailProvider, forward: EventForwarder): Promise<void> {
  const watches = await db.watch.findMany({
    where: { lastHistoryId: { not: null }, connection: { deletedAt: null, status: 'ACTIVE' } },
    select: { connectionId: true },
  });
  for (const { connectionId } of watches) {
    try {
      await processConnectionHistory(db, provider, forward, connectionId, null);
    } catch (err) {
      if (err instanceof ConnectionUnauthorizedError) continue; // marked ERROR already
      logError(`history sweep failed for connection ${connectionId}`, err);
    }
  }
}

/** Prune dedupe + idempotency rows older than the retention window. */
export async function pruneLedgers(db: Db): Promise<void> {
  const cutoff = new Date(Date.now() - LEDGER_RETENTION_MS);
  const [notifications, idempotency] = await Promise.all([
    db.processedNotification.deleteMany({ where: { processedAt: { lt: cutoff } } }),
    db.idempotencyRecord.deleteMany({ where: { createdAt: { lt: cutoff } } }),
  ]);
  if (notifications.count > 0 || idempotency.count > 0) {
    logInfo(`pruned ${notifications.count} notification + ${idempotency.count} idempotency ledger rows`);
  }
}

/** One worker tick: renewals, history sweep, then ledger pruning — each failure-isolated. */
async function tick(db: Db, provider: GmailProvider, forward: EventForwarder): Promise<void> {
  await renewExpiringWatches(db, provider).catch((err) => logError('renewal pass failed', err));
  await sweepHistory(db, provider, forward).catch((err) => logError('history sweep failed', err));
  await pruneLedgers(db).catch((err) => logError('ledger pruning failed', err));
}

/** Start the renewal timer: one pass at boot, then every RENEWAL_INTERVAL. Returns the timer so tests/shutdown can clear it. */
export function startRenewalWorker(db: Db, provider: GmailProvider, forward: EventForwarder): NodeJS.Timeout {
  void tick(db, provider, forward);
  const timer = setInterval(() => {
    void tick(db, provider, forward);
  }, RENEWAL_INTERVAL_MS);
  timer.unref();
  return timer;
}
