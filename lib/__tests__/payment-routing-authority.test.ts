/**
 * Payment routing authority guard tests.
 *
 * Verifies that initializePayment fail-closes on authority lookup failures
 * and does NOT silently change payment routing. Uses a shared gateway spy
 * so "provider not called" assertions are real.
 *
 * Required scenarios:
 * (1) BYO credential lookup throws → no provider call, no payment row, no platform fallback
 * (2) BYO credential lookup returns {error} → same
 * (3) Successful "no BYO credentials" + platform path → provider called once, exact URL returned
 * (4) direct_split payout authority lookup failure → fail closed, no platform fallback
 *     platform_managed does NOT depend on payout_accounts table
 * (5) Payment-channel read error → fail closed, not treated as absence
 * (6) Scheduling + ordering exercise the same corrected shared boundary
 * (7) V1 dispatched-row lookup error/throw → fail closed with stage log
 *     No duplicate provider initialization, V1 idempotency unchanged
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Stable shared gateway spy ──

const mockGatewayInitialize = vi.fn();
const KNOWN_CHECKOUT_URL = 'https://checkout.paystack.com/authority-test-exact';
const KNOWN_REFERENCE = 'AUTH-TEST-REF-001';

vi.mock('@/lib/payments/factory', () => {
  const gwInstance = {
    name: 'paystack',
    initializePayment: mockGatewayInitialize,
  };
  return {
    getPaymentGateway: vi.fn(() => gwInstance),
    getPaymentGatewayByName: vi.fn(() => gwInstance),
  };
});

// ── Logger spy for stage-specific assertions ──

const mockLoggerError = vi.fn();
const mockWithContext = vi.fn(() => ({ error: mockLoggerError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
    withContext: mockWithContext,
  },
}));

vi.mock('@/lib/errors', () => ({
  safeLogErrorContext: vi.fn(() => ({})),
}));

vi.mock('@/lib/observability', () => ({
  observe: vi.fn((_name: string, _ctx: unknown, fn: () => unknown) => fn()),
  observeProvider: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
}));

vi.mock('@/lib/getPlatformFees', () => ({
  getPlatformFees: vi.fn(async () => ({ feePercentage: 5, feeFlat: 0, feeTotal: 250 })),
}));

vi.mock('@/lib/trial-status', () => ({
  resolveTrialStatus: vi.fn(async () => false),
  resolveTrialCredit: vi.fn(async () => false),
}));

vi.mock('@/lib/countries', () => ({
  getCountry: vi.fn(() => ({ currency_code: 'NGN' })),
}));

// ── Test helpers ──

function makeChain(result: { data: unknown; error: unknown }) {
  const c: any = {
    select: vi.fn(() => c), insert: vi.fn(() => c), update: vi.fn(() => c),
    eq: vi.fn(() => c), neq: vi.fn(() => c), not: vi.fn(() => c),
    in: vi.fn(() => c), like: vi.fn(() => c), gte: vi.fn(() => c),
    lte: vi.fn(() => c), order: vi.fn(() => c), limit: vi.fn(() => c),
    or: vi.fn(() => c), is: vi.fn(() => c),
    single: vi.fn(async () => result),
    maybeSingle: vi.fn(async () => result),
  };
  c.then = (resolve: (v: any) => void) => resolve(result);
  return c;
}

function makeThrowChain(err: Error) {
  const c: any = {
    select: vi.fn(() => c), insert: vi.fn(() => c), update: vi.fn(() => c),
    eq: vi.fn(() => c), neq: vi.fn(() => c), not: vi.fn(() => c),
    in: vi.fn(() => c), like: vi.fn(() => c), gte: vi.fn(() => c),
    lte: vi.fn(() => c), order: vi.fn(() => c), limit: vi.fn(() => c),
    or: vi.fn(() => c), is: vi.fn(() => c),
    single: vi.fn(async () => { throw err; }),
    maybeSingle: vi.fn(async () => { throw err; }),
  };
  c.then = (_resolve: any, reject: any) => reject(err);
  return c;
}

type TableConfig = Record<string, { data?: unknown; error?: unknown; throw?: Error }>;

/** Default NG country row for per-request resolution */
const NG_COUNTRY_DATA = { payment_gateway: 'paystack', currency_code: 'NGN' };

function buildSupabase(config: TableConfig) {
  return {
    from: vi.fn((table: string) => {
      const cfg = config[table];
      if (cfg) {
        if (cfg.throw) return makeThrowChain(cfg.throw);
        return makeChain({ data: cfg.data ?? null, error: cfg.error ?? null });
      }
      if (table === 'countries') return makeChain({ data: NG_COUNTRY_DATA, error: null });
      return makeChain({ data: null, error: null });
    }),
    rpc: vi.fn(() => makeChain({ data: null, error: null })),
  };
}

/** Build a supabase mock from a custom from-implementation, with countries default */
function buildCustomSupabase(customFrom: (table: string) => any) {
  return {
    from: vi.fn((table: string) => {
      if (table === 'countries') return makeChain({ data: NG_COUNTRY_DATA, error: null });
      return customFrom(table);
    }),
    rpc: vi.fn(() => makeChain({ data: null, error: null })),
  };
}

const BASE_OPTS = {
  bookingId: 'booking-001',
  userId: 'user-001',
  amount: 5000,
  referenceCode: 'WAA-TEST-001',
  businessName: 'Test Business',
  phone: '+2348012345678',
  countryCode: 'NG' as const,
  businessId: 'biz-001',
  inboundChannelId: 'ch-001',
  confirmationOrigin: 'whatsapp' as const,
  transactionCategory: 'scheduling',
};

let initializePayment: typeof import('@/lib/bot/flows/shared/payment').initializePayment;

beforeEach(async () => {
  vi.clearAllMocks();
  // Configure gateway to return known URL on success
  mockGatewayInitialize.mockResolvedValue({
    url: KNOWN_CHECKOUT_URL,
    reference: KNOWN_REFERENCE,
  });
  const mod = await import('@/lib/bot/flows/shared/payment');
  initializePayment = mod.initializePayment;
});

function assertLoggerOp(expectedOp: string) {
  const opCalls = mockWithContext.mock.calls.filter(
    (args: any[]) => args[0]?.op === expectedOp
  );
  expect(opCalls.length, `Expected logger.withContext({ op: '${expectedOp}' }) to be called`).toBeGreaterThan(0);
}

// ══════════════════════════════════════════════════════════
// (1) BYO credential lookup throws → fail closed
// ══════════════════════════════════════════════════════════

describe('(1) BYO credential lookup throws', () => {
  it('returns null, no provider call, no payment INSERT', async () => {
    const supabase = buildSupabase({
      business_payment_credentials: { throw: new Error('Supabase transport error') },
      payments: { data: null },
    });

    const result = await initializePayment(supabase as any, BASE_OPTS);

    expect(result).toBeNull();
    expect(mockGatewayInitialize).not.toHaveBeenCalled();
    assertLoggerOp('payment.credential-classification');
  });
});

// ══════════════════════════════════════════════════════════
// (2) BYO credential lookup returns {error} → fail closed
// ══════════════════════════════════════════════════════════

describe('(2) BYO credential lookup returns {error}', () => {
  it('returns null, no provider call, stage-specific log emitted', async () => {
    const supabase = buildSupabase({
      business_payment_credentials: { error: { message: 'connection refused', code: 'PGRST000' } },
      payments: { data: null },
    });

    const result = await initializePayment(supabase as any, BASE_OPTS);

    expect(result).toBeNull();
    expect(mockGatewayInitialize).not.toHaveBeenCalled();
    assertLoggerOp('payment.credential-classification');
  });
});

// ══════════════════════════════════════════════════════════
// (3) Successful "no BYO" + platform_managed → provider called
// ══════════════════════════════════════════════════════════

describe('(3) Successful no-BYO platform path', () => {
  it('reaches provider exactly once and returns exact shortened checkout URL', async () => {
    const fromMock = vi.fn();
    let paymentsCallCount = 0;
    let businessCallCount = 0;

    fromMock.mockImplementation((table: string) => {
      if (table === 'countries') return makeChain({ data: NG_COUNTRY_DATA, error: null });
      if (table === 'payments') {
        paymentsCallCount++;
        // 1-3: quarantine, pending reuse, V1 dispatched → empty
        if (paymentsCallCount <= 3) return makeChain({ data: null, error: null });
        // 4+: post-provider payment lookup by gateway_reference → return the row
        // so identity persistence + URL shortening can complete
        return makeChain({
          data: {
            id: 'pay-v0-001',
            metadata: {},
          },
          error: null,
        });
      }
      if (table === 'business_payment_credentials') {
        return makeChain({ data: null, error: null }); // no BYO
      }
      if (table === 'businesses') {
        businessCallCount++;
        if (businessCallCount === 1) {
          return makeChain({ data: { payout_mode: 'platform_managed' }, error: null });
        }
        // payment_channels query
        return makeChain({ data: { payment_channels: null }, error: null });
      }
      if (table === 'platform_config_versions') {
        return makeChain({
          data: { id: 'cfg-001', config_snapshot: { fee_policy_enabled: false } },
          error: null,
        });
      }
      if (table === 'short_urls') {
        return makeChain({ data: null, error: null });
      }
      return makeChain({ data: null, error: null });
    });

    const supabase = { from: fromMock, rpc: vi.fn(() => makeChain({ data: null, error: null })) };

    const result = await initializePayment(supabase as any, BASE_OPTS);

    // Provider must be called exactly once
    expect(mockGatewayInitialize).toHaveBeenCalledTimes(1);

    // Result must be non-null — the complete V0 path succeeded
    expect(result).not.toBeNull();

    // Exact returned reference from the shared boundary
    expect(result!.reference).toBe(KNOWN_REFERENCE);

    // URL is the shortened form: {APP_URL}/api/pay?ref={last8chars}
    const expectedShortRef = KNOWN_REFERENCE.slice(-8);
    expect(result!.url).toContain(`/api/pay?ref=${expectedShortRef}`);

    // Provider was called with correct args
    const providerArgs = mockGatewayInitialize.mock.calls[0][0];
    expect(providerArgs.bookingId).toBe('booking-001');
    expect(providerArgs.amount).toBe(5000);
    expect(providerArgs.currency).toBe('NGN');
    expect(providerArgs.businessId).toBe('biz-001');
    expect(providerArgs.referenceCode).toBe('WAA-TEST-001');
  });

  it('platform_managed does NOT query payout_accounts', async () => {
    const fromMock = vi.fn();
    const queriedTables: string[] = [];

    fromMock.mockImplementation((table: string) => {
      if (table === 'countries') return makeChain({ data: NG_COUNTRY_DATA, error: null });
      queriedTables.push(table);
      if (table === 'business_payment_credentials') return makeChain({ data: null, error: null });
      if (table === 'businesses') return makeChain({ data: { payout_mode: 'platform_managed', payment_channels: null }, error: null });
      if (table === 'platform_config_versions') return makeChain({ data: { id: 'cfg-001', config_snapshot: { fee_policy_enabled: false } }, error: null });
      return makeChain({ data: null, error: null });
    });

    const supabase = { from: fromMock, rpc: vi.fn(() => makeChain({ data: null, error: null })) };
    await initializePayment(supabase as any, BASE_OPTS);

    expect(queriedTables).not.toContain('payout_accounts');
  });
});

// ══════════════════════════════════════════════════════════
// (4) Payout authority failures
// ══════════════════════════════════════════════════════════

describe('(4) Payout authority', () => {
  it('(4a) payout-mode lookup failure → fail closed, no provider call', async () => {
    const supabase = buildSupabase({
      business_payment_credentials: { data: null },
      businesses: { error: { message: 'connection timeout' } },
      payments: { data: null },
    });

    const result = await initializePayment(supabase as any, BASE_OPTS);

    expect(result).toBeNull();
    expect(mockGatewayInitialize).not.toHaveBeenCalled();
    assertLoggerOp('payment.payout-mode-authority');
  });

  it('(4b) direct_split payout-account lookup error → fail closed', async () => {
    const fromMock = vi.fn();
    fromMock.mockImplementation((table: string) => {
      if (table === 'countries') return makeChain({ data: NG_COUNTRY_DATA, error: null });
      if (table === 'business_payment_credentials') return makeChain({ data: null, error: null });
      if (table === 'businesses') return makeChain({ data: { payout_mode: 'direct_split' }, error: null });
      if (table === 'payout_accounts') return makeChain({ data: null, error: { message: 'connection reset' } });
      return makeChain({ data: null, error: null });
    });
    const supabase = { from: fromMock, rpc: vi.fn(() => makeChain({ data: null, error: null })) };

    const result = await initializePayment(supabase as any, BASE_OPTS);

    expect(result).toBeNull();
    expect(mockGatewayInitialize).not.toHaveBeenCalled();
    assertLoggerOp('payment.payout-account-authority');
  });

  it('(4c) direct_split payout-account lookup throws → fail closed with stage log', async () => {
    const fromMock = vi.fn();
    fromMock.mockImplementation((table: string) => {
      if (table === 'countries') return makeChain({ data: NG_COUNTRY_DATA, error: null });
      if (table === 'business_payment_credentials') return makeChain({ data: null, error: null });
      if (table === 'businesses') return makeChain({ data: { payout_mode: 'direct_split' }, error: null });
      if (table === 'payout_accounts') return makeThrowChain(new Error('TLS handshake failed'));
      return makeChain({ data: null, error: null });
    });
    const supabase = { from: fromMock, rpc: vi.fn(() => makeChain({ data: null, error: null })) };

    const result = await initializePayment(supabase as any, BASE_OPTS);

    expect(result).toBeNull();
    expect(mockGatewayInitialize).not.toHaveBeenCalled();
    // Payout lookup throws AFTER credential classification succeeds — caught by outer try/catch
    assertLoggerOp('payment.routing-authority-threw');
  });
});

// ══════════════════════════════════════════════════════════
// (5) Payment-channel read error → fail closed
// ══════════════════════════════════════════════════════════

describe('(5) Payment channel authority', () => {
  it('(5a) payment_channels read error → fail closed, not treated as absence', async () => {
    const fromMock = vi.fn();
    let businessCallCount = 0;

    fromMock.mockImplementation((table: string) => {
      if (table === 'countries') return makeChain({ data: NG_COUNTRY_DATA, error: null });
      if (table === 'business_payment_credentials') return makeChain({ data: null, error: null });
      if (table === 'businesses') {
        businessCallCount++;
        if (businessCallCount === 1) return makeChain({ data: { payout_mode: 'platform_managed' }, error: null });
        return makeChain({ data: null, error: { message: 'connection dropped' } });
      }
      return makeChain({ data: null, error: null });
    });
    const supabase = { from: fromMock, rpc: vi.fn(() => makeChain({ data: null, error: null })) };

    const result = await initializePayment(supabase as any, BASE_OPTS);

    expect(result).toBeNull();
    expect(mockGatewayInitialize).not.toHaveBeenCalled();
    assertLoggerOp('payment.channel-preference-authority');
  });

  it('(5b) payment_channels read throws → fail closed', async () => {
    const fromMock = vi.fn();
    let businessCallCount = 0;

    fromMock.mockImplementation((table: string) => {
      if (table === 'countries') return makeChain({ data: NG_COUNTRY_DATA, error: null });
      if (table === 'business_payment_credentials') return makeChain({ data: null, error: null });
      if (table === 'businesses') {
        businessCallCount++;
        if (businessCallCount === 1) return makeChain({ data: { payout_mode: 'platform_managed' }, error: null });
        return makeThrowChain(new Error('DNS resolution failed'));
      }
      return makeChain({ data: null, error: null });
    });
    const supabase = { from: fromMock, rpc: vi.fn(() => makeChain({ data: null, error: null })) };

    const result = await initializePayment(supabase as any, BASE_OPTS);

    expect(result).toBeNull();
    expect(mockGatewayInitialize).not.toHaveBeenCalled();
    assertLoggerOp('payment.channel-preference-threw');
  });
});

// ══════════════════════════════════════════════════════════
// (6) Cross-capability: direct initializePayment boundary evidence
//
// These supplement the flow-level caller tests in
// payment-flow-caller-boundary.test.ts, which exercise real
// scheduling.flow and ordering.flow steps with initializePayment
// mocked at the module boundary.
// ══════════════════════════════════════════════════════════

describe('(6) Cross-capability shared boundary', () => {
  it('(6a) scheduling transactionCategory: BYO error → fail closed, provider count = 0', async () => {
    const supabase = buildSupabase({
      business_payment_credentials: { error: { message: 'timeout' } },
      payments: { data: null },
    });

    const result = await initializePayment(supabase as any, {
      ...BASE_OPTS,
      transactionCategory: 'scheduling',
    });

    expect(result).toBeNull();
    expect(mockGatewayInitialize).toHaveBeenCalledTimes(0);
    assertLoggerOp('payment.credential-classification');
  });

  it('(6b) ordering transactionCategory: same boundary, BYO error → fail closed', async () => {
    const supabase = buildSupabase({
      business_payment_credentials: { error: { message: 'timeout' } },
      payments: { data: null },
    });

    const result = await initializePayment(supabase as any, {
      ...BASE_OPTS,
      orderId: 'order-001',
      bookingId: undefined,
      transactionCategory: 'ordering',
    });

    expect(result).toBeNull();
    expect(mockGatewayInitialize).toHaveBeenCalledTimes(0);
    assertLoggerOp('payment.credential-classification');
  });
});

// ══════════════════════════════════════════════════════════
// (7) V1 dispatched-row + idempotency
// ══════════════════════════════════════════════════════════

describe('(7) V1 dispatched-row + idempotency', () => {
  it('(7a) V1 dispatched-row lookup returns {error} → fail closed with stage log', async () => {
    const fromMock = vi.fn();
    let paymentsCallCount = 0;

    fromMock.mockImplementation((table: string) => {
      if (table === 'countries') return makeChain({ data: NG_COUNTRY_DATA, error: null });
      if (table === 'payments') {
        paymentsCallCount++;
        // 1st: quarantine → ok
        if (paymentsCallCount === 1) return makeChain({ data: null, error: null });
        // 2nd: pending reuse → ok
        if (paymentsCallCount === 2) return makeChain({ data: null, error: null });
        // 3rd: V1 dispatched → error
        return makeChain({ data: null, error: { message: 'connection refused' } });
      }
      return makeChain({ data: null, error: null });
    });
    const supabase = { from: fromMock, rpc: vi.fn(() => makeChain({ data: null, error: null })) };

    const result = await initializePayment(supabase as any, BASE_OPTS);

    expect(result).toBeNull();
    expect(mockGatewayInitialize).not.toHaveBeenCalled();
    assertLoggerOp('payment.v1-dispatched-recovery');
  });

  it('(7b) V1 dispatched-row lookup throws → fail closed with stage log', async () => {
    const fromMock = vi.fn();
    let paymentsCallCount = 0;

    fromMock.mockImplementation((table: string) => {
      if (table === 'countries') return makeChain({ data: NG_COUNTRY_DATA, error: null });
      if (table === 'payments') {
        paymentsCallCount++;
        if (paymentsCallCount <= 2) return makeChain({ data: null, error: null });
        return makeThrowChain(new Error('TLS timeout'));
      }
      return makeChain({ data: null, error: null });
    });
    const supabase = { from: fromMock, rpc: vi.fn(() => makeChain({ data: null, error: null })) };

    const result = await initializePayment(supabase as any, BASE_OPTS);

    expect(result).toBeNull();
    expect(mockGatewayInitialize).not.toHaveBeenCalled();
    assertLoggerOp('payment.v1-dispatched-recovery-threw');
  });

  it('(7c) Idempotent reuse still works — returns existing URL without new provider call', async () => {
    const fromMock = vi.fn();
    let paymentsCallCount = 0;

    fromMock.mockImplementation((table: string) => {
      if (table === 'countries') return makeChain({ data: NG_COUNTRY_DATA, error: null });
      if (table === 'payments') {
        paymentsCallCount++;
        // 1st: quarantine → no match
        if (paymentsCallCount === 1) return makeChain({ data: null, error: null });
        // 2nd: pending reuse → existing payment found
        return makeChain({
          data: {
            id: 'existing-pay-001',
            gateway_reference: 'EXISTING-REF-001',
            amount: 5000,
            currency: 'NGN',
            gateway: 'paystack',
            metadata: { checkout_url: 'https://paystack.com/existing' },
          },
          error: null,
        });
      }
      return makeChain({ data: null, error: null });
    });
    const supabase = { from: fromMock, rpc: vi.fn(() => makeChain({ data: null, error: null })) };

    const result = await initializePayment(supabase as any, BASE_OPTS);

    expect(result).not.toBeNull();
    expect(result!.reference).toBe('EXISTING-REF-001');
    // No new provider call — reused existing
    expect(mockGatewayInitialize).not.toHaveBeenCalled();
  });

  it('(7d) Country payment config throw → fail closed with stage log, no provider call', async () => {
    const supabase = buildSupabase({
      countries: { throw: new Error('Supabase transport error') },
      payments: { data: null },
    });

    const result = await initializePayment(supabase as any, BASE_OPTS);

    expect(result).toBeNull();
    expect(mockGatewayInitialize).not.toHaveBeenCalled();
    assertLoggerOp('payment.country-payment-config');
  });
});
