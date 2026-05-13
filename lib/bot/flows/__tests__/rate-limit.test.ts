import { describe, it, expect } from 'vitest';
import { checkRateLimit } from '@/lib/rate-limit';

describe('Rate Limiter', () => {
  it('allows requests within limit', () => {
    const key = `test-allow-${Date.now()}`;
    const result = checkRateLimit(key, 5, 60_000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('blocks requests exceeding limit', () => {
    const key = `test-block-${Date.now()}`;
    // Use up all 3 allowed requests
    checkRateLimit(key, 3, 60_000);
    checkRateLimit(key, 3, 60_000);
    checkRateLimit(key, 3, 60_000);

    // 4th should be blocked
    const result = checkRateLimit(key, 3, 60_000);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('resets after window expires', async () => {
    const key = `test-reset-${Date.now()}`;
    // Use all requests with 50ms window
    checkRateLimit(key, 1, 50);
    expect(checkRateLimit(key, 1, 50).allowed).toBe(false);

    // Wait for window to expire
    await new Promise(r => setTimeout(r, 60));
    const result = checkRateLimit(key, 1, 60_000);
    expect(result.allowed).toBe(true);
  });

  it('tracks separate keys independently', () => {
    const key1 = `test-independent-a-${Date.now()}`;
    const key2 = `test-independent-b-${Date.now()}`;

    // Exhaust key1
    checkRateLimit(key1, 1, 60_000);
    checkRateLimit(key1, 1, 60_000);
    expect(checkRateLimit(key1, 1, 60_000).allowed).toBe(false);

    // key2 should still be available
    expect(checkRateLimit(key2, 1, 60_000).allowed).toBe(true);
  });
});
