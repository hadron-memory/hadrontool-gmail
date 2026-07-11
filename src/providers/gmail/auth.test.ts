import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionUnauthorizedError } from '../../errors.js';
import { decodeIdToken, refreshAccessToken } from './auth.js';

/** Build an id_token-shaped JWT (unsigned — only the payload is decoded). */
function jwt(payload: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
}

describe('decodeIdToken', () => {
  it('extracts email and name claims', () => {
    expect(decodeIdToken(jwt({ email: 'a@gmail.example', name: 'A User' }))).toEqual({
      email: 'a@gmail.example',
      name: 'A User',
    });
  });

  it('returns nulls for missing claims or garbage tokens', () => {
    expect(decodeIdToken(jwt({}))).toEqual({ email: null, name: null });
    expect(decodeIdToken('not-a-jwt')).toEqual({ email: null, name: null });
    expect(decodeIdToken('')).toEqual({ email: null, name: null });
  });
});

describe('refreshAccessToken', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps the token endpoint's 400 invalid_grant to connection_unauthorized", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 })),
    );
    await expect(refreshAccessToken('rt-dead')).rejects.toBeInstanceOf(ConnectionUnauthorizedError);
  });

  it('surfaces other token-endpoint failures with their status for the provider mapper', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('server error', { status: 503 })),
    );
    await expect(refreshAccessToken('rt-x')).rejects.toMatchObject({ statusCode: 503 });
  });

  it('returns the token payload on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ access_token: 'at-1', expires_in: 3599, scope: 's', token_type: 'Bearer' }), {
          status: 200,
        }),
      ),
    );
    const tokens = await refreshAccessToken('rt-live');
    expect(tokens.access_token).toBe('at-1');
    expect(tokens.refresh_token).toBeUndefined(); // Google doesn't rotate
  });
});
