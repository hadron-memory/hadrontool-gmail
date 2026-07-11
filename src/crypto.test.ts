import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken, safeEqual } from './crypto.js';

describe('token encryption', () => {
  it('round-trips a token', () => {
    const enc = encryptToken('rt-secret-token');
    expect(enc).not.toContain('rt-secret-token');
    expect(decryptToken(enc)).toBe('rt-secret-token');
  });

  it('uses a fresh IV per encryption (same plaintext, different ciphertext)', () => {
    expect(encryptToken('same')).not.toBe(encryptToken('same'));
  });

  it('throws on tampered ciphertext', () => {
    const enc = encryptToken('rt-secret-token');
    const buf = Buffer.from(enc, 'base64');
    buf[buf.length - 1] ^= 0xff;
    expect(() => decryptToken(buf.toString('base64'))).toThrow();
  });
});

describe('safeEqual', () => {
  it('matches equal strings and rejects different ones', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});
