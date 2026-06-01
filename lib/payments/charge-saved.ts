import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY || '';

interface SavedMethod {
  id: string;
  gateway: string;
  authorization_code: string | null;
  customer_code: string | null;
  stripe_payment_method_id: string | null;
  stripe_customer_id: string | null;
  card_last4: string | null;
  card_brand: string | null;
}

/**
 * Get a customer's saved payment method for a business.
 */
export async function getSavedPaymentMethod(
  supabase: SupabaseClient,
  businessId: string,
  customerPhone: string,
): Promise<SavedMethod | null> {
  const { data } = await supabase
    .from('saved_payment_methods')
    .select('id, gateway, authorization_code, customer_code, stripe_payment_method_id, stripe_customer_id, card_last4, card_brand')
    .eq('business_id', businessId)
    .eq('customer_phone', customerPhone)
    .eq('is_active', true)
    .maybeSingle();

  return data || null;
}

/**
 * Charge a saved payment method (Paystack authorization).
 * Returns the transaction reference on success, or null on failure.
 */
export async function chargeSavedCard(
  supabase: SupabaseClient,
  opts: {
    savedMethod: SavedMethod;
    amount: number; // in main currency unit (e.g., Naira, not kobo)
    currency: string;
    email: string;
    reference: string;
    businessId: string;
    bookingId?: string;
    invoiceId?: string;
    reservationId?: string;
    orderId?: string;
    campaignId?: string;
    userId?: string;
    byoSecretKey?: string;
  },
): Promise<{ success: boolean; reference: string; message?: string }> {
  if (opts.savedMethod.gateway === 'paystack' && opts.savedMethod.authorization_code) {
    return chargePaystackAuthorization(supabase, opts);
  }

  // Stripe saved cards would go here
  // if (opts.savedMethod.gateway === 'stripe' && opts.savedMethod.stripe_payment_method_id) { ... }

  return { success: false, reference: opts.reference, message: 'Unsupported payment method' };
}

async function chargePaystackAuthorization(
  supabase: SupabaseClient,
  opts: {
    savedMethod: SavedMethod;
    amount: number;
    currency: string;
    email: string;
    reference: string;
    businessId: string;
    bookingId?: string;
    invoiceId?: string;
    reservationId?: string;
    orderId?: string;
    campaignId?: string;
    userId?: string;
    byoSecretKey?: string;
  },
): Promise<{ success: boolean; reference: string; message?: string }> {
  const secretKey = opts.byoSecretKey || paystackSecretKey;
  if (!secretKey) {
    return { success: false, reference: opts.reference, message: 'Payment gateway not configured' };
  }

  const amountInKobo = Math.round(opts.amount * 100);

  try {
    // Create payment record first
    await supabase.from('payments').insert({
      booking_id: opts.bookingId || null,
      invoice_id: opts.invoiceId || null,
      campaign_id: opts.campaignId || null,
      reservation_id: opts.reservationId || null,
      order_id: opts.orderId || null,
      user_id: opts.userId || null,
      amount: opts.amount,
      currency: opts.currency,
      gateway: 'paystack',
      gateway_reference: opts.reference,
      status: 'pending',
      payment_method: 'saved_card',
      card_last_four: opts.savedMethod.card_last4,
      card_brand: opts.savedMethod.card_brand,
      metadata: { business_id: opts.businessId, saved_method: true },
    });

    // Charge the authorization
    const res = await fetch('https://api.paystack.co/transaction/charge_authorization', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        authorization_code: opts.savedMethod.authorization_code,
        email: opts.email,
        amount: amountInKobo,
        currency: opts.currency,
        reference: opts.reference,
        metadata: {
          business_id: opts.businessId,
          booking_id: opts.bookingId || null,
          invoice_id: opts.invoiceId || null,
          saved_method: true,
        },
      }),
      signal: AbortSignal.timeout(15000),
    });

    const data = await res.json();

    if (data.status && data.data?.status === 'success') {
      // Update last used
      await supabase.from('saved_payment_methods')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', opts.savedMethod.id);

      logger.debug('[SAVED-CARD] Charge successful:', opts.reference);
      return { success: true, reference: opts.reference };
    }

    logger.error('[SAVED-CARD] Charge failed:', data.message || data.data?.gateway_response);
    return {
      success: false,
      reference: opts.reference,
      message: data.data?.gateway_response || data.message || 'Card charge failed',
    };
  } catch (error) {
    logger.error('[SAVED-CARD] Charge error:', (error as Error).message);
    return { success: false, reference: opts.reference, message: 'Payment processing error' };
  }
}
