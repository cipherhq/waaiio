import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import type { PaymentGateway, InitPaymentOpts, InitPaymentResult, RefundPaymentOpts, RefundResult } from './types';
import { logger } from '@/lib/logger';
import { observeProvider } from '@/lib/observability';
import { normalizeError, safeLogErrorContext } from '@/lib/errors';
import { safeProviderError } from '@/lib/redact';

function getStripeKey(): string {
  return process.env.STRIPE_SECRET_KEY || '';
}

async function stripeRequest(path: string, body: Record<string, string>, idempotencyKey?: string): Promise<Record<string, unknown>> {
  const key = getStripeKey();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST',
    headers,
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
    // Stable idempotency key derived from the authoritative referenceCode.
    // Same logical payment retry → same Stripe key. Different payment → different key.
    const idempotencyKey = `checkout_${opts.referenceCode}`;

    try {
      const stripeSecretKey = getStripeKey();
      if (!stripeSecretKey) {
        if (process.env.NODE_ENV === 'production') {
          throw new Error('Payment gateway not configured: missing Stripe secret key');
        }
        const mockRef = `mock_stripe_${opts.referenceCode}`;
        await opts.supabase.from('payments').insert({
          booking_id: opts.bookingId || null,
          invoice_id: opts.invoiceId || null,
          campaign_id: opts.campaignId || null,
          reservation_id: opts.reservationId || null,
          order_id: opts.orderId || null,
          business_id: opts.businessId || null,
          user_id: opts.userId,
          amount: opts.amount,
          currency: opts.currency,
          gateway: 'stripe',
          gateway_reference: mockRef,
          status: 'pending',
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

      const sessionData = await observeProvider({
        gateway: 'stripe',
        amount: opts.amount, currency: opts.currency,
        businessId: opts.businessId,
      }, () => stripeRequest('/checkout/sessions', sessionParams, idempotencyKey));

      if (!sessionData.id || !sessionData.url) {
        // Store detailed error for debug endpoint
        (globalThis as Record<string, unknown>).__stripeDebug = {
          keyPresent: !!stripeSecretKey,
          currency: sessionParams['line_items[0][price_data][currency]'],
          amount: sessionParams['line_items[0][price_data][unit_amount]'],
        };
        logger.error('Stripe session creation failed:', safeProviderError(sessionData));
        return null;
      }

      const stripeRef = sessionData.id as string;

      // Insert payment record — if gateway_reference already exists (idempotent retry),
      // the UNIQUE constraint prevents a duplicate; look up the existing row instead.
      let { data: payment } = await opts.supabase.from('payments').insert({
        booking_id: opts.bookingId || null,
        invoice_id: opts.invoiceId || null,
        campaign_id: opts.campaignId || null,
        reservation_id: opts.reservationId || null,
        order_id: opts.orderId || null,
        business_id: opts.businessId || null,
        user_id: opts.userId,
        amount: opts.amount,
        currency: opts.currency,
        gateway: 'stripe',
        gateway_reference: stripeRef,
        status: 'pending',
        metadata: {
          stripe_session_id: stripeRef,
          reference_code: opts.referenceCode,
          channel: 'whatsapp',
          order_id: opts.orderId || null,
        },
      }).select().single();

      if (!payment) {
        // Likely UNIQUE constraint on gateway_reference — reuse existing payment
        const { data: existing } = await opts.supabase
          .from('payments')
          .select()
          .eq('gateway_reference', stripeRef)
          .single();
        payment = existing;
      }

      if (payment && opts.bookingId) {
        await opts.supabase.from('bookings').update({ payment_id: payment.id }).eq('id', opts.bookingId);
      }
      if (payment && opts.invoiceId) {
        await opts.supabase.from('invoices').update({ payment_id: payment.id }).eq('id', opts.invoiceId);
      }

      return { url: sessionData.url as string, reference: stripeRef };
    } catch (error) {
      logger.withContext({ op: 'stripe.init', ...safeLogErrorContext(error) }).error('Stripe init error');
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
      const session = await observeProvider({
        gateway: 'stripe', providerRef: reference,
      }, () => stripeGet(`/checkout/sessions/${encodeURIComponent(reference)}`));

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
      logger.withContext({ op: 'stripe.verify', ...safeLogErrorContext(error) }).error('Stripe verify error');
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
        outcome: 'terminal_success' as const,
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
          return { success: false, outcome: 'terminal_failure' as const, errorMessage: 'Could not resolve checkout session to payment intent' };
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

      const refundIdempotencyKey = opts.idempotencyKey || `refund_${opts.gatewayReference}_${opts.amount ?? 'full'}`;
      const data = await stripeRequest('/refunds', refundParams, refundIdempotencyKey);

      if (data.id) {
        // Stripe Refund lifecycle: pending, requires_action, succeeded, failed, canceled
        const providerStatus = (data.status as string) || 'unknown';
        const outcome = providerStatus === 'succeeded' ? 'terminal_success' as const
          : (providerStatus === 'failed' || providerStatus === 'canceled') ? 'terminal_failure' as const
          : 'provider_pending' as const; // pending, requires_action, or unknown
        return {
          success: outcome === 'terminal_success',
          outcome,
          providerRefundId: data.id as string,
          providerStatus,
          gatewayRefundReference: data.id as string,
          gatewayResponse: data,
        };
      }

      // No refund ID — check if this is an explicit API error or unknown
      const error = data.error as Record<string, unknown> | undefined;
      if (error?.type || error?.code) {
        // Explicit Stripe error = terminal failure
        return {
          success: false,
          outcome: 'terminal_failure' as const,
          errorMessage: (error?.message as string) || 'Stripe refund failed',
          gatewayResponse: data,
        };
      }
      // No ID and no explicit error = transport_unknown (conservative)
      return {
        success: false,
        outcome: 'transport_unknown' as const,
        errorMessage: 'Stripe refund: unexpected response shape',
        gatewayResponse: data,
      };
    } catch (error) {
      return {
        success: false,
        outcome: 'transport_unknown' as const,
        errorMessage: `Stripe refund error: ${normalizeError(error).message}`,
      };
    }
  }

  async queryRefundStatus(refundReference: string): Promise<import('./types').RefundStatusResult> {
    const data = await stripeRequest(`/refunds/${encodeURIComponent(refundReference)}`, {}, undefined);
    const status = (data.status as string) || 'unknown';
    return {
      providerStatus: status,
      outcome: status === 'succeeded' ? 'terminal_success'
        : (status === 'failed' || status === 'canceled') ? 'terminal_failure'
        : 'provider_pending',
      providerRefundId: data.id as string,
    };
  }
}
