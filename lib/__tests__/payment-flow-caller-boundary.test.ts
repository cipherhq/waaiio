/**
 * Flow-level caller-boundary evidence for initializePayment.
 *
 * Exercises real scheduling.flow.ts create_booking and ordering.flow.ts
 * process_order steps with initializePayment mocked at the module boundary.
 * Proves each real flow caller supplies the expected entity ID, authoritative
 * amount, businessId, country/gateway context, inboundChannelId,
 * confirmationOrigin, and transactionCategory exactly once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FlowStepConfig } from '@/lib/bot/flows/types';

// ── Mock initializePayment at the module boundary ──

const initPaymentSpy = vi.fn();

vi.mock('@/lib/bot/flows/shared/payment', () => ({
  initializePayment: initPaymentSpy,
}));

vi.mock('@/lib/bot/flows/shared/bank-transfer', () => ({
  checkBankTransferEligibility: vi.fn(async () => ({
    qualifies: false, bankAccount: null, platformSettings: { transfer_expiry_hours: 24 },
  })),
  createPendingTransfer: vi.fn(async () => 'TRF-001'),
  formatBankTransferBlock: vi.fn(() => 'bank details'),
  BANK_ONLY_BUTTONS: [],
}));

vi.mock('@/lib/bot/flows/shared/capability-guard', () => ({
  requireCurrentCapability: vi.fn(async () => ({ allowed: true })),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => ({})),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
    withContext: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })),
  },
}));

vi.mock('@/lib/errors', () => ({
  safeLogErrorContext: vi.fn(() => ({})),
}));

vi.mock('@/lib/observability', () => ({
  observe: vi.fn((_n: string, _c: unknown, fn: () => unknown) => fn()),
  observeProvider: vi.fn((_c: unknown, fn: () => unknown) => fn()),
}));

vi.mock('@/lib/trial-status', () => ({
  resolveTrialStatus: vi.fn(async () => false),
  resolveTrialCredit: vi.fn(async () => false),
}));

// ── Supabase mock helpers ──

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

function buildFlowSupabase(rpcResult: { data: unknown; error: unknown }, opts?: { rpcUseSingle?: boolean }) {
  const fromMock = vi.fn((table: string) => {
    if (table === 'whatsapp_users') return makeChain({ data: { id: 'user-001', phone: '+2348012345678' }, error: null });
    if (table === 'businesses') return makeChain({
      data: { id: 'biz-001', status: 'active', subscription_tier: 'growth', trial_ends_at: '2027-01-01T00:00:00Z', deposit_per_guest: null, category: 'health_beauty' },
      error: null,
    });
    if (table === 'saved_payment_methods') return makeChain({ data: null, error: null });
    if (table === 'bot_sessions') return makeChain({ data: null, error: null });
    return makeChain({ data: null, error: null });
  });

  // Scheduling uses .rpc().single(); ordering uses .rpc() directly (no .single())
  const rpcMock = opts?.rpcUseSingle
    ? vi.fn(() => ({ single: vi.fn(async () => rpcResult) }))
    : vi.fn(async () => rpcResult);

  return { from: fromMock, rpc: rpcMock };
}

const FLOW_CHECKOUT_URL = 'https://checkout.paystack.com/flow-boundary-exact';
const FLOW_REFERENCE = 'FLOW-BOUNDARY-REF-001';

beforeEach(() => {
  vi.clearAllMocks();
  initPaymentSpy.mockResolvedValue({
    url: FLOW_CHECKOUT_URL,
    reference: FLOW_REFERENCE,
  });
});

// ── Scheduling flow caller ──

describe('(6a) scheduling create_booking → initializePayment caller contract', () => {
  it('calls initializePayment exactly once with correct booking entity, deposit amount, and full context', async () => {
    const { schedulingFlow } = await import('@/lib/bot/flows/scheduling.flow');
    const step = schedulingFlow.steps.find(s => s.id === 'create_booking')!;

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().split('T')[0];

    const supabase = buildFlowSupabase({
      data: { booking_id: 'booking-sched-001', reference_code: 'WAA-SCHED-001', slot_available: true },
      error: null,
    }, { rpcUseSingle: true });

    const ctx = {
      supabase,
      sender: { sendText: vi.fn(async () => ({})), sendButtons: vi.fn(async () => ({})), sendList: vi.fn(async () => ({})) } as any,
      standalone: {} as any,
      intelligence: { resetAbuse: vi.fn(), checkAbuse: vi.fn(() => false) } as any,
      from: '+2348012345678',
      session: {
        id: 'sess-001', user_id: 'user-001', business_id: 'biz-001',
        current_step: 'create_booking', version: 1,
        session_data: {
          flow_type: 'scheduling', service_id: 'svc-001', service_name: 'Wax Appt',
          service_price: 5000, service_deposit: 2000, party_size: 1,
          date: dateStr, time: '10:00', user_id: 'user-001',
          customer_name: 'Ade', email: 'ade@test.com',
          staff_id: null, location_id: null, selected_addons: [],
          _service_duration: 60, _inbound_channel_id: 'ch-sched-001',
          _terms_accepted: true,
        },
      },
      business: {
        id: 'biz-001', name: 'SnapaKit Test', slug: 'snapakit-test',
        category: 'health_beauty' as any, flow_type: 'scheduling' as any,
        subscription_tier: 'growth', trial_ends_at: '2027-01-01T00:00:00Z',
        metadata: {}, country_code: 'NG', payment_gateway: null,
      },
      t: vi.fn(async (text: string) => text),
    };

    const messages = await step.prompt(ctx as any);

    // initializePayment called exactly once
    expect(initPaymentSpy).toHaveBeenCalledTimes(1);

    // Assert exact caller args
    const [_sb, opts] = initPaymentSpy.mock.calls[0];
    expect(opts.bookingId).toBe('booking-sched-001');
    expect(opts.amount).toBe(2000); // deposit, not full price
    expect(opts.referenceCode).toBe('WAA-SCHED-001');
    expect(opts.businessId).toBe('biz-001');
    expect(opts.businessName).toBe('SnapaKit Test');
    expect(opts.countryCode).toBe('NG');
    expect(opts.gatewayOverride).toBeNull();
    expect(opts.inboundChannelId).toBe('ch-sched-001');
    expect(opts.confirmationOrigin).toBe('whatsapp');
    expect(opts.transactionCategory).toBe('scheduling');
    expect(opts.phone).toBe('+2348012345678');
    expect(opts.userEmail).toBe('ade@test.com');
    expect(opts.userId).toBe('user-001');

    // Response contains the exact checkout URL from initializePayment
    const allText = messages.map((m: any) => m.type === 'buttons' ? m.body : m.type === 'text' ? m.text : '').join('\n');
    expect(allText).toContain(FLOW_CHECKOUT_URL);

    // I've Paid button with the exact reference
    const allButtons = messages.filter((m: any) => m.type === 'buttons').flatMap((m: any) => m.buttons.map((b: any) => b.id));
    expect(allButtons).toContain(`i_paid_ref:${FLOW_REFERENCE}`);
  });
});

// ── Ordering flow caller ──

describe('(6b) ordering process_order → initializePayment caller contract', () => {
  it('calls initializePayment exactly once with correct order entity, cart total, and full context', async () => {
    const { orderingFlow } = await import('@/lib/bot/flows/ordering.flow');
    const step = orderingFlow.steps.find(s => s.id === 'process_order')!;

    // Ordering RPC returns { order_id, reference_code, created }
    const supabase = buildFlowSupabase({
      data: { order_id: 'order-ord-001', reference_code: 'WAA-ORD-001', created: true },
      error: null,
    });

    const ctx = {
      supabase,
      sender: { sendText: vi.fn(async () => ({})), sendButtons: vi.fn(async () => ({})), sendList: vi.fn(async () => ({})) } as any,
      standalone: { getBotTemplates: vi.fn(async () => ({})), checkTierLimits: vi.fn(async () => ({ allowed: true })) } as any,
      intelligence: { resetAbuse: vi.fn(), checkAbuse: vi.fn(() => false) } as any,
      from: '+2348012345678',
      session: {
        id: 'sess-002', user_id: 'user-001', business_id: 'biz-001',
        current_step: 'process_order', version: 1,
        session_data: {
          flow_type: 'ordering', active_capability: 'ordering',
          cart: [{ id: 'item-001', product_id: 'prod-001', name: 'Widget', price: 3000, quantity: 2, variants: [] }],
          user_id: 'user-001', customer_name: 'Ade',
          _inbound_channel_id: 'ch-order-001',
          _terms_accepted: true,
        },
      },
      business: {
        id: 'biz-001', name: 'Test Shop', slug: 'test-shop',
        category: 'shop' as any, flow_type: 'ordering' as any,
        subscription_tier: 'growth', trial_ends_at: '2027-01-01T00:00:00Z',
        metadata: {}, country_code: 'NG', payment_gateway: null,
      },
      t: vi.fn(async (text: string) => text),
    };

    const messages = await step.prompt(ctx as any);

    // initializePayment called exactly once
    expect(initPaymentSpy).toHaveBeenCalledTimes(1);

    // Assert exact caller args
    const [_sb, opts] = initPaymentSpy.mock.calls[0];
    expect(opts.orderId).toBe('order-ord-001');
    expect(opts.amount).toBe(6000); // 3000 × 2
    expect(opts.referenceCode).toBe('WAA-ORD-001');
    expect(opts.businessId).toBe('biz-001');
    expect(opts.businessName).toBe('Test Shop');
    expect(opts.countryCode).toBe('NG');
    expect(opts.gatewayOverride).toBeNull();
    expect(opts.inboundChannelId).toBe('ch-order-001');
    expect(opts.confirmationOrigin).toBe('whatsapp');
    expect(opts.transactionCategory).toBe('ordering');
    expect(opts.phone).toBe('+2348012345678');
  });
});
