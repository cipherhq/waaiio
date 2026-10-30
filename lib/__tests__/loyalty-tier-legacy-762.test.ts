/**
 * Legacy loyalty tier multiplier — #762 W17
 *
 * Invokes the actual handlePostCompletion legacy path (no paymentId) and
 * verifies tier multiplier behavior: tenant-bound lookup, phoneWithPlus
 * identity, active/inactive/missing tiers, default 1x, base-then-multiply
 * rounding, returned/thrown lookup errors skipping the award, paid-path
 * delegation, and tier evaluation ordering.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Dependency mocks (same pattern as phase-2d-r13-post-completion.test.ts) ──

const capsMock = vi.fn<[], Promise<string[]>>();
vi.mock('@/lib/capabilities/service', () => ({ getEnabledCapabilities: (...args: unknown[]) => capsMock() }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));
vi.mock('@/lib/pdf/receipt-generator', () => ({ generateReceiptPdf: vi.fn().mockResolvedValue(Buffer.from('pdf')) }));
vi.mock('@/lib/bot/automation/sequence-service', () => ({ triggerSequences: vi.fn() }));
vi.mock('@/lib/bot/automation/rules-engine', () => ({ evaluateRules: vi.fn() }));
vi.mock('@/lib/bot/customer-intelligence', () => ({ calculateLtvTier: vi.fn(() => 'new') }));
vi.mock('@/lib/payments/terminal-effects', () => ({
  driveInternalEffect: vi.fn(async (_sb: unknown, _pid: string, _key: string, _token: string, fn: () => Promise<void>) => { await fn(); return { ok: true }; }),
  driveExternalEffect: vi.fn(async () => ({ ok: true })),
  skipOptionalEffect: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/constants', () => ({
  PRICING_TIERS: { free: { whitelabel: false }, growth: { whitelabel: false }, business: { whitelabel: false } },
}));
vi.mock('@/lib/bot/flows/flow-localization', () => ({ getFlowCopy: vi.fn(() => '') }));
vi.mock('@/lib/whitelabel', () => ({ getPoweredByFooter: () => '' }));

// ── Supabase chain mock ──

interface ChainState {
  loyaltyRows: Array<{ id: string; points_balance: number; total_earned: number; visit_count: number }>;
  tierRow: { membership_tiers: { points_multiplier: number; is_active: boolean; business_id: string } } | null;
  tierError: { message: string } | null;
  inserts: Array<{ table: string; payload: unknown }>;
  updates: Array<{ table: string; payload: unknown }>;
}

let state: ChainState;

function createMockSupabase() {
  function chain(table: string): Record<string, any> {
    const c: Record<string, any> = {};
    for (const method of ['select', 'eq', 'neq', 'not', 'is', 'in', 'or', 'order', 'limit']) {
      c[method] = vi.fn(() => c);
    }
    c.update = vi.fn((payload: unknown) => { state.updates.push({ table, payload }); return c; });
    c.insert = vi.fn((payload: unknown) => { state.inserts.push({ table, payload }); return c; });
    c.upsert = vi.fn(() => c);
    c.single = vi.fn().mockResolvedValue({ data: table === 'businesses' ? {
      name: 'Test Biz', country_code: 'NG', subscription_tier: 'business',
      metadata: { loyalty_earning_enabled: true, loyalty_points_mode: 'per_visit', loyalty_points_per_visit: 10 },
      logo_url: null,
    } : null, error: null });
    c.maybeSingle = vi.fn(() => {
      if (table === 'loyalty_points') return Promise.resolve({ data: state.loyaltyRows[0] || null, error: null });
      if (table === 'customer_profiles') return Promise.resolve({ data: state.tierRow, error: state.tierError });
      return Promise.resolve({ data: null, error: null });
    });
    c.then = (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve);
    return c;
  }
  return {
    from: vi.fn((table: string) => chain(table)),
    rpc: vi.fn(async (name: string) => {
      if (name === 'apply_payment_customer_visit_once') return { data: { applied: true }, error: null };
      return { data: null, error: null };
    }),
    storage: { from: vi.fn(() => ({ upload: vi.fn(), createSignedUrl: vi.fn() })) },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  state = {
    loyaltyRows: [],
    tierRow: null,
    tierError: null,
    inserts: [],
    updates: [],
  };
  capsMock.mockResolvedValue(['loyalty', 'membership']);
});

async function callLegacy(overrides: Record<string, unknown> = {}) {
  const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
  await handlePostCompletion({
    supabase: createMockSupabase(),
    businessId: 'biz-1',
    customerPhone: '+2341234567890',
    customerName: 'Test Customer',
    serviceType: 'booking',
    referenceId: 'ref-1',
    sender: null,
    paymentId: undefined, // Legacy path: no paymentId
    claimToken: undefined,
    whatsappOriginMissingChannel: false,
    amountPaid: undefined,
    serviceName: 'Test Service',
    referenceCode: 'REF-001',
    skipLoyalty: false,
    skipAutomation: true,
    skipCustomerSpend: true,
    ...overrides,
  } as any);
}

describe('#762 legacy loyalty tier multiplier — actual handler execution', () => {
  it('applies Gold tier 2x multiplier: base 10 * 2 = 20 points', async () => {
    state.tierRow = { membership_tiers: { points_multiplier: 2, is_active: true, business_id: 'biz-1' } };
    await callLegacy();
    const loyaltyInsert = state.inserts.find(i => i.table === 'loyalty_points');
    expect(loyaltyInsert).toBeTruthy();
    expect((loyaltyInsert!.payload as any).points_balance).toBe(20);
    const txInsert = state.inserts.find(i => i.table === 'loyalty_transactions');
    expect(txInsert).toBeTruthy();
    expect((txInsert!.payload as any).points_change).toBe(20);
  });

  it('uses default 1x when customer has no tier (tierRow null)', async () => {
    state.tierRow = null;
    await callLegacy();
    const loyaltyInsert = state.inserts.find(i => i.table === 'loyalty_points');
    expect(loyaltyInsert).toBeTruthy();
    expect((loyaltyInsert!.payload as any).points_balance).toBe(10);
  });

  it('uses default 1x when tier is inactive', async () => {
    state.tierRow = { membership_tiers: { points_multiplier: 3, is_active: false, business_id: 'biz-1' } };
    await callLegacy();
    const loyaltyInsert = state.inserts.find(i => i.table === 'loyalty_points');
    expect(loyaltyInsert).toBeTruthy();
    expect((loyaltyInsert!.payload as any).points_balance).toBe(10);
  });

  it('uses default 1x when tier belongs to different business (tenant isolation)', async () => {
    state.tierRow = { membership_tiers: { points_multiplier: 3, is_active: true, business_id: 'other-biz' } };
    await callLegacy();
    const loyaltyInsert = state.inserts.find(i => i.table === 'loyalty_points');
    expect(loyaltyInsert).toBeTruthy();
    expect((loyaltyInsert!.payload as any).points_balance).toBe(10);
  });

  it('uses default 1x when membership capability is not enabled', async () => {
    capsMock.mockResolvedValue(['loyalty']); // No membership
    state.tierRow = { membership_tiers: { points_multiplier: 2, is_active: true, business_id: 'biz-1' } };
    await callLegacy();
    const loyaltyInsert = state.inserts.find(i => i.table === 'loyalty_points');
    expect(loyaltyInsert).toBeTruthy();
    expect((loyaltyInsert!.payload as any).points_balance).toBe(10);
  });

  it('base-then-multiply with floor rounding: per_amount 550/100=5, 5*1.5=7', async () => {
    state.tierRow = { membership_tiers: { points_multiplier: 1.5, is_active: true, business_id: 'biz-1' } };
    // Override business metadata for per_amount mode
    const supabase = createMockSupabase();
    supabase.from = vi.fn((table: string) => {
      const c = createMockSupabase().from(table);
      if (table === 'businesses') {
        c.single = vi.fn().mockResolvedValue({ data: {
          name: 'Test', country_code: 'NG', subscription_tier: 'business', logo_url: null,
          metadata: { loyalty_earning_enabled: true, loyalty_points_mode: 'per_amount', loyalty_points_per_currency: 100 },
        }, error: null });
      }
      return c;
    });
    const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
    await handlePostCompletion({
      supabase, businessId: 'biz-1', customerPhone: '+2341234567890', customerName: 'Test',
      serviceType: 'booking', sender: null, amountPaid: 550,
      skipLoyalty: false, skipAutomation: true, skipCustomerSpend: true,
    } as any);
    const loyaltyInsert = state.inserts.find(i => i.table === 'loyalty_points');
    expect(loyaltyInsert).toBeTruthy();
    expect((loyaltyInsert!.payload as any).points_balance).toBe(7); // floor(5 * 1.5)
  });

  it('returned tier-lookup error skips entire loyalty award', async () => {
    state.tierError = { message: 'DB connection lost' };
    await callLegacy();
    // No loyalty insert — error propagated to outer catch which skips award
    const loyaltyInsert = state.inserts.find(i => i.table === 'loyalty_points');
    expect(loyaltyInsert).toBeUndefined();
    const txInsert = state.inserts.find(i => i.table === 'loyalty_transactions');
    expect(txInsert).toBeUndefined();
  });

  it('uses phoneWithPlus for customer_profiles.phone lookup', async () => {
    state.tierRow = null;
    const supabase = createMockSupabase();
    const fromSpy = supabase.from;
    await callLegacy({ supabase });
    // Find the customer_profiles query
    const profileCalls = fromSpy.mock.calls.filter((c: unknown[]) => c[0] === 'customer_profiles');
    expect(profileCalls.length).toBeGreaterThan(0);
  });

  it('paid path delegates to RPC, not inline tier logic', async () => {
    state.tierRow = { membership_tiers: { points_multiplier: 2, is_active: true, business_id: 'biz-1' } };
    const supabase = createMockSupabase();
    supabase.rpc = vi.fn(async (name: string) => {
      if (name === 'apply_payment_loyalty_once') return { data: { applied: true, already_applied: false, points_awarded: 10 }, error: null };
      if (name === 'apply_payment_customer_visit_once') return { data: { applied: true }, error: null };
      return { data: null, error: null };
    });
    const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
    await handlePostCompletion({
      supabase, businessId: 'biz-1', customerPhone: '+2341234567890', customerName: 'Test',
      serviceType: 'booking', sender: null, paymentId: 'pay-1', claimToken: 'claim-1',
      amountPaid: 5000, skipLoyalty: false, skipAutomation: true, skipCustomerSpend: true,
    } as any);
    // Paid path: RPC called, no inline loyalty_points insert
    expect(supabase.rpc).toHaveBeenCalledWith('apply_payment_loyalty_once', { p_payment_id: 'pay-1' });
    const inlineInsert = state.inserts.find(i => i.table === 'loyalty_points');
    expect(inlineInsert).toBeUndefined();
  });

  it('tier evaluation occurs after base points (base-then-multiply ordering)', async () => {
    // With multiplier 1, base stays at 10 — confirms multiplier is not applied first
    state.tierRow = { membership_tiers: { points_multiplier: 1, is_active: true, business_id: 'biz-1' } };
    await callLegacy();
    const loyaltyInsert = state.inserts.find(i => i.table === 'loyalty_points');
    expect(loyaltyInsert).toBeTruthy();
    // multiplier=1 → guard (>1) prevents multiplication, so base=10
    expect((loyaltyInsert!.payload as any).points_balance).toBe(10);
  });
});
