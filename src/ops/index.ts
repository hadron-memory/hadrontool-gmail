/**
 * Provider-neutral operations — the spec 002 contract surface.
 *
 * Operation names, input shapes, and error codes follow
 * spec-kits/specs/002-generic-email-tool/contracts/ and are byte-for-byte
 * the hadrontool-ms-exchange contract. hadron-server's emailClient calls
 * POST /ops/<name>; nothing Gmail-specific leaks out of this layer (labels
 * are normalized to folders; even the flag vocabulary is neutral — Gmail has
 * no 'complete' state, so that value gets a typed validation_error, which is
 * exactly why the neutral vocabulary exists).
 *
 * Every operation's input is validated ONCE against its single schema
 * (defineOp parses before the handler runs), then executed through
 * withConnection (src/connectionCall.ts) — the shared load/decrypt/rotate/
 * error-map lifecycle.
 */
import { createHash } from 'crypto';
import { z } from 'zod';
import { withConnection } from '../connectionCall.js';
import { isUniqueViolation, type Db } from '../db.js';
import {
  BodyRequiredError,
  RecipientsRequiredError,
  ValidationError,
  toEmailToolError,
} from '../errors.js';
import { logError } from '../logger.js';
import { UNREAD_LABEL } from '../providers/gmail/labels.js';
import type { GmailMessage, GmailProvider } from '../providers/gmail/types.js';

/** Provider-neutral message shape returned by every read surface. */
export interface EmailMessage {
  id: string;
  conversationId: string | null;
  subject: string | null;
  from: { name: string | null; address: string } | null;
  to: { name: string | null; address: string }[];
  receivedAt: string;
  isRead: boolean;
  snippet: string;
  body: { contentType: string; content: string } | null;
  hasAttachments: boolean;
}

/** Normalize a parsed Gmail message to the neutral shape. */
export function normalizeMessage(m: GmailMessage): EmailMessage {
  return {
    id: m.id,
    conversationId: m.threadId,
    subject: m.subject,
    from: m.from,
    to: m.to,
    receivedAt: m.receivedAt,
    isRead: !m.labelIds.includes(UNREAD_LABEL),
    snippet: m.snippet,
    body: m.body,
    hasAttachments: m.hasAttachments,
  };
}

/** One operation: the single input schema + the handler over parsed input. */
export interface OperationDef {
  mutating: boolean;
  schema: z.ZodType;
  run(db: Db, provider: GmailProvider, input: Record<string, unknown>): Promise<unknown>;
}

/**
 * Define an operation with ONE schema: defineOp parses the raw input against
 * it and hands the handler the typed result — there is no second, shadow
 * schema inside the handler to drift from the declared contract.
 */
function defineOp<S extends z.ZodType>(
  mutating: boolean,
  schema: S,
  handler: (db: Db, provider: GmailProvider, input: z.infer<S>) => Promise<unknown>,
): OperationDef {
  return {
    mutating,
    schema,
    run: (db, provider, raw) => handler(db, provider, schema.parse(raw)),
  };
}

const connectionIdSchema = z.object({ connectionId: z.string().min(1) });
const messageRefSchema = connectionIdSchema.extend({ messageId: z.string().min(1) });

const listMessagesSchema = connectionIdSchema.extend({
  folder: z.string().min(1).default('inbox'),
  top: z.number().int().min(1).max(100).optional(),
  skip: z.number().int().min(0).optional(),
  unreadOnly: z.boolean().optional(),
});

const replySchema = messageRefSchema.extend({
  bodyHtml: z.string(),
  replyAll: z.boolean().default(false),
});

const moveSchema = messageRefSchema.extend({ destinationFolderId: z.string().min(1) });

const saveDraftSchema = connectionIdSchema.extend({
  // Either a reply-draft to an existing message, or a fresh draft.
  replyToMessageId: z.string().min(1).optional(),
  to: z.array(z.string().min(1)).optional(),
  subject: z.string().optional(),
  bodyHtml: z.string(),
});

const updateDraftSchema = connectionIdSchema.extend({ draftId: z.string().min(1), bodyHtml: z.string() });
const draftRefSchema = connectionIdSchema.extend({ draftId: z.string().min(1) });
const markReadSchema = messageRefSchema.extend({ isRead: z.boolean().default(true) });
// The neutral vocabulary includes 'complete', but Gmail's star is binary —
// the rejection lives IN the schema (not a shadow check in the handler) so
// the declared contract and the enforced one cannot drift.
const flagSchema = messageRefSchema.extend({
  flag: z
    .enum(['flagged', 'none', 'complete'])
    .default('flagged')
    .refine((f) => f !== 'complete', "the 'complete' flag state is not supported by Gmail"),
});
const categorizeSchema = messageRefSchema.extend({ categories: z.array(z.string()) });

/** The v1 operation registry, keyed by spec 002 operation name. */
export const OPERATIONS: Record<string, OperationDef> = {
  'list-messages': defineOp(false, listMessagesSchema, async (db, provider, input) => {
    const messages = await withConnection(db, input.connectionId, { resource: 'folder', id: input.folder }, (token) =>
      provider.listMessages(token, input.folder, {
        top: input.top,
        skip: input.skip,
        unreadOnly: input.unreadOnly,
      }),
    );
    return { messages: messages.map(normalizeMessage) };
  }),

  'get-message': defineOp(false, messageRefSchema, async (db, provider, input) => {
    const message = await withConnection(db, input.connectionId, { resource: 'message', id: input.messageId }, (token) =>
      provider.getMessage(token, input.messageId),
    );
    return { message: normalizeMessage(message) };
  }),

  'list-folders': defineOp(false, connectionIdSchema, async (db, provider, input) => {
    const folders = await withConnection(db, input.connectionId, undefined, (token) => provider.listFolders(token));
    return {
      folders: folders.map((f) => ({
        id: f.id,
        name: f.name,
        totalCount: f.totalCount,
        unreadCount: f.unreadCount,
      })),
    };
  }),

  'reply-to-message': defineOp(true, replySchema, async (db, provider, input) => {
    if (input.bodyHtml.trim() === '') throw new BodyRequiredError();
    await withConnection(db, input.connectionId, { resource: 'message', id: input.messageId }, (token) =>
      provider.replyToMessage(token, input.messageId, input.bodyHtml, input.replyAll),
    );
    return { sent: true };
  }),

  'move-message': defineOp(true, moveSchema, async (db, provider, input) => {
    await withConnection(db, input.connectionId, { resource: 'message', id: input.messageId }, (token) =>
      provider.moveMessage(token, input.messageId, input.destinationFolderId),
    );
    return { moved: true };
  }),

  'save-draft': defineOp(true, saveDraftSchema, async (db, provider, input) => {
    if (input.bodyHtml.trim() === '') throw new BodyRequiredError();
    if (input.replyToMessageId) {
      const replyTo = input.replyToMessageId;
      const draft = await withConnection(db, input.connectionId, { resource: 'message', id: replyTo }, (token) =>
        provider.createDraftReply(token, replyTo, input.bodyHtml),
      );
      return { draftId: draft.id, conversationId: draft.threadId };
    }
    if (!input.to || input.to.length === 0) throw new RecipientsRequiredError();
    if (input.subject == null) throw new ValidationError('subject', 'subject is required for a fresh draft');
    const { to, subject } = input;
    const draft = await withConnection(db, input.connectionId, undefined, (token) =>
      provider.createDraft(token, { to, subject, bodyHtml: input.bodyHtml }),
    );
    return { draftId: draft.id, conversationId: draft.threadId };
  }),

  'update-draft': defineOp(true, updateDraftSchema, async (db, provider, input) => {
    if (input.bodyHtml.trim() === '') throw new BodyRequiredError();
    const draft = await withConnection(db, input.connectionId, { resource: 'draft', id: input.draftId }, (token) =>
      provider.updateDraft(token, input.draftId, input.bodyHtml),
    );
    return { draftId: draft.id };
  }),

  'send-draft': defineOp(true, draftRefSchema, async (db, provider, input) => {
    await withConnection(db, input.connectionId, { resource: 'draft', id: input.draftId }, (token) =>
      provider.sendDraft(token, input.draftId),
    );
    return { sent: true };
  }),

  'delete-message': defineOp(true, messageRefSchema, async (db, provider, input) => {
    await withConnection(db, input.connectionId, { resource: 'message', id: input.messageId }, (token) =>
      provider.deleteMessage(token, input.messageId),
    );
    return { deleted: true };
  }),

  'mark-read': defineOp(true, markReadSchema, async (db, provider, input) => {
    await withConnection(db, input.connectionId, { resource: 'message', id: input.messageId }, (token) =>
      provider.setMessageReadStatus(token, input.messageId, input.isRead),
    );
    return { isRead: input.isRead };
  }),

  'flag-message': defineOp(true, flagSchema, async (db, provider, input) => {
    const flag = input.flag as 'flagged' | 'none'; // 'complete' rejected by the schema
    await withConnection(db, input.connectionId, { resource: 'message', id: input.messageId }, (token) =>
      provider.flagMessage(token, input.messageId, flag),
    );
    return { flag: input.flag };
  }),

  'categorize-message': defineOp(true, categorizeSchema, async (db, provider, input) => {
    await withConnection(db, input.connectionId, { resource: 'message', id: input.messageId }, (token) =>
      provider.categorizeMessage(token, input.messageId, input.categories),
    );
    return { categories: input.categories };
  }),
};

/** An in-flight reservation older than this is considered orphaned (the
 *  process died between the INSERT and the response update) and may be
 *  reclaimed by a retry — otherwise a crash blocks the key until the 7-day
 *  ledger prune. Well above any real request duration. */
const STALE_RESERVATION_MS = 5 * 60 * 1000;

/** Recursively key-sort a value so semantically equal inputs hash equal. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, val]) => [k, canonical(val)]),
    );
  }
  return v;
}

/** Stable SHA-256 of an operation input for idempotency-payload matching.
 *  Exported for tests that need to seed matching reservation rows. */
export function hashInput(input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
}

/**
 * Execute an operation by name with reservation-based idempotency: a
 * mutating call carrying an `idempotencyKey` first INSERTS an in-flight
 * reservation (unique key), so a concurrent duplicate cannot also execute
 * the provider mutation — it sees the reservation and is told to retry. A
 * completed key replays the stored response; a key reused with a different
 * operation or payload is rejected instead of leaking the stored response.
 * An in-flight reservation past the staleness cutoff (crashed process) is
 * reclaimed atomically so a retry can execute instead of waiting for the
 * ledger prune.
 */
export async function runOperation(
  db: Db,
  provider: GmailProvider,
  name: string,
  input: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<{ result: unknown; replayed: boolean }> {
  const op = OPERATIONS[name];
  if (!op) throw new ValidationError('operation', `unknown operation "${name}"`);

  const useIdempotency = Boolean(idempotencyKey) && op.mutating;
  const requestHash = useIdempotency ? hashInput(input) : '';

  if (useIdempotency) {
    try {
      await db.idempotencyRecord.create({
        data: { key: idempotencyKey!, operation: name, requestHash, responseJson: null },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await db.idempotencyRecord.findUnique({ where: { key: idempotencyKey! } });
      if (!existing) throw new ValidationError('idempotencyKey', 'key state changed concurrently — retry');
      if (existing.operation !== name || existing.requestHash !== requestHash) {
        throw new ValidationError('idempotencyKey', 'key was already used for a different request');
      }
      if (existing.responseJson == null) {
        // Reclaim an orphaned reservation (process died mid-request): the
        // conditional deleteMany is atomic, so of two concurrent retries only
        // one proceeds; the other still sees in-flight.
        const cutoff = new Date(Date.now() - STALE_RESERVATION_MS);
        const reclaimed = await db.idempotencyRecord.deleteMany({
          where: { key: idempotencyKey!, responseJson: null, createdAt: { lt: cutoff } },
        });
        if (reclaimed.count === 1) {
          return runOperation(db, provider, name, input, idempotencyKey);
        }
        throw new ValidationError('idempotencyKey', 'a request with this key is still in flight — retry shortly');
      }
      return { result: JSON.parse(existing.responseJson), replayed: true };
    }
  }

  let result: unknown;
  try {
    result = await op.run(db, provider, input);
  } catch (err) {
    // Release the reservation so the caller's retry can execute.
    if (useIdempotency) {
      await db.idempotencyRecord.delete({ where: { key: idempotencyKey! } }).catch(() => {});
    }
    throw toEmailToolError(err);
  }

  if (useIdempotency) {
    // The mutation already SUCCEEDED; persist its response so a retry replays
    // instead of re-executing. A silent failure here is dangerous: the
    // reservation stays in-flight and, past the staleness cutoff, a retry
    // reclaims it and re-runs the mutation (duplicate send/reply). We cannot
    // throw — that would tell the caller the (completed) op failed and invite
    // exactly that retry — so surface it loudly instead.
    await db.idempotencyRecord
      .update({ where: { key: idempotencyKey! }, data: { responseJson: JSON.stringify(result) } })
      .catch((err) =>
        logError(
          `idempotency completion write failed for key ${idempotencyKey} (${name}) — the mutation succeeded but is not recorded; a retry after the ${STALE_RESERVATION_MS}ms staleness window could re-execute it`,
          err,
        ),
      );
  }
  return { result, replayed: false };
}
