/**
 * Watch + folder-subscription domain logic — the single home for folder
 * semantics and the Gmail watch recipe, shared by the subscribe route, the
 * renewal worker, and the push handler so none of them can drift.
 *
 * Gmail differs from Graph here: there is AT MOST ONE watch per mailbox
 * (users.watch → the Pub/Sub topic), not one subscription per folder. Which
 * folders produce forwarded events is a tool-side decision recorded in
 * SubscribedFolder rows; the history processor classifies each new message
 * by its labels and forwards only subscribed folders.
 */
import { config } from './config.js';
import { withConnection } from './connectionCall.js';
import type { Db } from './db.js';
import { ValidationError } from './errors.js';
import { logError, logInfo } from './logger.js';
import { FOLDER_TO_LABEL } from './providers/gmail/labels.js';
import type { GmailProvider } from './providers/gmail/types.js';

/**
 * The one registry of folder semantics: which folders can be subscribed AND
 * which normalized event each produces. Adding a folder here is the complete
 * change — the subscribe route validates against the keys and the history
 * processor maps through the values.
 */
export const FOLDER_EVENTS = {
  inbox: 'email.received',
  sentitems: 'email.sent',
} as const;

export type SubscribableFolder = keyof typeof FOLDER_EVENTS;

/** Type guard for the subscribable-folder allow-list. */
export function isSubscribableFolder(folder: string): folder is SubscribableFolder {
  return folder in FOLDER_EVENTS;
}

/** Event-folder precedence: SENT beats INBOX (a self-addressed sent message
 *  carries both — it left this mailbox, so it is `email.sent` here). Keys
 *  must be FOLDER_EVENTS keys; labels come from the one labels.ts registry. */
const CLASSIFICATION_ORDER: SubscribableFolder[] = ['sentitems', 'inbox'];

/**
 * Classify a history-delta message by its Gmail labels, deriving from the
 * FOLDER_EVENTS keys × the labels.ts registry so adding a folder to
 * FOLDER_EVENTS really is the complete change. Drafts are never events;
 * anything unmatched (archived directly, spam, …) is not a folder event.
 */
export function folderForLabels(labelIds: string[]): SubscribableFolder | null {
  if (labelIds.includes(FOLDER_TO_LABEL.drafts)) return null;
  for (const folder of CLASSIFICATION_ORDER) {
    if (isSubscribableFolder(folder) && labelIds.includes(FOLDER_TO_LABEL[folder])) return folder;
  }
  return null;
}

/**
 * Register (or re-register) the mailbox watch and persist the row. Gmail
 * supersedes an existing watch for the same topic automatically, so no
 * explicit stop is needed on re-watch. The history CURSOR is only
 * initialized when absent — a re-watch must NOT fast-forward it, or every
 * message between the last processed delta and the re-watch would be lost.
 */
export async function ensureWatch(
  db: Db,
  provider: GmailProvider,
  connectionId: string,
): Promise<{ expiresAt: Date }> {
  if (!config.pubsubTopic) {
    throw new ValidationError('server', 'PUBSUB_TOPIC is not configured on this service');
  }

  const result = await withConnection(db, connectionId, undefined, (token) =>
    provider.createWatch(token, config.pubsubTopic!),
  );

  const expiresAt = new Date(result.expiresAt);
  const existing = await db.watch.findUnique({ where: { connectionId } });
  if (existing) {
    await db.watch.update({
      where: { connectionId },
      data: {
        expiresAt,
        // Preserve a live cursor; only adopt the watch baseline when the
        // cursor was never set.
        ...(existing.lastHistoryId == null ? { lastHistoryId: result.historyId } : {}),
      },
    });
  } else {
    await db.watch.create({
      data: { connectionId, expiresAt, lastHistoryId: result.historyId },
    });
  }
  logInfo(`watch registered for connection ${connectionId} (expires ${result.expiresAt})`);
  return { expiresAt };
}

/**
 * Subscribe a neutral folder for event forwarding: record the folder row and
 * make sure the mailbox watch exists.
 */
export async function registerFolderSubscription(
  db: Db,
  provider: GmailProvider,
  connectionId: string,
  folder: SubscribableFolder,
): Promise<{ folder: string; expiresAt: Date }> {
  const { expiresAt } = await ensureWatch(db, provider, connectionId);
  await db.subscribedFolder.upsert({
    where: { connectionId_folder: { connectionId, folder } },
    create: { connectionId, folder },
    update: {},
  });
  logInfo(`folder subscription registered: connection ${connectionId} ${folder}`);
  return { folder, expiresAt };
}

/** Best-effort watch teardown (disconnect path) — never throws. */
export async function stopWatchForConnection(db: Db, provider: GmailProvider, connectionId: string): Promise<void> {
  try {
    await withConnection(db, connectionId, undefined, (token) => provider.stopWatch(token));
  } catch (err) {
    logError(`failed to stop watch for connection ${connectionId} (continuing)`, err);
  }
}
