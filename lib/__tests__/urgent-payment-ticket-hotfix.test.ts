/**
 * URGENT PAYMENT/TICKET HOTFIX — Regression tests
 *
 * Covers:
 * 1. Defect 1: services(name, duration) → services(name, duration_minutes)
 * 2. Defect 1: ticketing booking with service_id=NULL resolves business
 * 3. Defect 1: payment confirmation reaches ticket-send path
 * 4. Defect 1: paid ticket session leaves await_ticket_payment
 * 5. Defect 2: payment-init re-entry reuses existing pending checkout
 * 6. Defect 2: no duplicate Paystack initialization for same pending payment
 * 7. Defect 2: mismatched amount does NOT reuse checkout
 * 8. Defect 2: successful/failed payment is NOT incorrectly reused
 * 9. Defect 3: normal Create Event defaults published
 * 10. Defect 3: Duplicate Event behavior remains draft
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ═══════════════════════════════════════════════════════
// DEFECT 1 — send-confirmation.ts service column fix
// ═══════════════════════════════════════════════════════

describe('Defect 1: send-confirmation service column', () => {
  it('1. selects duration_minutes (not duration) from services relationship', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../payments/send-confirmation.ts'),
      'utf-8',
    );
    // Must contain the correct column name
    expect(src).toContain('services(name, duration_minutes)');
    // Must NOT contain the malformed column name
    expect(src).not.toMatch(/services\(name,\s*duration\)/);
  });

  it('2. maps duration from duration_minutes (not duration)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../payments/send-confirmation.ts'),
      'utf-8',
    );
    expect(src).toContain('duration_minutes');
    // The type cast must reference duration_minutes
    expect(src).toMatch(/duration_minutes\?:\s*number/);
    // bookingDuration must use duration_minutes
    expect(src).toContain('svc?.duration_minutes');
  });

  it('3. logs booking lookup errors (not silently swallowed)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../payments/send-confirmation.ts'),
      'utf-8',
    );
    // Must destructure error from booking query
    expect(src).toMatch(/const\s*\{\s*data:\s*booking,\s*error:\s*bookingError\s*\}/);
    // Must log it
    expect(src).toContain("logSafeError(logPrefix, 'booking-lookup', bookingError)");
  });
});

// ═══════════════════════════════════════════════════════
// DEFECT 1 — Behavioral: ticketing booking resolves business
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

/** Build a mock supabase client with configurable RPC map and booking data */
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
    services: null, // ticketing bookings have service_id=NULL
    ...bookingOverrides,
  };

  mockRpc.mockImplementation((name: string) => {
    const r = rpcMap[name];
    return Promise.resolve({ data: r?.data ?? null, error: r?.error ?? null });
  });

  mockFrom.mockImplementation((table: string) => {
    const c = chain();
    if (table === 'bookings') {
      c.single = vi.fn().mockResolvedValue({ data: defaultBooking, error: null });
    }
    if (table === 'businesses') {
      c.single = vi.fn().mockResolvedValue({
        data: { subscription_tier: 'free', owner_id: 'owner-1' },
        error: null,
      });
    }
    if (table === 'profiles') {
      c.single = vi.fn().mockResolvedValue({
        data: { email: 'owner@test.com', phone: '+234' },
        error: null,
      });
    }
    if (table === 'bot_sessions') {
      c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    }
    return c;
  });

  // eslint-disable-next-line
  return { rpc: mockRpc, from: mockFrom, auth: { getUser: vi.fn() } } as any;
}

// Hoisted mocks
const { mockCalendarLinks } = vi.hoisted(() => ({
  mockCalendarLinks: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
  },
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/constants', () => ({ formatCurrency: (a: number) => `$${a}` }));
vi.mock('@/lib/utils/phone', () => ({ stripPlus: (p: string) => p.replace(/^\+/, '') }));
vi.mock('@/lib/bot/flows/shared/user', () => ({ getCustomerName: vi.fn().mockResolvedValue('Guest') }));
vi.mock('@/lib/calendar/generate-links', () => ({ getCalendarLinksText: mockCalendarLinks }));
vi.mock('@/lib/utils/sanitize', () => ({ sanitizeFilterValue: (v: string) => v }));
vi.mock('@/lib/bot/flows/shared/payment', () => ({ initializePayment: vi.fn().mockResolvedValue(null) }));

const CLAIM_OK = {
  data: {
    claimed: true,
    claim_token: 'tok-test',
    payment_id: 'pay-1',
    amount: 5000,
    booking_id: 'bk-ticket-1',
    invoice_id: null,
    campaign_id: null,
    reservation_id: null,
    order_id: null,
  },
};
const RENEW_OK = { data: { renewed: true } };
const FIN_OK = { data: { finalized: true, already_finalized: false } };
const REL_OK = { data: { released: true } };

describe('Defect 1: ticketing booking with service_id=NULL resolves business', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCalendarLinks.mockReturnValue(null);
  });

  it('4. ticketing booking (service_id=NULL) resolves businessId and does NOT skip', async () => {
    const s = buildConfirmationMock({
      claim_payment_confirmation: CLAIM_OK,
      renew_payment_confirmation_claim: RENEW_OK,
      finalize_payment_confirmation: FIN_OK,
    });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    const pay = { id: 'pay-1', amount: 5000, booking_id: 'bk-ticket-1', invoice_id: null, campaign_id: null };
    await sendProactiveConfirmation(s, pay);

    // Must reach finalize (proves businessId was resolved, not skipped)
    expect(mockRpc).toHaveBeenCalledWith(
      'finalize_payment_confirmation',
      expect.objectContaining({ p_claim_token: 'tok-test' }),
    );
    // Must NOT log "no business" warning
    const { logger } = await import('@/lib/logger');
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const noBizWarning = warnCalls.find(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('no business'),
    );
    expect(noBizWarning).toBeUndefined();
  });

  it('5. normal service booking also resolves correctly', async () => {
    const s = buildConfirmationMock(
      {
        claim_payment_confirmation: CLAIM_OK,
        renew_payment_confirmation_claim: RENEW_OK,
        finalize_payment_confirmation: FIN_OK,
      },
      {
        flow_type: 'scheduling',
        services: { name: 'Haircut', duration_minutes: 30 },
        reference_code: 'WA-BK-1234',
      },
    );
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    const pay = { id: 'pay-1', amount: 5000, booking_id: 'bk-svc-1', invoice_id: null, campaign_id: null };
    await sendProactiveConfirmation(s, pay);

    expect(mockRpc).toHaveBeenCalledWith(
      'finalize_payment_confirmation',
      expect.objectContaining({ p_claim_token: 'tok-test' }),
    );
  });
});

// ═══════════════════════════════════════════════════════
// DEFECT 1 — Session deactivation for ticketing
// ═══════════════════════════════════════════════════════

describe('Defect 1: paid ticket session deactivation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCalendarLinks.mockReturnValue(null);
  });

  it('6. session deactivation targets await_ticket_payment step', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../payments/send-confirmation.ts'),
      'utf-8',
    );
    // The session deactivation must include await_ticket_payment
    expect(src).toContain("'await_ticket_payment'");
    // And also the other payment steps
    expect(src).toContain("'payment'");
    expect(src).toContain("'await_payment'");
    expect(src).toContain("'await_order_payment'");
    expect(src).toContain("'create_booking'");
  });

  it('7. session update deactivates (is_active=false, current_step=complete)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../payments/send-confirmation.ts'),
      'utf-8',
    );
    // Must set is_active: false and current_step: 'complete'
    expect(src).toContain("is_active: false");
    expect(src).toContain("current_step: 'complete'");
  });
});

// ═══════════════════════════════════════════════════════
// DEFECT 1 — Ticket delivery path
// ═══════════════════════════════════════════════════════

describe('Defect 1: ticket delivery path', () => {
  it('8. sendTicketsAfterPurchase is called for flow_type=ticketing bookings', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../payments/send-confirmation.ts'),
      'utf-8',
    );
    // Must check flow_type === 'ticketing'
    expect(src).toContain("flow_type === 'ticketing'");
    // Must import and call sendTicketsAfterPurchase
    expect(src).toContain('sendTicketsAfterPurchase');
  });

  it('9. sendTicketsAfterPurchase deduplicates existing tickets', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../bot/flows/shared/send-tickets.ts'),
      'utf-8',
    );
    // Dedup check: query existing tickets by booking_id before inserting
    expect(src).toContain("eq('booking_id', bookingId)");
    expect(src).toContain('Tickets already exist for booking');
  });
});

// ═══════════════════════════════════════════════════════
// DEFECT 1E — Ticket counter audit
// ═══════════════════════════════════════════════════════

describe('Ticket counter finalization (unified)', () => {
  it('10. finalize_free_ticket_booking RPC provides idempotent counter increment', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../supabase/migrations/304_session_resilience.sql'),
      'utf-8',
    );
    expect(src).toContain('finalize_free_ticket_booking');
    expect(src).toContain('tickets_finalized');
    expect(src).toContain('IF v_already THEN');
    // Increments both event and ticket type counters
    expect(src).toContain('tickets_sold = tickets_sold + p_quantity');
    expect(src).toContain('event_ticket_types');
  });

  it('11. bot "I\'ve Paid" path uses finalize_free_ticket_booking (canonical RPC)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../bot/flows/ticketing.flow.ts'),
      'utf-8',
    );
    // Must use the canonical idempotent RPC (not increment_tickets_sold)
    expect(src).toContain("rpc('finalize_free_ticket_booking'");
    expect(src).not.toContain("rpc('increment_tickets_sold'");
  });

  it('12. webhook path (send-confirmation) calls finalize_free_ticket_booking after ticket send', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../payments/send-confirmation.ts'),
      'utf-8',
    );
    expect(src).toContain("rpc('finalize_free_ticket_booking'");
    // Must pass required params
    expect(src).toContain('p_booking_id');
    expect(src).toContain('p_event_id');
    expect(src).toContain('p_ticket_type_id');
    expect(src).toContain('p_quantity');
  });

  it('13. tickets_finalized guard prevents double-counting across bot and webhook paths', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../supabase/migrations/304_session_resilience.sql'),
      'utf-8',
    );
    // Guard: SELECT tickets_finalized FOR UPDATE → IF v_already RETURN already_finalized
    expect(src).toContain('SELECT tickets_finalized INTO v_already');
    expect(src).toContain('FOR UPDATE');
    expect(src).toMatch(/IF v_already THEN[\s\S]*?already_finalized.*true/);
  });

  it('14. service_id=NULL ticketing bookings work (counter RPC uses booking+event, not service)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../supabase/migrations/304_session_resilience.sql'),
      'utf-8',
    );
    // Extract just the function signature (between CREATE and RETURNS)
    const sigStart = src.indexOf('finalize_free_ticket_booking(');
    const sigEnd = src.indexOf(')', sigStart) + 1;
    const sig = src.slice(sigStart, sigEnd);
    expect(sig).toContain('p_booking_id');
    expect(sig).toContain('p_event_id');
    // Signature must NOT require a service_id
    expect(sig).not.toContain('service_id');
  });

  it('15. sendTicketsAfterPurchase deduplicates ticket rows (webhook+bot race)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../bot/flows/shared/send-tickets.ts'),
      'utf-8',
    );
    expect(src).toContain("eq('booking_id', bookingId)");
    expect(src).toContain('Tickets already exist for booking');
  });
});

// ═══════════════════════════════════════════════════════
// DEFECT 2 — Payment init idempotency
// ═══════════════════════════════════════════════════════

describe('Defect 2: payment-init idempotency', () => {
  it('16. reuse checks entity + status + amount + currency + gateway', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../bot/flows/shared/payment.ts'),
      'utf-8',
    );
    // Must query for pending status
    expect(src).toContain("eq('status', 'pending')");
    // Must validate amount
    expect(src).toContain('existingPayment.amount === opts.amount');
    // Must validate currency
    expect(src).toContain('existingPayment.currency === currencyCode');
    // Must validate gateway/provider
    expect(src).toContain('existingPayment.gateway === gateway.name');
    // Must check checkout_url exists
    expect(src).toContain('checkout_url');
    // Must check gateway_reference exists
    expect(src).toContain('checkoutUrl && existingPayment.gateway_reference');
  });

  it('17. selects currency and gateway columns for matching', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../bot/flows/shared/payment.ts'),
      'utf-8',
    );
    // Select must include currency and gateway for comparison
    expect(src).toMatch(/select\([^)]*currency[^)]*gateway/);
  });

  it('18. reuse returns shortened URL in same format as initial creation', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../bot/flows/shared/payment.ts'),
      'utf-8',
    );
    expect(src).toContain('gateway_reference.slice(-8)');
    expect(src).toContain('/api/pay?ref=');
  });

  it('19. entity matching uses correct column (booking_id, order_id, etc)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../bot/flows/shared/payment.ts'),
      'utf-8',
    );
    expect(src).toContain("opts.bookingId ? 'booking_id'");
    expect(src).toContain("opts.orderId ? 'order_id'");
    expect(src).toContain("opts.invoiceId ? 'invoice_id'");
    expect(src).toContain("'reservation_id'");
  });

  it('20. lookup failure does not block payment (falls through to fresh init)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../bot/flows/shared/payment.ts'),
      'utf-8',
    );
    // Must have try/catch around lookup
    expect(src).toContain('proceeding with fresh init');
    // Must log the error
    expect(src).toContain('payment.reuse-lookup');
  });

  it('21. success/failed/cancelled payments are not reused (only pending)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../bot/flows/shared/payment.ts'),
      'utf-8',
    );
    // The query explicitly filters to pending only
    expect(src).toContain("eq('status', 'pending')");
    // No fallback to other statuses
    expect(src).not.toMatch(/eq\('status',\s*'success'\)/);
    expect(src).not.toMatch(/eq\('status',\s*'failed'\)/);
  });
});

// ═══════════════════════════════════════════════════════
// DEFECT 2C — Order payment-success callback
// ═══════════════════════════════════════════════════════

describe('Defect 2C: payment-success page order support', () => {
  it('22. payment-success resolves payments by gateway_reference first', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../app/payment-success/page.tsx'),
      'utf-8',
    );
    // First lookup is by gateway_reference
    expect(src).toContain("eq('gateway_reference', params.ref)");
    // Selects order_id from payment
    expect(src).toContain('order_id');
  });

  it('23. processSuccessfulPayment confirms orders (not just bookings)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../payments/process-success.ts'),
      'utf-8',
    );
    // Must handle order confirmation
    expect(src).toContain("'confirmed'");
    expect(src).toContain('orderId');
  });
});

// ═══════════════════════════════════════════════════════
// DEFECT 3 — Event publish status
// ═══════════════════════════════════════════════════════

describe('Defect 3: event publish status', () => {
  it('24. normal Create Event defaults to published', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../app/dashboard/events/page.tsx'),
      'utf-8',
    );
    // openAdd function sets status to 'published'
    expect(src).toMatch(/openAdd[\s\S]*?status:\s*'published'/);
  });

  it('25. Duplicate Event defaults to draft (intentional)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../app/dashboard/events/page.tsx'),
      'utf-8',
    );
    // Duplicate sets status to 'draft'
    expect(src).toContain("status: 'draft'");
  });

  it('26. ticketing bot flow filters by status=published', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../bot/flows/ticketing.flow.ts'),
      'utf-8',
    );
    expect(src).toContain("in('status', ['published'])");
  });
});
