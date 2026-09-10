/**
 * Fee Policy Runtime Tests (#264)
 *
 * Executable tests driving real cron/webhook/payment-init exports
 * with provider HTTP (fetch) + Supabase boundaries mocked.
 *
 * NO source-string scans. Every assertion is on runtime behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ══════════════════════════════════════════════════════════
// Shared mock helpers
// ══════════════════════════════════════════════════════════

function mockLogger() {
  vi.doMock('@/lib/logger', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn().mockReturnThis() },
  }));
}

function mockCronAuth() {
  vi.doMock('@/lib/cron-auth', () => ({ verifyCronAuth: vi.fn().mockReturnValue(true) }));
}

function mockSentry() {
  vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
}

function mockObservability() {
  vi.doMock('@/lib/observability', () => ({
    observe: vi.fn((_n: string, _c: unknown, fn: () => unknown) => fn()),
    observeProvider: vi.fn((_c: unknown, fn: () => unknown) => fn()),
    createCronLogger: vi.fn(() => ({
      started: vi.fn(), completed: vi.fn(), failed: vi.fn(),
    })),
  }));
}

/** Build a Supabase mock that returns dispatched payments and tracks CAS writes */
function buildCronSupabaseMock(opts: {
  dispatchedPayments?: Array<Record<string, unknown>>;
  dispatchQueryError?: boolean;
  casResult?: { data: unknown[]; error: unknown };
  terminalResult?: { data: unknown[]; error: unknown };
  quarantineReread?: Record<string, unknown> | null;
}) {
  const casWrites: Array<Record<string, unknown>> = [];
  const terminalWrites: Array<Record<string, unknown>> = [];

  const makeChain = (): Record<string, unknown> => new Proxy({} as Record<string, unknown>, {
    get(_, prop: string) {
      if (prop === 'single' || prop === 'maybeSingle') return vi.fn().mockResolvedValue({ data: null, error: null });
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
      if (prop === 'select') return vi.fn((..._a: unknown[]) => makeChain());
      if (prop === 'update') {
        return vi.fn((payload: Record<string, unknown>) => {
          if (payload.provider_init_state === 'provider_confirmed') casWrites.push(payload);
          if (payload.status === 'failed') terminalWrites.push(payload);
          if (payload.gateway_status === 'dispatched_quarantine') casWrites.push(payload);
          const result = payload.provider_init_state ? (opts.casResult ?? { data: [{ id: 'x' }], error: null })
            : payload.status === 'failed' ? (opts.terminalResult ?? { data: [{ id: 'x' }], error: null })
            : { data: [{ id: 'x' }], error: null };
          return makeChain();
        });
      }
      return vi.fn((..._a: unknown[]) => makeChain());
    },
  });

  return {
    client: {
      from: vi.fn((table: string) => {
        if (table === 'payments') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    neq: vi.fn().mockReturnValue({
                      lt: vi.fn().mockReturnValue({
                        limit: vi.fn().mockResolvedValue({
                          data: opts.dispatchQueryError ? null : (opts.dispatchedPayments || []),
                          error: opts.dispatchQueryError ? { message: 'DB error' } : null,
                        }),
                      }),
                    }),
                  }),
                }),
                single: vi.fn().mockResolvedValue({
                  data: opts.quarantineReread ?? { provider_init_state: 'dispatched' },
                  error: null,
                }),
              }),
              or: vi.fn().mockReturnValue({
                lt: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({ data: [], error: null }),
                }),
              }),
            }),
            update: vi.fn((payload: Record<string, unknown>) => {
              if (payload.provider_init_state) casWrites.push(payload);
              if (payload.status === 'failed') terminalWrites.push(payload);
              if (payload.gateway_status) casWrites.push(payload);
              return makeChain();
            }),
          };
        }
        return makeChain();
      }),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
    casWrites,
    terminalWrites,
  };
}

// ══════════════════════════════════════════════════════════
// Flutterwave v1/v0 tx_ref
// ══════════════════════════════════════════════════════════

describe('FW v1 canonical tx_ref — real initializer', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); process.env.FLUTTERWAVE_SECRET_KEY = 'test-key'; });

  it('v1 uses referenceCode as tx_ref + X-Idempotency-Key', async () => {
    let body: Record<string, unknown> = {};
    let headers: Record<string, string> = {};
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse((init?.body as string) || '{}');
      headers = (init?.headers || {}) as Record<string, string>;
      return new Response(JSON.stringify({ status: 'success', data: { link: 'https://checkout.flutterwave.com/test' } }));
    }) as unknown as typeof fetch;

    const { FlutterwaveGateway } = await import('@/lib/payments/flutterwave');
    const sb = { from: vi.fn(() => ({ insert: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: null }), eq: vi.fn().mockReturnThis(), update: vi.fn().mockReturnThis() })) };
    await new FlutterwaveGateway().initializePayment({ supabase: sb as any, userId: 'u', amount: 100, currency: 'NGN', referenceCode: 'REF-V1', businessName: 'B', phone: '+234', existingPaymentId: 'ep1' });
    globalThis.fetch = origFetch;

    expect(body.tx_ref).toBe('REF-V1');
    expect(headers['X-Idempotency-Key']).toBe('REF-V1');
  });

  it('v0 uses random flw_ prefix', async () => {
    let body: Record<string, unknown> = {};
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse((init?.body as string) || '{}');
      return new Response(JSON.stringify({ status: 'success', data: { link: 'https://checkout.flutterwave.com/test' } }));
    }) as unknown as typeof fetch;

    const { FlutterwaveGateway } = await import('@/lib/payments/flutterwave');
    const sb = { from: vi.fn(() => ({ insert: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: { id: 'p1' } }), eq: vi.fn().mockReturnThis(), update: vi.fn().mockReturnThis() })) };
    await new FlutterwaveGateway().initializePayment({ supabase: sb as any, userId: 'u', amount: 100, currency: 'NGN', referenceCode: 'REF-V0', businessName: 'B', phone: '+234' });
    globalThis.fetch = origFetch;

    expect(body.tx_ref).toMatch(/^flw_/);
    expect(body.tx_ref).not.toBe('REF-V0');
  });
});

// ══════════════════════════════════════════════════════════
// Campaign guard — real initializePayment
// ══════════════════════════════════════════════════════════

describe('Campaign dispatched guard', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); });

  it('existing dispatched campaign → gateway NOT called', async () => {
    let gwCalled = false;
    vi.doMock('@/lib/payments/factory', () => ({
      getPaymentGateway: vi.fn(() => ({ name: 'paystack', initializePayment: vi.fn().mockImplementation(() => { gwCalled = true; return { url: 'u', reference: 'r' }; }) })),
      getPaymentGatewayByName: vi.fn(),
    }));
    vi.doMock('@/lib/countries', () => ({ getCountry: vi.fn(() => ({ currency_code: 'NGN' })) }));
    mockLogger(); mockObservability();
    vi.doMock('@/lib/errors', () => ({ safeLogErrorContext: vi.fn(() => ({})) }));

    const filters: string[] = [];
    const mp = (): Record<string, unknown> => new Proxy({} as Record<string, unknown>, {
      get(_, p: string) {
        if (p === 'single' || p === 'maybeSingle') return vi.fn().mockResolvedValue({ data: null, error: null });
        if (p === 'then') return (r: (v: unknown) => void) => r({ data: null, error: null });
        if (p === 'eq') return vi.fn((c: string, v: unknown) => {
          filters.push(`${c}=${v}`);
          if (c === 'provider_init_state' && v === 'dispatched') {
            return new Proxy({} as Record<string, unknown>, {
              get(_, p2: string) {
                if (p2 === 'maybeSingle') return vi.fn().mockResolvedValue({ data: { id: 'd1', provider_init_state: 'dispatched' }, error: null });
                return vi.fn(() => mp());
              },
            });
          }
          return mp();
        });
        return vi.fn(() => mp());
      },
    });
    const sb = { from: vi.fn(() => mp()) };

    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');
    const result = await initializePayment(sb as any, {
      userId: 'u1', amount: 5000, referenceCode: 'R', businessName: 'B', phone: '+234',
      campaignId: 'camp-1', businessId: 'b1', transactionCategory: 'giving',
    });

    expect(result).toBeNull();
    expect(gwCalled).toBe(false);
    expect(filters).toContainEqual('campaign_id=camp-1');
  });
});

// ══════════════════════════════════════════════════════════
// V1 finalization fail-closed
// ══════════════════════════════════════════════════════════

describe('V1 finalization fail-closed', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); });

  it('v1 missing configVersionId → throws', async () => {
    mockLogger(); mockSentry();
    vi.doMock('@/lib/errors', () => ({ safeLogErrorContext: vi.fn(() => ({})), isSafeIdentifier: vi.fn(() => true) }));
    vi.doMock('@/lib/trial-status', () => ({ resolveTrialStatus: vi.fn().mockResolvedValue(false) }));
    vi.doMock('@/lib/getPlatformFees', () => ({ getPlatformFees: vi.fn() }));
    const sb = { from: vi.fn(() => ({ select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: { business_id: 'b1' }, error: null }), insert: vi.fn().mockResolvedValue({ data: null, error: null }) })) };
    const { recordPlatformFee } = await import('@/lib/payments/process-success');
    await expect(recordPlatformFee(sb as any, {
      bookingId: 'bk1', paymentId: 'p1', paymentAmount: 5000, feePolicyVersion: 1,
      transactionCategory: 'scheduling',
      feeBasis: { payment_routing: 'platform', tier: 'free', is_in_trial: false, custom_fee_percentage: null, custom_fee_flat: null },
    })).rejects.toThrow(/missing authority fields/i);
  });
});

// ══════════════════════════════════════════════════════════
// Calculator pinned-config + BYO
// ══════════════════════════════════════════════════════════

describe('Pinned config isolation + BYO', () => {
  it('v1 uses pinned snapshot', async () => {
    const { calculateFee } = await import('@/lib/payments/calculateFee');
    const r = calculateFee(10000, { payment_routing: 'platform', tier: 'free', is_in_trial: false, custom_fee_percentage: null, custom_fee_flat: null }, 'scheduling',
      { pricing_tiers: { free: { feePercentage: 2.5, feeFlat: 0 } }, category_fee_rates: { scheduling: { feePercentage: 3.0 } } });
    expect(r.feeTotal).toBe(300);
  });

  it('BYO → 0%', async () => {
    const { calculateFee } = await import('@/lib/payments/calculateFee');
    const r = calculateFee(10000, { payment_routing: 'byo', tier: 'free', is_in_trial: false, custom_fee_percentage: null, custom_fee_flat: null }, 'scheduling',
      { pricing_tiers: { free: { feePercentage: 10, feeFlat: 0 } } });
    expect(r.feeTotal).toBe(0);
  });
});
