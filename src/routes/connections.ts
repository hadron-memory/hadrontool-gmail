/**
 * Connection lifecycle — internal plane (bearer-gated).
 *
 * OAuth handoff (#396 / #580): hadron-server owns the user-facing flow and
 * the callback URL; this tool owns the client secret and the tokens. Core's
 * callback forwards the authorization code here; the tool exchanges it,
 * derives the mailbox identity (ID-token claims first, OpenID userinfo
 * fallback), stores the encrypted refresh token, and returns the identity.
 * Core stores only that identity.
 *
 * Unlike hadrontool-ms-exchange there is NO raw-token import path — that was
 * the one-time core→tool migration for legacy Microsoft tokens; Gmail is
 * greenfield, so the smaller surface wins.
 */
import { Router } from 'express';
import { z } from 'zod';
import { encryptToken } from '../crypto.js';
import type { Db } from '../db.js';
import { ConnectionNotFoundError, ValidationError } from '../errors.js';
import { logInfo } from '../logger.js';
import { decodeIdToken } from '../providers/gmail/auth.js';
import type { GmailProvider } from '../providers/gmail/types.js';
import { isSubscribableFolder, registerFolderSubscription, stopWatchForConnection } from '../watches.js';
import { respondWithError } from './respond.js';

const createSchema = z.object({
  code: z.string().min(1),
  redirectUri: z.string().min(1),
});

const subscribeSchema = z.object({
  folder: z
    .string()
    .min(1)
    .transform((f) => f.toLowerCase()),
});

/** Build the /connections router over injected db + provider. */
export function connectionsRouter(db: Db, provider: GmailProvider): Router {
  const router = Router();

  // Create a connection from an OAuth authorization code.
  router.post('/', async (req, res) => {
    try {
      const input = createSchema.parse(req.body ?? {});

      const tokens = await provider.exchangeCode(input.code, input.redirectUri);
      // Google returns a refresh token only when the authorize URL carried
      // access_type=offline&prompt=consent — surface the real cause, not a
      // crypto crash.
      if (!tokens.refresh_token) {
        throw new ValidationError(
          'code',
          'Google did not return a refresh token — the authorize URL must carry access_type=offline&prompt=consent',
        );
      }

      // ID-token claims first, userinfo fallback.
      const idClaims = decodeIdToken(tokens.id_token ?? '');
      let mailboxEmail = idClaims.email;
      let displayName = idClaims.name;
      if (!mailboxEmail || !displayName) {
        const profile = await provider.fetchProfile(tokens.access_token);
        mailboxEmail = mailboxEmail ?? profile.email;
        displayName = displayName ?? profile.name;
      }
      if (!mailboxEmail) {
        throw new ValidationError('code', 'could not determine the mailbox email from the Google account');
      }

      const connection = await db.connection.create({
        data: {
          mailboxEmail,
          displayName: displayName ?? null,
          refreshTokenEnc: encryptToken(tokens.refresh_token),
        },
      });
      logInfo(`connection created for ${connection.mailboxEmail} (${connection.id})`);
      res.status(201).json({
        id: connection.id,
        provider: connection.provider,
        mailboxEmail: connection.mailboxEmail,
        displayName: connection.displayName,
        status: connection.status,
      });
    } catch (err) {
      respondWithError(res, err, 'create connection');
    }
  });

  // Connection identity + watch/subscription state.
  router.get('/:id', async (req, res) => {
    try {
      const connection = await db.connection.findUnique({
        where: { id: req.params.id },
        include: { watch: true, subscribedFolders: true },
      });
      if (!connection || connection.deletedAt) throw new ConnectionNotFoundError();
      res.json({
        id: connection.id,
        provider: connection.provider,
        mailboxEmail: connection.mailboxEmail,
        displayName: connection.displayName,
        status: connection.status,
        lastError: connection.lastError,
        // Presented in the same shape as hadrontool-ms-exchange: one entry
        // per subscribed folder, expiry from the mailbox-level watch.
        subscriptions: connection.subscribedFolders.map((f) => ({
          folder: f.folder,
          expiresAt: connection.watch?.expiresAt.toISOString() ?? null,
        })),
      });
    } catch (err) {
      respondWithError(res, err, 'get connection');
    }
  });

  // Disconnect: best-effort watch teardown, then soft-delete.
  router.delete('/:id', async (req, res) => {
    try {
      const connection = await db.connection.findUnique({
        where: { id: req.params.id },
        include: { watch: true },
      });
      if (!connection || connection.deletedAt) throw new ConnectionNotFoundError();

      if (connection.watch) {
        // Gmail's users.stop is ACCOUNT-wide — one watch per mailbox, not
        // per connection. When any other active connection exists for the
        // same mailbox (a second org, or the new connection minted by a
        // reconnect whose old-connection delete races this one), stopping
        // would kill ITS push feed too — skip the provider call and only
        // drop this connection's rows.
        const siblings = await db.connection.count({
          where: { mailboxEmail: connection.mailboxEmail, deletedAt: null, id: { not: connection.id } },
        });
        if (siblings === 0) {
          await stopWatchForConnection(db, provider, connection.id);
        } else {
          logInfo(
            `skipping users.stop for ${connection.mailboxEmail} — ${siblings} sibling connection(s) still watch this mailbox`,
          );
        }
        await db.watch.delete({ where: { id: connection.watch.id } }).catch(() => {});
      }
      await db.subscribedFolder.deleteMany({ where: { connectionId: connection.id } });
      await db.connection.update({ where: { id: connection.id }, data: { deletedAt: new Date() } });
      res.json({ deleted: true });
    } catch (err) {
      respondWithError(res, err, 'delete connection');
    }
  });

  // Subscribe a folder to event forwarding (registers the mailbox watch).
  router.post('/:id/subscriptions', async (req, res) => {
    try {
      const { folder } = subscribeSchema.parse(req.body ?? {});
      if (!isSubscribableFolder(folder)) {
        throw new ValidationError('folder', `folder must be a subscribable folder (inbox, sentitems)`);
      }
      const connection = await db.connection.findUnique({ where: { id: req.params.id } });
      if (!connection || connection.deletedAt) throw new ConnectionNotFoundError();

      const row = await registerFolderSubscription(db, provider, connection.id, folder);
      res.status(201).json({ folder: row.folder, expiresAt: row.expiresAt.toISOString() });
    } catch (err) {
      respondWithError(res, err, 'subscribe folder');
    }
  });

  return router;
}
