/**
 * Paystack Reconciliation 400 — Executable behavioral tests
 *
 * Tests the extracted paystack-reconciliation helper with mocks/stubs
 * to prove runtime financial behavior without live Paystack calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolvePaystackKey, verifyPaystackPayment } from '@/lib/payments/paystack-reconciliation';

// ═══════════════════════════════════════════════════════════════════════
// Mock setup
// ═══════════════════════════════════════════════════════════════════════

vi.mock('@/lib/encryption', () => ({
  decryptToken: vi.fn((stored: string) => {
    if (stored === 'DECRYPT_FAIL') throw new Error('Decryption failed');
    return `decrypted_${stored}`;
  }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const PLATFORM_KEY = 'fake_platform_key_for_test';
const MERCHANT_KEY_ENCRYPTED = 'merchant_encrypted_key';
const MERCHANT_KEY_DECRYPTED = 'decrypted_merchant_encrypted_key';

function mockSupabase(credResult: { data: any; error: any }) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnThis(),
        not: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue(credResult),
        }),
      }),
    }),
  } as any;
}

// ═══════════════════════════════════════════════════════════════════════
// A. BYO payment + active verified credential
// ═══════════════════════════════════════════════════════════════════════

describe('resolvePaystackKey', () => {
  beforeEach(() => {
    vi.stubEnv('PAYSTACK_SECRET_KEY', PLATFORM_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('BYO payment resolves merchant key (not platform key)', async () => {
    const supabase = mockSupabase({ data: { secret_key: MERCHANT_KEY_ENCRYPTED }, error: null });
    const payment = { id: 'pay-1', gateway: 'paystack', gateway_reference: 'ref-1', business_id: 'biz-1', metadata: { byo: true } };

    const { key, skip } = await resolvePaystackKey(supabase, payment);

    expect(skip).toBe(false);
    expect(key).toBe(MERCHANT_KEY_DECRYPTED);
    expect(key).not.toBe(PLATFORM_KEY);
  });

  it('platform payment uses PAYSTACK_SECRET_KEY', async () => {
    const supabase = mockSupabase({ data: null, error: null });
    const payment = { id: 'pay-2', gateway: 'paystack', gateway_reference: 'ref-2', business_id: 'biz-1', metadata: null };

    const { key, skip } = await resolvePaystackKey(supabase, payment);

    expect(skip).toBe(false);
    expect(key).toBe(PLATFORM_KEY);
  });

  it('BYO without metadata.byo uses platform key', async () => {
    const supabase = mockSupabase({ data: null, error: null });
    const payment = { id: 'pay-3', gateway: 'paystack', gateway_reference: 'ref-3', business_id: 'biz-1', metadata: { byo: false } };

    const { key, skip } = await resolvePaystackKey(supabase, payment);

    expect(skip).toBe(false);
    expect(key).toBe(PLATFORM_KEY);
  });

  // C. BYO credential missing
  it('BYO with no credential → skip (no mutation)', async () => {
    const supabase = mockSupabase({ data: null, error: null });
    const payment = { id: 'pay-4', gateway: 'paystack', gateway_reference: 'ref-4', business_id: 'biz-1', metadata: { byo: true } };

    const { key, skip } = await resolvePaystackKey(supabase, payment);

    expect(skip).toBe(true);
    expect(key).toBeUndefined();
  });

  // D. BYO credential query database error
  it('BYO credential DB error → skip (no mutation)', async () => {
    const supabase = mockSupabase({ data: null, error: { message: 'DB connection failed' } });
    const payment = { id: 'pay-5', gateway: 'paystack', gateway_reference: 'ref-5', business_id: 'biz-1', metadata: { byo: true } };

    const { key, skip } = await resolvePaystackKey(supabase, payment);

    expect(skip).toBe(true);
    expect(key).toBeUndefined();
  });

  // E. BYO decryption failure
  it('BYO decryption failure → skip (no mutation)', async () => {
    const supabase = mockSupabase({ data: { secret_key: 'DECRYPT_FAIL' }, error: null });
    const payment = { id: 'pay-6', gateway: 'paystack', gateway_reference: 'ref-6', business_id: 'biz-1', metadata: { byo: true } };

    const { key, skip } = await resolvePaystackKey(supabase, payment);

    expect(skip).toBe(true);
    expect(key).toBeUndefined();
  });

  it('BYO without business_id → skip', async () => {
    const supabase = mockSupabase({ data: null, error: null });
    const payment = { id: 'pay-7', gateway: 'paystack', gateway_reference: 'ref-7', business_id: null, metadata: { byo: true } };

    const { key, skip } = await resolvePaystackKey(supabase, payment);

    expect(skip).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Paystack verification HTTP handling
// ═══════════════════════════════════════════════════════════════════════

describe('verifyPaystackPayment', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // F. Paystack 400 + "Transaction reference not found"
  it('400 + "Transaction reference not found" → failed', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue('{"status":false,"message":"Transaction reference not found"}'),
    });

    const result = await verifyPaystackPayment('invalid-ref', 'fake_key_for_test');
    expect(result).toBe('failed');
  });

  // G. Paystack 400 + "Transaction reference is invalid"
  it('400 + "Transaction reference is invalid" → failed', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue('{"status":false,"message":"Transaction reference is invalid"}'),
    });

    const result = await verifyPaystackPayment('bad-ref', 'fake_key_for_test');
    expect(result).toBe('failed');
  });

  it('400 + "transaction not found" (lowercase) → failed', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue('{"status":false,"message":"transaction not found"}'),
    });

    const result = await verifyPaystackPayment('ref', 'fake_key_for_test');
    expect(result).toBe('failed');
  });

  // H. Generic 400 (non-reference error) → throws (payment stays pending)
  it('400 + generic validation error → throws (NOT failed)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue('{"status":false,"message":"Invalid amount format"}'),
    });

    await expect(verifyPaystackPayment('ref', 'fake_key_for_test')).rejects.toThrow('Paystack API 400');
  });

  // I. 401 → throws (NOT failed, credential problem)
  it('401 → throws (NOT failed)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue('Unauthorized'),
    });

    await expect(verifyPaystackPayment('ref', 'fake_key_for_test')).rejects.toThrow('Paystack API error: 401');
  });

  it('403 → throws (NOT failed)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: vi.fn().mockResolvedValue('Forbidden'),
    });

    await expect(verifyPaystackPayment('ref', 'fake_key_for_test')).rejects.toThrow('Paystack API error: 403');
  });

  // 404 → failed (existing behavior)
  it('404 → failed', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });

    const result = await verifyPaystackPayment('ref', 'fake_key_for_test');
    expect(result).toBe('failed');
  });

  // J. Successful verification
  it('200 + status=success → paid', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: { status: 'success' } }),
    });

    const result = await verifyPaystackPayment('ref', 'fake_key_for_test');
    expect(result).toBe('paid');
  });

  it('200 + status=failed → failed', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: { status: 'failed' } }),
    });

    const result = await verifyPaystackPayment('ref', 'fake_key_for_test');
    expect(result).toBe('failed');
  });

  it('200 + status=abandoned → failed', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: { status: 'abandoned' } }),
    });

    const result = await verifyPaystackPayment('ref', 'fake_key_for_test');
    expect(result).toBe('failed');
  });

  it('200 + status=pending → pending', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: { status: 'pending' } }),
    });

    const result = await verifyPaystackPayment('ref', 'fake_key_for_test');
    expect(result).toBe('pending');
  });

  // Verify the Authorization header uses the provided key
  it('uses provided secret key in Authorization header', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: { status: 'success' } }),
    });
    globalThis.fetch = mockFetch;

    await verifyPaystackPayment('test-ref', 'fake_merchant_key_for_test');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('test-ref'),
      expect.objectContaining({
        headers: { Authorization: 'Bearer fake_merchant_key_for_test' },
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// K. Source regression guard — Stripe unchanged
// ═══════════════════════════════════════════════════════════════════════

describe('Stripe behavior unchanged (source guard)', () => {
  it('route still uses verifyStripePayment for stripe gateway', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../app/api/cron/payment-reconciliation/route.ts'),
      'utf-8',
    );
    // Stripe verification uses process.env.STRIPE_SECRET_KEY
    expect(source).toContain('process.env.STRIPE_SECRET_KEY');
    // Stripe path does not use resolvePaystackKey
    const stripeFn = source.split('async function verifyStripePayment')[1];
    expect(stripeFn).toBeDefined();
    expect(stripeFn).not.toContain('resolvePaystackKey');
  });
});
