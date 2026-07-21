import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import type { PaymentGateway, InitPaymentOpts, InitPaymentResult, RefundPaymentOpts, RefundResult } from './types';
import { logger } from '@/lib/logger';

function getStripeKey(): string {
  return process.env.STRIPE_SECRET_KEY || '';
}

async function stripeRequest(path: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const key = getStripeKey();
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(15000),
  });
  return response.json() as Promise<Record<string, unknown>>;
}

async function stripeGet(path: string): Promise<Record<string, unknown>> {
  const key = getStripeKey();
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15000),
  });
  return response.json() as Promise<Record<string, unknown>>;
}

export class StripeGateway implements PaymentGateway {
  name = 'stripe' as const;

  async initializePayment(opts: InitPaymentOpts): Promise<InitPaymentResult | null> {
    const idempotencyKey = randomUUID();

    try {
      const stripeSecretKey = getStripeKey();
      if (!stripeSecretKey) {
        if (process.env.NODE_ENV === 'production') {
          throw new Error('Payment gateway not configured: missing Stripe secret key');
        }
        const mockRef = `mock_stripe_${idempotencyKey}`;
        await opts.supabase.from('payments').insert({
          booking_id: opts.bookingId || null,
          invoice_id: opts.invoiceId || null,
          campaign_id: opts.campaignId || null,
          reservation_id: opts.reservationId || null,
          business_id: opts.businessId || null,
          user_id: opts.userId,
          amount: opts.amount,
          currency: opts.currency,
          gateway: 'stripe',
          gateway_reference: mockRef,
          status: 'pending',
          collection_mode: opts.collectionMode || 'platform',
          fee_bearer: opts.feeBearerMode || 'platform',
          payout_account_id: opts.payoutAccountId || null,
          waaiio_fee: opts.waaiioFee ?? 0,
          metadata: { reference_code: opts.referenceCode, channel: 'whatsapp', order_id: opts.orderId || null },
        });
        return { url: `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'}/pay?ref=${mockRef}`, reference: mockRef };
      }

      // Convert amount to cents (Stripe uses smallest currency unit)
      const amountInCents = Math.round(opts.amount * 100);
      const callbackUrl = opts.callbackUrl || process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';

      const sessionParams: Record<string, string> = {
        'payment_method_types[0]': 'card',
        'line_items[0][price_data][currency]': opts.currency.toLowerCase(),
        'line_items[0][price_data][product_data][name]': `${opts.businessName} - ${opts.referenceCode}`,
        'line_items[0][price_data][unit_amount]': String(amountInCents),
        'line_items[0][quantity]': '1',
        mode: 'payment',
        success_url: `${callbackUrl}/payment-success?ref=${opts.referenceCode}`,
        cancel_url: `${callbackUrl}`,
        'metadata[booking_id]': opts.bookingId || '',
        'metadata[order_id]': opts.orderId || '',
        'metadata[user_id]': opts.userId,
        'metadata[reference_code]': opts.referenceCode,
        'metadata[channel]': 'whatsapp',
      };
      if (opts.userEmail) {
        sessionParams.customer_email = opts.userEmail;
      }

      // Stripe Connect split payment
      if (opts.stripeAccountId) {
        sessionParams['payment_intent_data[application_fee_amount]'] = String(
          opts.platformFeeAmount ? Math.round(opts.platformFeeAmount * 100) : 0,
        );
        sessionParams['payment_intent_data[transfer_data][destination]'] = opts.stripeAccountId;
      }

      const sessionData = await stripeRequest('/checkout/sessions', sessionParams);

      if (!sessionData.id || !sessionData.url) {
        // Store detailed error for debug endpoint
        (globalThis as Record<string, unknown>).__stripeDebug = {
          sessionData: JSON.stringify(sessionData).slice(0, 500),
          keyPresent: !!stripeSecretKey,
          keyPrefix: stripeSecretKey.slice(0, 15),
          keyLength: stripeSecretKey.length,
          currency: sessionParams['line_items[0][price_data][currency]'],
          amount: sessionParams['line_items[0][price_data][unit_amount]'],
        };
        logger.error('Stripe session creation failed:', JSON.stringify(sessionData).slice(0, 500));
        return null;
      }

      const stripeRef = sessionData.id as string;

      const { data: payment } = await opts.supabase.from('payments').insert({
        booking_id: opts.bookingId || null,
        invoice_id: opts.invoiceId || null,
        campaign_id: opts.campaignId || null,
        reservation_id: opts.reservationId || null,
        business_id: opts.businessId || null,
        user_id: opts.userId,
        amount: opts.amount,
        currency: opts.currency,
        gateway: 'stripe',
        gateway_reference: stripeRef,
        status: 'pending',
        collection_mode: opts.collectionMode || 'platform',
        fee_bearer: opts.feeBearerMode || 'platform',
        payout_account_id: opts.payoutAccountId || null,
        waaiio_fee: opts.waaiioFee ?? 0,
        metadata: {
          stripe_session_id: stripeRef,
          reference_code: opts.referenceCode,
          channel: 'whatsapp',
          order_id: opts.orderId || null,
        },
      }).select().single();

      if (payment && opts.bookingId) {
        await opts.supabase.from('bookings').update({ payment_id: payment.id }).eq('id', opts.bookingId);
      }
      if (payment && opts.invoiceId) {
        await opts.supabase.from('invoices').update({ payment_id: payment.id }).eq('id', opts.invoiceId);
      }

      return { url: sessionData.url as string, reference: stripeRef };
    } catch (error) {
      const e = error as Error;
      logger.error('Stripe init error:', e.message, e.stack?.split('\n').slice(0, 3).join(' '));
      return null;
    }
  }

  async verifyPayment(supabase: SupabaseClient, reference: string): Promise<boolean> {
    if (!getStripeKey() || reference.startsWith('mock_')) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Payment gateway not configured: missing Stripe secret key');
      }
      await supabase
        .from('payments')
        .update({ status: 'success', paid_at: new Date().toISOString() })
        .eq('gateway_reference', reference);

      const { data: payment } = await supabase
        .from('payments')
        .select('booking_id')
        .eq('gateway_reference', reference)
        .single();

      if (payment?.booking_id) {
        await supabase
          .from('bookings')
          .update({ deposit_status: 'paid', status: 'confirmed', confirmed_at: new Date().toISOString() })
          .eq('id', payment.booking_id);
      }
      return true;
    }

    try {
      const session = await stripeGet(`/checkout/sessions/${encodeURIComponent(reference)}`);

      if (session.payment_status === 'paid') {
        const { data: payment } = await supabase
          .from('payments')
          .select('id, booking_id, amount')
          .eq('gateway_reference', reference)
          .single();

        if (payment) {
          await supabase
            .from('payments')
            .update({
              status: 'success',
              gateway_status: 'paid',
              payment_method: 'card',
              paid_at: new Date().toISOString(),
            })
            .eq('id', payment.id);

          if (payment.booking_id) {
            await supabase
              .from('bookings')
              .update({ deposit_status: 'paid', status: 'confirmed', confirmed_at: new Date().toISOString() })
              .eq('id', payment.booking_id);
          }
        }
        return true;
      }
      return false;
    } catch (error) {
      logger.error('Stripe verify error:', (error as Error).message);
      return false;
    }
  }

  async refundPayment(opts: RefundPaymentOpts): Promise<RefundResult> {
    // Mock mode
    if (!getStripeKey() || opts.gatewayReference.startsWith('mock_')) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Payment gateway not configured: missing Stripe secret key');
      }
      return {
        success: true,
        outcome: 'succeeded',
        gatewayRefundReference: `mock_refund_stripe_${Date.now()}`,
        gatewayResponse: { mock: true },
      };
    }

    try {
      // If reference starts with cs_, it's a checkout session — resolve to payment_intent first
      let paymentIntent = opts.gatewayReference;
      if (opts.gatewayReference.startsWith('cs_')) {
        const session = await stripeGet(`/checkout/sessions/${encodeURIComponent(opts.gatewayReference)}`);
        paymentIntent = session.payment_intent as string;
        if (!paymentIntent) {
          return { success: false, outcome: 'definitively_failed', errorMessage: 'Could not resolve checkout session to payment intent' };
        }
      }

      const refundParams: Record<string, string> = {
        payment_intent: paymentIntent,
      };
      if (opts.amount != null) {
        refundParams.amount = String(Math.round(opts.amount * 100)); // convert to cents
      }
      if (opts.reason) {
        refundParams.reason = 'requested_by_customer';
      }

      // For Connect destination charges, reverse the transfer and refund application fee
      const collectionMode = opts.metadata?.collection_mode as string | undefined;
      if (collectionMode === 'managed_split' || collectionMode === 'connect') {
        refundParams.reverse_transfer = 'true';
        refundParams.refund_application_fee = 'true';
      }

      // Build request with idempotency key
      const headers: Record<string, string> = {
        Authorization: `Bearer ${getStripeKey()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      };
      if (opts.providerIdempotencyKey) {
        headers['Idempotency-Key'] = opts.providerIdempotencyKey;
      }

      const response = await fetch('https://api.stripe.com/v1/refunds', {
        method: 'POST',
        headers,
        body: new URLSearchParams(refundParams).toString(),
        signal: AbortSignal.timeout(15000),
      });
      const data = await response.json() as Record<string, unknown>;

      if (data.id) {
        return {
          success: true,
          outcome: 'succeeded',
          gatewayRefundReference: data.id as string,
          gatewayResponse: data,
        };
      }

      const error = data.error as Record<string, unknown> | undefined;
      const errCode = error?.code as string | undefined;
      const definitiveErrors = ['charge_already_refunded', 'amount_too_large', 'refund_not_allowed', 'invalid_charge', 'charge_not_found'];
      const isDefinitive = errCode && definitiveErrors.includes(errCode);
      return {
        success: false,
        outcome: isDefinitive ? 'definitively_failed' : 'ambiguous',
        errorMessage: (error?.message as string) || 'Stripe refund failed',
        gatewayResponse: data,
      };
    } catch (error) {
      return {
        success: false,
        outcome: 'ambiguous',
        errorMessage: `Stripe refund error: ${(error as Error).message}`,
      };
    }
  }
}
