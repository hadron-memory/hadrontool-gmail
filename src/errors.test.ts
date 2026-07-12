import { describe, expect, it } from 'vitest';
import {
  ConnectionUnauthorizedError,
  NotFoundError,
  ProviderRateLimitedError,
  ProviderUnavailableError,
  ValidationError,
  mapGmailError,
} from './errors.js';

/** Build a Headers-like object with a Retry-After value. */
function headersWith(retryAfter: string | null) {
  return { get: (name: string) => (name === 'Retry-After' ? retryAfter : null) };
}

describe('mapGmailError', () => {
  it('passes an already-typed error through', () => {
    const typed = new ValidationError('x', 'y');
    expect(mapGmailError(typed)).toBe(typed);
  });

  it('maps 401 to connection_unauthorized', () => {
    expect(mapGmailError({ statusCode: 401 })).toBeInstanceOf(ConnectionUnauthorizedError);
  });

  it('maps auth-class 403 reasons to connection_unauthorized', () => {
    for (const reason of ['authError', 'insufficientPermissions', 'accountDisabled']) {
      expect(mapGmailError({ statusCode: 403, reason }), reason).toBeInstanceOf(ConnectionUnauthorizedError);
    }
  });

  it('maps non-auth 403s (e.g. Pub/Sub topic permission) to provider_unavailable — never bricking the connection', () => {
    expect(mapGmailError({ statusCode: 403, reason: 'forbidden' })).toBeInstanceOf(ProviderUnavailableError);
    expect(mapGmailError({ statusCode: 403 })).toBeInstanceOf(ProviderUnavailableError);
  });

  it('maps 403 quota reasons to provider_rate_limited (Google rate limits via 403 too)', () => {
    for (const reason of ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded']) {
      const mapped = mapGmailError({ statusCode: 403, reason });
      expect(mapped, reason).toBeInstanceOf(ProviderRateLimitedError);
    }
  });

  it('maps 429 to provider_rate_limited, honoring Retry-After', () => {
    const mapped = mapGmailError({ statusCode: 429, headers: headersWith('17') }) as ProviderRateLimitedError;
    expect(mapped).toBeInstanceOf(ProviderRateLimitedError);
    expect(mapped.retryAfterSeconds).toBe(17);
  });

  it('defaults Retry-After to 60 when absent or malformed', () => {
    const absent = mapGmailError({ statusCode: 429 }) as ProviderRateLimitedError;
    expect(absent.retryAfterSeconds).toBe(60);
    const malformed = mapGmailError({ statusCode: 429, headers: headersWith('soon') }) as ProviderRateLimitedError;
    expect(malformed.retryAfterSeconds).toBe(60);
  });

  it('parses the RFC 7231 HTTP-date form of Retry-After', () => {
    const date = new Date(Date.now() + 90 * 1000).toUTCString();
    const mapped = mapGmailError({ statusCode: 429, headers: headersWith(date) }) as ProviderRateLimitedError;
    expect(mapped.retryAfterSeconds).toBeGreaterThan(80);
    expect(mapped.retryAfterSeconds).toBeLessThanOrEqual(91);
  });

  it('maps 404 to not_found with the resource hint', () => {
    const mapped = mapGmailError({ statusCode: 404 }, { resource: 'draft', id: 'd-9' }) as NotFoundError;
    expect(mapped).toBeInstanceOf(NotFoundError);
    expect(mapped.resource).toBe('draft');
    expect(mapped.id).toBe('d-9');
  });

  it('maps 400 to validation_error carrying the provider message', () => {
    const mapped = mapGmailError({ statusCode: 400, message: 'Invalid label' }) as ValidationError;
    expect(mapped).toBeInstanceOf(ValidationError);
    expect(mapped.reason).toBe('Invalid label');
  });

  it('maps 5xx and unknown shapes to provider_unavailable', () => {
    expect(mapGmailError({ statusCode: 503 })).toBeInstanceOf(ProviderUnavailableError);
    expect(mapGmailError(new Error('socket hang up'))).toBeInstanceOf(ProviderUnavailableError);
    expect(mapGmailError(undefined)).toBeInstanceOf(ProviderUnavailableError);
  });
});
