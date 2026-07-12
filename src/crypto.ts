/**
 * AES-256-GCM encryption for refresh tokens at rest.
 *
 * Wire format matches the other Hadron services (iv(12) ‖ authTag(16) ‖
 * ciphertext, base64). The KEY is this tool's own TOKEN_ENCRYPTION_KEY —
 * neither core's key nor hadrontool-ms-exchange's key ever ships here.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'crypto';
import { config } from './config.js';

/**
 * Constant-time string comparison — the ONE shared implementation for every
 * secret comparison in the service (bearer token, Pub/Sub verification
 * token), so a hardening change can never apply to one path and miss the
 * other.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Resolve the key buffer, failing loudly when the service runs keyless. */
function keyBuffer(): Buffer {
  if (!config.tokenEncryptionKey) {
    throw new Error('TOKEN_ENCRYPTION_KEY is not configured');
  }
  return Buffer.from(config.tokenEncryptionKey, 'hex');
}

/** Encrypt a plaintext token → base64(iv ‖ tag ‖ ciphertext). */
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBuffer(), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

/** Decrypt base64(iv ‖ tag ‖ ciphertext) → plaintext; throws on tamper. */
export function decryptToken(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', keyBuffer(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
