/**
 * Provider-layer types + the injectable GmailProvider interface.
 *
 * The ops layer (src/ops), routes, and workers depend only on this
 * interface; tests inject a fake, and src/providers/gmail/client.ts is the
 * production implementation over the Gmail REST API.
 *
 * Unlike Graph, the Gmail API traffics in raw RFC 2822 MIME — so the
 * provider surface returns messages ALREADY parsed into a header/body shape
 * (src/providers/gmail/mime.ts) rather than leaking base64url part trees
 * upward. The ops layer still owns the final provider-neutral normalization.
 */

export interface TokenResponse {
  access_token: string;
  /** Google returns this only when the authorize URL carried
   *  `access_type=offline&prompt=consent`; refresh responses normally omit it. */
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

/** Identity from the ID token / OpenID userinfo endpoint. */
export interface GoogleProfile {
  email: string | null;
  name: string | null;
}

/** An email address parsed from a MIME header. */
export interface MailAddress {
  name: string | null;
  address: string;
}

/** A Gmail message parsed out of the API's MIME representation. */
export interface GmailMessage {
  id: string;
  threadId: string | null;
  labelIds: string[];
  subject: string | null;
  from: MailAddress | null;
  to: MailAddress[];
  /** ISO timestamp derived from the message's internalDate. */
  receivedAt: string;
  snippet: string;
  /** Preferred body part (text/html over text/plain), decoded. Null when the
   *  message was fetched in a headers-only format. */
  body: { contentType: string; content: string } | null;
  hasAttachments: boolean;
}

/** A Gmail draft. `id` is the DRAFT id (distinct from the message id). */
export interface GmailDraft {
  id: string;
  messageId: string;
  threadId: string | null;
}

/** A Gmail label presented as a neutral folder. Counts are 0 when the API
 *  variant used doesn't report them. */
export interface GmailFolder {
  id: string;
  name: string;
  totalCount: number;
  unreadCount: number;
}

export interface ListMessagesOptions {
  top?: number;
  skip?: number;
  unreadOnly?: boolean;
}

/** Gmail has no tri-state flag: STARRED is on or off ('complete' is rejected
 *  at the ops layer before it ever reaches the provider). */
export type GmailFlag = 'flagged' | 'none';

/** users.watch registration result. */
export interface WatchResult {
  /** The mailbox's historyId at watch time — the initial history cursor. */
  historyId: string;
  /** ISO expiry (Gmail watches live ≤7 days). */
  expiresAt: string;
}

/** One message surfaced by a history delta. */
export interface HistoryMessageAdded {
  id: string;
  threadId: string | null;
  labelIds: string[];
}

/** users.history.list result, all pages collected. */
export interface HistoryDelta {
  /** The mailbox's current historyId — the new cursor once every message
   *  in `messagesAdded` has been processed. */
  historyId: string;
  messagesAdded: HistoryMessageAdded[];
}

/**
 * Result of a token-refreshing Gmail call. Google normally does NOT rotate
 * refresh tokens, but the plumbing is kept (per the platform-wide
 * oauth-rotation-persist-on-failure finding): if a rotated token ever
 * appears, `newRefreshToken` is set and the caller MUST persist it.
 */
export interface GmailCallResult<T> {
  data: T;
  newRefreshToken?: string;
}

/** Fields for composing a fresh (non-reply) draft. */
export interface DraftInput {
  to: string[];
  subject: string;
  bodyHtml: string;
}

/**
 * Everything the tool needs from Google. One method per interaction; every
 * mailbox method takes the connection's refresh token and reports rotation
 * via GmailCallResult.
 */
export interface GmailProvider {
  // ── OAuth ────────────────────────────────────────────────────────────
  exchangeCode(code: string, redirectUri: string): Promise<TokenResponse>;
  fetchProfile(accessToken: string): Promise<GoogleProfile>;

  // ── Mail operations (users/me — acts as the signed-in user) ──────────
  listMessages(refreshToken: string, folder: string, options?: ListMessagesOptions): Promise<GmailCallResult<GmailMessage[]>>;
  getMessage(refreshToken: string, messageId: string): Promise<GmailCallResult<GmailMessage>>;
  replyToMessage(refreshToken: string, messageId: string, bodyHtml: string, replyAll: boolean): Promise<GmailCallResult<void>>;
  moveMessage(refreshToken: string, messageId: string, destinationFolderId: string): Promise<GmailCallResult<void>>;
  listFolders(refreshToken: string): Promise<GmailCallResult<GmailFolder[]>>;
  createDraft(refreshToken: string, draft: DraftInput): Promise<GmailCallResult<GmailDraft>>;
  createDraftReply(refreshToken: string, messageId: string, bodyHtml: string): Promise<GmailCallResult<GmailDraft>>;
  updateDraft(refreshToken: string, draftId: string, bodyHtml: string): Promise<GmailCallResult<GmailDraft>>;
  sendDraft(refreshToken: string, draftId: string): Promise<GmailCallResult<void>>;
  deleteMessage(refreshToken: string, messageId: string): Promise<GmailCallResult<void>>;
  setMessageReadStatus(refreshToken: string, messageId: string, isRead: boolean): Promise<GmailCallResult<void>>;
  flagMessage(refreshToken: string, messageId: string, flag: GmailFlag): Promise<GmailCallResult<void>>;
  categorizeMessage(refreshToken: string, messageId: string, categories: string[]): Promise<GmailCallResult<void>>;

  // ── Watch lifecycle (Pub/Sub push notifications) ──────────────────────
  createWatch(refreshToken: string, topicName: string): Promise<GmailCallResult<WatchResult>>;
  stopWatch(refreshToken: string): Promise<GmailCallResult<void>>;
  listHistory(refreshToken: string, startHistoryId: string): Promise<GmailCallResult<HistoryDelta>>;
  /** The mailbox's current historyId (users.getProfile) — used to re-baseline
   *  a stale cursor. */
  getCurrentHistoryId(refreshToken: string): Promise<GmailCallResult<string>>;
}
