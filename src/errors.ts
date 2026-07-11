/**
 * Typed error catalog — the spec 002 contract (contracts/error-codes.md).
 *
 * Codes are the PUBLIC surface: hadron-server's emailClient passes them
 * through to GraphQL `extensions.code` / MCP errors verbatim, so their
 * meanings must stay stable. New codes may be added; existing ones never
 * change meaning. Identical catalog to hadrontool-ms-exchange — only the
 * provider mapper differs.
 */

/** Base class: every tool error carries a stable `code` + HTTP status. */
export abstract class EmailToolError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  /** JSON body shape every error response uses. */
  toBody(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...this.extraFields() };
  }

  protected extraFields(): Record<string, unknown> {
    return {};
  }
}

/** connectionId unknown OR not owned by the caller — indistinguishable by design (anti-enumeration). */
export class ConnectionNotFoundError extends EmailToolError {
  readonly code = 'connection_not_found';
  readonly httpStatus = 404;
  constructor() {
    super('This email connection no longer exists.');
  }
}

/** Connection exists but its provider grant is dead (revoked / expired refresh token). */
export class ConnectionUnauthorizedError extends EmailToolError {
  readonly code = 'connection_unauthorized';
  readonly httpStatus = 403;
  constructor() {
    super('The mailbox connection is no longer authorized; the user must reconnect.');
  }
}

/** Provider 429 (or quota-exceeded 403) — caller should retry after the indicated delay. */
export class ProviderRateLimitedError extends EmailToolError {
  readonly code = 'provider_rate_limited';
  readonly httpStatus = 429;
  constructor(public retryAfterSeconds: number) {
    super('The email provider is rate-limiting; retry shortly.');
  }
  protected extraFields() {
    return { retryAfterSeconds: this.retryAfterSeconds };
  }
}

/** Provider 5xx / network failure — transient, caller may retry with backoff. */
export class ProviderUnavailableError extends EmailToolError {
  readonly code = 'provider_unavailable';
  readonly httpStatus = 502;
  constructor() {
    super('The email provider is temporarily unavailable.');
  }
}

/** A message/draft/folder id does not exist within this connection. */
export class NotFoundError extends EmailToolError {
  readonly code = 'not_found';
  readonly httpStatus = 404;
  constructor(
    public resource: 'message' | 'attachment' | 'draft' | 'conversation' | 'folder',
    public id: string,
  ) {
    super(`The ${resource} is no longer available.`);
  }
  protected extraFields() {
    return { resource: this.resource, id: this.id };
  }
}

/** Input failed schema or semantic validation. */
export class ValidationError extends EmailToolError {
  readonly code = 'validation_error';
  readonly httpStatus = 400;
  constructor(
    public field: string,
    public reason: string,
  ) {
    super(`This request couldn't be processed: ${reason}`);
  }
  protected extraFields() {
    return { field: this.field, reason: this.reason };
  }
}

/** Message body missing on a compose operation. */
export class BodyRequiredError extends EmailToolError {
  readonly code = 'body_required';
  readonly httpStatus = 400;
  constructor() {
    super('The message has no body.');
  }
}

/** Recipient list empty on a compose operation. */
export class RecipientsRequiredError extends EmailToolError {
  readonly code = 'recipients_required';
  readonly httpStatus = 400;
  constructor() {
    super('This message has no recipients.');
  }
}

/** The service is missing its Google OAuth credentials (deploy-time gap). */
export class ProviderNotConfiguredError extends EmailToolError {
  readonly code = 'provider_not_configured';
  readonly httpStatus = 503;
  constructor(what = 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET') {
    super(`${what} are not configured on this service.`);
  }
}

/**
 * Build a ValidationError from a zod failure — the ONE place the
 * first-issue/path-join convention lives; `field`/`reason` are part of the
 * stable public error contract, so every plane must flatten identically.
 */
export function validationFromZod(err: { issues: { path: PropertyKey[]; message: string }[] }): ValidationError {
  const issue = err.issues[0];
  return new ValidationError(issue?.path.map(String).join('.') || 'input', issue?.message ?? 'invalid input');
}

/**
 * Shape of the error this tool's REST client throws for a failed Gmail /
 * Google API call: HTTP status, the parsed `error.status` / first
 * `error.errors[].reason` from the JSON body, and the response headers.
 */
export interface GoogleApiErrorLike {
  statusCode?: number;
  /** Google's error reason, e.g. `rateLimitExceeded`, `notFound`, `authError`. */
  reason?: string;
  message?: string;
  headers?: { get?: (name: string) => string | null };
}

/** Google 403 reasons that mean "slow down", not "grant dead". */
const RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'dailyLimitExceeded',
  'quotaExceeded',
]);

/**
 * Map a raw Google API / fetch failure to a typed EmailToolError.
 * Anything already typed passes through; unknown shapes become
 * provider_unavailable (transient by default — never pretend success).
 *
 * Google specifics vs Graph: rate limiting arrives as 429 OR as 403 with a
 * quota reason; a dead grant surfaces as 401 (or the token endpoint's 400
 * invalid_grant, mapped in auth.ts before it gets here).
 */
export function mapGmailError(err: unknown, resourceHint?: { resource: 'message' | 'draft' | 'folder'; id: string }): EmailToolError {
  if (err instanceof EmailToolError) return err;

  const apiErr = (err ?? {}) as GoogleApiErrorLike;
  const status = typeof apiErr.statusCode === 'number' ? apiErr.statusCode : undefined;
  const reason = apiErr.reason;

  if (status === 429 || (status === 403 && reason !== undefined && RATE_LIMIT_REASONS.has(reason))) {
    const raw = apiErr.headers?.get?.('Retry-After');
    const parsed = raw != null ? parseInt(raw, 10) : NaN;
    return new ProviderRateLimitedError(Number.isFinite(parsed) && parsed > 0 ? parsed : 60);
  }
  if (status === 401 || status === 403) {
    return new ConnectionUnauthorizedError();
  }
  if (status === 404) {
    return new NotFoundError(resourceHint?.resource ?? 'message', resourceHint?.id ?? 'unknown');
  }
  if (status === 400) {
    return new ValidationError('request', apiErr.message ?? 'the provider rejected the request');
  }
  return new ProviderUnavailableError();
}
