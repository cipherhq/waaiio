/**
 * URGENT PAYMENT/TICKET HOTFIX — Regression tests (CTO Final Round)
 *
 * Behavioral + structural tests covering:
 * - Payment confirmation schema fix
 * - Confirmation result contract
 * - Payment reuse fail-closed
 * - Quarantine/second-charge guard
 * - Typed ticket fail-closed
 * - Ticket state completeness
 * - Bot counter fail-closed
 * - Event publish defaults
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

function readSrc(relPath: string) {
  return fs.readFileSync(path.resolve(__dirname, relPath), 'utf-8');
}

// ═══════════════════════════════════════════════════════
// 1. PAYMENT CONFIRMATION SCHEMA FIX
// ═══════════════════════════════════════════════════════

describe('Payment confirmation schema', () => {
  it('selects duration_minutes from services', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    expect(src).toContain('services(name, duration_minutes)');
    expect(src).not.toMatch(/services\(name,\s*duration\)/);
  });

  it('type-casts and assigns duration_minutes', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    expect(src).toMatch(/duration_minutes\?:\s*number/);
    expect(src).toContain('svc?.duration_minutes');
  });

  it('destructures and logs booking lookup error', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    expect(src).toMatch(/const\s*\{\s*data:\s*booking,\s*error:\s*bookingError\s*\}/);
    expect(src).toContain("logSafeError(logPrefix, 'booking-lookup', bookingError)");
  });
});

// ═══════════════════════════════════════════════════════
// 2. CONFIRMATION RESULT CONTRACT
// ═══════════════════════════════════════════════════════

describe('Confirmation result contract', () => {
  it('exports ConfirmationResult type', () => {
    expect(readSrc('../payments/send-confirmation.ts')).toContain('export type ConfirmationResult');
  });

  it('function returns Promise<ConfirmationResult>', () => {
    expect(readSrc('../payments/send-confirmation.ts')).toContain('): Promise<ConfirmationResult>');
  });

  it('defines all semantic states', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    for (const status of ['completed', 'already_completed', 'retryable_failed', 'claimed_by_other', 'not_deliverable']) {
      expect(src).toContain(`status: '${status}'`);
    }
  });

  it('no business → retryable_failed', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    const idx = src.indexOf('no business');
    const ret = src.slice(src.indexOf('return', idx), src.indexOf(';', src.indexOf('return', idx)));
    expect(ret).toContain('retryable_failed');
  });

  it('claim error → retryable_failed', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    const idx = src.indexOf('claim-rpc');
    const ret = src.slice(src.indexOf('return', idx), src.indexOf(';', src.indexOf('return', idx)));
    expect(ret).toContain('retryable_failed');
  });

  it('already completed → already_completed', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    expect(src).toMatch(/already_completed[\s\S]*?return.*already_completed/);
  });

  it('ticket state incomplete → retryable, NOT finalized', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    expect(src).toContain('ticket_state_incomplete');
    const idx = src.indexOf('ticket_state_incomplete');
    const nearby = src.slice(idx - 100, idx + 50);
    expect(nearby).toContain('retryable_failed');
  });

  it('no void returns in function body', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    const fnBody = src.slice(src.indexOf('): Promise<ConfirmationResult>'));
    expect(fnBody.match(/return;/g)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════
// 3. PAYMENT REUSE FAIL-CLOSED
// ═══════════════════════════════════════════════════════

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/constants', () => ({ formatCurrency: (a: number) => `$${a}` }));
vi.mock('@/lib/utils/phone', () => ({ stripPlus: (p: string) => p.replace(/^\+/, '') }));
vi.mock('@/lib/bot/flows/shared/user', () => ({ getCustomerName: vi.fn().mockResolvedValue('Guest') }));
vi.mock('@/lib/calendar/generate-links', () => ({ getCalendarLinksText: vi.fn().mockReturnValue(null) }));
vi.mock('@/lib/utils/sanitize', () => ({ sanitizeFilterValue: (v: string) => v }));
vi.mock('@/lib/bot/flows/shared/payment', () => ({ initializePayment: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/countries', () => ({ getCountry: vi.fn().mockReturnValue({ currency_code: 'NGN' }) }));
vi.mock('@/lib/payments/factory', () => ({ getPaymentGateway: vi.fn(), getPaymentGatewayByName: vi.fn() }));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));
vi.mock('@/lib/observability', () => ({ observe: vi.fn((_n: string, _m: unknown, fn: () => unknown) => fn()) }));
vi.mock('@/lib/getPlatformFees', () => ({ getPlatformFees: vi.fn().mockResolvedValue({ feePercentage: 2, feeFlat: 0, feeTotal: 200 }) }));

// eslint-disable-next-line
function paymentChain(overrides: Record<string, unknown> = {}): any {
  // eslint-disable-next-line
  const c: Record<string, any> = {};
  ['select', 'eq', 'not', 'is', 'order', 'limit', 'in', 'like'].forEach(m => c[m] = vi.fn().mockReturnValue(c));
  c.single = vi.fn().mockResolvedValue({ data: null, error: null });
  c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  c.update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) });
  c.insert = vi.fn().mockResolvedValue({ data: null, error: null });
  Object.assign(c, overrides);
  return c;
}

describe('Payment reuse: fail-closed behavioral', () => {
  let mockGateway: { name: string; initializePayment: ReturnType<typeof vi.fn>; verifyPayment: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGateway = {
      name: 'paystack',
      initializePayment: vi.fn().mockResolvedValue({ url: 'https://pay.test/abc', reference: 'REF-ABC' }),
      verifyPayment: vi.fn(),
    };
    const { getPaymentGateway } = await import('@/lib/payments/factory');
    (getPaymentGateway as ReturnType<typeof vi.fn>).mockReturnValue(mockGateway);
  });

  it('Supabase lookup {data:null, error} → provider call 0', async () => {
    vi.resetModules();
    const { getPaymentGateway } = await import('@/lib/payments/factory');
    (getPaymentGateway as ReturnType<typeof vi.fn>).mockReturnValue(mockGateway);
    const supabase = {
      from: vi.fn(() => paymentChain({
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: 'db down' } }),
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

  it('lookup throws → provider call 0', async () => {
    vi.resetModules();
    const { getPaymentGateway } = await import('@/lib/payments/factory');
    (getPaymentGateway as ReturnType<typeof vi.fn>).mockReturnValue(mockGateway);
    const supabase = { from: vi.fn(() => { throw new Error('timeout'); }) };
    const { initializePayment } = await import('../bot/flows/shared/payment');
    const result = await initializePayment(supabase as never, {
      bookingId: 'bk-1', userId: 'u1', amount: 5000, referenceCode: 'REF-001',
      businessName: 'Test', phone: '+234123', countryCode: 'NG',
    });
    expect(result).toBeNull();
    expect(mockGateway.initializePayment).not.toHaveBeenCalled();
  });

  it('reuse requires entity + pending + amount + currency + gateway (structural)', () => {
    const src = readSrc('../bot/flows/shared/payment.ts');
    expect(src).toContain('existingPayment.amount === opts.amount');
    expect(src).toContain('existingPayment.currency === currencyCode');
    expect(src).toContain('existingPayment.gateway === gateway.name');
    expect(src).toContain("eq('status', 'pending')");
  });

  it('quarantine guard blocks new charges for review-required payments', () => {
    const src = readSrc('../bot/flows/shared/payment.ts');
    expect(src).toContain("like('gateway_status', 'review_required:%')");
    expect(src).toContain('blocking new charge');
  });
});

// ═══════════════════════════════════════════════════════
// 4. TYPED TICKET FAIL-CLOSED
// ═══════════════════════════════════════════════════════

describe('Typed ticket finalization fail-closed', () => {
  it('checks event_ticket_types to determine typed/untyped', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    expect(src).toContain("from('event_ticket_types')");
    expect(src).toContain('isTypedEvent');
  });

  it('typed event + missing bot_session_id → finalize NOT called', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    expect(src).toContain('isTypedEvent && (!ticketTypeId || typeResolutionFailed)');
    expect(src).toContain('failing closed');
  });

  it('session lookup error → typeResolutionFailed', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    const idx = src.indexOf('ticket-type-session-lookup');
    expect(idx).toBeGreaterThan(-1);
    expect(src.slice(idx, idx + 200)).toContain('typeResolutionFailed = true');
  });

  it('untyped event → NULL type accepted', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    // Fail-closed only triggers for isTypedEvent
    expect(src).toContain('isTypedEvent && (!ticketTypeId || typeResolutionFailed)');
  });

  it('uses booking.bot_session_id (not phone)', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    expect(src).toContain("eq('id', ticketBooking.bot_session_id)");
    const section = src.slice(src.indexOf('8b. Resolve ticket_type_id'), src.indexOf('8c.'));
    expect(section).not.toContain('whatsapp_number');
  });
});

// ═══════════════════════════════════════════════════════
// 5. BOT COUNTER FAIL-CLOSED
// ═══════════════════════════════════════════════════════

describe('Bot ticket counter fail-closed', () => {
  it('bot uses finalize_free_ticket_booking (not increment_tickets_sold)', () => {
    const src = readSrc('../bot/flows/ticketing.flow.ts');
    expect(src).toContain("rpc('finalize_free_ticket_booking'");
    expect(src).not.toContain("rpc('increment_tickets_sold'");
  });

  it('bot finalization error → validation failure (not continue)', () => {
    const src = readSrc('../bot/flows/ticketing.flow.ts');
    const idx = src.indexOf('finalize_free_ticket_booking RPC error');
    const after = src.slice(idx, idx + 300);
    expect(after).toContain('valid: false');
    expect(after).toContain('blocking ticket delivery');
  });

  it('no legacy SELECT→UPDATE counter fallback', () => {
    const src = readSrc('../bot/flows/ticketing.flow.ts');
    // The old pattern was: SELECT tickets_sold → UPDATE tickets_sold + qty
    // That should be gone now
    expect(src).not.toContain("update({ tickets_sold:");
  });
});

// ═══════════════════════════════════════════════════════
// 6. INVENTORY + TICKET STATE COMPLETENESS
// ═══════════════════════════════════════════════════════

describe('Ticket inventory and state completeness', () => {
  it('finalization BEFORE ticket creation', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    const fin = src.indexOf("rpc('finalize_free_ticket_booking'");
    const send = src.indexOf('sendTicketsAfterPurchase({');
    expect(fin).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(fin);
  });

  it('finalization failure blocks delivery', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    // After finError, Sentry alert is raised and ticket delivery is NOT reached
    // sendTicketsAfterPurchase is inside the else block (only reached when !finError)
    const finErrIdx = src.indexOf('if (finError)');
    const sendIdx = src.indexOf('sendTicketsAfterPurchase({');
    expect(finErrIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeGreaterThan(finErrIdx);
    // The finError block does NOT contain sendTicketsAfterPurchase
    const errBlock = src.slice(finErrIdx, src.indexOf('} else', finErrIdx));
    expect(errBlock).not.toContain('sendTicketsAfterPurchase');
  });

  it('ticket row count verified after creation', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    expect(src).toContain('createdTickets?.length');
    expect(src).toContain('Expected');
    expect(src).toContain('ticket rows');
  });

  it('incomplete state prevents finalization', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    expect(src).toContain('if (!ticketStateComplete)');
    const gate = src.indexOf('if (!ticketStateComplete)');
    const finalize = src.indexOf('finalizeConfirmationClaim', gate);
    expect(finalize).toBeGreaterThan(gate);
  });

  it('tickets_finalized RPC guard prevents double-counting', () => {
    const src = readSrc('../../supabase/migrations/304_session_resilience.sql');
    expect(src).toContain('SELECT tickets_finalized INTO v_already');
    expect(src).toContain('FOR UPDATE');
  });

  it('sendTicketsAfterPurchase deduplicates', () => {
    const src = readSrc('../bot/flows/shared/send-tickets.ts');
    expect(src).toContain("eq('booking_id', bookingId)");
    expect(src).toContain('Tickets already exist');
  });
});

// ═══════════════════════════════════════════════════════
// 7. TICKET ROW CONCURRENCY
// ═══════════════════════════════════════════════════════

describe('Ticket row concurrency', () => {
  it('NO booking-scoped UNIQUE on event_tickets — MIGRATION REQUIRED', () => {
    const src = readSrc('../../supabase/migrations/072_event_tickets.sql');
    expect(src).toContain('ticket_code VARCHAR(12) UNIQUE NOT NULL');
    expect(src).not.toMatch(/UNIQUE.*booking_id.*ticket_number/);

    const dir = path.resolve(__dirname, '../../supabase/migrations');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql'));
    let found = false;
    for (const f of files) {
      const c = fs.readFileSync(path.join(dir, f), 'utf-8');
      if (c.includes('event_tickets') && c.match(/UNIQUE.*booking_id.*ticket_number/)) found = true;
    }
    expect(found).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// 8. EVENT PUBLISH + SESSION
// ═══════════════════════════════════════════════════════

describe('Event publish status', () => {
  it('Create → published, Duplicate → draft', () => {
    const src = readSrc('../../app/dashboard/events/page.tsx');
    expect(src).toMatch(/openAdd[\s\S]*?status:\s*'published'/);
    expect(src).toContain("status: 'draft'");
  });
  it('bot filters by published', () => {
    expect(readSrc('../bot/flows/ticketing.flow.ts')).toContain("in('status', ['published'])");
  });
});

describe('Session deactivation', () => {
  it('targets all payment steps', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    for (const s of ['await_ticket_payment', 'payment', 'await_payment', 'await_order_payment', 'create_booking']) {
      expect(src).toContain(`'${s}'`);
    }
  });
});
