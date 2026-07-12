/**
 * Operations plane — POST /ops/<operation> (internal, bearer-gated).
 *
 * The request body carries the operation input (spec 002 shapes) plus an
 * optional `idempotencyKey` for mutating operations; every response is JSON.
 * Errors use the typed catalog (src/errors.ts) — hadron-server's emailClient
 * passes the `error` code through to GraphQL/MCP verbatim.
 */
import { Router } from 'express';
import type { Db } from '../db.js';
import { OPERATIONS, runOperation } from '../ops/index.js';
import type { GmailProvider } from '../providers/gmail/types.js';
import { respondWithError } from './respond.js';

/** Build the /ops router over injected db + provider. */
export function opsRouter(db: Db, provider: GmailProvider): Router {
  const router = Router();

  router.post('/:operation', async (req, res) => {
    const name = req.params.operation;
    if (!OPERATIONS[name]) {
      res.status(404).json({ error: 'unknown_operation', message: `No operation "${name}"`, operations: Object.keys(OPERATIONS) });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { idempotencyKey, ...input } = body;
    try {
      const { result, replayed } = await runOperation(
        db,
        provider,
        name,
        input,
        typeof idempotencyKey === 'string' ? idempotencyKey : undefined,
      );
      res.status(200).json({ ok: true, replayed, ...(result as Record<string, unknown>) });
    } catch (err) {
      respondWithError(res, err, `operation ${name}`);
    }
  });

  return router;
}
