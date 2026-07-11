/**
 * Production GmailProvider — plain REST over fetch (no SDK; the surface this
 * tool needs is small and the error mapping stays fully in our hands).
 *
 * All mail calls use users/me endpoints (delegated scopes — the tool acts as
 * the signed-in user), acquire an access token from the connection's refresh
 * token per call, and surface refresh-token rotation via GmailCallResult
 * (Google normally doesn't rotate, but the plumbing is the platform-wide
 * invariant — see findings:oauth-rotation-persist-on-failure).
 */
import { refreshAccessToken, exchangeGoogleCode, fetchGoogleProfile } from './auth.js';
import { FOLDER_TO_LABEL, STARRED_LABEL, UNREAD_LABEL, labelForFolder } from './labels.js';
import {
  buildMimeMessage,
  headerValue,
  parseAddressList,
  parseGmailMessage,
  replyRecipients,
  replySubject,
  toRawBase64Url,
  type GmailApiMessage,
} from './mime.js';
import type {
  DraftInput,
  GmailCallResult,
  GmailProvider,
  ListMessagesOptions,
  MailAddress,
} from './types.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const REQUEST_TIMEOUT_MS = 30000;

/** Shape of a failed Google API call — what mapGmailError consumes. */
interface ApiError extends Error {
  statusCode: number;
  reason?: string;
  headers: Headers;
}

/**
 * Fetch a Google API endpoint with a bearer token. The timeout signal covers
 * the response BODY read, not just the headers. Failures throw an ApiError
 * carrying status + Google's error reason for the typed mapper.
 */
async function apiFetch<T>(
  accessToken: string,
  method: string,
  path: string,
  options: { query?: Record<string, string | string[] | number | undefined>; body?: unknown } = {},
): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, v));
    else url.searchParams.set(key, String(value));
  }
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal,
  });
  const text = await res.text(); // still under the same timeout signal
  if (!res.ok) {
    let reason: string | undefined;
    let message = `Gmail API ${method} ${path} failed with ${res.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; errors?: { reason?: string }[]; status?: string } };
      reason = parsed.error?.errors?.[0]?.reason ?? parsed.error?.status;
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // non-JSON error body — keep the generic message
    }
    const err = new Error(message) as ApiError;
    err.statusCode = res.status;
    err.reason = reason;
    err.headers = res.headers;
    throw err;
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * Execute a Gmail call using a refresh token: acquire an access token, run
 * the call, retry once on 429 honoring Retry-After, and report refresh-token
 * rotation. Everything else propagates for mapGmailError at the ops layer.
 */
async function withToken<T>(
  refreshToken: string,
  fn: (accessToken: string) => Promise<T>,
): Promise<GmailCallResult<T>> {
  const tokenRes = await refreshAccessToken(refreshToken);
  const accessToken = tokenRes.access_token;
  const newRefreshToken =
    tokenRes.refresh_token && tokenRes.refresh_token !== refreshToken ? tokenRes.refresh_token : undefined;
  try {
    try {
      const data = await fn(accessToken);
      return { data, newRefreshToken };
    } catch (err) {
      const statusCode = (err as { statusCode?: number })?.statusCode;
      if (statusCode === 429) {
        const rawRetry = (err as { headers?: { get?: (h: string) => string | null } })?.headers?.get?.('Retry-After');
        const retryAfter = parseInt(rawRetry ?? '5', 10);
        await new Promise((resolve) => setTimeout(resolve, (Number.isFinite(retryAfter) ? retryAfter : 5) * 1000));
        const data = await fn(accessToken);
        return { data, newRefreshToken };
      }
      throw err;
    }
  } catch (err) {
    // The refresh SUCCEEDED before fn() failed — a rotated token must still
    // reach the caller or one harmless API error permanently strands the
    // connection. withConnection persists it from the error object.
    if (newRefreshToken && err != null && typeof err === 'object') {
      (err as { newRefreshToken?: string }).newRefreshToken = newRefreshToken;
    }
    throw err;
  }
}

// ── Read-side API shapes ─────────────────────────────────────────────────

interface MessageListResponse {
  messages?: { id: string; threadId?: string }[];
  nextPageToken?: string;
}

interface LabelResource {
  id: string;
  name: string;
  type?: 'system' | 'user';
  messagesTotal?: number;
  messagesUnread?: number;
}

interface DraftResource {
  id: string;
  message: GmailApiMessage;
}

interface ProfileResource {
  emailAddress: string;
  historyId: string;
}

interface HistoryListResponse {
  historyId?: string;
  nextPageToken?: string;
  history?: {
    messagesAdded?: { message: { id: string; threadId?: string; labelIds?: string[] } }[];
  }[];
}

/** Headers needed to compute a reply (recipients, threading). */
const REPLY_HEADERS = ['Subject', 'From', 'To', 'Cc', 'Reply-To', 'Message-ID', 'References'];

/** Fetch original-message context and build the raw MIME for a reply. */
async function buildReplyRaw(
  accessToken: string,
  messageId: string,
  bodyHtml: string,
  replyAll: boolean,
): Promise<{ raw: string; threadId: string | null }> {
  const [profile, original] = await Promise.all([
    apiFetch<ProfileResource>(accessToken, 'GET', '/profile'),
    apiFetch<GmailApiMessage>(accessToken, 'GET', `/messages/${encodeURIComponent(messageId)}`, {
      query: { format: 'metadata', metadataHeaders: REPLY_HEADERS },
    }),
  ]);
  const headers = original.payload?.headers;
  const fromRaw = headerValue(headers, 'From');
  const recipients = replyRecipients(
    {
      from: fromRaw ? (parseAddressList(fromRaw)[0] ?? null) : null,
      to: parseAddressList(headerValue(headers, 'To')),
      cc: parseAddressList(headerValue(headers, 'Cc')),
      replyTo: parseAddressList(headerValue(headers, 'Reply-To')),
    },
    profile.emailAddress ?? null,
    replyAll,
  );
  const originalMessageId = headerValue(headers, 'Message-ID');
  const originalReferences = headerValue(headers, 'References');
  const mime = buildMimeMessage({
    to: recipients.to,
    cc: recipients.cc,
    subject: replySubject(headerValue(headers, 'Subject')),
    bodyHtml,
    inReplyTo: originalMessageId,
    references: originalMessageId
      ? [originalReferences, originalMessageId].filter(Boolean).join(' ')
      : originalReferences,
  });
  return { raw: toRawBase64Url(mime), threadId: original.threadId ?? null };
}

/** The system labels that behave like "the folder a message is in". */
const FOLDER_LABELS = new Set(Object.values(FOLDER_TO_LABEL));

export const gmailProvider: GmailProvider = {
  exchangeCode: exchangeGoogleCode,
  fetchProfile: fetchGoogleProfile,

  async listMessages(refreshToken, folder, options: ListMessagesOptions = {}) {
    return withToken(refreshToken, async (accessToken) => {
      const top = options.top ?? 25;
      const skip = options.skip ?? 0;
      const labelIds = [labelForFolder(folder)];
      if (options.unreadOnly) labelIds.push(UNREAD_LABEL);

      // Gmail paginates by token, not offset — collect ids until skip+top.
      const needed = skip + top;
      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const page = await apiFetch<MessageListResponse>(accessToken, 'GET', '/messages', {
          query: { labelIds, maxResults: Math.min(needed - ids.length, 500), pageToken },
        });
        ids.push(...(page.messages ?? []).map((m) => m.id));
        pageToken = page.nextPageToken;
      } while (pageToken && ids.length < needed);

      const window = ids.slice(skip, needed);
      // metadata format: headers + snippet + labels, no body — the list
      // surface stays cheap; get-message provides full fidelity (body,
      // attachment detection).
      const messages = await Promise.all(
        window.map((id) =>
          apiFetch<GmailApiMessage>(accessToken, 'GET', `/messages/${encodeURIComponent(id)}`, {
            query: { format: 'metadata', metadataHeaders: ['Subject', 'From', 'To'] },
          }),
        ),
      );
      return messages.map(parseGmailMessage);
    });
  },

  async getMessage(refreshToken, messageId) {
    return withToken(refreshToken, async (accessToken) => {
      const message = await apiFetch<GmailApiMessage>(
        accessToken,
        'GET',
        `/messages/${encodeURIComponent(messageId)}`,
        { query: { format: 'full' } },
      );
      return parseGmailMessage(message);
    });
  },

  async replyToMessage(refreshToken, messageId, bodyHtml, replyAll) {
    return withToken(refreshToken, async (accessToken) => {
      const { raw, threadId } = await buildReplyRaw(accessToken, messageId, bodyHtml, replyAll);
      await apiFetch(accessToken, 'POST', '/messages/send', {
        body: { raw, ...(threadId ? { threadId } : {}) },
      });
    });
  },

  async moveMessage(refreshToken, messageId, destinationFolderId) {
    return withToken(refreshToken, async (accessToken) => {
      const dest = labelForFolder(destinationFolderId);
      if (dest === 'TRASH') {
        await apiFetch(accessToken, 'POST', `/messages/${encodeURIComponent(messageId)}/trash`, { body: {} });
        return;
      }
      // A Gmail "move" is a label swap: add the destination, remove whichever
      // folder-class labels the message currently carries.
      const current = await apiFetch<GmailApiMessage>(accessToken, 'GET', `/messages/${encodeURIComponent(messageId)}`, {
        query: { format: 'minimal' },
      });
      const removeLabelIds = (current.labelIds ?? []).filter((l) => FOLDER_LABELS.has(l) && l !== dest);
      await apiFetch(accessToken, 'POST', `/messages/${encodeURIComponent(messageId)}/modify`, {
        body: { addLabelIds: [dest], removeLabelIds },
      });
    });
  },

  async listFolders(refreshToken) {
    return withToken(refreshToken, async (accessToken) => {
      const list = await apiFetch<{ labels?: LabelResource[] }>(accessToken, 'GET', '/labels');
      const labels = (list.labels ?? []).slice(0, 100); // labels.list carries no counts
      const detailed = await Promise.all(
        labels.map((l) =>
          apiFetch<LabelResource>(accessToken, 'GET', `/labels/${encodeURIComponent(l.id)}`).catch(() => l),
        ),
      );
      return detailed.map((l) => ({
        id: l.id,
        name: l.name,
        totalCount: l.messagesTotal ?? 0,
        unreadCount: l.messagesUnread ?? 0,
      }));
    });
  },

  async createDraft(refreshToken, draft: DraftInput) {
    return withToken(refreshToken, async (accessToken) => {
      const to: MailAddress[] = draft.to.map((address) => ({ name: null, address }));
      const raw = toRawBase64Url(buildMimeMessage({ to, subject: draft.subject, bodyHtml: draft.bodyHtml }));
      const created = await apiFetch<DraftResource>(accessToken, 'POST', '/drafts', {
        body: { message: { raw } },
      });
      return { id: created.id, messageId: created.message.id, threadId: created.message.threadId ?? null };
    });
  },

  async createDraftReply(refreshToken, messageId, bodyHtml) {
    return withToken(refreshToken, async (accessToken) => {
      const { raw, threadId } = await buildReplyRaw(accessToken, messageId, bodyHtml, false);
      const created = await apiFetch<DraftResource>(accessToken, 'POST', '/drafts', {
        body: { message: { raw, ...(threadId ? { threadId } : {}) } },
      });
      return { id: created.id, messageId: created.message.id, threadId: created.message.threadId ?? null };
    });
  },

  async updateDraft(refreshToken, draftId, bodyHtml) {
    return withToken(refreshToken, async (accessToken) => {
      // drafts.update replaces the whole message — re-read the draft and
      // preserve its recipients, subject, and threading headers.
      const existing = await apiFetch<DraftResource>(accessToken, 'GET', `/drafts/${encodeURIComponent(draftId)}`, {
        query: { format: 'full' },
      });
      const headers = existing.message.payload?.headers;
      const mime = buildMimeMessage({
        to: parseAddressList(headerValue(headers, 'To')),
        cc: parseAddressList(headerValue(headers, 'Cc')),
        subject: headerValue(headers, 'Subject') ?? '',
        bodyHtml,
        inReplyTo: headerValue(headers, 'In-Reply-To'),
        references: headerValue(headers, 'References'),
      });
      const threadId = existing.message.threadId;
      const updated = await apiFetch<DraftResource>(accessToken, 'PUT', `/drafts/${encodeURIComponent(draftId)}`, {
        body: { message: { raw: toRawBase64Url(mime), ...(threadId ? { threadId } : {}) } },
      });
      return { id: updated.id, messageId: updated.message.id, threadId: updated.message.threadId ?? null };
    });
  },

  async sendDraft(refreshToken, draftId) {
    return withToken(refreshToken, async (accessToken) => {
      await apiFetch(accessToken, 'POST', '/drafts/send', { body: { id: draftId } });
    });
  },

  async deleteMessage(refreshToken, messageId) {
    return withToken(refreshToken, async (accessToken) => {
      await apiFetch(accessToken, 'POST', `/messages/${encodeURIComponent(messageId)}/trash`, { body: {} });
    });
  },

  async setMessageReadStatus(refreshToken, messageId, isRead) {
    return withToken(refreshToken, async (accessToken) => {
      await apiFetch(accessToken, 'POST', `/messages/${encodeURIComponent(messageId)}/modify`, {
        body: isRead ? { removeLabelIds: [UNREAD_LABEL] } : { addLabelIds: [UNREAD_LABEL] },
      });
    });
  },

  async flagMessage(refreshToken, messageId, flag) {
    return withToken(refreshToken, async (accessToken) => {
      await apiFetch(accessToken, 'POST', `/messages/${encodeURIComponent(messageId)}/modify`, {
        body: flag === 'flagged' ? { addLabelIds: [STARRED_LABEL] } : { removeLabelIds: [STARRED_LABEL] },
      });
    });
  },

  async categorizeMessage(refreshToken, messageId, categories) {
    return withToken(refreshToken, async (accessToken) => {
      const list = await apiFetch<{ labels?: LabelResource[] }>(accessToken, 'GET', '/labels');
      const userLabels = (list.labels ?? []).filter((l) => l.type === 'user');
      const byName = new Map(userLabels.map((l) => [l.name.toLowerCase(), l]));

      // Create-if-missing, then diff against the message's current user labels
      // (Graph's categories PATCH replaces the set; mirror that semantics).
      const targetIds: string[] = [];
      for (const name of categories) {
        const existing = byName.get(name.toLowerCase());
        if (existing) {
          targetIds.push(existing.id);
        } else {
          const created = await apiFetch<LabelResource>(accessToken, 'POST', '/labels', { body: { name } });
          targetIds.push(created.id);
        }
      }
      const current = await apiFetch<GmailApiMessage>(accessToken, 'GET', `/messages/${encodeURIComponent(messageId)}`, {
        query: { format: 'minimal' },
      });
      const userLabelIds = new Set(userLabels.map((l) => l.id));
      const currentUserIds = (current.labelIds ?? []).filter((l) => userLabelIds.has(l));
      const target = new Set(targetIds);
      const addLabelIds = targetIds.filter((id) => !currentUserIds.includes(id));
      const removeLabelIds = currentUserIds.filter((id) => !target.has(id));
      if (addLabelIds.length > 0 || removeLabelIds.length > 0) {
        await apiFetch(accessToken, 'POST', `/messages/${encodeURIComponent(messageId)}/modify`, {
          body: { addLabelIds, removeLabelIds },
        });
      }
    });
  },

  async createWatch(refreshToken, topicName) {
    return withToken(refreshToken, async (accessToken) => {
      const res = await apiFetch<{ historyId: string; expiration: string }>(accessToken, 'POST', '/watch', {
        body: {
          topicName,
          // Only folder-event labels — keeps notification volume down; the
          // history processor classifies by label anyway.
          labelIds: ['INBOX', 'SENT'],
          labelFilterBehavior: 'include',
        },
      });
      return { historyId: res.historyId, expiresAt: new Date(Number(res.expiration)).toISOString() };
    });
  },

  async stopWatch(refreshToken) {
    return withToken(refreshToken, async (accessToken) => {
      await apiFetch(accessToken, 'POST', '/stop', { body: {} });
    });
  },

  async listHistory(refreshToken, startHistoryId) {
    return withToken(refreshToken, async (accessToken) => {
      const messagesAdded: { id: string; threadId: string | null; labelIds: string[] }[] = [];
      let historyId = startHistoryId;
      let pageToken: string | undefined;
      do {
        const page = await apiFetch<HistoryListResponse>(accessToken, 'GET', '/history', {
          query: { startHistoryId, historyTypes: 'messageAdded', pageToken, maxResults: 500 },
        });
        if (page.historyId) historyId = page.historyId;
        for (const entry of page.history ?? []) {
          for (const added of entry.messagesAdded ?? []) {
            messagesAdded.push({
              id: added.message.id,
              threadId: added.message.threadId ?? null,
              labelIds: added.message.labelIds ?? [],
            });
          }
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
      return { historyId, messagesAdded };
    });
  },

  async getCurrentHistoryId(refreshToken) {
    return withToken(refreshToken, async (accessToken) => {
      const profile = await apiFetch<ProfileResource>(accessToken, 'GET', '/profile');
      return profile.historyId;
    });
  },
};
