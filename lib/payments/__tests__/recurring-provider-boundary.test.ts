/**
 * #165 / #213 Fix 6: Provider-boundary tests for recurring setup.
 *
 * Tests the Paystack setup logic with mocked provider calls.
 * Covers success, definitive failure (4xx), and indeterminate (timeout/5xx)
 * for both plan and subscription creation phases.
 *
 * CRITICAL invariant: in every ambiguous subscription scenario,
 * createSubscription must be called exactly once (NEVER auto-retry).
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ── Mock paystack-recurring before importing the module under test ──
vi.mock('@/lib/payments/paystack-recurring', () => ({
  createPlan: vi.fn(),
  createSubscription: vi.fn(),
}));

// ── Mock logger ──
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
  },
}));

import {
  classifiedCreatePlan,
  classifiedCreateSubscription,
  executePaystackRecurringSetup,
} from '../recurring-setup';
import { createPlan, createSubscription } from '@/lib/payments/paystack-recurring';

const mockCreatePlan = createPlan as Mock;
const mockCreateSubscription = createSubscription as Mock;

// ── Helpers ──

function mockSupabase(overrides: Record<string, unknown> = {}) {
  const rpcResults: Record<string, unknown> = {
    begin_recurring_provider_attempt: { transitioned: true, claim_token: 'test-claim-token' },
    persist_recurring_plan_id: { persisted: true },
    persist_recurring_subscription_id: { persisted: true },
    activate_recurring_subscription: { activated: true, subscription_id: 'sub-123' },
    fail_recurring_setup: { failed: true },
    mark_recurring_ambiguous: { marked: true },
    ...overrides,
  };

  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: {
              metadata: {
                _card_authorization: {
                  reusable: true,
                  authorization_code: 'AUTH_test',
                  customer_code: 'CUS_test',
                },
              },
            },
            error: null,
          }),
        }),
      }),
    }),
    rpc: vi.fn().mockImplementation((name: string) => {
      const result = rpcResults[name];
      return Promise.resolve({ data: result, error: null });
    }),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

function baseIntent() {
  return {
    id: 'intent-001',
    source_payment_id: 'pay-001',
    business_id: 'biz-001',
    user_id: 'user-001',
    service_id: 'svc-001',
    amount: 5000,
    currency: 'NGN',
    frequency: 'monthly' as string | null,
    status: 'consent_confirmed',
    provider: 'paystack' as string | null,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    provider_customer_code: null as string | null,
    provider_authorization_code: null as string | null,
    provider_plan_id: null as string | null,
  };
}

// ═══════════════════════════════════════════════════════
// classifiedCreatePlan tests
// ═══════════════════════════════════════════════════════

describe('classifiedCreatePlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns success when createPlan returns a plan code', async () => {
    mockCreatePlan.mockResolvedValue({ planCode: 'PLN_test' });
    const result = await classifiedCreatePlan({
      name: 'Test Plan', interval: 'monthly', amount: 5000, currency: 'NGN',
    });
    expect(result).toEqual({ status: 'success', planCode: 'PLN_test' });
  });

  it('returns definitive_failure when createPlan returns null (4xx)', async () => {
    mockCreatePlan.mockResolvedValue(null);
    const result = await classifiedCreatePlan({
      name: 'Test Plan', interval: 'monthly', amount: 5000, currency: 'NGN',
    });
    expect(result.status).toBe('definitive_failure');
  });

  it('returns indeterminate on timeout/network error', async () => {
    mockCreatePlan.mockRejectedValue(new Error('fetch failed'));
    const result = await classifiedCreatePlan({
      name: 'Test Plan', interval: 'monthly', amount: 5000, currency: 'NGN',
    });
    expect(result.status).toBe('indeterminate');
    expect((result as { reason: string }).reason).toContain('fetch failed');
  });
});

// ═══════════════════════════════════════════════════════
// classifiedCreateSubscription tests
// ═══════════════════════════════════════════════════════

describe('classifiedCreateSubscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns success when createSubscription returns codes', async () => {
    mockCreateSubscription.mockResolvedValue({ subscriptionCode: 'SUB_test', emailToken: 'tok_test' });
    const result = await classifiedCreateSubscription({
      customer: 'CUS_test', planCode: 'PLN_test', authorizationCode: 'AUTH_test',
    });
    expect(result).toEqual({ status: 'success', subscriptionCode: 'SUB_test', emailToken: 'tok_test' });
  });

  it('returns definitive_failure when createSubscription returns null (4xx)', async () => {
    mockCreateSubscription.mockResolvedValue(null);
    const result = await classifiedCreateSubscription({
      customer: 'CUS_test', planCode: 'PLN_test', authorizationCode: 'AUTH_test',
    });
    expect(result.status).toBe('definitive_failure');
  });

  it('returns indeterminate on timeout/network error', async () => {
    mockCreateSubscription.mockRejectedValue(new Error('ETIMEDOUT'));
    const result = await classifiedCreateSubscription({
      customer: 'CUS_test', planCode: 'PLN_test', authorizationCode: 'AUTH_test',
    });
    expect(result.status).toBe('indeterminate');
    expect((result as { reason: string }).reason).toContain('ETIMEDOUT');
  });
});

// ═══════════════════════════════════════════════════════
// executePaystackRecurringSetup integration tests
// ═══════════════════════════════════════════════════════

describe('executePaystackRecurringSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('plan success + subscription success -> active', async () => {
    mockCreatePlan.mockResolvedValue({ planCode: 'PLN_ok' });
    mockCreateSubscription.mockResolvedValue({ subscriptionCode: 'SUB_ok', emailToken: 'tok_ok' });

    const supabase = mockSupabase();
    const sender = { sendText: vi.fn().mockResolvedValue(undefined) } as unknown as import('@/lib/channels/message-sender').MessageSender;

    await executePaystackRecurringSetup(supabase, baseIntent(), sender, '2348000000000', '[TEST]');

    // Verify activation was called
    expect(supabase.rpc).toHaveBeenCalledWith('activate_recurring_subscription', expect.objectContaining({
      p_subscription_code: 'SUB_ok',
    }));
    // Verify subscription code was persisted BEFORE activation
    const rpcCalls = (supabase.rpc as Mock).mock.calls.map((c: unknown[]) => c[0]);
    const persistIdx = rpcCalls.indexOf('persist_recurring_subscription_id');
    const activateIdx = rpcCalls.indexOf('activate_recurring_subscription');
    expect(persistIdx).toBeGreaterThan(-1);
    expect(activateIdx).toBeGreaterThan(-1);
    expect(persistIdx).toBeLessThan(activateIdx);
  });

  it('plan 4xx -> setup_failed', async () => {
    mockCreatePlan.mockResolvedValue(null); // definitive failure

    const supabase = mockSupabase();
    const sender = { sendText: vi.fn().mockResolvedValue(undefined) } as unknown as import('@/lib/channels/message-sender').MessageSender;

    await executePaystackRecurringSetup(supabase, baseIntent(), sender, '2348000000000', '[TEST]');

    expect(supabase.rpc).toHaveBeenCalledWith('fail_recurring_setup', expect.objectContaining({
      p_intent_id: 'intent-001',
    }));
    expect(mockCreateSubscription).not.toHaveBeenCalled();
  });

  it('plan timeout -> provider_ambiguous', async () => {
    mockCreatePlan.mockRejectedValue(new Error('ETIMEDOUT'));

    const supabase = mockSupabase();
    const sender = { sendText: vi.fn().mockResolvedValue(undefined) } as unknown as import('@/lib/channels/message-sender').MessageSender;

    await executePaystackRecurringSetup(supabase, baseIntent(), sender, '2348000000000', '[TEST]');

    expect(supabase.rpc).toHaveBeenCalledWith('mark_recurring_ambiguous', expect.objectContaining({
      p_intent_id: 'intent-001',
    }));
    expect(mockCreateSubscription).not.toHaveBeenCalled();
  });

  it('subscription 4xx -> setup_failed (plan orphaned)', async () => {
    mockCreatePlan.mockResolvedValue({ planCode: 'PLN_ok' });
    mockCreateSubscription.mockResolvedValue(null); // definitive failure

    const supabase = mockSupabase();
    const sender = { sendText: vi.fn().mockResolvedValue(undefined) } as unknown as import('@/lib/channels/message-sender').MessageSender;

    await executePaystackRecurringSetup(supabase, baseIntent(), sender, '2348000000000', '[TEST]');

    expect(supabase.rpc).toHaveBeenCalledWith('fail_recurring_setup', expect.objectContaining({
      p_intent_id: 'intent-001',
    }));
    // Plan was created but subscription failed — plan is orphaned
    expect(mockCreatePlan).toHaveBeenCalledTimes(1);
    expect(mockCreateSubscription).toHaveBeenCalledTimes(1);
  });

  it('subscription timeout -> provider_ambiguous, createSubscription called exactly once', async () => {
    mockCreatePlan.mockResolvedValue({ planCode: 'PLN_ok' });
    mockCreateSubscription.mockRejectedValue(new Error('socket hang up'));

    const supabase = mockSupabase();
    const sender = { sendText: vi.fn().mockResolvedValue(undefined) } as unknown as import('@/lib/channels/message-sender').MessageSender;

    await executePaystackRecurringSetup(supabase, baseIntent(), sender, '2348000000000', '[TEST]');

    expect(supabase.rpc).toHaveBeenCalledWith('mark_recurring_ambiguous', expect.objectContaining({
      p_intent_id: 'intent-001',
    }));
    // CRITICAL: createSubscription must be called exactly once — NEVER auto-retry
    expect(mockCreateSubscription).toHaveBeenCalledTimes(1);
  });

  it('subscription success + DB activation failure -> subscription code still persisted', async () => {
    mockCreatePlan.mockResolvedValue({ planCode: 'PLN_ok' });
    mockCreateSubscription.mockResolvedValue({ subscriptionCode: 'SUB_ok', emailToken: 'tok_ok' });

    // Override: activate fails
    const supabase = mockSupabase({
      activate_recurring_subscription: { activated: false, reason: 'db_error' },
    });
    const sender = { sendText: vi.fn().mockResolvedValue(undefined) } as unknown as import('@/lib/channels/message-sender').MessageSender;

    await executePaystackRecurringSetup(supabase, baseIntent(), sender, '2348000000000', '[TEST]');

    // Verify subscription code was persisted BEFORE the failed activation
    const rpcCalls = (supabase.rpc as Mock).mock.calls.map((c: unknown[]) => c[0]);
    expect(rpcCalls).toContain('persist_recurring_subscription_id');

    // Verify persist was called with the correct subscription code
    expect(supabase.rpc).toHaveBeenCalledWith('persist_recurring_subscription_id', expect.objectContaining({
      p_subscription_code: 'SUB_ok',
      p_email_token: 'tok_ok',
    }));

    // Verify it fell through to ambiguous (not lost)
    expect(supabase.rpc).toHaveBeenCalledWith('mark_recurring_ambiguous', expect.objectContaining({
      p_intent_id: 'intent-001',
    }));
  });

  it('ambiguous subscription scenarios always call createSubscription exactly once', async () => {
    // Test with 5xx error response
    mockCreatePlan.mockResolvedValue({ planCode: 'PLN_ok' });
    mockCreateSubscription.mockRejectedValue(new Error('Internal Server Error'));

    const supabase = mockSupabase();
    const sender = { sendText: vi.fn().mockResolvedValue(undefined) } as unknown as import('@/lib/channels/message-sender').MessageSender;

    await executePaystackRecurringSetup(supabase, baseIntent(), sender, '2348000000000', '[TEST]');

    // CRITICAL assertion: exactly one call, no retry
    expect(mockCreateSubscription).toHaveBeenCalledTimes(1);
  });
});
