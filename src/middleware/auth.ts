/**
 * Bearer-token gate for the internal operations plane (mirrors the other
 * capability tools): every /ops/* and /connections* request must carry
 * `Authorization: Bearer <GMAIL_TOOL_TOKEN>`. In production the service
 * refuses to boot without the token (src/config.ts), so an unauthenticated
 * deploy cannot exist; in development an unset token disables the gate.
 */
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { safeEqual } from '../crypto.js';

/** Express middleware enforcing the shared bearer token when configured. */
export function requireToolToken(req: Request, res: Response, next: NextFunction): void {
  if (!config.toolToken) {
    next(); // development only — production boot requires the token
    return;
  }
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !safeEqual(token, config.toolToken)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}
