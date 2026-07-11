/**
 * The one error → HTTP response funnel every router uses. The actual
 * mapping lives in errors.ts (toEmailToolError) so the ops plane shares it.
 */
import type { Response } from 'express';
import { toEmailToolError } from '../errors.js';
import { logError } from '../logger.js';

/** Send the uniform JSON error response; 5xx failures are logged with the original error. */
export function respondWithError(res: Response, err: unknown, context: string): void {
  const mapped = toEmailToolError(err);
  if (mapped.httpStatus >= 500) logError(`${context} failure`, err);
  res.status(mapped.httpStatus).json(mapped.toBody());
}
