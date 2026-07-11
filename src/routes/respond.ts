/**
 * The one error → HTTP response funnel every router uses, so the mapping
 * (zod flattening, typed-error passthrough, provider mapping, 5xx logging)
 * cannot drift between planes.
 */
import type { Response } from 'express';
import { z } from 'zod';
import { EmailToolError, mapGmailError, validationFromZod } from '../errors.js';
import { logError } from '../logger.js';

/** Convert any thrown value to a typed EmailToolError. */
export function toEmailToolError(err: unknown): EmailToolError {
  if (err instanceof z.ZodError) return validationFromZod(err);
  if (err instanceof EmailToolError) return err;
  return mapGmailError(err);
}

/** Send the uniform JSON error response; 5xx failures are logged with the original error. */
export function respondWithError(res: Response, err: unknown, context: string): void {
  const mapped = toEmailToolError(err);
  if (mapped.httpStatus >= 500) logError(`${context} failure`, err);
  res.status(mapped.httpStatus).json(mapped.toBody());
}
