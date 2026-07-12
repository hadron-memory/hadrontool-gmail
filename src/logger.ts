/**
 * Minimal structured-ish logger (mirrors the other capability tools' posture:
 * console with a stable prefix, no logging framework until the platform
 * picks one).
 */

/** Log an informational line. */
export function logInfo(msg: string, ...args: unknown[]): void {
  console.log(`[gmail] ${msg}`, ...args);
}

/** Log an error line. */
export function logError(msg: string, ...args: unknown[]): void {
  console.error(`[gmail] ${msg}`, ...args);
}
