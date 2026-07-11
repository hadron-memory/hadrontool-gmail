/**
 * Event plane, tool → core (same seam as hadrontool-ms-exchange): normalized
 * email events are POSTed to hadron-server's internal ingress over HTTP now,
 * designed so the transport can wrap behind a NATS subject later without
 * touching callers. Unset CORE_EVENTS_URL ⇒ events are logged and dropped —
 * a missing consumer never breaks notification handling.
 */
import { config } from '../config.js';
import { logError, logInfo } from '../logger.js';
import type { EmailMessage } from '../ops/index.js';

/** Normalized event delivered to core's /internal/email-events ingress. */
export interface EmailEvent {
  /** `email.received` (inbox) or `email.sent` (sentitems). */
  event: 'email.received' | 'email.sent';
  connectionId: string;
  folder: string;
  message: EmailMessage;
}

/** Signature of the forwarder — injectable for tests. A REJECTION means the
 *  event was not delivered: history processing releases the dedupe row and
 *  holds the cursor back so the delta is retried. Swallowing failures here
 *  would silently defeat the at-least-once mechanism. */
export type EventForwarder = (event: EmailEvent) => Promise<void>;

/** Production forwarder: POST to core with the events bearer token. Unset
 *  CORE_EVENTS_URL is a deliberate no-consumer deploy → log + drop (success);
 *  a configured-but-failing ingress THROWS so the caller retries. */
export const forwardEventToCore: EventForwarder = async (event) => {
  if (!config.coreEventsUrl) {
    logInfo(`event ${event.event} for connection ${event.connectionId} dropped (CORE_EVENTS_URL unset)`);
    return;
  }
  const res = await fetch(config.coreEventsUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.coreEventsToken ? { authorization: `Bearer ${config.coreEventsToken}` } : {}),
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    logError(`core event ingress returned ${res.status} for ${event.event} (connection ${event.connectionId})`);
    throw new Error(`core event ingress returned ${res.status}`);
  }
};
