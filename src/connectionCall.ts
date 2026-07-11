/**
 * The ONE lifecycle wrapper for every Gmail call made on behalf of a
 * connection — used by the ops plane, the push-notification plane, the watch
 * renewal worker, and the connection routes alike, so the invariants can't
 * drift per plane:
 *
 *  1. load the ACTIVE connection (typed connection_not_found /
 *     connection_unauthorized; a stored ERROR status short-circuits),
 *  2. decrypt the refresh token with the tool's key,
 *  3. run the provider call,
 *  4. persist refresh-token rotation — on SUCCESS and on FAILURE (withToken
 *     attaches `newRefreshToken` to thrown errors when the refresh succeeded
 *     before the API call failed; Google rarely rotates, but losing a
 *     rotation strands the connection — platform invariant),
 *  5. map provider failures to the typed catalog, marking the connection
 *     ERROR on connection_unauthorized so later calls short-circuit until
 *     the user reconnects.
 */
import { decryptToken, encryptToken } from './crypto.js';
import type { Db } from './db.js';
import { ConnectionNotFoundError, ConnectionUnauthorizedError, mapGmailError } from './errors.js';
import { logError } from './logger.js';
import type { GmailCallResult } from './providers/gmail/types.js';

/** Optional hint improving not_found error payloads. */
export type ResourceHint = { resource: 'message' | 'draft' | 'folder'; id: string } | undefined;

/**
 * Persist a rotated refresh token. Non-fatal on failure (the op itself may
 * have succeeded) but logged loudly — a lost rotation strands the connection.
 */
async function persistRotation(db: Db, connectionId: string, newRefreshToken: string | undefined): Promise<void> {
  if (!newRefreshToken) return;
  try {
    await db.connection.update({
      where: { id: connectionId },
      data: { refreshTokenEnc: encryptToken(newRefreshToken) },
    });
  } catch (err) {
    logError(`failed to persist rotated refresh token for connection ${connectionId}`, err);
  }
}

/** Run a provider call for a connection with the full lifecycle above. */
export async function withConnection<T>(
  db: Db,
  connectionId: string,
  resourceHint: ResourceHint,
  fn: (refreshToken: string) => Promise<GmailCallResult<T>>,
): Promise<T> {
  const connection = await db.connection.findUnique({ where: { id: connectionId } });
  if (!connection || connection.deletedAt) throw new ConnectionNotFoundError();
  if (connection.status === 'ERROR') throw new ConnectionUnauthorizedError();
  const refreshToken = decryptToken(connection.refreshTokenEnc);

  try {
    const result = await fn(refreshToken);
    await persistRotation(db, connectionId, result.newRefreshToken);
    return result.data;
  } catch (err) {
    await persistRotation(db, connectionId, (err as { newRefreshToken?: string } | null)?.newRefreshToken);
    const mapped = mapGmailError(err, resourceHint);
    if (mapped instanceof ConnectionUnauthorizedError) {
      await db.connection
        .update({
          where: { id: connectionId },
          data: { status: 'ERROR', lastError: 'provider auth failure — user must reconnect' },
        })
        .catch(() => {});
    }
    throw mapped;
  }
}
