/**
 * Public push ingress — the ONLY publicly exposed route (Traefik routes just
 * <public host>/webhooks/gmail here; the operations plane stays internal).
 *
 * Cloud Pub/Sub push contract:
 *  - POST body: `{ message: { data: base64(JSON), messageId, … }, subscription }`
 *    where the decoded data is Gmail's `{ emailAddress, historyId }`.
 *  - Delivery is at-least-once; a 2xx acks, anything else is retried.
 *
 * Authenticity: the push subscription's endpoint URL carries
 * `?token=<PUBSUB_VERIFICATION_TOKEN>` (configured in GCP), verified
 * constant-time before any work — the Pub/Sub-recommended shared-token
 * scheme. There is no Graph-style clientState; the notification carries no
 * per-connection secret.
 *
 * The 204 ack is sent immediately; processing is async. A processing
 * failure is NOT lost: the history cursor only advances on success, so the
 * next notification (or the worker's sweep) retries the same delta.
 */
import { Router } from 'express';
import { config } from '../config.js';
import { safeEqual } from '../crypto.js';
import type { Db } from '../db.js';
import type { EventForwarder } from '../events/forwarder.js';
import { logError } from '../logger.js';
import { processPushNotification } from '../history.js';
import type { GmailProvider } from '../providers/gmail/types.js';

/** Decode the Pub/Sub envelope into Gmail's notification payload. */
function decodeNotification(body: unknown): { emailAddress: string; historyId: string } | null {
  const data = (body as { message?: { data?: unknown } } | null)?.message?.data;
  if (typeof data !== 'string') return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as {
      emailAddress?: unknown;
      historyId?: unknown;
    };
    if (typeof parsed.emailAddress !== 'string' || parsed.emailAddress === '') return null;
    const historyId = typeof parsed.historyId === 'number' ? String(parsed.historyId) : parsed.historyId;
    if (typeof historyId !== 'string' || historyId === '') return null;
    return { emailAddress: parsed.emailAddress, historyId };
  } catch {
    return null;
  }
}

/**
 * Build the /webhooks router over injected db + provider + forwarder.
 *
 * `onProcessing` is a test-only seam: the push is acked immediately and the
 * history processing runs fire-and-forget, so tests need a handle on that
 * promise to await it deterministically (a fixed sleep is racy under load).
 * Production passes nothing.
 */
export function webhooksRouter(
  db: Db,
  provider: GmailProvider,
  forward: EventForwarder,
  onProcessing?: (p: Promise<void>) => void,
): Router {
  const router = Router();

  router.post('/gmail', (req, res) => {
    // Verification token first — an unverified push does no DB-driven work.
    if (!config.pubsubVerificationToken) {
      // Development-only posture (production boot requires the token):
      // refuse rather than process unauthenticated pushes.
      res.status(503).json({ error: 'pubsub_not_configured' });
      return;
    }
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!token || !safeEqual(token, config.pubsubVerificationToken)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const notification = decodeNotification(req.body);
    // Malformed payloads are acked and dropped — retrying cannot fix them.
    res.status(204).end();
    if (!notification) return;

    const processing = processPushNotification(
      db,
      provider,
      forward,
      notification.emailAddress,
      notification.historyId,
    ).catch((err) => logError('push notification processing crashed', err));
    onProcessing?.(processing);
  });

  return router;
}
