/**
 * Test doubles: an in-memory GmailProvider fake with call recording, and a
 * fixture GmailMessage builder. Route tests run the real Express app + real
 * test DB over these fakes — only Google is simulated.
 */
import type { Db } from '../db.js';
import type {
  GmailCallResult,
  GmailMessage,
  GmailProvider,
  HistoryDelta,
} from '../providers/gmail/types.js';

/** Wipe every table in FK-safe order — the one cleanup list all test files share. */
export async function resetDb(db: Db): Promise<void> {
  await db.processedNotification.deleteMany();
  await db.idempotencyRecord.deleteMany();
  await db.watch.deleteMany();
  await db.subscribedFolder.deleteMany();
  await db.connection.deleteMany();
}

/** Build a plausible parsed Gmail message fixture. */
export function gmailMessage(overrides: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id: 'msg-1',
    threadId: 'conv-1',
    labelIds: ['INBOX', 'UNREAD'],
    subject: 'Office hours',
    from: { name: 'A Student', address: 'student@example.edu' },
    to: [{ name: 'The Professor', address: 'prof@example.edu' }],
    receivedAt: '2026-07-10T12:00:00.000Z',
    snippet: 'When are your office hours?',
    body: { contentType: 'html', content: '<p>When are your office hours?</p>' },
    hasAttachments: false,
    ...overrides,
  };
}

/** Wrap data in a GmailCallResult. */
function ok<T>(data: T, newRefreshToken?: string): GmailCallResult<T> {
  return { data, newRefreshToken };
}

export interface FakeProviderOptions {
  /** When set, every mailbox call reports this rotated refresh token once. */
  rotateTo?: string;
  /** When set, the named methods throw this error. */
  failWith?: { methods: string[]; error: unknown };
  /** Simulate a grant without offline access: exchangeCode omits refresh_token. */
  omitRefreshToken?: boolean;
  /** Simulate an ID token without claims: identity must come from userinfo. */
  omitIdToken?: boolean;
  /** What listHistory returns (keyed by nothing — one delta for the test). */
  historyDelta?: HistoryDelta;
  /** What createWatch reports as the mailbox historyId baseline. */
  watchHistoryId?: string;
  /** What getCurrentHistoryId returns (stale-cursor re-baseline). */
  currentHistoryId?: string;
}

/**
 * A recording fake provider. `calls` collects [method, args] tuples so tests
 * assert both HTTP behavior and what reached "Google".
 */
export function fakeProvider(options: FakeProviderOptions = {}): GmailProvider & { calls: [string, unknown[]][] } {
  const calls: [string, unknown[]][] = [];
  let rotation = options.rotateTo;

  /** Record a call; throw if configured to fail; consume one rotation. */
  function record<T>(method: string, args: unknown[], data: T): GmailCallResult<T> {
    calls.push([method, args]);
    if (options.failWith?.methods.includes(method)) throw options.failWith.error;
    const result = ok(data, rotation);
    rotation = undefined;
    return result;
  }

  return {
    calls,
    async exchangeCode(code, redirectUri) {
      calls.push(['exchangeCode', [code, redirectUri]]);
      if (options.failWith?.methods.includes('exchangeCode')) throw options.failWith.error;
      return {
        access_token: 'at-1',
        ...(options.omitRefreshToken ? {} : { refresh_token: 'rt-fresh' }),
        // header.payload.signature — payload carries the OpenID claims
        ...(options.omitIdToken
          ? {}
          : {
              id_token: `x.${Buffer.from(
                JSON.stringify({ email: 'user@gmail.example', name: 'Gmail User' }),
              ).toString('base64url')}.y`,
            }),
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/gmail.modify',
        token_type: 'Bearer',
      };
    },
    async fetchProfile() {
      calls.push(['fetchProfile', []]);
      return { email: 'userinfo@gmail.example', name: 'Userinfo User' };
    },
    async listMessages(token, folder, opts) {
      return record('listMessages', [token, folder, opts], [gmailMessage()]);
    },
    async getMessage(token, messageId) {
      return record('getMessage', [token, messageId], gmailMessage({ id: messageId }));
    },
    async replyToMessage(token, messageId, bodyHtml, replyAll) {
      return record('replyToMessage', [token, messageId, bodyHtml, replyAll], undefined);
    },
    async moveMessage(token, messageId, dest) {
      return record('moveMessage', [token, messageId, dest], undefined);
    },
    async listFolders(token) {
      return record('listFolders', [token], [
        { id: 'INBOX', name: 'INBOX', totalCount: 10, unreadCount: 2 },
      ]);
    },
    async createDraft(token, draft) {
      return record('createDraft', [token, draft], { id: 'draft-new', messageId: 'm-draft-new', threadId: 'thread-new' });
    },
    async createDraftReply(token, messageId, bodyHtml) {
      return record('createDraftReply', [token, messageId, bodyHtml], {
        id: 'draft-reply',
        messageId: 'm-draft-reply',
        threadId: 'conv-1',
      });
    },
    async updateDraft(token, draftId, bodyHtml) {
      return record('updateDraft', [token, draftId, bodyHtml], { id: draftId, messageId: `m-${draftId}`, threadId: null });
    },
    async sendDraft(token, draftId) {
      return record('sendDraft', [token, draftId], undefined);
    },
    async deleteMessage(token, messageId) {
      return record('deleteMessage', [token, messageId], undefined);
    },
    async setMessageReadStatus(token, messageId, isRead) {
      return record('setMessageReadStatus', [token, messageId, isRead], undefined);
    },
    async flagMessage(token, messageId, flag) {
      return record('flagMessage', [token, messageId, flag], undefined);
    },
    async categorizeMessage(token, messageId, categories) {
      return record('categorizeMessage', [token, messageId, categories], undefined);
    },
    async createWatch(token, topicName) {
      return record('createWatch', [token, topicName], {
        historyId: options.watchHistoryId ?? '1000',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      });
    },
    async stopWatch(token) {
      return record('stopWatch', [token], undefined);
    },
    async listHistory(token, startHistoryId) {
      return record(
        'listHistory',
        [token, startHistoryId],
        options.historyDelta ?? { historyId: startHistoryId, messagesAdded: [] },
      );
    },
    async getCurrentHistoryId(token) {
      return record('getCurrentHistoryId', [token], options.currentHistoryId ?? '5000');
    },
  };
}
