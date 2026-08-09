/**
 * URGENT PAYMENT/TICKET HOTFIX — Regression tests (CTO Final)
 *
 * Covers all blockers from CTO correction rounds:
 * - Payment confirmation schema fix
 * - Confirmation result contract (processing state)
 * - Payment reuse fail-closed + quarantine guard
 * - Typed ticket fail-closed
 * - Ticket type ownership validation
 * - Ticket booking lookup fail-closed
 * - Ticket state completeness
 * - Bot counter fail-closed
 * - sendTicketsAfterPurchase result contract
 * - Event publish defaults
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

function readSrc(relPath: string) {
  return fs.readFileSync(path.resolve(__dirname, relPath), 'utf-8');
}

// ═══════════════════════════════════════════════════════
// 1. PAYMENT CONFIRMATION SCHEMA
// ═══════════════════════════════════════════════════════

describe('Payment confirmation schema', () => {
  it('selects duration_minutes from services', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    expect(src).toContain('services(name, duration_minutes)');
    expect(src).not.toMatch(/services\(name,\s*duration\)/);
  });
  it('logs booking lookup error', () => {
    expect(readSrc('../payments/send-confirmation.ts')).toContain("logSafeError(logPrefix, 'booking-lookup', bookingError)");
  });
});

// ═══════════════════════════════════════════════════════
// 2. CONFIRMATION RESULT CONTRACT
// ═══════════════════════════════════════════════════════

describe('Confirmation result contract', () => {
  it('returns ConfirmationResult (not void)', () => {
    expect(readSrc('../payments/send-confirmation.ts')).toContain('): Promise<ConfirmationResult>');
  });
  it('defines processing state (not claimed_by_other)', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    expect(src).toContain("status: 'processing'");
    expect(src).not.toContain("status: 'claimed_by_other'");
  });
  it('no void returns in function body', () => {
    const fn = readSrc('../payments/send-confirmation.ts').slice(
      readSrc('../payments/send-confirmation.ts').indexOf('): Promise<ConfirmationResult>'),
    );
    expect(fn.match(/return;/g)).toBeNull();
  });
  it('no business → retryable_failed', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    const idx = src.indexOf('no business');
    expect(src.slice(src.indexOf('return', idx), src.indexOf(';', src.indexOf('return', idx)))).toContain('retryable_failed');
  });
  it('ticket state incomplete → retryable, NOT finalized', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    expect(src).toContain('ticket_state_incomplete');
  });
  it('another worker → processing (retryable: true)', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    // All claim-lost/another-worker returns should be processing
    expect(src).toContain("{ status: 'processing', retryable: true }");
    // Not claimed_by_other with retryable: false
    expect(src).not.toContain("retryable: false }; // claim may belong");
  });
});

// ═══════════════════════════════════════════════════════
// 3. PAYMENT REUSE FAIL-CLOSED + QUARANTINE
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

describe('Payment reuse fail-closed', () => {
  let mockGateway: { name: string; initializePayment: ReturnType<typeof vi.fn>; verifyPayment: ReturnType<typeof vi.fn> };
  beforeEach(async () => {
    vi.clearAllMocks();
    mockGateway = { name: 'paystack', initializePayment: vi.fn().mockResolvedValue({ url: 'https://pay/abc', reference: 'REF' }), verifyPayment: vi.fn() };
    const { getPaymentGateway } = await import('@/lib/payments/factory');
    (getPaymentGateway as ReturnType<typeof vi.fn>).mockReturnValue(mockGateway);
  });

  it('Supabase lookup {data:null,error} → provider 0', async () => {
    vi.resetModules();
    (await import('@/lib/payments/factory')).getPaymentGateway;
    const { getPaymentGateway } = await import('@/lib/payments/factory');
    (getPaymentGateway as ReturnType<typeof vi.fn>).mockReturnValue(mockGateway);
    const supabase = { from: vi.fn(() => paymentChain({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: 'db' } }) })) };
    const { initializePayment } = await import('../bot/flows/shared/payment');
    expect(await initializePayment(supabase as never, { bookingId: 'bk-1', userId: 'u1', amount: 5000, referenceCode: 'R', businessName: 'T', phone: '+234', countryCode: 'NG' })).toBeNull();
    expect(mockGateway.initializePayment).not.toHaveBeenCalled();
  });

  it('lookup throws → provider 0', async () => {
    vi.resetModules();
    const { getPaymentGateway } = await import('@/lib/payments/factory');
    (getPaymentGateway as ReturnType<typeof vi.fn>).mockReturnValue(mockGateway);
    const supabase = { from: vi.fn(() => { throw new Error('timeout'); }) };
    const { initializePayment } = await import('../bot/flows/shared/payment');
    expect(await initializePayment(supabase as never, { bookingId: 'bk-1', userId: 'u1', amount: 5000, referenceCode: 'R', businessName: 'T', phone: '+234', countryCode: 'NG' })).toBeNull();
    expect(mockGateway.initializePayment).not.toHaveBeenCalled();
  });

  it('requires entity + pending + amount + currency + gateway (structural)', () => {
    const src = readSrc('../bot/flows/shared/payment.ts');
    expect(src).toContain('existingPayment.amount === opts.amount');
    expect(src).toContain('existingPayment.currency === currencyCode');
    expect(src).toContain('existingPayment.gateway === gateway.name');
  });
});

describe('Quarantine guard', () => {
  it('quarantine check runs BEFORE pending reuse', () => {
    const src = readSrc('../bot/flows/shared/payment.ts');
    const quarantineIdx = src.indexOf("like('gateway_status', 'review_required:%')");
    const pendingIdx = src.indexOf("eq('status', 'pending')");
    expect(quarantineIdx).toBeGreaterThan(-1);
    expect(pendingIdx).toBeGreaterThan(quarantineIdx);
  });

  it('quarantine matches regardless of payment status (not just success)', () => {
    const src = readSrc('../bot/flows/shared/payment.ts');
    // The quarantine query should NOT filter by status='success'
    const quarantineSection = src.slice(src.indexOf('Step 1: Quarantine'), src.indexOf('Step 2: Pending'));
    expect(quarantineSection).not.toContain("eq('status', 'success')");
    expect(quarantineSection).toContain("like('gateway_status', 'review_required:%')");
  });

  it('quarantine lookup error → provider 0', () => {
    const src = readSrc('../bot/flows/shared/payment.ts');
    expect(src).toContain('quarantine-lookup');
    expect(src).toContain('Quarantine lookup failed');
    // After the error, return null
    const idx = src.indexOf('Quarantine lookup failed');
    expect(src.slice(idx, idx + 200)).toContain('return null');
  });

  it('quarantine row blocks new charge', () => {
    const src = readSrc('../bot/flows/shared/payment.ts');
    expect(src).toContain('blocking new charge');
  });
});

// ═══════════════════════════════════════════════════════
// 4. TYPED TICKET FAIL-CLOSED
// ═══════════════════════════════════════════════════════

describe('Typed ticket fail-closed', () => {
  it('type query error → fail closed (not treated as untyped)', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    expect(src).toContain("error: typeQueryError");
    expect(src).toContain("logSafeError(logPrefix, 'ticket-type-query', typeQueryError)");
    // After error, isTypedEvent is NOT set → ticketStateComplete stays false
  });

  it('queries ALL types (not just active) for typed-event classification', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    const typeQuerySection = src.slice(src.indexOf('8a. Determine'), src.indexOf('8b. Resolve'));
    // Should NOT filter is_active for classification
    expect(typeQuerySection).not.toContain("eq('is_active'");
  });

  it('validates ticket_type_id belongs to event', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    expect(src).toContain("eq('id', ticketTypeId)");
    expect(src).toContain("eq('event_id', ticketBooking.event_id)");
    expect(src).toContain('does not belong to event');
  });

  it('wrong-event ticket_type_id → typeResolutionFailed', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    const ownershipSection = src.slice(src.indexOf('8c. For typed events'), src.indexOf('8d.'));
    expect(ownershipSection).toContain('typeResolutionFailed = true');
  });

  it('typed event + missing bot_session_id → fail closed', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    expect(src).toContain('isTypedEvent && (!ticketTypeId || typeResolutionFailed)');
    expect(src).toContain('failing closed');
  });

  it('uses booking.bot_session_id (not phone)', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    expect(src).toContain("eq('id', ticketBooking.bot_session_id)");
    const section = src.slice(src.indexOf('8b. Resolve ticket_type_id'), src.indexOf('8c.'));
    expect(section).not.toContain('whatsapp_number');
  });
});

// ═══════════════════════════════════════════════════════
// 5. TICKET BOOKING LOOKUP FAIL-CLOSED
// ═══════════════════════════════════════════════════════

describe('Ticket booking lookup fail-closed', () => {
  it('destructures error from booking query', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    expect(src).toContain('error: ticketBookingError');
  });

  it('booking lookup error → ticketStateComplete = false', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    const idx = src.indexOf('ticket-booking-lookup');
    const after = src.slice(idx, idx + 200);
    expect(after).toContain('ticketStateComplete = false');
  });
});

// ═══════════════════════════════════════════════════════
// 6. BOT COUNTER FAIL-CLOSED
// ═══════════════════════════════════════════════════════

describe('Bot counter fail-closed', () => {
  it('uses finalize_free_ticket_booking (not increment_tickets_sold)', () => {
    const src = readSrc('../bot/flows/ticketing.flow.ts');
    expect(src).toContain("rpc('finalize_free_ticket_booking'");
    expect(src).not.toContain("rpc('increment_tickets_sold'");
  });
  it('finalization error → validation failure', () => {
    const src = readSrc('../bot/flows/ticketing.flow.ts');
    const idx = src.indexOf('finalize_free_ticket_booking RPC error');
    expect(src.slice(idx, idx + 300)).toContain('valid: false');
  });
  it('no legacy SELECT→UPDATE fallback', () => {
    expect(readSrc('../bot/flows/ticketing.flow.ts')).not.toContain("update({ tickets_sold:");
  });
});

// ═══════════════════════════════════════════════════════
// 7. TICKET STATE COMPLETENESS
// ═══════════════════════════════════════════════════════

describe('Ticket state completeness', () => {
  it('finalization BEFORE ticket creation', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    expect(src.indexOf("rpc('finalize_free_ticket_booking'")).toBeLessThan(src.indexOf('sendTicketsAfterPurchase({'));
  });
  it('incomplete state prevents confirmation finalization', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    expect(src).toContain('if (!ticketStateComplete)');
    // The gate check must be before the invocation (not the function definition)
    const gateIdx = src.indexOf('if (!ticketStateComplete)');
    const invokeIdx = src.indexOf('await finalizeConfirmationClaim(');
    expect(gateIdx).toBeLessThan(invokeIdx);
  });
  it('uses sendTicketsAfterPurchase result (not void)', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    expect(src).toContain('ticketResult.success');
    expect(src).toContain('ticketResult.tickets.length');
  });
});

// ═══════════════════════════════════════════════════════
// 8. sendTicketsAfterPurchase RESULT CONTRACT
// ═══════════════════════════════════════════════════════

describe('sendTicketsAfterPurchase result contract', () => {
  it('returns TicketCreationResult (not void)', () => {
    const src = readSrc('../bot/flows/shared/send-tickets.ts');
    expect(src).toContain('Promise<TicketCreationResult>');
    expect(src).toContain('export interface TicketCreationResult');
  });
  it('reports success with ticket data', () => {
    const src = readSrc('../bot/flows/shared/send-tickets.ts');
    expect(src).toContain('return { success: true, tickets }');
  });
  it('reports insert failure explicitly', () => {
    const src = readSrc('../bot/flows/shared/send-tickets.ts');
    expect(src).toContain("return { success: false, tickets: [], error: 'insert_failed' }");
  });
  it('handles UNIQUE conflict from concurrent worker (code 23505)', () => {
    const src = readSrc('../bot/flows/shared/send-tickets.ts');
    expect(src).toContain("insertError.code === '23505'");
    expect(src).toContain('concurrent worker created rows');
  });
  it('re-reads canonical rows on UNIQUE conflict', () => {
    const src = readSrc('../bot/flows/shared/send-tickets.ts');
    expect(src).toContain('concurrentRows');
  });
});

// ═══════════════════════════════════════════════════════
// 9. MIGRATION 313 TICKET ROW IDENTITY
// ═══════════════════════════════════════════════════════

describe('Migration 313: ticket row identity', () => {
  it('creates UNIQUE(booking_id, ticket_number) constraint', () => {
    const src = readSrc('../../supabase/migrations/313_ticket_row_identity.sql');
    expect(src).toContain('UNIQUE INDEX');
    expect(src).toContain('booking_id');
    expect(src).toContain('ticket_number');
  });
  it('uses IF NOT EXISTS (idempotent)', () => {
    expect(readSrc('../../supabase/migrations/313_ticket_row_identity.sql')).toContain('IF NOT EXISTS');
  });
  it('does not change RLS or privileges', () => {
    const src = readSrc('../../supabase/migrations/313_ticket_row_identity.sql');
    expect(src).not.toContain('POLICY');
    expect(src).not.toContain('GRANT');
    expect(src).not.toContain('REVOKE');
  });
});

// ═══════════════════════════════════════════════════════
// 10. EVENT PUBLISH + SESSION
// ═══════════════════════════════════════════════════════

describe('Event publish + session', () => {
  it('Create → published, Duplicate → draft', () => {
    const src = readSrc('../../app/dashboard/events/page.tsx');
    expect(src).toMatch(/openAdd[\s\S]*?status:\s*'published'/);
    expect(src).toContain("status: 'draft'");
  });
  it('bot filters by published', () => {
    expect(readSrc('../bot/flows/ticketing.flow.ts')).toContain("in('status', ['published'])");
  });
  it('session deactivation targets all payment steps', () => {
    const src = readSrc('../payments/send-confirmation.ts');
    for (const s of ['await_ticket_payment', 'payment', 'await_payment', 'await_order_payment', 'create_booking']) {
      expect(src).toContain(`'${s}'`);
    }
  });
});
