/**
 * History-delta processing — the heart of the Gmail event plane.
 *
 * A Pub/Sub push notification carries only {emailAddress, historyId}; the
 * actual "what's new" comes from users.history.list(startHistoryId). The
 * per-connection cursor (Watch.lastHistoryId) is the PRIMARY at-least-once
 * mechanism: it advances only after every message in the delta was handled,
 * so a failed pass is retried by the next notification (or the worker's
 * periodic sweep). ProcessedNotification adds message-level idempotency on
 * top, because consecutive deltas overlap (each run re-reads from the last
 * fully-processed cursor).
 */
import { withConnection } from './connectionCall.js';
import type { Db } from './db.js';
import { NotFoundError } from './errors.js';
import type { EmailEvent, EventForwarder } from './events/forwarder.js';
import { logError, logInfo } from './logger.js';
import { normalizeMessage } from './ops/index.js';
import type { GmailProvider } from './providers/gmail/types.js';
import { FOLDER_EVENTS, folderForLabels } from './watches.js';

/** Prisma unique-violation check (P2002). */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

type ConnectionRow = { id: string; mailboxEmail: string };

/**
 * Process one message from a delta: dedupe, fetch, normalize, forward.
 * Returns false when the message must be retried (dedupe row released) —
 * a permanent not_found (message deleted before we fetched it) counts as
 * handled, keeping its dedupe row so the cursor can advance past it.
 */
async function processMessage(
  db: Db,
  provider: GmailProvider,
  forward: EventForwarder,
  connection: ConnectionRow,
  messageId: string,
  folder: keyof typeof FOLDER_EVENTS,
): Promise<boolean> {
  const dedupeId = `${connection.id}:${messageId}`;
  try {
    await db.processedNotification.create({ data: { id: dedupeId } });
  } catch (err) {
    if (isUniqueViolation(err)) return true; // an overlapping delta already handled it
    throw err;
  }

  try {
    const message = await withConnection(db, connection.id, { resource: 'message', id: messageId }, (token) =>
      provider.getMessage(token, messageId),
    );
    const event: EmailEvent = {
      event: FOLDER_EVENTS[folder],
      connectionId: connection.id,
      folder,
      message: normalizeMessage(message),
    };
    logInfo(`${event.event} in ${connection.mailboxEmail}: "${event.message.subject ?? ''}"`);
    await forward(event);
    return true;
  } catch (err) {
    if (err instanceof NotFoundError) {
      // The message vanished between the delta and the fetch (deleted /
      // moved out of scope). Permanent — keep the dedupe row, let the
      // cursor advance.
      logInfo(`message ${dedupeId} disappeared before processing — skipping`);
      return true;
    }
    logError(`failed to process message ${dedupeId} — releasing dedupe for retry`, err);
    await db.processedNotification.delete({ where: { id: dedupeId } }).catch(() => {});
    return false;
  }
}

/**
 * Run the history delta for one connection. `notifiedHistoryId` is the value
 * from the Pub/Sub notification (null on worker sweeps); it only matters
 * when the cursor was never initialized.
 */
export async function processConnectionHistory(
  db: Db,
  provider: GmailProvider,
  forward: EventForwarder,
  connectionId: string,
  notifiedHistoryId: string | null,
): Promise<void> {
  const connection = await db.connection.findUnique({
    where: { id: connectionId },
    include: { watch: true, subscribedFolders: true },
  });
  if (!connection || connection.deletedAt || connection.status !== 'ACTIVE') return;
  const watch = connection.watch;
  if (!watch) return; // no watch registered — nothing to process

  if (watch.lastHistoryId == null) {
    // No baseline yet (legacy row) — adopt the notified id; deltas start
    // from the next notification.
    if (notifiedHistoryId) {
      await db.watch.update({ where: { id: watch.id }, data: { lastHistoryId: notifiedHistoryId } });
    }
    return;
  }

  const startHistoryId = watch.lastHistoryId;
  let delta;
  try {
    delta = await withConnection(db, connection.id, undefined, (token) => provider.listHistory(token, startHistoryId));
  } catch (err) {
    if (err instanceof NotFoundError) {
      // Gmail 404s a startHistoryId that aged out (cursors are only valid
      // for a window). Re-baseline to now; anything in the gap is lost and
      // said so loudly.
      const current = await withConnection(db, connection.id, undefined, (token) => provider.getCurrentHistoryId(token));
      await db.watch.update({ where: { id: watch.id }, data: { lastHistoryId: current } });
      logError(
        `history cursor ${startHistoryId} for ${connection.mailboxEmail} expired — re-baselined to ${current}; events in the gap were not forwarded`,
      );
      return;
    }
    throw err;
  }

  const subscribed = new Set(connection.subscribedFolders.map((f) => f.folder));
  let allHandled = true;
  for (const added of delta.messagesAdded) {
    const folder = folderForLabels(added.labelIds);
    if (!folder || !subscribed.has(folder)) continue;
    const handled = await processMessage(db, provider, forward, connection, added.id, folder);
    if (!handled) allHandled = false;
  }

  // Advance the cursor only when every relevant message was handled — a
  // failed message keeps the cursor back so the next pass retries it.
  if (allHandled && delta.historyId !== watch.lastHistoryId) {
    await db.watch.update({ where: { id: watch.id }, data: { lastHistoryId: delta.historyId } });
  }
}

/**
 * Handle one decoded Pub/Sub notification. Gmail keys notifications by
 * mailbox address; the same address may be connected more than once (two
 * orgs, reconnects) — every active connection for it gets a pass. Failures
 * are logged, never thrown to Express (the push was already acked; the
 * cursor makes the next notification retry).
 */
export async function processPushNotification(
  db: Db,
  provider: GmailProvider,
  forward: EventForwarder,
  emailAddress: string,
  historyId: string,
): Promise<void> {
  const connections = await db.connection.findMany({
    where: { mailboxEmail: emailAddress, deletedAt: null, status: 'ACTIVE' },
    select: { id: true },
  });
  for (const { id } of connections) {
    try {
      await processConnectionHistory(db, provider, forward, id, historyId);
    } catch (err) {
      logError(`history processing failed for connection ${id}`, err);
    }
  }
}
