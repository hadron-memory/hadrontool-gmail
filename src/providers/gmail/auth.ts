/**
 * Google OAuth 2.0 Authorization Code flow (delegated Gmail scopes).
 *
 * Hadron owns ONE Google OAuth client for mailbox connections (its own GCP
 * project, SEPARATE from the login client — see hadron-server#580/#583);
 * this tool holds its client secret — hadron-server only builds the
 * user-facing authorize URL (client id is public). The authorize URL MUST
 * carry `access_type=offline&prompt=consent` or Google returns no refresh
 * token; the connections route surfaces that as a typed error.
 */
import { ConnectionUnauthorizedError, ProviderNotConfiguredError, ValidationError } from '../../errors.js';
import { config } from '../../config.js';
import type { GoogleProfile, TokenResponse } from './types.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

/** The Google OAuth client credentials; typed 503 when the deploy lacks them. */
function credentials(): { clientId: string; clientSecret: string } {
  if (!config.googleClientId || !config.googleClientSecret) {
    throw new ProviderNotConfiguredError();
  }
  return { clientId: config.googleClientId, clientSecret: config.googleClientSecret };
}

/** Exchange the authorization code for tokens. The redirectUri must equal the one used on the authorize URL (hadron-server's callback). */
export async function exchangeGoogleCode(code: string, redirectUri: string): Promise<TokenResponse> {
  const { clientId, clientSecret } = credentials();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  return postToken(body, 'code');
}

/** Use a refresh token to get a fresh access token. Google normally does NOT
 *  rotate the refresh token, but if the response ever carries one the caller
 *  persists it (the rotation plumbing is kept platform-wide). */
export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const { clientId, clientSecret } = credentials();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  return postToken(body, 'refresh');
}

/** POST to the token endpoint with shared, grant-aware error shaping. */
async function postToken(body: URLSearchParams, grant: 'code' | 'refresh'): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const err = await res.text();
    if (res.status === 400 && err.includes('invalid_grant')) {
      // invalid_grant means different things per grant type. On a REFRESH it
      // is a dead grant (revoked consent, expired Testing-status token) —
      // connection_unauthorized, so the connection gets marked ERROR. On a
      // CODE exchange no connection exists yet: the code is expired/replayed,
      // which is the caller's input problem, not a reconnect situation.
      if (grant === 'code') {
        throw new ValidationError('code', 'the authorization code is invalid, expired, or already redeemed');
      }
      throw new ConnectionUnauthorizedError();
    }
    const failure = new Error(`Google token ${grant} exchange failed: ${err}`) as Error & { statusCode: number };
    failure.statusCode = res.status;
    throw failure;
  }
  return res.json() as Promise<TokenResponse>;
}

/**
 * Decode the email and name from the ID token (JWT) claims — the primary
 * identity source (mirrors the ms-exchange ID-token-first pattern). The
 * token comes fresh from Google's token endpoint over TLS, so no local
 * signature verification is needed here.
 */
export function decodeIdToken(idToken: string): GoogleProfile {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString());
    return {
      email: payload.email ?? null,
      name: payload.name ?? null,
    };
  } catch {
    return { email: null, name: null };
  }
}

/** Fetch the signed-in user's profile from the OpenID userinfo endpoint —
 *  the fallback when the ID token lacks claims. Fails soft to null fields. */
export async function fetchGoogleProfile(accessToken: string): Promise<GoogleProfile> {
  try {
    const res = await fetch(USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { email: null, name: null };
    const data = (await res.json()) as { email?: string; name?: string };
    return { email: data.email ?? null, name: data.name ?? null };
  } catch {
    return { email: null, name: null };
  }
}
