/**
 * Payment Success Resolver
 *
 * Resolves the canonical payment from the `?ref=` parameter on the payment-success page.
 *
 * Resolution order:
 * 1. Exact `payments.gateway_reference = ref` — provider-neutral, works for all gateways.
 *    After the Stripe {CHECKOUT_SESSION_ID} fix, new Stripe sessions return `cs_...` and
 *    resolve here directly.
 * 2. Booking reference_code fallback — provider-neutral, preserves existing behavior for
 *    booking-backed payments (scheduling, appointment, ticketing, payment flow).
 * 3. Legacy Stripe entity-reference fallback — for old Stripe sessions whose frozen
 *    success_url contains a business entity reference (e.g. WA-OR-xxxx, WA-BK-xxxx,
 *    WA-IN-xxxx, DON-xxxx). Uses `payments.metadata->reference_code` as the durable
 *    canonical linkage. Requires exact Stripe provider binding and exactly one candidate.
 *    Fails closed on zero or multiple candidates.
 *
 * The resolver only identifies the canonical payment row. It does NOT verify payment
 * status or finalize anything — that responsibility belongs to `reconcilePayment`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

/** The payment columns needed by the payment-success page */
const PAYMENT_SELECT = 'id, status, amount, booking_id, invoice_id, campaign_id, order_id, reservation_id, business_id, metadata, businesses(phone, name, country_code, subscription_tier)' as const;

export type ResolvedPayment = {
  id: string;
  status: string;
  amount: number;
  booking_id: string | null;
  invoice_id: string | null;
  campaign_id: string | null;
  order_id: string | null;
  reservation_id: string | null;
  business_id: string | null;
  metadata: Record<string, unknown> | null;
  businesses: { phone: string; name: string; country_code?: string; subscription_tier?: string } | null;
};

export type ResolutionPath = 'gateway_reference' | 'booking_reference' | 'legacy_stripe_metadata';

export interface ResolverResult {
  payment: ResolvedPayment | null;
  path: ResolutionPath | null;
}

/**
 * Resolve the canonical payment for a payment-success page reference.
 *
 * @param supabase Service-role Supabase client
 * @param ref The `?ref=` parameter value from the payment-success URL
 * @returns The resolved payment and which resolution path was used, or null payment if unresolvable
 */
export async function resolvePaymentFromRef(
  supabase: SupabaseClient,
  ref: string,
): Promise<ResolverResult> {
  // ── Path 1: Exact gateway_reference lookup (provider-neutral) ──
  // This is the primary path for all new Stripe sessions (cs_...) and all other
  // providers that use gateway_reference as the success URL reference.
  try {
    const { data: payment, error } = await supabase
      .from('payments')
      .select(PAYMENT_SELECT)
      .eq('gateway_reference', ref)
      .maybeSingle();

    if (error) {
      logger.error('[PAYMENT-RESOLVER] gateway_reference lookup error — fail closed', { error });
      return { payment: null, path: null };
    }
    if (payment) {
      return { payment: payment as unknown as ResolvedPayment, path: 'gateway_reference' };
    }
  } catch (err) {
    logger.error('[PAYMENT-RESOLVER] gateway_reference lookup threw — fail closed', { err });
    return { payment: null, path: null };
  }

  // ── Path 2: Booking reference_code fallback (provider-neutral) ──
  // Preserves existing behavior: look up booking by reference_code, then find
  // the payment linked to that booking.
  try {
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .select('id')
      .eq('reference_code', ref)
      .maybeSingle();

    if (bookingError) {
      logger.error('[PAYMENT-RESOLVER] booking reference lookup error — continuing to legacy path', { bookingError });
      // Don't fail closed here — continue to legacy path
    } else if (booking) {
      const { data: payment, error: paymentError } = await supabase
        .from('payments')
        .select(PAYMENT_SELECT)
        .eq('booking_id', booking.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (paymentError) {
        logger.error('[PAYMENT-RESOLVER] booking->payment lookup error — fail closed', { paymentError });
        return { payment: null, path: null };
      }
      if (payment) {
        return { payment: payment as unknown as ResolvedPayment, path: 'booking_reference' };
      }
    }
  } catch (err) {
    logger.error('[PAYMENT-RESOLVER] booking reference lookup threw — continuing to legacy path', { err });
    // Don't fail closed — continue to legacy path
  }

  // ── Path 3: Legacy Stripe entity-reference fallback ──
  // For old Stripe Checkout sessions whose frozen success_url contains a business
  // entity reference (e.g. WA-OR-9138, WA-BK-1234, WA-IN-5678, DON-xxxx).
  //
  // Uses `payments.metadata->reference_code` as the durable canonical linkage.
  // This field is persisted by both V0 and V1 Stripe payment initialization.
  //
  // Requirements:
  // - Exact match on metadata.reference_code
  // - Exact Stripe provider binding (gateway = 'stripe')
  // - Exactly one canonical candidate (fail closed on 0 or 2+)
  // - No arbitrary "latest" selection
  // - Does not trust the browser redirect as payment proof
  try {
    const { data: candidates, error: metadataError } = await supabase
      .from('payments')
      .select(PAYMENT_SELECT)
      .eq('gateway', 'stripe')
      .eq('metadata->>reference_code', ref);

    if (metadataError) {
      logger.error('[PAYMENT-RESOLVER] legacy Stripe metadata lookup error — fail closed', { metadataError });
      return { payment: null, path: null };
    }

    if (!candidates || candidates.length === 0) {
      // Zero candidates — fail closed (unknown reference)
      return { payment: null, path: null };
    }

    if (candidates.length > 1) {
      // Multiple candidates — fail closed (ambiguous, cannot determine which
      // payment attempt this browser redirect belongs to)
      logger.warn('[PAYMENT-RESOLVER] legacy Stripe metadata lookup returned multiple candidates — fail closed', {
        ref,
        candidateCount: candidates.length,
        candidateIds: candidates.map((c: Record<string, unknown>) => c.id),
      });
      return { payment: null, path: null };
    }

    // Exactly one candidate
    return { payment: candidates[0] as unknown as ResolvedPayment, path: 'legacy_stripe_metadata' };
  } catch (err) {
    logger.error('[PAYMENT-RESOLVER] legacy Stripe metadata lookup threw — fail closed', { err });
    return { payment: null, path: null };
  }
}
