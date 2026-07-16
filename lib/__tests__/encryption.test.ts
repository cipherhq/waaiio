import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * Tests for token encryption/decryption (lib/encryption.ts).
 * Uses AES-256-GCM with format: iv:authTag:ciphertext (all hex).
 *
 * Each test sets TOKEN_ENCRYPTION_KEY before dynamically importing
 * the module, because the module reads the env var at import time.
 */

// 64 hex chars = 32 bytes for AES-256
const TEST_KEY = 'a'.repeat(64);

describe('Token encryption', () => {
  let originalKey: string | undefined;
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalKey = process.env.TOKEN_ENCRYPTION_KEY;
    originalNodeEnv = process.env.NODE_ENV;
    // Force non-production so dev fallbacks apply for error paths
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.TOKEN_ENCRYPTION_KEY = originalKey;
    } else {
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
    if (originalNodeEnv !== undefined) {
      process.env.NODE_ENV = originalNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
    // Clear module cache so next import picks up new env var
    vi.resetModules();
  });

  it('encryptToken and decryptToken are inverses', async () => {
    process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
    const { encryptToken, decryptToken } = await import('@/lib/encryption');

    const plaintext = 'EAABsbCS1iHOBO_test_meta_token_value_12345';
    const encrypted = encryptToken(plaintext);

    // Encrypted should not equal plaintext
    expect(encrypted).not.toBe(plaintext);
    // Should be in iv:tag:ciphertext format
    expect(encrypted.split(':')).toHaveLength(3);

    const decrypted = decryptToken(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('decryptToken handles plaintext gracefully (no colons)', async () => {
    process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
    const { decryptToken } = await import('@/lib/encryption');

    const plaintext = 'not_encrypted_token';
    const result = decryptToken(plaintext);
    expect(result).toBe(plaintext);
  });

  it('decryptToken handles plaintext with fewer than 3 colon segments', async () => {
    process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
    const { decryptToken } = await import('@/lib/encryption');

    // A value with one colon (2 segments) should be treated as plaintext
    const result = decryptToken('abc:def');
    expect(result).toBe('abc:def');
  });

  it('encrypted output is different each time (random IV)', async () => {
    process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
    const { encryptToken } = await import('@/lib/encryption');

    const plaintext = 'same_token_value';
    const enc1 = encryptToken(plaintext);
    const enc2 = encryptToken(plaintext);

    // Different IVs produce different ciphertexts
    expect(enc1).not.toBe(enc2);

    // But both should have 3 segments
    expect(enc1.split(':')).toHaveLength(3);
    expect(enc2.split(':')).toHaveLength(3);
  });

  it('roundtrips unicode content', async () => {
    process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
    const { encryptToken, decryptToken } = await import('@/lib/encryption');

    const unicode = 'Token with emojis and accents: cafe\u0301 \u2615';
    const encrypted = encryptToken(unicode);
    const decrypted = decryptToken(encrypted);
    expect(decrypted).toBe(unicode);
  });

  it('roundtrips empty string', async () => {
    process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
    const { encryptToken, decryptToken } = await import('@/lib/encryption');

    const encrypted = encryptToken('');
    const decrypted = decryptToken(encrypted);
    expect(decrypted).toBe('');
  });

  it('encryption output segments are valid hex', async () => {
    process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
    const { encryptToken } = await import('@/lib/encryption');

    const encrypted = encryptToken('test_value');
    const [iv, tag, ciphertext] = encrypted.split(':');

    const hexRegex = /^[0-9a-f]+$/;
    expect(iv).toMatch(hexRegex);
    expect(tag).toMatch(hexRegex);
    expect(ciphertext).toMatch(hexRegex);

    // IV should be 12 bytes = 24 hex chars
    expect(iv).toHaveLength(24);
    // Auth tag should be 16 bytes = 32 hex chars
    expect(tag).toHaveLength(32);
  });
});
