/**
 * #165 / #213 Fix 6: Provider-boundary tests for recurring setup.
 *
 * Tests the REAL HTTP boundary by mocking global.fetch.
 * Proves typed outcomes from actual HTTP status codes, timeouts, and network errors.
 *
 * CRITICAL invariant: in every ambiguous subscription scenario,
 * fetch must be called exactly once for the subscription endpoint (NEVER auto-retry).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock logger ──
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
  },
}));

// ── Stub PAYSTACK_SECRET_KEY so the wrappers use fetch ──
vi.stubEnv('PAYSTACK_SECRET_KEY', 'test_placeholder_not_real');

import {
  recurringCreatePlan,
  recurringCreateSubscription,
  executePaystackRecurringSetup,
} from '../recurring-setup';
import type { Mock } from 'vitest';

// ── Helpers ──

const originalFetch = globalThis.fetch;
let mockFetch: Mock;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.stubGlobal('fetch', originalFetch);
  vi.clearAllMocks();
});

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

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
              name: 'Test Business',
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
// recurringCreatePlan — real fetch boundary tests
// ═══════════════════════════════════════════════════════

describe('recurringCreatePlan (fetch boundary)', () => {
  it('HTTP 200 + status:true → success', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({
      status: true,
      data: { plan_code: 'PLN_test123' },
    }));
    const result = await recurringCreatePlan({
      name: 'Test Plan', interval: 'monthly', amount: 5000, currency: 'NGN',
    });
    expect(result).toEqual({ outcome: 'success', data: { planCode: 'PLN_test123' } });
  });

  it('HTTP 200 + status:false → definitive_failure', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({
      status: false,
      message: 'Plan name already exists',
    }));
    const result = await recurringCreatePlan({
      name: 'Dup Plan', interval: 'monthly', amount: 5000, currency: 'NGN',
    });
    expect(result.outcome).toBe('definitive_failure');
    expect((result as { reason: string }).reason).toContain('Plan name already exists');
  });

  it('HTTP 400 + valid JSON → definitive_failure', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(
      { status: false, message: 'Invalid plan interval' },
      400,
    ));
    const result = await recurringCreatePlan({
      name: 'Bad Plan', interval: 'monthly', amount: 5000, currency: 'NGN',
    });
    expect(result.outcome).toBe('definitive_failure');
    expect((result as { reason: string }).reason).toContain('http_400');
    expect((result as { reason: string }).reason).toContain('Invalid plan interval');
  });

  it('HTTP 500 + valid JSON body → indeterminate (NOT definitive failure)', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(
      { status: false, message: 'Server error' },
      500,
    ));
    const result = await recurringCreatePlan({
      name: 'Server Error Plan', interval: 'monthly', amount: 5000, currency: 'NGN',
    });
    expect(result.outcome).toBe('indeterminate');
    expect((result as { reason: string }).reason).toBe('http_500');
  });

  it('HTTP 502 → indeterminate', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }));
    const result = await recurringCreatePlan({
      name: 'GW Plan', interval: 'monthly', amount: 5000, currency: 'NGN',
    });
    expect(result.outcome).toBe('indeterminate');
    expect((result as { reason: string }).reason).toBe('http_502');
  });

  it('network error → indeterminate', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    const result = await recurringCreatePlan({
      name: 'Net Error Plan', interval: 'monthly', amount: 5000, currency: 'NGN',
    });
    expect(result.outcome).toBe('indeterminate');
    expect((result as { reason: string }).reason).toContain('fetch failed');
  });

  it('timeout → indeterminate', async () => {
    mockFetch.mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'));
    const result = await recurringCreatePlan({
      name: 'Timeout Plan', interval: 'monthly', amount: 5000, currency: 'NGN',
    });
    expect(result.outcome).toBe('indeterminate');
    expect((result as { reason: string }).reason).toBe('timeout');
  });

  it('HTTP 200 but malformed JSON → indeterminate', async () => {
    mockFetch.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    const result = await recurringCreatePlan({
      name: 'Bad JSON Plan', interval: 'monthly', amount: 5000, currency: 'NGN',
    });
    expect(result.outcome).toBe('indeterminate');
    expect((result as { reason: string }).reason).toBe('malformed_json');
  });
});

// ═══════════════════════════════════════════════════════
// recurringCreateSubscription — real fetch boundary tests
// ═══════════════════════════════════════════════════════

describe('recurringCreateSubscription (fetch boundary)', () => {
  it('HTTP 200 + status:true → success', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({
      status: true,
      data: { subscription_code: 'SUB_test456', email_token: 'tok_test456' },
    }));
    const result = await recurringCreateSubscription({
      customer: 'CUS_test', planCode: 'PLN_test', authorizationCode: 'AUTH_test',
    });
    expect(result).toEqual({
      outcome: 'success',
      data: { subscriptionCode: 'SUB_test456', emailToken: 'tok_test456' },
    });
  });

  it('HTTP 400 + valid JSON → definitive_failure', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(
      { status: false, message: 'Customer not found' },
      400,
    ));
    const result = await recurringCreateSubscription({
      customer: 'CUS_bad', planCode: 'PLN_test', authorizationCode: 'AUTH_test',
    });
    expect(result.outcome).toBe('definitive_failure');
    expect((result as { reason: string }).reason).toContain('http_400');
  });

  it('HTTP 500 + valid JSON body → indeterminate', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(
      { status: false, message: 'Server error' },
      500,
    ));
    const result = await recurringCreateSubscription({
      customer: 'CUS_test', planCode: 'PLN_test', authorizationCode: 'AUTH_test',
    });
    expect(result.outcome).toBe('indeterminate');
    expect((result as { reason: string }).reason).toBe('http_500');
  });

  it('network error → indeterminate', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    const result = await recurringCreateSubscription({
      customer: 'CUS_test', planCode: 'PLN_test', authorizationCode: 'AUTH_test',
    });
    expect(result.outcome).toBe('indeterminate');
    expect((result as { reason: string }).reason).toContain('fetch failed');
  });

  it('timeout → indeterminate', async () => {
    mockFetch.mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'));
    const result = await recurringCreateSubscription({
      customer: 'CUS_test', planCode: 'PLN_test', authorizationCode: 'AUTH_test',
    });
    expect(result.outcome).toBe('indeterminate');
    expect((result as { reason: string }).reason).toBe('timeout');
  });
});

// ═══════════════════════════════════════════════════════
// executePaystackRecurringSetup integration tests (fetch-level)
// ═══════════════════════════════════════════════════════

describe('executePaystackRecurringSetup (fetch boundary)', () => {
  it('plan success + subscription success → active', async () => {
    // Plan creation fetch
    mockFetch.mockResolvedValueOnce(makeResponse({
      status: true,
      data: { plan_code: 'PLN_ok' },
    }));
    // Subscription creation fetch
    mockFetch.mockResolvedValueOnce(makeResponse({
      status: true,
      data: { subscription_code: 'SUB_ok', email_token: 'tok_ok' },
    }));

    const supabase = mockSupabase();
    const sender = { sendText: vi.fn().mockResolvedValue(undefined) } as unknown as import('@/lib/channels/message-sender').MessageSender;

    await executePaystackRecurringSetup(supabase, baseIntent(), sender, '2348000000000', '[TEST]');

    // Verify activation was called
    expect(supabase.rpc).toHaveBeenCalledWith('activate_recurring_subscription', expect.objectContaining({
      p_intent_id: 'intent-001',
    }));
    // Verify subscription code was persisted BEFORE activation
    const rpcCalls = (supabase.rpc as Mock).mock.calls.map((c: unknown[]) => c[0]);
    const persistIdx = rpcCalls.indexOf('persist_recurring_subscription_id');
    const activateIdx = rpcCalls.indexOf('activate_recurring_subscription');
    expect(persistIdx).toBeGreaterThan(-1);
    expect(activateIdx).toBeGreaterThan(-1);
    expect(persistIdx).toBeLessThan(activateIdx);
  });

  it('plan 4xx → setup_failed', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(
      { status: false, message: 'Bad request' },
      400,
    ));

    const supabase = mockSupabase();
    const sender = { sendText: vi.fn().mockResolvedValue(undefined) } as unknown as import('@/lib/channels/message-sender').MessageSender;

    await executePaystackRecurringSetup(supabase, baseIntent(), sender, '2348000000000', '[TEST]');

    expect(supabase.rpc).toHaveBeenCalledWith('fail_recurring_setup', expect.objectContaining({
      p_intent_id: 'intent-001',
    }));
    // Subscription fetch should never have been called
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('plan 500 → provider_ambiguous', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(
      { status: false, message: 'Internal error' },
      500,
    ));

    const supabase = mockSupabase();
    const sender = { sendText: vi.fn().mockResolvedValue(undefined) } as unknown as import('@/lib/channels/message-sender').MessageSender;

    await executePaystackRecurringSetup(supabase, baseIntent(), sender, '2348000000000', '[TEST]');

    expect(supabase.rpc).toHaveBeenCalledWith('mark_recurring_ambiguous', expect.objectContaining({
      p_intent_id: 'intent-001',
    }));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('plan timeout → provider_ambiguous', async () => {
    mockFetch.mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'));

    const supabase = mockSupabase();
    const sender = { sendText: vi.fn().mockResolvedValue(undefined) } as unknown as import('@/lib/channels/message-sender').MessageSender;

    await executePaystackRecurringSetup(supabase, baseIntent(), sender, '2348000000000', '[TEST]');

    expect(supabase.rpc).toHaveBeenCalledWith('mark_recurring_ambiguous', expect.objectContaining({
      p_intent_id: 'intent-001',
    }));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('subscription 4xx → setup_failed (plan orphaned)', async () => {
    // Plan succeeds
    mockFetch.mockResolvedValueOnce(makeResponse({
      status: true, data: { plan_code: 'PLN_ok' },
    }));
    // Subscription 400
    mockFetch.mockResolvedValueOnce(makeResponse(
      { status: false, message: 'Customer not found' },
      400,
    ));

    const supabase = mockSupabase();
    const sender = { sendText: vi.fn().mockResolvedValue(undefined) } as unknown as import('@/lib/channels/message-sender').MessageSender;

    await executePaystackRecurringSetup(supabase, baseIntent(), sender, '2348000000000', '[TEST]');

    expect(supabase.rpc).toHaveBeenCalledWith('fail_recurring_setup', expect.objectContaining({
      p_intent_id: 'intent-001',
    }));
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('subscription timeout → provider_ambiguous, fetch called exactly once per endpoint', async () => {
    // Plan succeeds
    mockFetch.mockResolvedValueOnce(makeResponse({
      status: true, data: { plan_code: 'PLN_ok' },
    }));
    // Subscription timeout
    mockFetch.mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'));

    const supabase = mockSupabase();
    const sender = { sendText: vi.fn().mockResolvedValue(undefined) } as unknown as import('@/lib/channels/message-sender').MessageSender;

    await executePaystackRecurringSetup(supabase, baseIntent(), sender, '2348000000000', '[TEST]');

    expect(supabase.rpc).toHaveBeenCalledWith('mark_recurring_ambiguous', expect.objectContaining({
      p_intent_id: 'intent-001',
    }));
    // CRITICAL: exactly 2 fetch calls (plan + subscription), no retry
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('subscription network error → provider_ambiguous, NEVER auto-retry', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({
      status: true, data: { plan_code: 'PLN_ok' },
    }));
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

    const supabase = mockSupabase();
    const sender = { sendText: vi.fn().mockResolvedValue(undefined) } as unknown as import('@/lib/channels/message-sender').MessageSender;

    await executePaystackRecurringSetup(supabase, baseIntent(), sender, '2348000000000', '[TEST]');

    expect(supabase.rpc).toHaveBeenCalledWith('mark_recurring_ambiguous', expect.objectContaining({
      p_intent_id: 'intent-001',
    }));
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('subscription success + DB activation failure → subscription code still persisted', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({
      status: true, data: { plan_code: 'PLN_ok' },
    }));
    mockFetch.mockResolvedValueOnce(makeResponse({
      status: true, data: { subscription_code: 'SUB_ok', email_token: 'tok_ok' },
    }));

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
});
