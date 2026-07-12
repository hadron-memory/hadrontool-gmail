/**
 * Express app factory. Dependencies (db, Gmail provider, event forwarder)
 * are injected so tests run the real HTTP surface over fakes.
 *
 * Route map:
 *   GET  /healthz                          liveness (public-safe, no secrets)
 *   GET  /readyz                           readiness (DB reachable)
 *   GET  /info                             capabilities (bearer-gated)
 *   POST /ops/<operation>                  operations plane   (bearer-gated, internal)
 *   *    /connections…                     connection plane   (bearer-gated, internal)
 *   POST /webhooks/gmail                   Pub/Sub push (PUBLIC — Traefik routes only this)
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { config } from './config.js';
import { logError } from './logger.js';
import type { Db } from './db.js';
import type { EventForwarder } from './events/forwarder.js';
import { requireToolToken } from './middleware/auth.js';
import { OPERATIONS } from './ops/index.js';
import type { GmailProvider } from './providers/gmail/types.js';
import { connectionsRouter } from './routes/connections.js';
import { opsRouter } from './routes/ops.js';
import { webhooksRouter } from './routes/webhooks.js';

/** Package version, surfaced on /info. */
const VERSION = process.env.npm_package_version ?? '0.1.0';

/** Build the app over injected dependencies. */
export function createApp(db: Db, provider: GmailProvider, forward: EventForwarder): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: config.maxBodySize }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/readyz', async (_req, res) => {
    try {
      await db.$queryRaw`SELECT 1`;
      res.json({ ok: true, db: true });
    } catch {
      res.status(503).json({ ok: false, db: false });
    }
  });

  app.get('/info', requireToolToken, (_req, res) => {
    res.json({
      name: 'hadrontool-gmail',
      version: VERSION,
      provider: 'gmail',
      operations: Object.keys(OPERATIONS),
      events: ['email.received', 'email.sent'],
    });
  });

  app.use('/ops', requireToolToken, opsRouter(db, provider));
  app.use('/connections', requireToolToken, connectionsRouter(db, provider));
  app.use('/webhooks', webhooksRouter(db, provider, forward));

  // Errors thrown OUTSIDE route try/catch blocks — body-parse failures
  // included — get the service's uniform JSON error shape, never Express's
  // default HTML page (which /webhooks/gmail would otherwise expose to the
  // internet).
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const isParseError = err instanceof SyntaxError || (err as { type?: string } | null)?.type === 'entity.parse.failed';
    if (isParseError) {
      res.status(400).json({ error: 'validation_error', message: 'request body is not valid JSON', field: 'body' });
      return;
    }
    logError('unhandled route error', err);
    res.status(500).json({ error: 'internal_error', message: 'internal error' });
  });

  return app;
}
