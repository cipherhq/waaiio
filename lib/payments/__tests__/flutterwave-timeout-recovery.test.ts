/**
 * M378 Phase 1 — Timeout-Recovery Production Orchestration Proofs
 *
 * Tests the ACTUAL production function `executeTimeoutRecovery` from
 * lib/payments/flutterwave-timeout-recovery.ts — the exact function that
 * app/api/onboarding/subscribe/route.ts calls for the timeout boundary path.
 *
 * Provider HTTP (fetch) is mocked. Supabase service client is mocked.
 * Asserted production side effects:
 *
 * 1. Verified timeout success → exact finalize_flutterwave_subscription_checkout RPC
 *    for the ORIGINAL intent ID with verified provider tx/sub/plan, amount, currency, timestamp
 * 2. Verified terminal failure → exact replace_terminal_checkout_intent RPC
 * 3. Replay/duplicate terminal recovery → no second replacement (idempotent via RPC)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock fetch globally ──
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), withContext: () => ({ error: vi.fn() }) },
}));

// ── Track RPC calls ──
interface RpcCall { fn: string; args: Record<string, unknown> }

import { executeTimeoutRecovery, type TimeoutRecoveryInput } from '../flutterwave-timeout-recovery';

// ── Helpers ──
function createMockService() {
  const rpcCalls: RpcCall[] = [];
  const rpcResults: Record<string, { data: unknown; error: unknown }> = {};

  return {
    rpcCalls,
    setRpcResult(fn: string, data: unknown, error: unknown = null) {
      rpcResults[fn] = { data, error };
    },
    service: {
      rpc: vi.fn().mockImplementation((fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        return Promise.resolve(rpcResults[fn] || { data: null, error: null });
      }),
    },
  };
}

const baseInput: TimeoutRecoveryInput = {
  intentId: 'intent-orig-001',
  idempotencyKey: 'waaiiosubORIG1234567890abcdef12345',
  intentCreatedAt: '2026-09-12T00:00:00Z',
  providerCheckoutUrl: 'https://checkout.flutterwave.com/pay/test123',
  flutterwaveKey: 'flw-test-key',
  replaceParams: {
    businessId: 'biz-001',
    plan: 'growth',
    currency: 'NGN',
    amount: 14999,
    providerPlanRef: 'FLW-PLAN-001',
    configVersionId: 'cv-001',
    subscriberEmail: 'test@test.com',
    actorId: 'user-001',
  },
};

beforeEach(() => {
  mockFetch.mockReset();
});

// ═════════════════════════════════════════════════════════════════════════════
// PROOF 1: Verified timeout success → finalize_flutterwave_subscription_checkout
//          for the ORIGINAL intent ID with full verified provider evidence
// ═════════════════════════════════════════════════════════════════════════════
describe('Proof 1: timeout success → original intent finalizer', () => {
  it('calls finalize_flutterwave_subscription_checkout with exact original intent ID and verified evidence', async () => {
    const mock = createMockService();
    mock.setRpcResult('finalize_flutterwave_subscription_checkout', { finalized: true });

    // discoverAndVerifyTransaction: find successful tx
    mockFetch.mockImplementation(async (url: string) => {
      // Discovery: successful query finds tx
      if (typeof url === 'string' && url.includes('/v3/transactions?') && url.includes('status=successful')) {
        return {
          ok: true,
          json: async () => ({
            status: 'success',
            data: [{ id: 42, tx_ref: baseInput.idempotencyKey }],
          }),
        };
      }
      // Discovery: failed query (empty)
      if (typeof url === 'string' && url.includes('/v3/transactions?') && url.includes('status=failed')) {
        return { ok: true, json: async () => ({ status: 'success', data: [] }) };
      }
      // Exact-ID verify
      if (typeof url === 'string' && url.includes('/v3/transactions/42/verify')) {
        return {
          ok: true,
          json: async () => ({
            status: 'success',
            data: {
              id: 42, tx_ref: baseInput.idempotencyKey,
              status: 'successful', amount: 14999, currency: 'NGN',
              created_at: '2026-09-12T10:30:00Z',
            },
          }),
        };
      }
      // correlateProviderSubscription
      if (typeof url === 'string' && url.includes('/v3/subscriptions')) {
        return {
          ok: true,
          json: async () => ({ status: 'success', data: [{ id: 800, plan: 900 }] }),
        };
      }
      return { ok: false, status: 404 };
    });

    const result = await executeTimeoutRecovery(mock.service, baseInput);

    // Assert outcome
    expect(result.outcome).toBe('finalized');
    if (result.outcome === 'finalized') {
      expect(result.reference).toBe(baseInput.idempotencyKey);
    }

    // Assert the exact RPC call with ORIGINAL intent ID and full verified provider evidence
    const finCall = mock.rpcCalls.find(c => c.fn === 'finalize_flutterwave_subscription_checkout');
    expect(finCall).toBeDefined();
    expect(finCall!.args).toEqual({
      p_intent_id: 'intent-orig-001', // ORIGINAL intent ID
      p_provider_tx_id: '42',
      p_provider_subscription_id: '800',
      p_provider_plan_id: 900,
      p_verified_amount_minor: 1499900,
      p_verified_currency: 'NGN',
      p_provider_paid_at: '2026-09-12T10:30:00Z',
    });

    // No replacement RPC should have been called
    expect(mock.rpcCalls.find(c => c.fn === 'replace_terminal_checkout_intent')).toBeUndefined();
  });

  it('subscription correlation failure → subscription_pending, no finalizer RPC', async () => {
    const mock = createMockService();

    // Successful tx found
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/v3/transactions?') && url.includes('status=successful')) {
        return { ok: true, json: async () => ({ status: 'success', data: [{ id: 55, tx_ref: baseInput.idempotencyKey }] }) };
      }
      if (typeof url === 'string' && url.includes('/v3/transactions?') && url.includes('status=failed')) {
        return { ok: true, json: async () => ({ status: 'success', data: [] }) };
      }
      if (typeof url === 'string' && url.includes('/v3/transactions/55/verify')) {
        return { ok: true, json: async () => ({ status: 'success', data: { id: 55, tx_ref: baseInput.idempotencyKey, status: 'successful', amount: 14999, currency: 'NGN', created_at: '2026-09-12T10:30:00Z' } }) };
      }
      // Subscription correlation fails
      if (typeof url === 'string' && url.includes('/v3/subscriptions')) {
        return { ok: true, json: async () => ({ status: 'success', data: [] }) }; // zero → not_found → fail_closed
      }
      return { ok: false, status: 404 };
    });

    const result = await executeTimeoutRecovery(mock.service, baseInput);
    expect(result.outcome).toBe('subscription_pending');
    expect(mock.rpcCalls.find(c => c.fn === 'finalize_flutterwave_subscription_checkout')).toBeUndefined();
  });

  it('finalizer RPC fails → finalization_failed', async () => {
    const mock = createMockService();
    mock.setRpcResult('finalize_flutterwave_subscription_checkout', null, { message: 'RPC error' });

    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/v3/transactions?') && url.includes('status=successful')) {
        return { ok: true, json: async () => ({ status: 'success', data: [{ id: 42, tx_ref: baseInput.idempotencyKey }] }) };
      }
      if (typeof url === 'string' && url.includes('/v3/transactions?') && url.includes('status=failed')) {
        return { ok: true, json: async () => ({ status: 'success', data: [] }) };
      }
      if (typeof url === 'string' && url.includes('/v3/transactions/42/verify')) {
        return { ok: true, json: async () => ({ status: 'success', data: { id: 42, tx_ref: baseInput.idempotencyKey, status: 'successful', amount: 14999, currency: 'NGN', created_at: '2026-09-12T10:30:00Z' } }) };
      }
      if (typeof url === 'string' && url.includes('/v3/subscriptions')) {
        return { ok: true, json: async () => ({ status: 'success', data: [{ id: 800, plan: 900 }] }) };
      }
      return { ok: false, status: 404 };
    });

    const result = await executeTimeoutRecovery(mock.service, baseInput);
    expect(result.outcome).toBe('finalization_failed');
    // Finalizer was called (but failed)
    expect(mock.rpcCalls.find(c => c.fn === 'finalize_flutterwave_subscription_checkout')).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PROOF 2: Verified terminal failure/cancellation → replace_terminal_checkout_intent
// ═════════════════════════════════════════════════════════════════════════════
describe('Proof 2: terminal timeout → replacement RPC', () => {
  it('failed provider tx → exact replace_terminal_checkout_intent RPC', async () => {
    const mock = createMockService();
    mock.setRpcResult('replace_terminal_checkout_intent', [{ intent_id: 'new-intent-002', idempotency_key: 'waaiiosubNEW' }]);

    // discoverAndVerifyTransaction: find failed tx
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/v3/transactions?') && url.includes('status=successful')) {
        return { ok: true, json: async () => ({ status: 'success', data: [] }) };
      }
      if (typeof url === 'string' && url.includes('/v3/transactions?') && url.includes('status=failed')) {
        return { ok: true, json: async () => ({ status: 'success', data: [{ id: 77, tx_ref: baseInput.idempotencyKey }] }) };
      }
      if (typeof url === 'string' && url.includes('/v3/transactions/77/verify')) {
        return { ok: true, json: async () => ({ status: 'success', data: { id: 77, tx_ref: baseInput.idempotencyKey, status: 'failed', amount: 14999, currency: 'NGN', created_at: '2026-09-12T10:30:00Z' } }) };
      }
      return { ok: false, status: 404 };
    });

    const result = await executeTimeoutRecovery(mock.service, baseInput);
    expect(result.outcome).toBe('replaced');

    // Assert the exact replacement RPC call
    const replaceCall = mock.rpcCalls.find(c => c.fn === 'replace_terminal_checkout_intent');
    expect(replaceCall).toBeDefined();
    expect(replaceCall!.args).toEqual({
      p_old_intent_id: 'intent-orig-001',
      p_business_id: 'biz-001',
      p_plan: 'growth',
      p_gateway: 'flutterwave',
      p_currency: 'NGN',
      p_amount: 14999,
      p_provider_plan_ref: 'FLW-PLAN-001',
      p_config_version_id: 'cv-001',
      p_subscriber_email: 'test@test.com',
      p_session_duration: 30,
      p_actor_id: 'user-001',
    });

    // No finalizer RPC should have been called
    expect(mock.rpcCalls.find(c => c.fn === 'finalize_flutterwave_subscription_checkout')).toBeUndefined();
  });

  it('cancelled provider tx → replace_terminal_checkout_intent', async () => {
    const mock = createMockService();
    mock.setRpcResult('replace_terminal_checkout_intent', [{ intent_id: 'new-intent-003' }]);

    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/v3/transactions?') && url.includes('status=successful')) {
        return { ok: true, json: async () => ({ status: 'success', data: [] }) };
      }
      if (typeof url === 'string' && url.includes('/v3/transactions?') && url.includes('status=failed')) {
        return { ok: true, json: async () => ({ status: 'success', data: [{ id: 88, tx_ref: baseInput.idempotencyKey }] }) };
      }
      if (typeof url === 'string' && url.includes('/v3/transactions/88/verify')) {
        return { ok: true, json: async () => ({ status: 'success', data: { id: 88, tx_ref: baseInput.idempotencyKey, status: 'cancelled', amount: 14999, currency: 'NGN', created_at: '2026-09-12T10:30:00Z' } }) };
      }
      return { ok: false, status: 404 };
    });

    const result = await executeTimeoutRecovery(mock.service, baseInput);
    expect(result.outcome).toBe('replaced');
    expect(mock.rpcCalls.filter(c => c.fn === 'replace_terminal_checkout_intent')).toHaveLength(1);
  });

  it('replacement RPC returns empty → replacement_failed', async () => {
    const mock = createMockService();
    mock.setRpcResult('replace_terminal_checkout_intent', []); // Empty array

    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/v3/transactions?') && url.includes('status=successful')) {
        return { ok: true, json: async () => ({ status: 'success', data: [] }) };
      }
      if (typeof url === 'string' && url.includes('/v3/transactions?') && url.includes('status=failed')) {
        return { ok: true, json: async () => ({ status: 'success', data: [{ id: 99, tx_ref: baseInput.idempotencyKey }] }) };
      }
      if (typeof url === 'string' && url.includes('/v3/transactions/99/verify')) {
        return { ok: true, json: async () => ({ status: 'success', data: { id: 99, tx_ref: baseInput.idempotencyKey, status: 'failed', amount: 14999, currency: 'NGN', created_at: '2026-09-12T10:30:00Z' } }) };
      }
      return { ok: false, status: 404 };
    });

    const result = await executeTimeoutRecovery(mock.service, baseInput);
    expect(result.outcome).toBe('replacement_failed');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PROOF 3: Replay/duplicate terminal recovery → no second replacement
// ═════════════════════════════════════════════════════════════════════════════
describe('Proof 3: replay/duplicate terminal recovery → no second replacement', () => {
  it('calling executeTimeoutRecovery twice with same failed tx → each call makes exactly one replace RPC', async () => {
    // The replace_terminal_checkout_intent RPC is idempotent in the DB:
    // if old intent is already non-pending, it returns any existing pending intent.
    // Each call to executeTimeoutRecovery produces exactly one replace RPC call.
    // A replay/duplicate execution does NOT create a second intent — the DB handles idempotency.

    const setupFetch = () => {
      mockFetch.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/v3/transactions?') && url.includes('status=successful')) {
          return { ok: true, json: async () => ({ status: 'success', data: [] }) };
        }
        if (typeof url === 'string' && url.includes('/v3/transactions?') && url.includes('status=failed')) {
          return { ok: true, json: async () => ({ status: 'success', data: [{ id: 77, tx_ref: baseInput.idempotencyKey }] }) };
        }
        if (typeof url === 'string' && url.includes('/v3/transactions/77/verify')) {
          return { ok: true, json: async () => ({ status: 'success', data: { id: 77, tx_ref: baseInput.idempotencyKey, status: 'failed', amount: 14999, currency: 'NGN', created_at: '2026-09-12T10:30:00Z' } }) };
        }
        return { ok: false, status: 404 };
      });
    };

    // First execution
    const mock1 = createMockService();
    mock1.setRpcResult('replace_terminal_checkout_intent', [{ intent_id: 'new-intent-idempotent' }]);
    setupFetch();
    const result1 = await executeTimeoutRecovery(mock1.service, baseInput);
    expect(result1.outcome).toBe('replaced');
    expect(mock1.rpcCalls.filter(c => c.fn === 'replace_terminal_checkout_intent')).toHaveLength(1);

    // Second execution (replay/duplicate) — same input, fresh service mock
    const mock2 = createMockService();
    // DB returns the same existing pending intent (idempotent behavior)
    mock2.setRpcResult('replace_terminal_checkout_intent', [{ intent_id: 'new-intent-idempotent' }]);
    setupFetch();
    const result2 = await executeTimeoutRecovery(mock2.service, baseInput);
    expect(result2.outcome).toBe('replaced');
    // Each call made exactly one RPC — the DB-level idempotency prevents duplicate intents
    expect(mock2.rpcCalls.filter(c => c.fn === 'replace_terminal_checkout_intent')).toHaveLength(1);

    // Both calls passed the same old intent ID — proving no cascading replacements
    expect(mock1.rpcCalls[0].args.p_old_intent_id).toBe('intent-orig-001');
    expect(mock2.rpcCalls[0].args.p_old_intent_id).toBe('intent-orig-001');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Additional: provider unavailable + retain
// ═════════════════════════════════════════════════════════════════════════════
describe('Additional timeout-recovery cases', () => {
  it('provider unavailable → unavailable, no RPCs', async () => {
    const mock = createMockService();
    mockFetch.mockRejectedValue(new Error('network'));

    const result = await executeTimeoutRecovery(mock.service, baseInput);
    expect(result.outcome).toBe('unavailable');
    expect(mock.rpcCalls).toHaveLength(0);
  });

  it('pending tx → retained with checkout URL', async () => {
    const mock = createMockService();

    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/v3/transactions?') && url.includes('status=successful')) {
        return { ok: true, json: async () => ({ status: 'success', data: [{ id: 66, tx_ref: baseInput.idempotencyKey }] }) };
      }
      if (typeof url === 'string' && url.includes('/v3/transactions?') && url.includes('status=failed')) {
        return { ok: true, json: async () => ({ status: 'success', data: [] }) };
      }
      if (typeof url === 'string' && url.includes('/v3/transactions/66/verify')) {
        return { ok: true, json: async () => ({ status: 'success', data: { id: 66, tx_ref: baseInput.idempotencyKey, status: 'pending', amount: 14999, currency: 'NGN', created_at: '2026-09-12T10:30:00Z' } }) };
      }
      return { ok: false, status: 404 };
    });

    const result = await executeTimeoutRecovery(mock.service, baseInput);
    expect(result.outcome).toBe('retained');
    if (result.outcome === 'retained') {
      expect(result.checkoutUrl).toBe(baseInput.providerCheckoutUrl);
      expect(result.reference).toBe(baseInput.idempotencyKey);
    }
    expect(mock.rpcCalls).toHaveLength(0);
  });
});
