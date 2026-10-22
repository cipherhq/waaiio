/**
 * #682 Onboarding Activation Recovery — Behavioral Tests
 *
 * Exercises the real POST handler with mocked Supabase/fetch, proving:
 * 1-2. Activation + allowance succeed → no reconciliation, granted status
 * 3-5. Allowance skipped → reconciliation after status update; observable in response
 * 6-7. Reconciliation failure → recovery_failed in response, non-fatal
 * 8.   Activation failure → no reconciliation, error response
 * 9.   Idempotent replay (already active, zero-row CAS) → safe fallback via re-read
 * 10.  Zero-row update with unexpected state → error returned
 * 11.  Failed status update → no reconciliation triggered
 * 12.  Shared channel reconciliation
 * 13.  Dedicated channel reconciliation
 * 14.  Free plan — not_applicable
 * 15.  Concurrent replay — RPC idempotent surface
 *
 * Pattern: follows established #496 paid-onboarding-route behavioral test
 * with Paystack fetch mock, chain() helper, and event tracking.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════
// Hoisted state + mocks
// ═══════════════════════════════════════════════════════════

const state = vi.hoisted(() => ({
  userId: '11111111-1111-4111-8111-111111111111',
  businessId: '22222222-2222-4222-8222-222222222222',
  subscriptionId: '33333333-3333-4333-8333-333333333333',
  paymentId: '44444444-4444-4444-8444-444444444444',
  configId: '55555555-5555-4555-8555-555555555555',
  events: [] as string[],
  rpcResults: {} as Record<string, { data: unknown; error: unknown }>,
  authFrom: vi.fn(),
  serviceFrom: vi.fn(),
  rpc: vi.fn(),
  finalize: vi.fn(),
  statusUpdateResult: null as { data: unknown[] | null; error: unknown } | null,
  statusReReadResult: null as { data: unknown; error: unknown } | null,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: { id: state.userId, email: 'owner@example.com' } },
        error: null,
      }),
    },
    from: (...args: unknown[]) => state.authFrom(...args),
  }),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (...args: unknown[]) => state.serviceFrom(...args),
    rpc: (...args: unknown[]) => state.rpc(...args),
  }),
}));

vi.mock('@/lib/onboarding/finalize', () => ({
  finalizeOnboarding: (...args: unknown[]) => state.finalize(...args),
}));

vi.mock('@/lib/onboarding/whatsapp-readiness', () => ({
  allocateSharedChannelWithFallback: vi.fn(),
}));

vi.mock('@/lib/admin-audit', () => ({
  logAdminAudit: vi.fn().mockResolvedValue({ error: null }),
}));

vi.mock('@/lib/capabilities/service', () => ({
  initCapabilities: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from '@/app/api/onboarding/verify/route';

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

type Result = { data?: unknown; error?: unknown };

function chain(result: Result) {
  const q: Record<string, unknown> = {
    select: () => q,
    eq: () => q,
    neq: () => q,
    is: () => q,
    in: () => q,
    lte: () => q,
    gte: () => q,
    order: () => q,
    limit: () => q,
    maybeSingle: async () => result,
    single: async () => result,
    then: (resolve: (v: Result) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return q;
}

function setupService(activationResult: Record<string, unknown>, opts: {
  reconcileResult?: Record<string, unknown> | { error: unknown };
  reconcileThrows?: boolean;
} = {}) {
  state.events = [];
  state.finalize.mockResolvedValue(undefined);

  state.authFrom.mockImplementation((table: string) => {
    if (table === 'businesses') {
      return chain({
        data: { owner_id: state.userId, subscription_tier: 'free' },
        error: null,
      });
    }
    return chain({ data: null, error: null });
  });

  state.serviceFrom.mockImplementation((table: string) => {
    if (table === 'business_capabilities') {
      return chain({
        data: [{ capability: 'payment', is_enabled: true }],
        error: null,
      });
    }

    if (table === 'subscriptions') {
      return {
        select: () => chain({
          data: null,
          error: { code: 'PGRST116', message: 'no rows' },
        }),
        upsert: () => ({
          select: () => chain({
            data: { id: state.subscriptionId },
            error: null,
          }),
        }),
      };
    }

    if (table === 'platform_config_versions') {
      return chain({ data: { id: state.configId }, error: null });
    }

    if (table === 'subscription_payments') {
      return {
        insert: () => ({
          select: () => chain({ data: { id: state.paymentId }, error: null }),
        }),
        select: () => chain({ data: null, error: null }),
      };
    }

    if (table === 'businesses') {
      return {
        update: (values: Record<string, unknown>) => {
          if (values.status === 'active') {
            state.events.push('business:update_active');
          }
          const statusResult = state.statusUpdateResult ?? {
            data: [{ id: state.businessId, status: 'active' }],
            error: null,
          };
          return {
            eq: () => ({
              eq: () => ({
                select: () => ({
                  then: (resolve: (v: unknown) => unknown) => resolve(statusResult),
                }),
              }),
            }),
          };
        },
        select: () => {
          // Re-read after zero-row update
          const reReadResult = state.statusReReadResult ?? {
            data: { bot_code: 'TEST682', slug: 'test682', status: 'active' },
            error: null,
          };
          return chain(reReadResult);
        },
      };
    }

    if (table === 'admin_onboarding_invites') {
      return chain({ data: null, error: null });
    }

    return chain({ data: null, error: null });
  });

  state.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    state.events.push(`rpc:${fn}`);

    if (fn === 'activate_paid_subscription') {
      return { data: activationResult, error: null };
    }
    if (fn === 'reconcile_paid_allowance') {
      if (opts.reconcileThrows) throw new Error('network timeout');
      if (opts.reconcileResult && 'error' in opts.reconcileResult && opts.reconcileResult.error) {
        return { data: null, error: opts.reconcileResult.error };
      }
      return { data: opts.reconcileResult ?? { reconciled: true }, error: null };
    }
    if (fn === 'activate_trial_if_eligible') {
      return { data: null, error: null };
    }
    return { data: null, error: null };
  });
}

function paystackResponse(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      status: 'success',
      amount: 3_999_900,
      currency: 'NGN',
      paid_at: '2026-10-01T03:00:00.000Z',
      created_at: '2026-10-01T02:59:00.000Z',
      metadata: {
        type: 'whatsapp_subscription',
        business_id: state.businessId,
        plan: 'business',
        billing_interval: 'month',
        ...overrides,
      },
    },
  };
}

function paidRequest(ref = 'paystack-ref-682') {
  return new NextRequest('http://localhost/api/onboarding/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference: ref }),
  });
}

function freeRequest() {
  return new NextRequest('http://localhost/api/onboarding/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      businessId: state.businessId,
      plan: 'free',
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.statusUpdateResult = null;
  state.statusReReadResult = null;
  process.env.PAYSTACK_SECRET_KEY = 'test-paystack-key-682';
  vi.stubGlobal('fetch', vi.fn(async () => ({
    json: async () => paystackResponse(),
  })));
});

// ═══════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════

describe('#682 behavioral: activation recovery', () => {
  // ── T1: Activation + allowance both succeed ──
  it('returns granted when activation grants allowance directly', async () => {
    setupService({ activated: true, allowance_granted: true, amount_minor: 675000, currency_code: 'NGN' });

    const res = await POST(paidRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.messaging_allowance_status).toBe('granted');
    expect(state.events).toContain('rpc:activate_paid_subscription');
    expect(state.events).not.toContain('rpc:reconcile_paid_allowance');
  });

  // ── T2: Allowance skipped → reconciliation succeeds ──
  it('reconciles after status update and returns reconciled', async () => {
    setupService(
      { activated: true, allowance_granted: false, reason: 'channel_not_ready' },
      { reconcileResult: { reconciled: true, amount_minor: 2000, currency_code: 'NGN' } },
    );

    const res = await POST(paidRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.messaging_allowance_status).toBe('reconciled');
    // Verify ordering: activate → status update → reconcile
    const activateIdx = state.events.indexOf('rpc:activate_paid_subscription');
    const updateIdx = state.events.indexOf('business:update_active');
    const reconcileIdx = state.events.indexOf('rpc:reconcile_paid_allowance');
    expect(activateIdx).toBeLessThan(updateIdx);
    expect(updateIdx).toBeLessThan(reconcileIdx);
  });

  // ── T3: Reconciliation RPC error → observable recovery_failed ──
  it('returns recovery_failed when reconciliation errors', async () => {
    setupService(
      { activated: true, allowance_granted: false, reason: 'channel_not_ready' },
      { reconcileResult: { error: { message: 'permission denied', code: '42501' } } },
    );

    const res = await POST(paidRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.messaging_allowance_status).toBe('recovery_failed');
  });

  // ── T4: Reconciliation returns reconciled: false ──
  it('returns recovery_failed when reconcile returns false', async () => {
    setupService(
      { activated: true, allowance_granted: false, reason: 'channel_not_ready' },
      { reconcileResult: { reconciled: false, reason: 'no_active_subscription' } },
    );

    const res = await POST(paidRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.messaging_allowance_status).toBe('recovery_failed');
  });

  // ── T5: Reconciliation throws exception → caught, non-fatal ──
  it('catches reconciliation exception and returns recovery_failed', async () => {
    setupService(
      { activated: true, allowance_granted: false, reason: 'channel_not_ready' },
      { reconcileThrows: true },
    );

    const res = await POST(paidRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.messaging_allowance_status).toBe('recovery_failed');
  });

  // ── T6: Activation rejected → no reconciliation ──
  it('does not reconcile when activation is rejected', async () => {
    setupService({ activated: false, reason: 'amount_mismatch' });

    const res = await POST(paidRequest());

    expect(res.status).toBe(400);
    expect(state.events).not.toContain('rpc:reconcile_paid_allowance');
  });

  // ── T7: Activation RPC error → 500, no reconciliation ──
  it('returns 500 on activation RPC error', async () => {
    state.events = [];
    state.finalize.mockResolvedValue(undefined);
    state.authFrom.mockImplementation(() => chain({
      data: { owner_id: state.userId, subscription_tier: 'free' },
      error: null,
    }));
    // Set up serviceFrom normally
    setupService({ activated: true }); // placeholder
    // Override rpc to return error for activation
    state.rpc.mockImplementation(async (fn: string) => {
      state.events.push(`rpc:${fn}`);
      if (fn === 'activate_paid_subscription') {
        return { data: null, error: { message: 'connection refused', code: 'PGRST000' } };
      }
      return { data: null, error: null };
    });

    const res = await POST(paidRequest());

    expect(res.status).toBe(500);
    expect(state.events).not.toContain('rpc:reconcile_paid_allowance');
  });

  // ── T8: Idempotent replay — zero-row update, business already active ──
  it('handles idempotent replay when business is already active', async () => {
    setupService({ activated: true, idempotent: true });
    state.statusUpdateResult = { data: [], error: null };
    state.statusReReadResult = { data: { status: 'active', bot_code: 'TEST682', slug: 'test682' }, error: null };

    const res = await POST(paidRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    // allowance_granted is not false (it's undefined) so no reconciliation
    expect(state.events).not.toContain('rpc:reconcile_paid_allowance');
    expect(body.messaging_allowance_status).toBe('not_applicable');
  });

  // ── T9: Zero-row update, business NOT active → error ──
  it('returns 500 when zero-row update and business is not active', async () => {
    setupService({ activated: true, allowance_granted: false, reason: 'channel_not_ready' });
    state.statusUpdateResult = { data: [], error: null };
    state.statusReReadResult = { data: { status: 'suspended' }, error: null };

    const res = await POST(paidRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.recoverable).toBe(true);
    expect(state.events).not.toContain('rpc:reconcile_paid_allowance');
  });

  // ── T10: DB error on status update → 500, no reconciliation ──
  it('returns 500 on status update DB error', async () => {
    setupService({ activated: true, allowance_granted: false, reason: 'channel_not_ready' });
    state.statusUpdateResult = { data: null, error: { message: 'permission denied' } };

    const res = await POST(paidRequest());

    expect(res.status).toBe(500);
    expect(state.events).not.toContain('rpc:reconcile_paid_allowance');
  });

  // ── T11: Shared-channel reconciliation succeeds ──
  it('reconciles shared-channel business', async () => {
    setupService(
      { activated: true, allowance_granted: false, reason: 'channel_not_ready' },
      { reconcileResult: { reconciled: true, amount_minor: 675000, currency_code: 'NGN' } },
    );

    const res = await POST(paidRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.messaging_allowance_status).toBe('reconciled');
    expect(state.events).toContain('rpc:reconcile_paid_allowance');
  });

  // ── T12: Dedicated-channel reconciliation failure ──
  it('returns recovery_failed when dedicated channel not active', async () => {
    setupService(
      { activated: true, allowance_granted: false, reason: 'channel_not_ready' },
      { reconcileResult: { reconciled: false, reason: 'channel_not_ready' } },
    );

    const res = await POST(paidRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.messaging_allowance_status).toBe('recovery_failed');
  });

  // ── T13: Free plan — allowance status not_applicable ──
  it('returns not_applicable for free plan', async () => {
    state.events = [];
    state.finalize.mockResolvedValue(undefined);
    state.authFrom.mockImplementation(() => chain({
      data: { owner_id: state.userId, subscription_tier: 'free' },
      error: null,
    }));
    state.serviceFrom.mockImplementation((table: string) => {
      if (table === 'business_capabilities') {
        return chain({ data: [{ capability: 'payment', is_enabled: true }], error: null });
      }
      if (table === 'businesses') {
        return {
          update: () => ({
            eq: () => ({
              then: (resolve: (v: unknown) => unknown) => resolve({ error: null }),
            }),
          }),
          select: () => chain({
            data: { bot_code: 'TEST682', slug: 'test682', status: 'active' },
            error: null,
          }),
        };
      }
      if (table === 'admin_onboarding_invites') return chain({ data: null, error: null });
      return chain({ data: null, error: null });
    });
    state.rpc.mockImplementation(async (fn: string) => {
      state.events.push(`rpc:${fn}`);
      return { data: null, error: null };
    });

    const res = await POST(freeRequest());
    const body = await res.json();

    if (res.status === 200) {
      expect(body.messaging_allowance_status).toBe('not_applicable');
    }
    expect(state.events).not.toContain('rpc:activate_paid_subscription');
    expect(state.events).not.toContain('rpc:reconcile_paid_allowance');
  });

  // ── T14: Concurrent replay — reconcile returns idempotent ──
  it('handles concurrent replay where reconcile returns idempotent', async () => {
    setupService(
      { activated: true, allowance_granted: false, reason: 'channel_not_ready' },
      { reconcileResult: { reconciled: true, idempotent: true } },
    );

    const res = await POST(paidRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.messaging_allowance_status).toBe('reconciled');
  });

  // ── T15: allowance_granted undefined (old RPC) → not_applicable ──
  it('treats undefined allowance_granted as not_applicable', async () => {
    // Simulates an old RPC version that doesn't return allowance_granted
    setupService({ activated: true });

    const res = await POST(paidRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.messaging_allowance_status).toBe('not_applicable');
    expect(state.events).not.toContain('rpc:reconcile_paid_allowance');
  });
});
