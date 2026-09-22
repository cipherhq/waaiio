/**
 * Payment Success Resolver — #358 executable evidence
 *
 * Tests the three-tier resolution logic in payment-success-resolver.ts:
 * 1. Provider-neutral exact gateway_reference lookup
 * 2. Provider-neutral booking reference_code fallback (no Stripe cross-check
 *    for non-reservation bookings — R4-B2)
 * 3. Legacy Stripe entity-reference fallback via metadata.reference_code
 *
 * Also tests:
 * - fail-closed semantics for ambiguity, multi-candidate, and error cases
 * - DB error fail-closed behavior (R3-B2)
 * - WA-RS collision detection only for reservation bookings (R3-B1 + R4-B2)
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
 * The chain is thenable for non-maybeSingle terminal queries.
 */
function createMockSupabase(handler: (table: string, callIndex: number) => { data: unknown; error: unknown }) {
  let callCount = 0;
  const supabase = {
    from: vi.fn((table: string) => {
      const idx = callCount++;
      const result = handler(table, idx);

      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'order', 'limit']) {
        chain[method] = vi.fn().mockReturnValue(chain);
      }
      chain.maybeSingle = vi.fn().mockResolvedValue(result);
      chain.single = vi.fn().mockResolvedValue(result);
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
  // Non-reservation bookings return directly (no Stripe cross-check)
  // ──────────────────────────────────────────────────────────────────────

  describe('Path 2: booking reference fallback (provider-neutral)', () => {
    it('resolves WA-BK scheduling booking — no Stripe cross-check', async () => {
      const payment = makePayment({ id: 'pay_booking', booking_id: 'bk_001' });
      let fromCallCount = 0;
      const supabase = createMockSupabase((table, idx) => {
        fromCallCount = idx + 1;
        if (table === 'payments' && idx === 0) return { data: null, error: null }; // no gw match
        if (table === 'bookings' && idx === 1) return { data: { id: 'bk_001', flow_type: 'scheduling' }, error: null };
        if (table === 'payments' && idx === 2) return { data: payment, error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'WA-BK-1234');
      expect(result.payment).not.toBeNull();
      expect(result.path).toBe('booking_reference');
      expect(result.payment!.booking_id).toBe('bk_001');
      // Only 3 from() calls: gateway_ref, bookings, payments. No Stripe cross-check.
      expect(fromCallCount).toBe(3);
    });

    it('resolves WA-TK ticketing booking — no Stripe cross-check', async () => {
      const payment = makePayment({ id: 'pay_ticket', booking_id: 'bk_tk_001' });
      let fromCallCount = 0;
      const supabase = createMockSupabase((table, idx) => {
        fromCallCount = idx + 1;
        if (table === 'payments' && idx === 0) return { data: null, error: null };
        if (table === 'bookings' && idx === 1) return { data: { id: 'bk_tk_001', flow_type: 'ticketing' }, error: null };
        if (table === 'payments' && idx === 2) return { data: payment, error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'WA-TK-5678');
      expect(result.payment).not.toBeNull();
      expect(result.path).toBe('booking_reference');
      expect(fromCallCount).toBe(3);
    });

    it('resolves Paystack appointment booking — provider-neutral, no Stripe cross-check', async () => {
      const payment = makePayment({ id: 'pay_paystack_bk', booking_id: 'bk_ps_001' });
      let fromCallCount = 0;
      const supabase = createMockSupabase((table, idx) => {
        fromCallCount = idx + 1;
        if (table === 'payments' && idx === 0) return { data: null, error: null };
        if (table === 'bookings' && idx === 1) return { data: { id: 'bk_ps_001', flow_type: 'scheduling' }, error: null };
        if (table === 'payments' && idx === 2) return { data: payment, error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'WA-BK-7777');
      expect(result.payment).not.toBeNull();
      expect(result.path).toBe('booking_reference');
      expect(fromCallCount).toBe(3);
    });

    it('resolves Flutterwave ticketing booking — provider-neutral, no Stripe cross-check', async () => {
      const payment = makePayment({ id: 'pay_flw_tk', booking_id: 'bk_flw_001' });
      let fromCallCount = 0;
      const supabase = createMockSupabase((table, idx) => {
        fromCallCount = idx + 1;
        if (table === 'payments' && idx === 0) return { data: null, error: null };
        if (table === 'bookings' && idx === 1) return { data: { id: 'bk_flw_001', flow_type: 'ticketing' }, error: null };
        if (table === 'payments' && idx === 2) return { data: payment, error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'WA-TK-FLW');
      expect(result.payment).not.toBeNull();
      expect(result.path).toBe('booking_reference');
      expect(fromCallCount).toBe(3);
    });

    it('continues to legacy path when booking not found (successful empty result)', async () => {
      const payment = makePayment({ id: 'pay_legacy', order_id: 'ord_001', metadata: { reference_code: 'WA-OR-9138' } });
      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: null, error: null };
        if (table === 'bookings' && idx === 1) return { data: null, error: null };
        if (table === 'payments' && idx === 2) return { data: [payment], error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'WA-OR-9138');
      expect(result.payment).not.toBeNull();
      expect(result.path).toBe('legacy_stripe_metadata');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // R3-B2: Booking DB error fail-closed
  // ──────────────────────────────────────────────────────────────────────

  describe('R3-B2: booking lookup DB errors fail closed', () => {
    it('booking reference lookup DB error → fail closed (does NOT continue to legacy)', async () => {
      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: null, error: null };
        if (table === 'bookings' && idx === 1) return { data: null, error: { message: 'connection reset' } };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'WA-BK-FAIL');
      expect(result.payment).toBeNull();
      expect(result.path).toBeNull();
    });

    it('booking reference lookup throw → fail closed', async () => {
      let callCount = 0;
      const supabase = {
        from: vi.fn((table: string) => {
          const idx = callCount++;
          if (table === 'payments' && idx === 0) {
            const chain: Record<string, unknown> = {};
            for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = vi.fn().mockReturnValue(chain);
            chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
            chain.then = (r: (v: unknown) => void) => Promise.resolve({ data: null, error: null }).then(r);
            return chain;
          }
          if (table === 'bookings' && idx === 1) {
            throw new Error('connection timeout');
          }
          return {};
        }),
      } as unknown as import('@supabase/supabase-js').SupabaseClient;

      const result = await resolvePaymentFromRef(supabase, 'WA-BK-THROW');
      expect(result.payment).toBeNull();
      expect(result.path).toBeNull();
    });

    it('booking→payment lookup DB error → fail closed', async () => {
      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: null, error: null };
        if (table === 'bookings' && idx === 1) return { data: { id: 'bk_err', flow_type: 'scheduling' }, error: null };
        if (table === 'payments' && idx === 2) return { data: null, error: { message: 'DB timeout' } };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'WA-BK-PAY-ERR');
      expect(result.payment).toBeNull();
      expect(result.path).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // R3-B1 + R4-B2: WA-RS collision detection (reservation bookings only)
  // ──────────────────────────────────────────────────────────────────────

  describe('WA-RS collision fence (reservation bookings only)', () => {
    it('reservation booking + different Stripe reservation payment same ref → fail closed', async () => {
      const bookingPayment = makePayment({ id: 'pay_bk_rs', booking_id: 'bk_rs_1' });
      const stripeReservationPayment = makePayment({ id: 'pay_stripe_rv', reservation_id: 'rv_1', metadata: { reference_code: 'WA-RS-COLL' } });

      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: null, error: null };
        if (table === 'bookings' && idx === 1) return { data: { id: 'bk_rs_1', flow_type: 'reservation' }, error: null };
        if (table === 'payments' && idx === 2) return { data: bookingPayment, error: null };
        // Cross-check: different Stripe payment
        if (table === 'payments' && idx === 3) return { data: [stripeReservationPayment], error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'WA-RS-COLL');
      expect(result.payment).toBeNull();
      expect(result.path).toBeNull();
    });

    it('reservation booking + same canonical Stripe payment → safe resolution', async () => {
      const payment = makePayment({ id: 'pay_same', booking_id: 'bk_same', metadata: { reference_code: 'WA-RS-SAFE' } });

      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: null, error: null };
        if (table === 'bookings' && idx === 1) return { data: { id: 'bk_same', flow_type: 'reservation' }, error: null };
        if (table === 'payments' && idx === 2) return { data: payment, error: null };
        // Cross-check: same payment
        if (table === 'payments' && idx === 3) return { data: [payment], error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'WA-RS-SAFE');
      expect(result.payment).not.toBeNull();
      expect(result.path).toBe('booking_reference');
      expect(result.payment!.id).toBe('pay_same');
    });

    it('reservation booking + no Stripe candidates → safe (non-Stripe provider)', async () => {
      const payment = makePayment({ id: 'pay_paystack_rs', booking_id: 'bk_ps_rs' });

      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: null, error: null };
        if (table === 'bookings' && idx === 1) return { data: { id: 'bk_ps_rs', flow_type: 'reservation' }, error: null };
        if (table === 'payments' && idx === 2) return { data: payment, error: null };
        if (table === 'payments' && idx === 3) return { data: [], error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'WA-RS-PAYSTACK');
      expect(result.payment).not.toBeNull();
      expect(result.path).toBe('booking_reference');
    });

    it('reservation cross-check DB error → fail closed', async () => {
      const bookingPayment = makePayment({ id: 'pay_bk_cross_err', booking_id: 'bk_cross' });

      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: null, error: null };
        if (table === 'bookings' && idx === 1) return { data: { id: 'bk_cross', flow_type: 'reservation' }, error: null };
        if (table === 'payments' && idx === 2) return { data: bookingPayment, error: null };
        if (table === 'payments' && idx === 3) return { data: null, error: { message: 'cross-check error' } };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'WA-RS-CROSS-ERR');
      expect(result.payment).toBeNull();
      expect(result.path).toBeNull();
    });

    it('reservation booking + multiple Stripe candidates → fail closed', async () => {
      const bookingPayment = makePayment({ id: 'pay_bk_multi', booking_id: 'bk_multi' });
      const stripe1 = makePayment({ id: 'pay_stripe_1', metadata: { reference_code: 'WA-RS-MULTI' } });
      const stripe2 = makePayment({ id: 'pay_stripe_2', metadata: { reference_code: 'WA-RS-MULTI' } });

      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: null, error: null };
        if (table === 'bookings' && idx === 1) return { data: { id: 'bk_multi', flow_type: 'reservation' }, error: null };
        if (table === 'payments' && idx === 2) return { data: bookingPayment, error: null };
        if (table === 'payments' && idx === 3) return { data: [stripe1, stripe2], error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'WA-RS-MULTI');
      expect(result.payment).toBeNull();
      expect(result.path).toBeNull();
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
    });

    it('fails closed on multiple candidates', async () => {
      const p1 = makePayment({ id: 'pay_a' });
      const p2 = makePayment({ id: 'pay_b' });
      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: null, error: null };
        if (table === 'bookings' && idx === 1) return { data: null, error: null };
        if (table === 'payments' && idx === 2) return { data: [p1, p2], error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'DON-DUP');
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
      };
      const payment = makePayment({ id: 'pay_meta', metadata: { ...originalMeta } });
      const supabase = createMockSupabase((table, idx) => {
        if (table === 'payments' && idx === 0) return { data: payment, error: null };
        return { data: null, error: null };
      });

      const result = await resolvePaymentFromRef(supabase, 'cs_test_preserved');
      const meta = result.payment!.metadata as Record<string, unknown>;
      expect(meta._inbound_channel_id).toBe('ch_original');
      expect(meta._confirmation_origin).toBe('whatsapp');
      expect(meta.payment_origin).toBe('platform');
    });

    it('preserves all entity IDs on the resolved payment', async () => {
      const payment = makePayment({
        id: 'pay_entity', order_id: 'ord_99', booking_id: null,
        invoice_id: null, campaign_id: null, reservation_id: null, business_id: 'biz_99',
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
      const supabase = createMockSupabase(() => ({ data: null, error: null }));
      const result = await resolvePaymentFromRef(supabase, 'UNKNOWN-REF-XYZ');
      expect(result.payment).toBeNull();
    });
  });
});
