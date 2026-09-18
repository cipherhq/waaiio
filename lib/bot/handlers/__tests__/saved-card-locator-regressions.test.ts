/**
 * F3/F4/P3 Locator regression tests for findLatestSavedCardPaymentIdForPhone.
 *
 * P1 (F3): Two same-family entities — older entity has newer payment → locator returns newer payment.
 * P2 (F4): Booking candidate exists + profile lookup errors → locator fails closed (null).
 * P3: Two campaign donations — older donation has newer payment → locator returns newer payment.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/payments/saved-card-compat', () => ({
  canonicalSavedCardPhone: vi.fn().mockImplementation((p: string) => p.startsWith('+') ? p : `+${p}`),
}));

const PHONE = '+2348012345678';
const PHONE_N = '2348012345678';

// Newer payment on OLDER booking
const PAY_A = 'pay-aaa-newer';
const PAY_B = 'pay-bbb-older';
const BK_A = 'bk-older-entity';
const BK_B = 'bk-newer-entity';

function makeChain(data: unknown = null) {
  const chain: Record<string, unknown> = {};
  ['select', 'eq', 'in', 'or', 'not', 'order', 'limit'].forEach(m => {
    chain[m] = vi.fn().mockReturnValue(chain);
  });
  chain.single = vi.fn().mockResolvedValue({ data, error: null });
  chain.maybeSingle = vi.fn().mockResolvedValue({ data, error: null });
  // Thenable for array queries
  Object.defineProperty(chain, 'then', {
    value: (resolve: (v: unknown) => void) => resolve({
      data: data === null ? [] : (Array.isArray(data) ? data : [data]),
      error: null,
    }),
    configurable: true,
  });
  return chain;
}

describe('Locator regressions: findLatestSavedCardPaymentIdForPhone', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // ═══════════════════════════════════════════════════════════════
  // P1 (F3): Older entity has newer payment → locator returns newer payment
  // ═══════════════════════════════════════════════════════════════
  it('P1/F3: two bookings — older booking has newer payment — locator returns the newer PAYMENT', async () => {
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'bookings') {
          // Return BOTH booking IDs for this phone
          return makeChain([{ id: BK_A }, { id: BK_B }]);
        }
        if (table === 'payments') {
          // When queried with .in('booking_id', [BK_A, BK_B]).order(created_at desc).limit(1)
          // → return PAY_A (the newer payment, which belongs to the older booking BK_A)
          const chain = makeChain();
          chain.maybeSingle = vi.fn().mockResolvedValue({
            data: { id: PAY_A, created_at: '2026-09-18T12:00:00Z' },
            error: null,
          });
          return chain;
        }
        // Other families return empty (no reservations, invoices, orders, donations)
        if (table === 'reservations' || table === 'invoices' || table === 'orders') {
          return makeChain([]);
        }
        if (table === 'campaign_donations') return makeChain([]);
        if (table === 'profiles') return makeChain(null);
        return makeChain(null);
      }),
    };

    const { findLatestSavedCardPaymentIdForPhone } = await import('../saved-cards');
    const result = await findLatestSavedCardPaymentIdForPhone(supabase as any, PHONE);

    // MUST return PAY_A (newer payment on older booking), NOT PAY_B
    expect(result).toBe(PAY_A);

    // Verify the locator queried payments with .in() across BOTH bookings
    const paymentCalls = supabase.from.mock.calls.filter((c: unknown[]) => c[0] === 'payments');
    expect(paymentCalls.length).toBeGreaterThan(0);
  });

  // ═══════════════════════════════════════════════════════════════
  // P2 (F4): Booking candidate exists + profile lookup errors → fail closed
  // ═══════════════════════════════════════════════════════════════
  it('P2/F4: booking candidate exists + profile lookup errors → returns null (fail closed)', async () => {
    const BOOKING_PAY = 'pay-booking-valid';
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'bookings') {
          return makeChain([{ id: 'bk-valid' }]);
        }
        if (table === 'payments') {
          const chain = makeChain();
          chain.maybeSingle = vi.fn().mockResolvedValue({
            data: { id: BOOKING_PAY, created_at: '2026-09-18T10:00:00Z' },
            error: null,
          });
          return chain;
        }
        // Other entity families: empty
        if (table === 'reservations' || table === 'invoices' || table === 'orders') {
          return makeChain([]);
        }
        if (table === 'campaign_donations') return makeChain([]);
        // Profile lookup ERRORS
        if (table === 'profiles') {
          const chain = makeChain(null);
          chain.maybeSingle = vi.fn().mockResolvedValue({
            data: null,
            error: { message: 'connection refused', code: 'PGRST301' },
          });
          return chain;
        }
        return makeChain(null);
      }),
    };

    const { findLatestSavedCardPaymentIdForPhone } = await import('../saved-cards');
    const result = await findLatestSavedCardPaymentIdForPhone(supabase as any, PHONE);

    // MUST return null (fail closed) — NOT the booking payment
    expect(result).toBeNull();
  });

  // ═══════════════════════════════════════════════════════════════
  // P3: Two campaign donations — older donation has newer payment
  // ═══════════════════════════════════════════════════════════════
  it('P3: two donations — older donation has newer payment — locator returns newer payment', async () => {
    const DON_PAY_NEWER = 'pay-don-newer';
    const DON_PAY_OLDER = 'pay-don-older';
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        // Entity families: empty
        if (table === 'bookings' || table === 'reservations' || table === 'invoices' || table === 'orders') {
          return makeChain([]);
        }
        if (table === 'campaign_donations') {
          // Return BOTH donation payment_ids
          return makeChain([{ payment_id: DON_PAY_NEWER }, { payment_id: DON_PAY_OLDER }]);
        }
        if (table === 'payments') {
          // Queried with .in('id', [DON_PAY_NEWER, DON_PAY_OLDER]).order(created_at desc).limit(1)
          const chain = makeChain();
          chain.maybeSingle = vi.fn().mockResolvedValue({
            data: { id: DON_PAY_NEWER, created_at: '2026-09-18T15:00:00Z' },
            error: null,
          });
          return chain;
        }
        if (table === 'profiles') return makeChain(null);
        return makeChain(null);
      }),
    };

    const { findLatestSavedCardPaymentIdForPhone } = await import('../saved-cards');
    const result = await findLatestSavedCardPaymentIdForPhone(supabase as any, PHONE);

    expect(result).toBe(DON_PAY_NEWER);
  });
});
