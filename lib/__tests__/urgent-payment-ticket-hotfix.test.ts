/**
 * URGENT PAYMENT/TICKET HOTFIX — Regression tests
 *
 * Behavioral + structural tests covering:
 * - Defect 1: services column fix + business resolution
 * - Ticket counter finalization (unified canonical RPC)
 * - Payment reuse fail-closed behavior
 * - Event publish defaults
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ═══════════════════════════════════════════════════════
// DEFECT 1 — send-confirmation.ts service column fix
// ═══════════════════════════════════════════════════════

describe('Defect 1: send-confirmation service column', () => {
  it('selects duration_minutes (not duration) from services relationship', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../payments/send-confirmation.ts'), 'utf-8');
    expect(src).toContain('services(name, duration_minutes)');
    expect(src).not.toMatch(/services\(name,\s*duration\)/);
  });

  it('maps duration from duration_minutes', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../payments/send-confirmation.ts'), 'utf-8');
    expect(src).toMatch(/duration_minutes\?:\s*number/);
    expect(src).toContain('svc?.duration_minutes');
  });

  it('logs booking lookup errors', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../payments/send-confirmation.ts'), 'utf-8');
    expect(src).toMatch(/const\s*\{\s*data:\s*booking,\s*error:\s*bookingError\s*\}/);
    expect(src).toContain("logSafeError(logPrefix, 'booking-lookup', bookingError)");
  });
});

// ═══════════════════════════════════════════════════════
// DEFECT 1 — Behavioral: confirmation mock infrastructure
// ═══════════════════════════════════════════════════════

const mockRpc = vi.fn();
const mockFrom = vi.fn();

function chain() {
  // eslint-disable-next-line
  const c: Record<string, any> = {};
  ['select', 'eq', 'is', 'in', 'or', 'not', 'neq', 'order', 'limit', 'update'].forEach(
    (m) => (c[m] = vi.fn().mockReturnValue(c)),
  );
  c.single = vi.fn().mockResolvedValue({ data: null, error: null });
  c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  return c;
}

function buildConfirmationMock(
  rpcMap: Record<string, { data?: unknown; error?: unknown }>,
  bookingOverrides?: Record<string, unknown>,
) {
  const defaultBooking = {
    guest_phone: '+2348012345678',
    business_id: 'biz-1',
    reference_code: 'WA-TK-8676',
    date: '2026-08-10',
    time: '14:00',
    flow_type: 'ticketing',
    total_amount: 5000,
    deposit_amount: 5000,
    businesses: { name: 'TestBiz', country_code: 'NG', address: null, payment_gateway: 'paystack' },
    services: null,
    ...bookingOverrides,
  };

  mockRpc.mockImplementation((name: string) => {
    const r = rpcMap[name];
    return Promise.resolve({ data: r?.data ?? null, error: r?.error ?? null });
  });

  mockFrom.mockImplementation((table: string) => {
    const c = chain();
    if (table === 'bookings') c.single = vi.fn().mockResolvedValue({ data: defaultBooking, error: null });
    if (table === 'businesses') c.single = vi.fn().mockResolvedValue({ data: { subscription_tier: 'free', owner_id: 'o1' }, error: null });
    if (table === 'profiles') {
      c.single = vi.fn().mockResolvedValue({ data: { email: 'o@t.com', phone: '+234' }, error: null });
      c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    }
    if (table === 'bot_sessions') c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    return c;
  });

  // eslint-disable-next-line
  return { rpc: mockRpc, from: mockFrom, auth: { getUser: vi.fn() } } as any;
}

const { mockCalendarLinks } = vi.hoisted(() => ({ mockCalendarLinks: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/constants', () => ({ formatCurrency: (a: number) => `$${a}` }));
vi.mock('@/lib/utils/phone', () => ({ stripPlus: (p: string) => p.replace(/^\+/, '') }));
vi.mock('@/lib/bot/flows/shared/user', () => ({ getCustomerName: vi.fn().mockResolvedValue('Guest') }));
vi.mock('@/lib/calendar/generate-links', () => ({ getCalendarLinksText: mockCalendarLinks }));
vi.mock('@/lib/utils/sanitize', () => ({ sanitizeFilterValue: (v: string) => v }));
vi.mock('@/lib/bot/flows/shared/payment', () => ({ initializePayment: vi.fn().mockResolvedValue(null) }));

const CLAIM_OK = {
  data: { claimed: true, claim_token: 'tok-test', payment_id: 'pay-1', amount: 5000, booking_id: 'bk-1', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null },
};
const RENEW_OK = { data: { renewed: true } };
const FIN_OK = { data: { finalized: true, already_finalized: false } };

describe('Defect 1: ticketing booking resolution', () => {
  beforeEach(() => { vi.clearAllMocks(); mockCalendarLinks.mockReturnValue(null); });

  it('ticketing booking (service_id=NULL) resolves businessId', async () => {
    const s = buildConfirmationMock({
      claim_payment_confirmation: CLAIM_OK, renew_payment_confirmation_claim: RENEW_OK,
      finalize_payment_confirmation: FIN_OK, finalize_free_ticket_booking: { data: { success: true, already_finalized: false } },
    });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, { id: 'pay-1', amount: 5000, booking_id: 'bk-1', invoice_id: null, campaign_id: null });
    expect(mockRpc).toHaveBeenCalledWith('finalize_payment_confirmation', expect.objectContaining({ p_claim_token: 'tok-test' }));
  });

  it('normal service booking also resolves correctly', async () => {
    const s = buildConfirmationMock(
      { claim_payment_confirmation: CLAIM_OK, renew_payment_confirmation_claim: RENEW_OK, finalize_payment_confirmation: FIN_OK },
      { flow_type: 'scheduling', services: { name: 'Haircut', duration_minutes: 30 }, reference_code: 'WA-BK-1234' },
    );
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, { id: 'pay-1', amount: 5000, booking_id: 'bk-1', invoice_id: null, campaign_id: null });
    expect(mockRpc).toHaveBeenCalledWith('finalize_payment_confirmation', expect.objectContaining({ p_claim_token: 'tok-test' }));
  });
});

// ═══════════════════════════════════════════════════════
// TICKET COUNTER FINALIZATION
// ═══════════════════════════════════════════════════════

describe('Ticket counter finalization', () => {
  it('finalize_free_ticket_booking RPC: idempotent with tickets_finalized guard', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/304_session_resilience.sql'), 'utf-8');
    expect(src).toContain('finalize_free_ticket_booking');
    expect(src).toContain('tickets_finalized');
    expect(src).toContain('IF v_already THEN');
    expect(src).toContain('tickets_sold = tickets_sold + p_quantity');
  });

  it('bot path uses canonical finalize_free_ticket_booking (not increment_tickets_sold)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../bot/flows/ticketing.flow.ts'), 'utf-8');
    expect(src).toContain("rpc('finalize_free_ticket_booking'");
    expect(src).not.toContain("rpc('increment_tickets_sold'");
  });

  it('webhook path calls finalize_free_ticket_booking BEFORE sendTicketsAfterPurchase', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../payments/send-confirmation.ts'), 'utf-8');
    const finIdx = src.indexOf("rpc('finalize_free_ticket_booking'");
    const sendIdx = src.indexOf('sendTicketsAfterPurchase({');
    expect(finIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeGreaterThan(finIdx); // finalize BEFORE send
  });

  it('webhook path blocks ticket delivery if finalization fails', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../payments/send-confirmation.ts'), 'utf-8');
    // After finalization, delivery is gated by !finError
    expect(src).toContain('if (!finError)');
    expect(src).toContain('sendTicketsAfterPurchase');
  });

  it('uses booking.bot_session_id for durable ticket_type_id (not latest session by phone)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../payments/send-confirmation.ts'), 'utf-8');
    // Must select bot_session_id from booking query
    expect(src).toContain('bot_session_id');
    // Must query bot_sessions by EXACT session ID (durable FK)
    expect(src).toContain("eq('id', ticketBooking.bot_session_id)");
    // The ticket_type_id resolution section must NOT use phone-based lookup
    const ticketSection = src.slice(src.indexOf('8a. Resolve ticket_type_id'), src.indexOf('8b. Canonical inventory'));
    expect(ticketSection).not.toContain('whatsapp_number');
    expect(ticketSection).toContain('bot_session_id');
  });

  it('finalize_free_ticket_booking does not depend on service_id', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/304_session_resilience.sql'), 'utf-8');
    const sigStart = src.indexOf('finalize_free_ticket_booking(');
    const sigEnd = src.indexOf(')', sigStart) + 1;
    const sig = src.slice(sigStart, sigEnd);
    expect(sig).toContain('p_booking_id');
    expect(sig).toContain('p_event_id');
    expect(sig).not.toContain('service_id');
  });

  it('tickets_finalized guard: SELECT FOR UPDATE prevents concurrent double-count', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/304_session_resilience.sql'), 'utf-8');
    expect(src).toContain('SELECT tickets_finalized INTO v_already');
    expect(src).toContain('FOR UPDATE');
    expect(src).toMatch(/IF v_already THEN[\s\S]*?already_finalized.*true/);
  });

  it('event_tickets deduplication: sendTicketsAfterPurchase checks existing before insert', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../bot/flows/shared/send-tickets.ts'), 'utf-8');
    expect(src).toContain("eq('booking_id', bookingId)");
    expect(src).toContain('Tickets already exist for booking');
  });

  it('event_tickets has UNIQUE constraint on ticket_code (prevents code collision)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/072_event_tickets.sql'), 'utf-8');
    expect(src).toContain('ticket_code VARCHAR(12) UNIQUE NOT NULL');
  });
});

// ═══════════════════════════════════════════════════════
// PAYMENT REUSE — BEHAVIORAL TESTS
// ═══════════════════════════════════════════════════════

// These tests exercise actual initializePayment behavior with controlled mocks
// to prove fail-closed semantics and matching rules.

vi.mock('@/lib/countries', () => ({
  getCountry: vi.fn().mockReturnValue({ currency_code: 'NGN' }),
}));

vi.mock('@/lib/payments/factory', () => ({
  getPaymentGateway: vi.fn(),
  getPaymentGatewayByName: vi.fn(),
}));

vi.mock('@/lib/errors', () => ({
  safeLogErrorContext: () => ({}),
}));

vi.mock('@/lib/observability', () => ({
  observe: vi.fn((_name: string, _meta: unknown, fn: () => unknown) => fn()),
}));

vi.mock('@/lib/getPlatformFees', () => ({
  getPlatformFees: vi.fn().mockResolvedValue({ feePercentage: 2.0, feeFlat: 0, feeTotal: 200 }),
}));

function paymentChain(overrides: Record<string, unknown> = {}) {
  // eslint-disable-next-line
  const c: Record<string, any> = {};
  ['select', 'eq', 'not', 'is', 'order', 'limit', 'in'].forEach(m => c[m] = vi.fn().mockReturnValue(c));
  c.single = vi.fn().mockResolvedValue({ data: null, error: null });
  c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  c.update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) });
  c.insert = vi.fn().mockResolvedValue({ data: null, error: null });
  Object.assign(c, overrides);
  return c;
}

describe('Payment reuse: fail-closed behavioral tests', () => {
  let mockGateway: { name: string; initializePayment: ReturnType<typeof vi.fn>; verifyPayment: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGateway = {
      name: 'paystack',
      initializePayment: vi.fn().mockResolvedValue({ url: 'https://checkout.paystack.com/abc', reference: 'REF-ABC' }),
      verifyPayment: vi.fn(),
    };
    const { getPaymentGateway } = await import('@/lib/payments/factory');
    (getPaymentGateway as ReturnType<typeof vi.fn>).mockReturnValue(mockGateway);
  });

  it('Supabase returns { data: null, error } → gateway NOT called', async () => {
    vi.resetModules();
    const { getPaymentGateway } = await import('@/lib/payments/factory');
    (getPaymentGateway as ReturnType<typeof vi.fn>).mockReturnValue(mockGateway);

    const supabase = {
      from: vi.fn(() => paymentChain({
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: 'connection refused', code: 'PGRST301' } }),
      })),
    };

    const { initializePayment } = await import('../bot/flows/shared/payment');
    const result = await initializePayment(supabase as never, {
      bookingId: 'bk-1', userId: 'u1', amount: 5000, referenceCode: 'REF-001',
      businessName: 'Test', phone: '+234123', countryCode: 'NG',
    });

    expect(result).toBeNull();
    expect(mockGateway.initializePayment).not.toHaveBeenCalled();
  });

  it('lookup throws → gateway NOT called', async () => {
    vi.resetModules();
    const { getPaymentGateway } = await import('@/lib/payments/factory');
    (getPaymentGateway as ReturnType<typeof vi.fn>).mockReturnValue(mockGateway);

    const supabase = {
      from: vi.fn(() => {
        throw new Error('network timeout');
      }),
    };

    const { initializePayment } = await import('../bot/flows/shared/payment');
    const result = await initializePayment(supabase as never, {
      bookingId: 'bk-1', userId: 'u1', amount: 5000, referenceCode: 'REF-001',
      businessName: 'Test', phone: '+234123', countryCode: 'NG',
    });

    expect(result).toBeNull();
    expect(mockGateway.initializePayment).not.toHaveBeenCalled();
  });

  it('matching pending payment → reused (source + structural proof)', () => {
    // Structural proof: when all conditions match and checkout_url exists,
    // the function returns the existing URL without calling the gateway.
    const src = fs.readFileSync(path.resolve(__dirname, '../bot/flows/shared/payment.ts'), 'utf-8');
    // The reuse return is inside the matching block and happens BEFORE any gateway call
    const reuseReturnIdx = src.indexOf("return { url: `${appUrl}/api/pay?ref=");
    const gatewayCallIdx = src.indexOf('gateway.initializePayment(');
    expect(reuseReturnIdx).toBeGreaterThan(-1);
    expect(gatewayCallIdx).toBeGreaterThan(reuseReturnIdx); // reuse return is earlier → gateway never reached
    // The reuse return contains the gateway_reference
    expect(src).toContain('reference: existingPayment.gateway_reference');
  });

  it('different amount → no reuse (source verification)', () => {
    // This is a source-level proof: amount mismatch means the if-block doesn't enter
    const src = fs.readFileSync(path.resolve(__dirname, '../bot/flows/shared/payment.ts'), 'utf-8');
    // All three conditions must match for reuse
    expect(src).toContain('existingPayment.amount === opts.amount');
    expect(src).toContain('existingPayment.currency === currencyCode');
    expect(src).toContain('existingPayment.gateway === gateway.name');
    // They're in a single AND condition — any mismatch falls through
    expect(src).toMatch(/existingPayment\s*&&\s*existingPayment\.amount.*&&\s*existingPayment\.currency.*&&\s*existingPayment\.gateway/s);
  });

  it('different currency → no reuse (source verification)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../bot/flows/shared/payment.ts'), 'utf-8');
    expect(src).toContain('existingPayment.currency === currencyCode');
  });

  it('different gateway → no reuse (source verification)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../bot/flows/shared/payment.ts'), 'utf-8');
    expect(src).toContain('existingPayment.gateway === gateway.name');
  });

  it('success/failed payments not reused (query filters pending only)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../bot/flows/shared/payment.ts'), 'utf-8');
    expect(src).toContain("eq('status', 'pending')");
    expect(src).not.toMatch(/eq\('status',\s*'success'\)/);
  });
});

// ═══════════════════════════════════════════════════════
// PAYMENT-SUCCESS + ORDERS
// ═══════════════════════════════════════════════════════

describe('Payment-success page order support', () => {
  it('resolves payments by gateway_reference first', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/payment-success/page.tsx'), 'utf-8');
    expect(src).toContain("eq('gateway_reference', params.ref)");
    expect(src).toContain('order_id');
  });

  it('processSuccessfulPayment confirms orders', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../payments/process-success.ts'), 'utf-8');
    expect(src).toContain("'confirmed'");
    expect(src).toContain('orderId');
  });
});

// ═══════════════════════════════════════════════════════
// EVENT PUBLISH STATUS
// ═══════════════════════════════════════════════════════

describe('Event publish status', () => {
  it('normal Create Event defaults to published', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/dashboard/events/page.tsx'), 'utf-8');
    expect(src).toMatch(/openAdd[\s\S]*?status:\s*'published'/);
  });

  it('Duplicate Event defaults to draft', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/dashboard/events/page.tsx'), 'utf-8');
    expect(src).toContain("status: 'draft'");
  });

  it('ticketing bot flow filters by status=published', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../bot/flows/ticketing.flow.ts'), 'utf-8');
    expect(src).toContain("in('status', ['published'])");
  });
});

// ═══════════════════════════════════════════════════════
// SESSION DEACTIVATION
// ═══════════════════════════════════════════════════════

describe('Session deactivation', () => {
  it('targets await_ticket_payment + all payment steps', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../payments/send-confirmation.ts'), 'utf-8');
    expect(src).toContain("'await_ticket_payment'");
    expect(src).toContain("'payment'");
    expect(src).toContain("'await_payment'");
    expect(src).toContain("'await_order_payment'");
    expect(src).toContain("'create_booking'");
  });
});
