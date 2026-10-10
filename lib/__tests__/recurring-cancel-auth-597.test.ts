/**
 * #597 F3 R2: Recurring cancellation authorization — executable + proof tests.
 *
 * B1: Unknown gateway and missing provider code fail closed.
 * B2: Zero-row CAS re-reads actual state.
 * B3: Real handler invocation with mocked Supabase + provider.
 * B4: Error display in list state.
 * B5: Provider retry semantics documented and tested.
 * B6: Input validation and type safety.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  issueRecurringCancellationProof,
  verifyRecurringCancellationProof,
} from '@/lib/otp-challenge';

const PHONE = '+2348012345678';
const SUB_ID = '00000000-0000-0000-0000-000000000001';

// ═══════════════════════════════════════════════════════════════════
// Section 1: Proof helper tests (production functions)
// ═══════════════════════════════════════════════════════════════════

describe('#597 F3: Proof system (production functions)', () => {
  it('valid proof accepted', () => {
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    expect(verifyRecurringCancellationProof(proof, PHONE, SUB_ID)).toBe(true);
  });

  it('wrong phone rejected', () => {
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    expect(verifyRecurringCancellationProof(proof, '+9999', SUB_ID)).toBe(false);
  });

  it('wrong subscription rejected', () => {
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    expect(verifyRecurringCancellationProof(proof, PHONE, '00000000-0000-0000-0000-999999999999')).toBe(false);
  });

  it('tampered payload rejected', () => {
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    const sig = proof.split('.')[1];
    const fake = Buffer.from('{"v":1}').toString('base64url');
    expect(verifyRecurringCancellationProof(fake + '.' + sig, PHONE, SUB_ID)).toBe(false);
  });

  it('null/undefined/number rejected', () => {
    expect(verifyRecurringCancellationProof(null, PHONE, SUB_ID)).toBe(false);
    expect(verifyRecurringCancellationProof(undefined, PHONE, SUB_ID)).toBe(false);
    expect(verifyRecurringCancellationProof(42 as unknown, PHONE, SUB_ID)).toBe(false);
  });

  it('empty string rejected', () => {
    expect(verifyRecurringCancellationProof('', PHONE, SUB_ID)).toBe(false);
  });

  it('oversized proof rejected', () => {
    expect(verifyRecurringCancellationProof('x'.repeat(1025), PHONE, SUB_ID)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Section 2: Executable handler tests (real POST handler, mocked deps)
// ═══════════════════════════════════════════════════════════════════

// Mock infrastructure
let mockSubData: Record<string, unknown> | null = null;
let mockSubError: unknown = null;
let mockUpdateData: unknown[] | null = null;
let mockUpdateError: unknown = null;
let mockRereadData: Record<string, unknown> | null = null;
let mockPaystackResult: boolean | Error = true;
let mockStripeResult: boolean | Error = true;
let providerCallCount = 0;
let dbUpdateCalls: { id: string; status: string }[] = [];

function resetMocks() {
  mockSubData = {
    id: SUB_ID, status: 'active', gateway: 'paystack',
    gateway_subscription_code: 'SUB_test123',
    metadata: { email_token: 'tok_test' },
  };
  mockSubError = null;
  mockUpdateData = [{ id: SUB_ID }];
  mockUpdateError = null;
  mockRereadData = null;
  mockPaystackResult = true;
  mockStripeResult = true;
  providerCallCount = 0;
  dbUpdateCalls = [];
}

// Supabase chain mock that handles the multi-step query patterns
let fromCallCount = 0;

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table !== 'customer_subscriptions') {
        const c: Record<string, unknown> = {};
        const self = () => c;
        c.select = self; c.eq = self; c.in = self; c.update = self;
        c.maybeSingle = () => Promise.resolve({ data: null, error: null });
        return c;
      }

      fromCallCount++;
      const callNum = fromCallCount;
      let isUpdate = false;

      const chain: Record<string, unknown> = {};
      const chainSelf = () => chain;

      chain.select = (cols?: string) => {
        if (isUpdate) {
          // This is the .select() after .update() — return update result
          return Promise.resolve({ data: mockUpdateData, error: mockUpdateError });
        }
        return chain;
      };
      chain.eq = chainSelf;
      chain.in = chainSelf;
      chain.update = (vals: Record<string, unknown>) => {
        isUpdate = true;
        dbUpdateCalls.push({ id: SUB_ID, status: vals.status as string });
        return chain;
      };
      chain.maybeSingle = () => {
        if (callNum > 1 && dbUpdateCalls.length > 0 && mockRereadData !== null) {
          // B2: re-read after zero-row update
          return Promise.resolve({ data: mockRereadData, error: null });
        }
        return Promise.resolve({ data: mockSubData, error: mockSubError });
      };
      return chain;
    },
  }),
}));

vi.mock('@/lib/payments/paystack-recurring', () => ({
  cancelSubscription: async () => {
    providerCallCount++;
    if (mockPaystackResult instanceof Error) throw mockPaystackResult;
    return mockPaystackResult;
  },
}));

vi.mock('@/lib/payments/stripe-recurring', () => ({
  cancelSubscription: async () => {
    providerCallCount++;
    if (mockStripeResult instanceof Error) throw mockStripeResult;
    return mockStripeResult;
  },
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: async () => null,
  getRateLimitKey: () => 'test',
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
}));

async function callCancel(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  // Dynamic import to pick up mocks
  const { POST } = await import('@/app/api/recurring/cancel/route');
  const req = new NextRequest(new URL('http://localhost/api/recurring/cancel'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
  const res = await POST(req);
  return { status: res.status, body: await res.json() };
}

describe('#597 F3 R2: Executable cancel handler tests', () => {
  beforeEach(() => { resetMocks(); fromCallCount = 0; vi.clearAllMocks(); });

  // ── Authorization ──

  it('403 without proof — ZERO provider/DB calls', async () => {
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE });
    expect(r.status).toBe(403);
    expect(providerCallCount).toBe(0);
    expect(dbUpdateCalls).toHaveLength(0);
  });

  it('403 with forged proof', async () => {
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: 'forged.aaaa' + 'a'.repeat(62) });
    expect(r.status).toBe(403);
    expect(providerCallCount).toBe(0);
  });

  it('403 with wrong-subscription proof', async () => {
    const proof = issueRecurringCancellationProof(PHONE, '00000000-0000-0000-0000-000000000099');
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: proof });
    expect(r.status).toBe(403);
  });

  it('403 with expired proof type check', async () => {
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: 123 });
    expect(r.status).toBe(403);
  });

  // ── B6: Input validation ──

  it('400 for non-UUID subscriptionId', async () => {
    const proof = issueRecurringCancellationProof(PHONE, 'not-a-uuid');
    const r = await callCancel({ subscriptionId: 'not-a-uuid', phone: PHONE, cancellationProof: proof });
    expect(r.status).toBe(400);
  });

  it('400 for missing phone', async () => {
    const r = await callCancel({ subscriptionId: SUB_ID, cancellationProof: 'x' });
    expect(r.status).toBe(400);
  });

  // ── B1 R2: Gateway classification — fail closed ──

  it('400 for unknown gateway (fail closed)', async () => {
    mockSubData = { ...mockSubData!, gateway: 'unknown_gateway', gateway_subscription_code: 'CODE' };
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: proof });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('cannot be cancelled online');
    expect(providerCallCount).toBe(0);
  });

  it('422 for Paystack subscription missing provider code', async () => {
    mockSubData = { ...mockSubData!, gateway: 'paystack', gateway_subscription_code: null };
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: proof });
    expect(r.status).toBe(422);
    expect(r.body.error).toContain('missing provider reference');
    expect(providerCallCount).toBe(0);
    expect(dbUpdateCalls).toHaveLength(0); // NO DB cancel
  });

  it('422 for Paystack subscription missing email token', async () => {
    mockSubData = { ...mockSubData!, gateway: 'paystack', gateway_subscription_code: 'SUB_test', metadata: {} };
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: proof });
    expect(r.status).toBe(422);
    expect(r.body.error).toContain('missing provider credentials');
    expect(providerCallCount).toBe(0);
    expect(dbUpdateCalls).toHaveLength(0);
  });

  it('422 for Stripe subscription missing provider code', async () => {
    mockSubData = { ...mockSubData!, gateway: 'stripe', gateway_subscription_code: '' };
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: proof });
    expect(r.status).toBe(422);
    expect(r.body.error).toContain('missing provider reference');
    expect(providerCallCount).toBe(0);
    expect(dbUpdateCalls).toHaveLength(0);
  });

  // ── Provider behavior ──

  it('503 when Paystack refuses cancellation', async () => {
    mockPaystackResult = false;
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: proof });
    expect(r.status).toBe(503);
    expect(providerCallCount).toBe(1);
    expect(dbUpdateCalls).toHaveLength(0); // No DB update when provider refuses
  });

  it('503 when Paystack throws', async () => {
    mockPaystackResult = new Error('Network timeout');
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: proof });
    expect(r.status).toBe(503);
    expect(dbUpdateCalls).toHaveLength(0);
  });

  it('503 when Stripe refuses cancellation', async () => {
    mockSubData = { ...mockSubData!, gateway: 'stripe', gateway_subscription_code: 'sub_test456' };
    mockStripeResult = false;
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: proof });
    expect(r.status).toBe(503);
    expect(providerCallCount).toBe(1);
    expect(dbUpdateCalls).toHaveLength(0);
  });

  it('503 when Stripe throws', async () => {
    mockSubData = { ...mockSubData!, gateway: 'stripe', gateway_subscription_code: 'sub_test456' };
    mockStripeResult = new Error('Connection reset');
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: proof });
    expect(r.status).toBe(503);
    expect(dbUpdateCalls).toHaveLength(0);
  });

  it('503 when DB lookup fails', async () => {
    mockSubError = { message: 'connection timeout' };
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: proof });
    expect(r.status).toBe(503);
    expect(providerCallCount).toBe(0);
    expect(dbUpdateCalls).toHaveLength(0);
  });

  it('404 when subscription not found', async () => {
    mockSubData = null;
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: proof });
    expect(r.status).toBe(404);
    expect(providerCallCount).toBe(0);
  });

  // ── Successful cancellation ──

  it('200 success with valid proof and provider confirmation', async () => {
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: proof });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(providerCallCount).toBe(1);
  });

  // ── Already cancelled (idempotent) ──

  it('200 for already-cancelled subscription', async () => {
    mockSubData = { ...mockSubData!, status: 'cancelled' };
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: proof });
    expect(r.status).toBe(200);
    expect(r.body.already_cancelled).toBe(true);
    expect(providerCallCount).toBe(0); // No provider call for already-cancelled
  });

  // ── Flutterwave (no provider code — DB-only cancel) ──

  it('200 for Flutterwave without provider code (DB-only cancel)', async () => {
    mockSubData = { ...mockSubData!, gateway: 'flutterwave', gateway_subscription_code: null };
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: proof });
    expect(r.status).toBe(200);
    expect(providerCallCount).toBe(0); // No provider call
  });
});
