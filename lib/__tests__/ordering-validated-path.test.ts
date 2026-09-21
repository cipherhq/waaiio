/**
 * Ordering validated path tests (#352 Phase 2B+2C, M393).
 *
 * Part A: Structural verification (source text proofs)
 * Part B: Executable tests — addon revalidation in review_order_summary
 * Part C: Executable tests — create_order_atomic args in process_order
 * Part D: Executable tests — cancel_order_immediate RPC
 * Part E: Executable tests — authoritative retry/re-entry
 * Part F: Executable tests — create_transfer_with_reservation RPC
 * Part G: Non-order createPendingTransfer preserved
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { FlowContext, FlowStepConfig } from '@/lib/bot/flows/types';

// ── Module-level mocks (must be before any dynamic import of ordering.flow) ──

const initializePaymentSpy = vi.fn();
vi.mock('@/lib/bot/flows/shared/payment', () => ({
  initializePayment: initializePaymentSpy,
}));

vi.mock('@/lib/bot/flows/shared/user', () => ({
  createWhatsAppUser: vi.fn().mockResolvedValue('user-uuid-001'),
  findUserByPhone: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/bot/flows/shared/bank-transfer', () => ({
  checkBankTransferEligibility: vi.fn(async () => ({
    qualifies: false,
    bankAccount: null,
    platformSettings: { transfer_expiry_hours: 24 },
  })),
  createPendingTransfer: vi.fn(async () => 'TRF-TEST-001'),
  formatBankTransferBlock: vi.fn(() => 'Bank: Test\nAcct: 1234'),
  BANK_ONLY_BUTTONS: [{ id: 'sent_transfer', title: "I've Sent Transfer" }],
}));

vi.mock('@/lib/bot/flows/shared/terms', () => ({
  getTermsPrompt: vi.fn(() => [{ type: 'text', text: 'Terms prompt' }]),
}));
vi.mock('@/lib/bot/flows/shared/templates', () => ({
  getOrderConfirmationMessage: vi.fn(() => 'Order summary'),
  getConfirmationMessage: vi.fn(() => 'Confirmed'),
}));
vi.mock('@/lib/bot/flows/shared/post-completion', () => ({ handlePostCompletion: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/bot/flows/shared/notify-owner', () => ({
  notifyOwnerNewOrder: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewQuoteRequest: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/bot/flows/shared/notifications', () => ({ createNotification: vi.fn() }));
vi.mock('@/lib/bot/flows/shared/ive-paid-input', () => ({
  parseIvePaidInput: vi.fn().mockReturnValue({ recognized: false }),
  isIvePaidInput: vi.fn(() => false),
}));
vi.mock('@/lib/bot/receipt-ocr', () => ({ analyzeReceipt: vi.fn(), receiptMatchesExpected: vi.fn() }));
vi.mock('@/lib/bot/flows/shared/saved-card-flow', () => ({
  buildSavedCardOffer: vi.fn().mockResolvedValue(null),
  handleSavedCardInput: vi.fn(),
}));
vi.mock('@/lib/bot/flows/shared/safe-interactive', () => ({
  safeButtons: vi.fn((body: string, buttons: unknown[]) => [{ type: 'buttons', body, buttons }]),
}));
vi.mock('@/lib/bot/flows/shared/capability-guard', () => ({
  requireCurrentCapability: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('@/lib/bot/flows/shared/product-availability', () => ({
  isProductAvailable: vi.fn(() => true),
  computeVariantAvailability: vi.fn(() => new Map()),
  getViableAxisValues: vi.fn(() => []),
}));
vi.mock('@/lib/bot/utils/truncate', () => ({ truncTitle: (s: string) => s }));
vi.mock('@/lib/bot/automation/rules-engine', () => ({ evaluateRules: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/bot/automation/sequence-service', () => ({ triggerSequences: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/tier-limits', () => ({ checkTierLimit: vi.fn().mockResolvedValue({ allowed: true }) }));
vi.mock('@/lib/capabilities/service', () => ({ getEnabledCapabilities: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), withContext: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() })) },
}));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: vi.fn(() => ({})) }));
vi.mock('@/lib/observability', () => ({
  observe: vi.fn((_name: string, fn: () => unknown) => fn()),
  observeProvider: vi.fn(),
  logSplitResolved: vi.fn(),
  logSplitMissing: vi.fn(),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }));
vi.mock('@/lib/trial-status', () => ({
  resolveTrialStatus: vi.fn(async () => ({ isInTrial: false, trialEndsAt: null })),
  resolveTrialCredit: vi.fn(async () => false),
}));
vi.mock('@/lib/getPlatformFees', () => ({ getPlatformFees: vi.fn(async () => ({ feePercentage: 5, isInTrial: false })) }));
vi.mock('@/lib/payments/factory', () => ({ getPaymentGateway: vi.fn(), getPaymentGatewayByName: vi.fn() }));
vi.mock('@/lib/payments/reconcile', () => ({ reconcilePayment: vi.fn(async () => ({ lifecycle: { status: 'completed' } })) }));
vi.mock('@/lib/payments/saved-card-compat', () => ({
  isSharedPlatformPaystackCompatible: vi.fn().mockResolvedValue({ compatible: true }),
  canonicalSavedCardPhone: vi.fn().mockImplementation((p: string) => {
    const withPlus = p.startsWith('+') ? p : `+${p}`;
    return /^\+[1-9]\d{7,14}$/.test(withPlus) ? withPlus : null;
  }),
}));
vi.mock('@/lib/payments/paystack-recurring', () => ({ getAuthorization: vi.fn(), createPlan: vi.fn(), createSubscription: vi.fn() }));
vi.mock('@/lib/payments/stripe-recurring', () => ({ createRecurringCheckout: vi.fn() }));
vi.mock('@/lib/payments/flutterwave-recurring', () => ({ getCardToken: vi.fn() }));
vi.mock('@/lib/payments/saved-payment-adapter', () => ({ savedPaymentAdapter: { getSavedMethods: vi.fn().mockResolvedValue([]) } }));
vi.mock('@/lib/whitelabel', () => ({ getPoweredByFooter: vi.fn(() => ''), isWhiteLabel: () => false }));
vi.mock('@/lib/utils/sanitize', () => ({ sanitizeFilterValue: (v: string) => v }));
vi.mock('@/lib/calendar/generate-links', () => ({ getCalendarLinksText: vi.fn(() => '') }));
vi.mock('@/lib/payments/stale-payment-recovery', () => ({ recoverByPaymentReference: vi.fn(async () => null) }));
vi.mock('@/lib/bot/smart-intent', () => ({ extractEntitiesOnly: vi.fn(async () => null) }));

// ── Source text for structural proofs ──

const orderingSource = readFileSync(join(process.cwd(), 'lib/bot/flows/ordering.flow.ts'), 'utf-8');

// ── Chainable mock supabase builder ──

function mockSupabaseClient() {
  const chainable: any = {
    select: vi.fn(() => chainable),
    insert: vi.fn(() => chainable),
    update: vi.fn(() => chainable),
    upsert: vi.fn(() => chainable),
    delete: vi.fn(() => chainable),
    eq: vi.fn(() => chainable),
    neq: vi.fn(() => chainable),
    in: vi.fn(() => chainable),
    gte: vi.fn(() => chainable),
    lte: vi.fn(() => chainable),
    gt: vi.fn(() => chainable),
    lt: vi.fn(() => chainable),
    is: vi.fn(() => chainable),
    or: vi.fn(() => chainable),
    not: vi.fn(() => chainable),
    order: vi.fn(() => chainable),
    limit: vi.fn(() => chainable),
    single: vi.fn(async () => ({ data: null, error: null })),
    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    then: undefined as any,
    count: 0,
    head: true,
  };
  chainable.then = (resolve: (v: any) => void) => resolve({ data: null, error: null, count: 0 });

  return {
    from: vi.fn(() => chainable),
    rpc: vi.fn(async () => ({ data: null, error: null })),
    auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) },
    _chainable: chainable,
  };
}

function makeFlowContext(overrides?: {
  sessionData?: Record<string, unknown>;
  rpcHandler?: (name: string, params: any) => any;
  fromTableHandler?: (table: string) => any;
}): FlowContext {
  const supabase = mockSupabaseClient() as any;

  if (overrides?.rpcHandler) {
    supabase.rpc = vi.fn(async (name: string, params: any) => overrides.rpcHandler!(name, params));
  }

  if (overrides?.fromTableHandler) {
    supabase.from = vi.fn((table: string) => {
      const result = overrides.fromTableHandler!(table);
      if (result) return result;
      const chain = supabase._chainable;
      chain.then = (resolve: (v: any) => void) => resolve({ data: null, error: null, count: 0 });
      return chain;
    });
  } else {
    supabase.from.mockImplementation(() => {
      const chain = supabase._chainable;
      chain.then = (resolve: (v: any) => void) => resolve({ data: null, error: null, count: 0 });
      return chain;
    });
  }

  return {
    supabase,
    sender: {
      sendText: vi.fn(async () => ({ success: true })),
      sendButtons: vi.fn(async () => ({ success: true })),
      sendList: vi.fn(async () => ({ success: true })),
      sendImage: vi.fn(async () => ({ success: true })),
      sendDocument: vi.fn(async () => ({ success: true })),
    } as any,
    standalone: {} as any,
    intelligence: {
      resetAbuse: vi.fn(),
      checkAbuse: vi.fn(() => false),
      classify: vi.fn(async () => null),
    } as any,
    from: '+2348012345678',
    session: {
      id: 'session-uuid-001',
      user_id: 'user-uuid-001',
      business_id: 'biz-uuid-001',
      current_step: 'process_order',
      session_data: {
        flow_type: 'ordering',
        cart: [{ product_id: 'prod-1', name: 'Widget', quantity: 2, price: 500 }],
        first_name: 'Ada',
        last_name: 'Test',
        delivery_type: 'pickup',
        _terms_accepted: true,
        ...(overrides?.sessionData || {}),
      },
      version: 1,
    },
    business: {
      id: 'biz-uuid-001',
      name: 'Test Shop',
      slug: 'test-shop',
      category: 'retail' as any,
      flow_type: 'ordering' as any,
      subscription_tier: 'growth',
      trial_ends_at: '2027-01-01T00:00:00Z',
      metadata: {},
      country_code: 'NG' as any,
    },
    t: async (s: string) => s,
  };
}

/** Default from-handler: returns products table with shipping_cost=0; everything else is empty. */
function defaultFromHandler(extraHandlers?: Record<string, () => any>) {
  return (table: string) => {
    if (extraHandlers?.[table]) return extraHandlers[table]();
    if (table === 'products') {
      const c: any = { select: vi.fn(() => c), in: vi.fn(() => c), eq: vi.fn(() => c), then: (r: (v: any) => void) => r({ data: [{ id: 'prod-1', shipping_cost: 0 }], error: null }) };
      return c;
    }
    const c: any = {
      select: vi.fn(() => c), insert: vi.fn(() => c), update: vi.fn(() => c),
      eq: vi.fn(() => c), in: vi.fn(() => c),
      single: vi.fn(async () => ({ data: null, error: null })),
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
      then: (r: (v: any) => void) => r({ data: null, error: null }),
    };
    return c;
  };
}

// ── Step lookup ──

let orderingSteps: FlowStepConfig[];

async function getStep(id: string): Promise<FlowStepConfig> {
  if (!orderingSteps) {
    const { orderingFlow } = await import('@/lib/bot/flows/ordering.flow');
    orderingSteps = orderingFlow.steps;
  }
  const step = orderingSteps.find((s) => s.id === id);
  if (!step) throw new Error(`Step "${id}" not found in orderingFlow`);
  return step;
}

// ═══════════════════════════════════════════════════════════════
// Part A: Structural verification — source text proofs
// ═══════════════════════════════════════════════════════════════

describe('M393 structural: validated path activation', () => {
  it('1. create_order_atomic called with p_validate_products: true', () => {
    expect(orderingSource).toContain('p_validate_products: true');
  });

  it('2. p_expected_total: total is passed', () => {
    expect(orderingSource).toContain('p_expected_total: total');
  });
});

describe('M393 structural: addon revalidation', () => {
  it('3. re-reads addons from product_addons table', () => {
    expect(orderingSource).toContain('M393: Addon revalidation');
    expect(orderingSource).toContain("from('product_addons')");
  });

  it('warns on addon price change', () => {
    expect(orderingSource).toContain("Add-on *${a.name}* price updated:");
  });

  it('removes inactive addon', () => {
    expect(orderingSource).toContain('!cur.is_active');
    expect(orderingSource).toContain("Add-on *${a.name}* is no longer available");
  });

  it('removes wrong-business addon', () => {
    expect(orderingSource).toContain('cur.business_id !== ctx.business!.id');
  });

  it('removes wrong-product addon', () => {
    expect(orderingSource).toContain('cur.product_id && cur.product_id !== item.product_id');
    expect(orderingSource).toContain("Add-on *${a.name}* is no longer compatible");
  });
});

describe('M393 structural: authoritative retry', () => {
  it('re-reads order status before reuse', () => {
    expect(orderingSource).toContain('M393: Authoritative retry');
    expect(orderingSource).toContain("existingOrder.status === 'confirmed'");
    expect(orderingSource).toContain("existingOrder.status === 'cancelled'");
  });

  it('R28/B6: uses cancel_stale_order_atomic for ALL pending state classification', () => {
    expect(orderingSource).toContain("rpc('cancel_stale_order_atomic'");
    expect(orderingSource).toContain("committed_not_cancellable");
    expect(orderingSource).toContain("instant_not_expired");
  });

  it('fail closed on committed marker via RPC reason', () => {
    expect(orderingSource).toContain("committed_not_cancellable");
    expect(orderingSource).toContain('Your order is being processed');
  });

  it('calls cancel_stale_order_atomic for all pending orders', () => {
    expect(orderingSource).toContain("rpc('cancel_stale_order_atomic'");
  });
});

describe('M393 structural: cancel_order_immediate', () => {
  it('process_order cancel uses RPC', () => {
    expect(orderingSource).toContain("rpc('cancel_order_immediate', { p_order_id: orderId, p_reason: 'customer_cancel' })");
  });

  it('saved_card_cancelled uses RPC', () => {
    expect(orderingSource).toContain("rpc('cancel_order_immediate', { p_order_id: orderId, p_reason: 'saved_card_cancelled' })");
  });

  it('at least 3 cancel_order_immediate call sites', () => {
    const matches = orderingSource.match(/rpc\('cancel_order_immediate'/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(3);
  });

  it('no direct orders.update status=cancelled remains', () => {
    const directCancels = orderingSource.match(/from\('orders'\)\.update\(\{ status: 'cancelled'/g);
    expect(directCancels).toBeNull();
  });
});

describe('M393 structural: order-linked transfer', () => {
  it('12. uses create_transfer_with_reservation RPC (2 call sites)', () => {
    const matches = orderingSource.match(/rpc\('create_transfer_with_reservation'/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(2);
  });

  it('13. scheduling.flow.ts still uses createPendingTransfer (not the new RPC)', () => {
    const schedSrc = readFileSync(join(process.cwd(), 'lib/bot/flows/scheduling.flow.ts'), 'utf-8');
    expect(schedSrc).toContain('createPendingTransfer(ctx.supabase');
    expect(schedSrc).not.toContain("rpc('create_transfer_with_reservation'");
  });
});

// ═══════════════════════════════════════════════════════════════
// Part B: Executable — addon revalidation in review_order_summary
// ═══════════════════════════════════════════════════════════════

describe('M393 executable: addon revalidation — review_order_summary', () => {
  let reviewStep: FlowStepConfig;

  beforeEach(async () => {
    reviewStep = await getStep('review_order_summary');
    vi.clearAllMocks();
  });

  function addonRevalFromHandler(opts: {
    productRows: any[];
    addonRows: any[];
  }) {
    return (table: string) => {
      if (table === 'products') {
        const c: any = { select: vi.fn(() => c), in: vi.fn(() => c), eq: vi.fn(() => c), then: (r: (v: any) => void) => r({ data: opts.productRows, error: null }) };
        return c;
      }
      if (table === 'product_addons') {
        const c: any = { select: vi.fn(() => c), in: vi.fn(() => c), eq: vi.fn(() => c), then: (r: (v: any) => void) => r({ data: opts.addonRows, error: null }) };
        return c;
      }
      const c: any = {
        select: vi.fn(() => c), insert: vi.fn(() => c), update: vi.fn(() => c),
        eq: vi.fn(() => c), in: vi.fn(() => c),
        single: vi.fn(async () => ({ data: null, error: null })),
        then: (r: (v: any) => void) => r({ data: null, error: null }),
      };
      return c;
    };
  }

  const baseProduct = { id: 'prod-1', name: 'Widget', price: 500, stock_quantity: null, track_inventory: false, is_active: true, deleted_at: null };

  it('3. addon price change produces customer warning', async () => {
    const cart = [{ product_id: 'prod-1', name: 'Widget', quantity: 1, price: 500, addons: [{ id: 'a1', name: 'Gift Wrap', price: 100 }] }];

    const ctx = makeFlowContext({
      sessionData: { cart, _terms_accepted: true },
      fromTableHandler: addonRevalFromHandler({
        productRows: [baseProduct],
        addonRows: [{ id: 'a1', name: 'Gift Wrap', price: 200, is_active: true, business_id: 'biz-uuid-001', product_id: 'prod-1' }],
      }),
      rpcHandler: (name) => name === 'calculate_volume_discount' ? { data: 0, error: null } : { data: null, error: null },
    });

    await reviewStep.prompt(ctx);

    const sendTextCalls = (ctx.sender.sendText as any).mock.calls;
    const allWarnings = sendTextCalls.map((c: any[]) => c[0]?.text || '').join('\n');
    expect(allWarnings).toContain('Gift Wrap');
    expect(allWarnings).toContain('price updated');
  });

  it('4. inactive addon removed from cart', async () => {
    const cart = [{ product_id: 'prod-1', name: 'Widget', quantity: 1, price: 500, addons: [{ id: 'a1', name: 'Gift Wrap', price: 100 }] }];

    const ctx = makeFlowContext({
      sessionData: { cart, _terms_accepted: true },
      fromTableHandler: addonRevalFromHandler({
        productRows: [baseProduct],
        addonRows: [{ id: 'a1', name: 'Gift Wrap', price: 100, is_active: false, business_id: 'biz-uuid-001', product_id: 'prod-1' }],
      }),
      rpcHandler: (name) => name === 'calculate_volume_discount' ? { data: 0, error: null } : { data: null, error: null },
    });

    await reviewStep.prompt(ctx);

    const allWarnings = (ctx.sender.sendText as any).mock.calls.map((c: any[]) => c[0]?.text || '').join('\n');
    expect(allWarnings).toContain('no longer available');
    expect(allWarnings).toContain('Gift Wrap');

    // Cart item should have empty addons after revalidation
    const updatedCart = ctx.session.session_data.cart as any[];
    expect(updatedCart[0].addons).toHaveLength(0);
  });

  it('5. wrong-business addon removed from cart', async () => {
    const cart = [{ product_id: 'prod-1', name: 'Widget', quantity: 1, price: 500, addons: [{ id: 'a1', name: 'Gift Wrap', price: 100 }] }];

    const ctx = makeFlowContext({
      sessionData: { cart, _terms_accepted: true },
      fromTableHandler: addonRevalFromHandler({
        productRows: [baseProduct],
        addonRows: [{ id: 'a1', name: 'Gift Wrap', price: 100, is_active: true, business_id: 'other-biz', product_id: 'prod-1' }],
      }),
      rpcHandler: (name) => name === 'calculate_volume_discount' ? { data: 0, error: null } : { data: null, error: null },
    });

    await reviewStep.prompt(ctx);

    const allWarnings = (ctx.sender.sendText as any).mock.calls.map((c: any[]) => c[0]?.text || '').join('\n');
    expect(allWarnings).toContain('no longer available');
    expect(allWarnings).toContain('Gift Wrap');
  });
});

// ═══════════════════════════════════════════════════════════════
// Part C: Executable — create_order_atomic args
// ═══════════════════════════════════════════════════════════════

describe('M393 executable: create_order_atomic — process_order', () => {
  let processStep: FlowStepConfig;

  beforeEach(async () => {
    processStep = await getStep('process_order');
    vi.clearAllMocks();
    initializePaymentSpy.mockReset();
  });

  it('1+2. create_order_atomic called with p_validate_products=true and p_expected_total matching total', async () => {
    const cart = [{ product_id: 'prod-1', name: 'Widget', quantity: 2, price: 500 }];
    // Expected total: 2 * 500 = 1000

    let capturedRpcParams: any;

    const ctx = makeFlowContext({
      sessionData: {
        cart,
        _terms_accepted: true,
        _calc_addons_total: 0,
        _calc_volume_discount: 0,
        _calc_shipping_cost: 0,
        _calc_total: 1000,
        delivery_type: 'pickup',
      },
      rpcHandler: (name, params) => {
        if (name === 'create_order_atomic') {
          capturedRpcParams = params;
          return { data: { order_id: 'o1', reference_code: 'WAA-001', created: true }, error: null };
        }
        if (name === 'calculate_volume_discount') return { data: 0, error: null };
        return { data: null, error: null };
      },
      fromTableHandler: defaultFromHandler(),
    });

    await processStep.prompt(ctx);

    expect(capturedRpcParams).toBeDefined();
    expect(capturedRpcParams.p_validate_products).toBe(true);
    expect(capturedRpcParams.p_expected_total).toBe(1000);
    expect(capturedRpcParams.p_total_amount).toBe(1000);
  });
});

// ═══════════════════════════════════════════════════════════════
// Part D: Executable — cancel_order_immediate
// ═══════════════════════════════════════════════════════════════

describe('M393 executable: cancel_order_immediate', () => {
  it('6a. process_order validate("cancel_order") calls cancel_order_immediate RPC', async () => {
    const processStep = await getStep('process_order');

    let capturedRpcName: string | undefined;
    let capturedRpcParams: any;

    const ctx = makeFlowContext({
      sessionData: { order_id: 'order-999', reference_code: 'WAA-999' },
      rpcHandler: (name, params) => {
        capturedRpcName = name;
        capturedRpcParams = params;
        return { data: { cancelled: true }, error: null };
      },
    });

    const result = await processStep.validate('cancel_order', ctx);

    expect(result.valid).toBe(true);
    expect(result.data?._action).toBe('cancelled');
    expect(capturedRpcName).toBe('cancel_order_immediate');
    expect(capturedRpcParams.p_order_id).toBe('order-999');
    expect(capturedRpcParams.p_reason).toBe('customer_cancel');
  });

  it('6b. await_order_payment validate("cancel_order") calls cancel_order_immediate RPC', async () => {
    const awaitStep = await getStep('await_order_payment');

    let capturedRpcName: string | undefined;
    let capturedRpcParams: any;

    const ctx = makeFlowContext({
      sessionData: { order_id: 'order-888', reference_code: 'WAA-888' },
      rpcHandler: (name, params) => {
        capturedRpcName = name;
        capturedRpcParams = params;
        return { data: { cancelled: true }, error: null };
      },
    });

    const result = await awaitStep.validate('cancel_order', ctx);

    expect(result.valid).toBe(true);
    expect(result.data?._action).toBe('cancel');
    expect(capturedRpcName).toBe('cancel_order_immediate');
    expect(capturedRpcParams.p_order_id).toBe('order-888');
    expect(capturedRpcParams.p_reason).toBe('customer_cancel');
  });
});

// ═══════════════════════════════════════════════════════════════
// Part E: Executable — authoritative retry/re-entry
// ═══════════════════════════════════════════════════════════════

describe('M393 executable: authoritative retry — process_order', () => {
  let processStep: FlowStepConfig;

  beforeEach(async () => {
    processStep = await getStep('process_order');
    vi.clearAllMocks();
    initializePaymentSpy.mockReset();
  });

  function ordersTableReturning(orderData: any) {
    return () => {
      const c: any = {
        select: vi.fn(() => c),
        eq: vi.fn(() => c),
        single: vi.fn(async () => ({ data: orderData, error: null })),
        then: (r: (v: any) => void) => r({ data: null, error: null }),
      };
      return c;
    };
  }

  function markerTableReturning(markerData: any) {
    return () => {
      const c: any = {
        select: vi.fn(() => c),
        eq: vi.fn(() => c),
        maybeSingle: vi.fn(async () => ({ data: markerData, error: null })),
        then: (r: (v: any) => void) => r({ data: null, error: null }),
      };
      return c;
    };
  }

  const baseSessionData = {
    cart: [{ product_id: 'prod-1', name: 'Widget', quantity: 1, price: 500 }],
    _terms_accepted: true,
    _calc_total: 500,
    delivery_type: 'pickup',
  };

  it('7. confirmed order -> no new creation, shows completion message', async () => {
    const ctx = makeFlowContext({
      sessionData: { ...baseSessionData, order_id: 'o-conf', reference_code: 'WAA-CONF' },
      rpcHandler: (name) => {
        if (name === 'create_order_atomic') throw new Error('Should not be called');
        if (name === 'calculate_volume_discount') return { data: 0, error: null };
        return { data: null, error: null };
      },
      fromTableHandler: defaultFromHandler({
        orders: ordersTableReturning({ id: 'o-conf', status: 'confirmed', reference_code: 'WAA-CONF' }),
      }),
    });

    const messages = await processStep.prompt(ctx);
    const txt = messages.find((m: any) => m.type === 'text');
    expect(txt).toBeDefined();
    expect((txt as any).text).toContain('already confirmed');
    expect((txt as any).text).toContain('WAA-CONF');
  });

  it('8. cancelled order -> clears refs and recreates', async () => {
    let createOrderCalled = false;

    const ctx = makeFlowContext({
      sessionData: { ...baseSessionData, order_id: 'o-canc', reference_code: 'WAA-CANC' },
      rpcHandler: (name) => {
        if (name === 'create_order_atomic') {
          createOrderCalled = true;
          return { data: { order_id: 'o-new', reference_code: 'WAA-NEW', created: true }, error: null };
        }
        if (name === 'calculate_volume_discount') return { data: 0, error: null };
        return { data: null, error: null };
      },
      fromTableHandler: defaultFromHandler({
        orders: ordersTableReturning({ id: 'o-canc', status: 'cancelled', reference_code: 'WAA-CANC' }),
      }),
    });

    await processStep.prompt(ctx);

    expect(createOrderCalled).toBe(true);
    expect(ctx.session.session_data.order_id).toBe('o-new');
    expect(ctx.session.session_data.reference_code).toBe('WAA-NEW');
  });

  it('9. pending + non-expired reservation -> reuses order', async () => {
    let createOrderCalled = false;

    initializePaymentSpy.mockResolvedValue({ url: 'https://pay.test/x', reference: 'PAY-X' });

    const ctx = makeFlowContext({
      sessionData: { ...baseSessionData, order_id: 'o-pend', reference_code: 'WAA-PEND' },
      rpcHandler: (name) => {
        if (name === 'create_order_atomic') { createOrderCalled = true; return { data: { order_id: 'o-shouldnt', reference_code: 'WAA-NO', created: true }, error: null }; }
        if (name === 'calculate_volume_discount') return { data: 0, error: null };
        // R28/B6: RPC returns instant_not_expired for non-expired markers
        if (name === 'cancel_stale_order_atomic') return { data: { cancelled: false, reason: 'instant_not_expired' }, error: null };
        return { data: null, error: null };
      },
      fromTableHandler: defaultFromHandler({
        orders: ordersTableReturning({ id: 'o-pend', status: 'pending', reference_code: 'WAA-PEND' }),
      }),
    });

    await processStep.prompt(ctx);

    expect(createOrderCalled).toBe(false);
    expect(ctx.session.session_data.order_id).toBe('o-pend');
  });

  it('10. pending + expired marker -> cancel_stale_order_atomic then recreates', async () => {
    let cancelStaleCalled = false;
    let createOrderCalled = false;
    const pastDate = new Date(Date.now() - 3600_000).toISOString();

    const ctx = makeFlowContext({
      sessionData: { ...baseSessionData, order_id: 'o-exp', reference_code: 'WAA-EXP' },
      rpcHandler: (name, params) => {
        if (name === 'cancel_stale_order_atomic') {
          cancelStaleCalled = true;
          expect(params.p_order_id).toBe('o-exp');
          return { data: { cancelled: true }, error: null };
        }
        if (name === 'create_order_atomic') {
          createOrderCalled = true;
          return { data: { order_id: 'o-fresh', reference_code: 'WAA-FRESH', created: true }, error: null };
        }
        if (name === 'calculate_volume_discount') return { data: 0, error: null };
        return { data: null, error: null };
      },
      fromTableHandler: defaultFromHandler({
        orders: ordersTableReturning({ id: 'o-exp', status: 'pending', reference_code: 'WAA-EXP' }),
        order_stock_applications: markerTableReturning({ reservation_class: 'instant', expires_at: pastDate, payment_id: null }),
      }),
    });

    await processStep.prompt(ctx);

    expect(cancelStaleCalled).toBe(true);
    expect(createOrderCalled).toBe(true);
    expect(ctx.session.session_data.order_id).toBe('o-fresh');
  });

  it('11. pending + committed marker -> fail closed message', async () => {
    const ctx = makeFlowContext({
      sessionData: { ...baseSessionData, order_id: 'o-com', reference_code: 'WAA-COM' },
      rpcHandler: (name) => {
        if (name === 'create_order_atomic') throw new Error('Should not be called');
        if (name === 'calculate_volume_discount') return { data: 0, error: null };
        // R28/B6: RPC returns committed_not_cancellable for committed markers
        if (name === 'cancel_stale_order_atomic') return { data: { cancelled: false, reason: 'committed_not_cancellable' }, error: null };
        return { data: null, error: null };
      },
      fromTableHandler: defaultFromHandler({
        orders: ordersTableReturning({ id: 'o-com', status: 'pending', reference_code: 'WAA-COM' }),
      }),
    });

    const messages = await processStep.prompt(ctx);
    const txt = messages.find((m: any) => m.type === 'text');
    expect(txt).toBeDefined();
    expect((txt as any).text).toContain('being processed');
  });
});

// ═══════════════════════════════════════════════════════════════
// Part F: Executable — create_transfer_with_reservation
// ═══════════════════════════════════════════════════════════════

describe('M393 executable: create_transfer_with_reservation', () => {
  let processStep: FlowStepConfig;

  beforeEach(async () => {
    processStep = await getStep('process_order');
    vi.clearAllMocks();
    initializePaymentSpy.mockReset();
  });

  it('12. order-linked transfer uses create_transfer_with_reservation RPC', async () => {
    const { checkBankTransferEligibility } = await import('@/lib/bot/flows/shared/bank-transfer');
    (checkBankTransferEligibility as any).mockResolvedValue({
      qualifies: true,
      bankAccount: { bank_name: 'Test Bank', account_number: '1234567890', account_name: 'Test Shop' },
      platformSettings: { transfer_expiry_hours: 24 },
    });

    let transferRpcCalled = false;
    let transferRpcParams: any;

    initializePaymentSpy.mockResolvedValue({ url: 'https://pay.test/abc', reference: 'PAY-001' });

    const ctx = makeFlowContext({
      sessionData: {
        cart: [{ product_id: 'prod-1', name: 'Widget', quantity: 2, price: 500 }],
        _terms_accepted: true,
        _calc_total: 1000,
        delivery_type: 'pickup',
      },
      rpcHandler: (name, params) => {
        if (name === 'create_order_atomic') {
          return { data: { order_id: 'o-t1', reference_code: 'WAA-T1', created: true }, error: null };
        }
        if (name === 'create_transfer_with_reservation') {
          transferRpcCalled = true;
          transferRpcParams = params;
          return { data: { transfer_id: 'trf-001', reference_code: 'WA-TRF-001' }, error: null };
        }
        if (name === 'calculate_volume_discount') return { data: 0, error: null };
        return { data: null, error: null };
      },
      fromTableHandler: defaultFromHandler(),
    });

    await processStep.prompt(ctx);

    expect(transferRpcCalled).toBe(true);
    expect(transferRpcParams.p_order_id).toBe('o-t1');
    expect(transferRpcParams.p_business_id).toBe('biz-uuid-001');
    expect(transferRpcParams.p_customer_phone).toBe('+2348012345678');
    expect(transferRpcParams.p_transfer_expiry_hours).toBe(24);
    // R28/B4: p_bot_session_id removed — RPC derives session from locked order
    expect(transferRpcParams.p_bot_session_id).toBeUndefined();

    // Cleanup mock
    (checkBankTransferEligibility as any).mockResolvedValue({
      qualifies: false, bankAccount: null, platformSettings: { transfer_expiry_hours: 24 },
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Part G: Non-order createPendingTransfer preserved
// ═══════════════════════════════════════════════════════════════

describe('M393 non-order createPendingTransfer unchanged', () => {
  it('13. scheduling.flow.ts still uses createPendingTransfer for bookings', () => {
    const schedSrc = readFileSync(join(process.cwd(), 'lib/bot/flows/scheduling.flow.ts'), 'utf-8');
    expect(schedSrc).toContain('createPendingTransfer(ctx.supabase');
    // And does NOT use the new RPC
    expect(schedSrc).not.toContain("rpc('create_transfer_with_reservation'");
  });

  it('ticketing.flow.ts still uses createPendingTransfer', () => {
    const src = readFileSync(join(process.cwd(), 'lib/bot/flows/ticketing.flow.ts'), 'utf-8');
    expect(src).toContain('createPendingTransfer(ctx.supabase');
    expect(src).not.toContain("rpc('create_transfer_with_reservation'");
  });
});
