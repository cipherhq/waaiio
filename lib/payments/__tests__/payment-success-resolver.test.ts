/**
 * Payment Success Resolver — #358 executable evidence
 *
 * Tests the three-tier resolution logic in payment-success-resolver.ts:
 * 1. Provider-neutral exact gateway_reference lookup
 * 2. Provider-neutral booking reference_code fallback
 * 3. Legacy Stripe entity-reference fallback via metadata.reference_code
 *
 * Also tests fail-closed semantics for ambiguity, multi-candidate, and error cases.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolvePaymentFromRef } from '../payment-success-resolver';

// ── Mock helper ──

function makePayment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pay_001',
    status: 'pending',
    amount: 5000,
    booking_id: null,
    invoice_id: null,
    campaign_id: null,
    order_id: null,
    reservation_id: null,
    business_id: 'biz_001',
    metadata: { reference_code: 'WA-OR-9138' },
    businesses: { phone: '+1234', name: 'Test Biz', country_code: 'US', subscription_tier: 'free' },
    ...overrides,
  };
}

/**
 * Creates a chainable Supabase mock where `from(table)` calls are handled
 * sequentially by index. Each handler returns `{data, error}`.
 * Terminal methods (maybeSingle or the last .eq for non-maybeSingle chains)
 * resolve to the handler's return value.
 */
function createMockSupabase(handler: (table: string, callIndex: number) => { data: unknown; error: unknown }) {
  let callCount = 0;
  const supabase = {
    from: vi.fn((table: string) => {
      const idx = callCount++;
      const result = handler(table, idx);

      // Build a chainable + thenable object.
      // Each chaining method returns the same object; awaiting it resolves to result.
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'order', 'limit']) {
        chain[method] = vi.fn().mockReturnValue(chain);
      }
      chain.maybeSingle = vi.fn().mockResolvedValue(result);
      chain.single = vi.fn().mockResolvedValue(result);
      // Make the chain itself thenable so `await chain.eq(...)` works without maybeSingle
      chain.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
        return Promise.resolve(result).then(resolve, reject);
      };
      return chain;
    }),
  };
  return supabase as unknown as import('@supabase/supabase-js').SupabaseClient;
}

describe('resolvePaymentFromRef', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Path 1: Provider-neutral exact gateway_reference
  // ──────────────────────────────────────────────────────────────────────

  describe('Path 1: gateway_reference (provider-neutral)', () => {
    it('resolves new Stripe cs_... session directly', async () => {
      const payment = makePayment({ id: 'pay_stripe_cs' });
      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: payment, error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'cs_test_abc123');
      expect(result.payment).not.toBeNull();
      expect(result.path).toBe('gateway_reference');
      expect(result.payment!.id).toBe('pay_stripe_cs');
    });

    it('resolves Paystack reference (provider-neutral)', async () => {
      const payment = makePayment({ id: 'pay_paystack' });
      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: payment, error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'paystack_ref_xyz');
      expect(result.payment).not.toBeNull();
      expect(result.path).toBe('gateway_reference');
    });

    it('resolves Flutterwave reference (provider-neutral)', async () => {
      const payment = makePayment({ id: 'pay_flw' });
      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: payment, error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'flw_ref_123');
      expect(result.payment).not.toBeNull();
      expect(result.path).toBe('gateway_reference');
    });

    it('fails closed on gateway_reference DB error', async () => {
      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: null, error: { message: 'DB error' } };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'cs_test_abc');
      expect(result.payment).toBeNull();
      expect(result.path).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Path 2: Provider-neutral booking reference_code fallback
  // ──────────────────────────────────────────────────────────────────────

  describe('Path 2: booking reference fallback (provider-neutral)', () => {
    it('resolves booking reference for scheduling/appointment payment', async () => {
      const payment = makePayment({ id: 'pay_booking', booking_id: 'bk_001' });
      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: null, error: null }; // no gw match
        if (table === 'bookings' && idx === 1) return { data: { id: 'bk_001' }, error: null };
        if (table === 'payments' && idx === 2) return { data: payment, error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'WA-BK-1234');
      expect(result.payment).not.toBeNull();
      expect(result.path).toBe('booking_reference');
      expect(result.payment!.booking_id).toBe('bk_001');
    });

    it('resolves booking reference for ticketing payment', async () => {
      const payment = makePayment({ id: 'pay_ticket', booking_id: 'bk_tk_001' });
      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: null, error: null };
        if (table === 'bookings' && idx === 1) return { data: { id: 'bk_tk_001' }, error: null };
        if (table === 'payments' && idx === 2) return { data: payment, error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'WA-TK-5678');
      expect(result.payment).not.toBeNull();
      expect(result.path).toBe('booking_reference');
    });

    it('resolves booking reference for reservation (WA-RS-) via booking table', async () => {
      const payment = makePayment({ id: 'pay_res_booking', booking_id: 'bk_res_001' });
      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: null, error: null };
        if (table === 'bookings' && idx === 1) return { data: { id: 'bk_res_001' }, error: null };
        if (table === 'payments' && idx === 2) return { data: payment, error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'WA-RS-9999');
      expect(result.payment).not.toBeNull();
      expect(result.path).toBe('booking_reference');
    });

    it('continues to legacy path when booking not found', async () => {
      const payment = makePayment({ id: 'pay_legacy', order_id: 'ord_001', metadata: { reference_code: 'WA-OR-9138' } });
      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: null, error: null };
        if (table === 'bookings' && idx === 1) return { data: null, error: null }; // no booking
        // Legacy Stripe path: returns array
        if (table === 'payments' && idx === 2) return { data: [payment], error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'WA-OR-9138');
      expect(result.payment).not.toBeNull();
      expect(result.path).toBe('legacy_stripe_metadata');
    });

    it('is provider-neutral — works for Paystack booking payments', async () => {
      const payment = makePayment({ id: 'pay_paystack_bk', booking_id: 'bk_ps_001' });
      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: null, error: null };
        if (table === 'bookings' && idx === 1) return { data: { id: 'bk_ps_001' }, error: null };
        if (table === 'payments' && idx === 2) return { data: payment, error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'WA-BK-7777');
      expect(result.payment).not.toBeNull();
      expect(result.path).toBe('booking_reference');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Path 3: Legacy Stripe entity-reference fallback
  // ──────────────────────────────────────────────────────────────────────

  describe('Path 3: legacy Stripe metadata.reference_code', () => {
    it('resolves legacy Stripe order payment (WA-OR-xxxx)', async () => {
      const payment = makePayment({ id: 'pay_ord', order_id: 'ord_001', metadata: { reference_code: 'WA-OR-9138' } });
      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: null, error: null };
        if (table === 'bookings' && idx === 1) return { data: null, error: null };
        if (table === 'payments' && idx === 2) return { data: [payment], error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'WA-OR-9138');
      expect(result.payment).not.toBeNull();
      expect(result.path).toBe('legacy_stripe_metadata');
      expect(result.payment!.order_id).toBe('ord_001');
    });

    it('resolves legacy Stripe invoice payment (WA-IN-xxxx)', async () => {
      const payment = makePayment({ id: 'pay_inv', invoice_id: 'inv_001', metadata: { reference_code: 'WA-IN-4567' } });
      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: null, error: null };
        if (table === 'bookings' && idx === 1) return { data: null, error: null };
        if (table === 'payments' && idx === 2) return { data: [payment], error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'WA-IN-4567');
      expect(result.payment).not.toBeNull();
      expect(result.path).toBe('legacy_stripe_metadata');
      expect(result.payment!.invoice_id).toBe('inv_001');
    });

    it('resolves legacy Stripe reservation payment', async () => {
      const payment = makePayment({ id: 'pay_resv', reservation_id: 'res_001', metadata: { reference_code: 'WA-RS-3333' } });
      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: null, error: null };
        if (table === 'bookings' && idx === 1) return { data: null, error: null };
        if (table === 'payments' && idx === 2) return { data: [payment], error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'WA-RS-3333');
      expect(result.payment).not.toBeNull();
      expect(result.path).toBe('legacy_stripe_metadata');
      expect(result.payment!.reservation_id).toBe('res_001');
    });

    it('resolves legacy Stripe campaign/giving payment (DON-xxxx)', async () => {
      const payment = makePayment({ id: 'pay_don', campaign_id: 'camp_001', metadata: { reference_code: 'DON-ABC123' } });
      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: null, error: null };
        if (table === 'bookings' && idx === 1) return { data: null, error: null };
        if (table === 'payments' && idx === 2) return { data: [payment], error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'DON-ABC123');
      expect(result.payment).not.toBeNull();
      expect(result.path).toBe('legacy_stripe_metadata');
      expect(result.payment!.campaign_id).toBe('camp_001');
    });

    it('fails closed on zero candidates', async () => {
      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: null, error: null };
        if (table === 'bookings' && idx === 1) return { data: null, error: null };
        if (table === 'payments' && idx === 2) return { data: [], error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'WA-OR-0000');
      expect(result.payment).toBeNull();
      expect(result.path).toBeNull();
    });

    it('fails closed on multiple candidates — no arbitrary latest', async () => {
      const payment1 = makePayment({ id: 'pay_a', metadata: { reference_code: 'DON-DUP1' } });
      const payment2 = makePayment({ id: 'pay_b', metadata: { reference_code: 'DON-DUP1' } });
      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: null, error: null };
        if (table === 'bookings' && idx === 1) return { data: null, error: null };
        if (table === 'payments' && idx === 2) return { data: [payment1, payment2], error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'DON-DUP1');
      expect(result.payment).toBeNull();
      expect(result.path).toBeNull();
    });

    it('WA-RS- ambiguity: multiple Stripe payments with same ref fails closed', async () => {
      const paymentBooking = makePayment({ id: 'pay_bk_rs', booking_id: 'bk_rs_1', metadata: { reference_code: 'WA-RS-AMBIG' } });
      const paymentReserv = makePayment({ id: 'pay_rv_rs', reservation_id: 'rv_rs_1', metadata: { reference_code: 'WA-RS-AMBIG' } });
      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: null, error: null };
        if (table === 'bookings' && idx === 1) return { data: null, error: null };
        if (table === 'payments' && idx === 2) return { data: [paymentBooking, paymentReserv], error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'WA-RS-AMBIG');
      expect(result.payment).toBeNull();
      expect(result.path).toBeNull();
    });

    it('DON- non-uniqueness: multiple donation payments fails closed', async () => {
      const don1 = makePayment({ id: 'don_a', campaign_id: 'c1', metadata: { reference_code: 'DON-SAME' } });
      const don2 = makePayment({ id: 'don_b', campaign_id: 'c1', metadata: { reference_code: 'DON-SAME' } });
      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: null, error: null };
        if (table === 'bookings' && idx === 1) return { data: null, error: null };
        if (table === 'payments' && idx === 2) return { data: [don1, don2], error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'DON-SAME');
      expect(result.payment).toBeNull();
    });

    it('fails closed on legacy metadata DB error', async () => {
      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: null, error: null };
        if (table === 'bookings' && idx === 1) return { data: null, error: null };
        if (table === 'payments' && idx === 2) return { data: null, error: { message: 'DB error' } };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'WA-OR-FAIL');
      expect(result.payment).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Metadata/channel preservation
  // ──────────────────────────────────────────────────────────────────────

  describe('metadata and channel preservation', () => {
    it('does not mutate payment metadata during resolution', async () => {
      const originalMeta = {
        reference_code: 'WA-OR-9138',
        _inbound_channel_id: 'ch_original',
        _confirmation_origin: 'whatsapp',
        payment_origin: 'platform',
        stripe_session_id: 'cs_test_preserved',
      };
      const payment = makePayment({ id: 'pay_meta', metadata: { ...originalMeta } });
      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: payment, error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'cs_test_preserved');
      expect(result.payment).not.toBeNull();
      const meta = result.payment!.metadata as Record<string, unknown>;
      expect(meta._inbound_channel_id).toBe('ch_original');
      expect(meta._confirmation_origin).toBe('whatsapp');
      expect(meta.payment_origin).toBe('platform');
      expect(meta.reference_code).toBe('WA-OR-9138');
    });

    it('preserves all entity IDs on the resolved payment', async () => {
      const payment = makePayment({
        id: 'pay_entity',
        order_id: 'ord_99',
        booking_id: null,
        invoice_id: null,
        campaign_id: null,
        reservation_id: null,
        business_id: 'biz_99',
      });
      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: payment, error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'cs_test_entity');
      expect(result.payment!.order_id).toBe('ord_99');
      expect(result.payment!.business_id).toBe('biz_99');
      expect(result.payment!.booking_id).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Unknown / missing reference
  // ──────────────────────────────────────────────────────────────────────

  describe('unknown reference', () => {
    it('returns null for completely unknown reference', async () => {
      const supabase = createMockSupabase(() => {
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'UNKNOWN-REF-XYZ');
      expect(result.payment).toBeNull();
    });
  });
});
