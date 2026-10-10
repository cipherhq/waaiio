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
let mockRereadData: Record<string, unknown> | null | undefined = undefined; // undefined = no re-read expected
let mockPaystackResult: boolean | Error = true;
let mockStripeResult: boolean | Error = true;
let mockPaystackStatus: string | null = null;
let mockStripeStatus: string | null = null;
let providerCallCount = 0;
let providerVerifyCount = 0;
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
  mockRereadData = undefined;
  mockPaystackResult = true;
  mockStripeResult = true;
  mockPaystackStatus = null;
  mockStripeStatus = null;
  providerCallCount = 0;
  providerVerifyCount = 0;
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
        if (callNum > 1 && dbUpdateCalls.length > 0 && mockRereadData !== undefined) {
          // B2/R3-1: re-read after zero-row update
          return Promise.resolve({ data: mockRereadData, error: mockRereadData === null ? null : null });
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
  getSubscriptionStatus: async () => {
    providerVerifyCount++;
    return mockPaystackStatus;
  },
}));

vi.mock('@/lib/payments/stripe-recurring', () => ({
  cancelSubscription: async () => {
    providerCallCount++;
    if (mockStripeResult instanceof Error) throw mockStripeResult;
    return mockStripeResult;
  },
  getSubscriptionStatus: async () => {
    providerVerifyCount++;
    return mockStripeStatus;
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

  // ── R3-1: DB update failure tests ──

  it('503 when DB update returns error (provider already cancelled)', async () => {
    mockUpdateError = { message: 'connection lost' };
    mockUpdateData = null;
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: proof });
    expect(r.status).toBe(503);
    expect(r.body.error).toContain('could not be completed');
    expect(providerCallCount).toBe(1); // Provider was called
  });

  it('200 already_cancelled when zero-row CAS re-reads cancelled state', async () => {
    mockUpdateData = []; // zero rows affected
    mockRereadData = { status: 'cancelled' }; // re-read shows cancelled
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: proof });
    expect(r.status).toBe(200);
    expect(r.body.already_cancelled).toBe(true);
  });

  it('409 when zero-row CAS re-reads different non-cancelled state', async () => {
    mockUpdateData = []; // zero rows
    mockRereadData = { status: 'paused' }; // changed to paused, not cancelled
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: proof });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('status changed');
  });

  it('409 when zero-row CAS and re-read shows unchanged state', async () => {
    // Update affected zero rows, re-read returns the original active state
    // (e.g., concurrent operation changed and reverted, or row was locked)
    mockUpdateData = []; // zero rows affected
    // mockRereadData stays undefined → falls back to mockSubData (active)
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: proof });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('status changed');
    expect(r.body.success).toBeUndefined(); // NOT success
  });

  // ── R3-2: Provider success + DB failure reconciliation ──

  it('provider-success/DB-failure returns 503, not false success', async () => {
    // Provider cancellation succeeds, but DB write fails
    // Client should retry; provider cancel is designed to be idempotent
    // (Paystack /subscription/disable, Stripe DELETE /subscriptions/{id})
    // but we return 503 to indicate the need for reconciliation
    mockUpdateError = { message: 'serialization failure' };
    mockUpdateData = null;
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: proof });
    expect(r.status).toBe(503);
    expect(r.body.success).toBeUndefined(); // NOT success
    expect(providerCallCount).toBe(1); // Provider was called and succeeded
  });

  // ── R3-3: Input validation edge cases ──

  it('400 for null JSON body', async () => {
    const { POST } = await import('@/app/api/recurring/cancel/route');
    const req = new NextRequest(new URL('http://localhost/api/recurring/cancel'), {
      method: 'POST',
      body: 'null',
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('400 for array JSON body', async () => {
    const { POST } = await import('@/app/api/recurring/cancel/route');
    const req = new NextRequest(new URL('http://localhost/api/recurring/cancel'), {
      method: 'POST',
      body: '[]',
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  // ── B5: Provider/DB convergence tests ──

  it('B5: Paystack cancel refused but status-check confirms non-renewing → converges to success', async () => {
    // Scenario: Prior call cancelled at provider + DB failed. On retry,
    // cancel API refuses (already disabled). Status check confirms non-renewing.
    mockPaystackResult = false; // cancel refuses
    mockPaystackStatus = 'non-renewing'; // but status check confirms cancelled
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: proof });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(providerCallCount).toBe(1); // cancel was attempted
    expect(providerVerifyCount).toBe(1); // status was verified
  });

  it('B5: Stripe cancel refused but status-check confirms canceled → converges', async () => {
    mockSubData = { ...mockSubData!, gateway: 'stripe', gateway_subscription_code: 'sub_test789' };
    mockStripeResult = false;
    mockStripeStatus = 'canceled';
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: proof });
    expect(r.status).toBe(200);
    expect(providerCallCount).toBe(1);
    expect(providerVerifyCount).toBe(1);
  });

  it('B5: Paystack cancel refused AND status-check shows active → no false success', async () => {
    mockPaystackResult = false;
    mockPaystackStatus = 'active'; // still active at provider
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: proof });
    expect(r.status).toBe(503); // fail closed
    expect(r.body.success).toBeUndefined();
    expect(dbUpdateCalls).toHaveLength(0); // no DB cancel
  });

  it('B5: Paystack cancel refused AND status-check fails → no false success', async () => {
    mockPaystackResult = false;
    mockPaystackStatus = null; // verification failed
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: proof });
    expect(r.status).toBe(503);
    expect(r.body.success).toBeUndefined();
    expect(dbUpdateCalls).toHaveLength(0);
  });

  it('B5: Stripe cancel throws AND status-check confirms canceled → converges', async () => {
    mockSubData = { ...mockSubData!, gateway: 'stripe', gateway_subscription_code: 'sub_test789' };
    mockStripeResult = new Error('Timeout');
    mockStripeStatus = 'canceled';
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: proof });
    expect(r.status).toBe(200);
    expect(providerVerifyCount).toBe(1);
  });

  // ── R5-1: Paystack 'completed' status (typo fix) ──

  it('R5-1: Paystack cancel refused + status completed → converges', async () => {
    mockPaystackResult = false;
    mockPaystackStatus = 'completed'; // Paystack documented terminal status
    const proof = issueRecurringCancellationProof(PHONE, SUB_ID);
    const r = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: proof });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(providerVerifyCount).toBe(1);
  });

  // ── R5-2: Two-request stateful convergence ──

  it('R5-2: Request 1 provider-success/DB-failure → 503; Request 2 provider-refused/status-verified → 200', async () => {
    // REQUEST 1: Provider cancel succeeds, but DB update fails
    const proof1 = issueRecurringCancellationProof(PHONE, SUB_ID);
    mockPaystackResult = true;      // provider accepts cancellation
    mockUpdateError = { message: 'connection lost' };
    mockUpdateData = null;

    const r1 = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: proof1 });
    expect(r1.status).toBe(503);             // correctly reports failure
    expect(r1.body.success).toBeUndefined(); // no false success
    expect(providerCallCount).toBe(1);       // provider was called once
    const r1DbCalls = dbUpdateCalls.length;
    expect(r1DbCalls).toBe(1);               // DB update was attempted

    // Reset mock state for request 2 (simulating fresh retry)
    fromCallCount = 0;
    providerCallCount = 0;
    providerVerifyCount = 0;
    dbUpdateCalls = [];

    // REQUEST 2: Provider now refuses (already disabled), status check confirms
    const proof2 = issueRecurringCancellationProof(PHONE, SUB_ID);
    mockPaystackResult = false;          // cancel API refuses (already disabled)
    mockPaystackStatus = 'non-renewing'; // status check confirms cancelled
    mockUpdateError = null;              // DB is now available
    mockUpdateData = [{ id: SUB_ID }];   // DB CAS succeeds

    const r2 = await callCancel({ subscriptionId: SUB_ID, phone: PHONE, cancellationProof: proof2 });
    expect(r2.status).toBe(200);             // converges to success
    expect(r2.body.success).toBe(true);
    expect(providerCallCount).toBe(1);       // cancel attempted
    expect(providerVerifyCount).toBe(1);     // status verified
    expect(dbUpdateCalls.length).toBe(1);    // DB CAS executed
    expect(dbUpdateCalls[0].status).toBe('cancelled'); // correct target state
  });

  /**
   * R5-2 RECOVERY DOCUMENTATION:
   *
   * If the customer does NOT retry (proof expires, gives up, DB outage persists):
   * - The subscription remains 'active'/'past_due' in Waaiio's DB
   * - The provider has already disabled the subscription (no future charges)
   * - retry-failed-charges cron (daily) processes past_due subscriptions:
   *   it calls claim_paystack_billing_cycle which reads next_charge_at;
   *   since the provider subscription is disabled, the charge attempt will fail,
   *   incrementing failure_count. After 3 failures, the cron cancels locally.
   * - This provides EVENTUAL convergence (within 3 billing cycles) but is NOT
   *   immediate. A dedicated customer_subscription reconciliation worker that
   *   verifies provider state for locally-active subscriptions would provide
   *   faster convergence. This is tracked as separate operational work, not
   *   a blocker for the authorization fix in this PR.
   *
   * The critical safety invariant is preserved: the provider will NOT charge
   * the customer again, regardless of local DB state. The local state will
   * converge through the existing retry/failure/cancellation lifecycle.
   */
});
