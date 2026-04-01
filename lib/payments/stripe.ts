import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import type { PaymentGateway, InitPaymentOpts, InitPaymentResult } from './types';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';

async function stripeRequest(path: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
  });
  return response.json() as Promise<Record<string, unknown>>;
}

async function stripeGet(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${stripeSecretKey}` },
  });
  return response.json() as Promise<Record<string, unknown>>;
}

export class StripeGateway implements PaymentGateway {
  name = 'stripe' as const;

  async initializePayment(opts: InitPaymentOpts): Promise<InitPaymentResult | null> {
    const idempotencyKey = randomUUID();

    try {
      if (!stripeSecretKey) {
        const mockRef = `mock_stripe_${idempotencyKey}`;
        await opts.supabase.from('payments').insert({
          booking_id: opts.bookingId || null,
          user_id: opts.userId,
          amount: opts.amount,
          currency: opts.currency,
          gateway: 'stripe',
          gateway_reference: mockRef,
          status: 'pending',
          metadata: { reference_code: opts.referenceCode, channel: 'whatsapp', order_id: opts.orderId || null },
        });
        return { url: `https://blowded.com/pay?ref=${mockRef}`, reference: mockRef };
      }

      // Convert amount to cents (Stripe uses smallest currency unit)
      const amountInCents = Math.round(opts.amount * 100);
      const callbackUrl = opts.callbackUrl || process.env.NEXT_PUBLIC_APP_URL || 'https://blowded.com';

      const sessionData = await stripeRequest('/checkout/sessions', {
        'payment_method_types[0]': 'card',
        'line_items[0][price_data][currency]': opts.currency.toLowerCase(),
        'line_items[0][price_data][product_data][name]': `${opts.businessName} - ${opts.referenceCode}`,
        'line_items[0][price_data][unit_amount]': String(amountInCents),
        'line_items[0][quantity]': '1',
        mode: 'payment',
        success_url: `${callbackUrl}/api/payments/stripe-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${callbackUrl}`,
        'metadata[booking_id]': opts.bookingId || '',
        'metadata[order_id]': opts.orderId || '',
        'metadata[user_id]': opts.userId,
        'metadata[reference_code]': opts.referenceCode,
        'metadata[channel]': 'whatsapp',
        customer_email: opts.userEmail || '',
      });

      if (!sessionData.id || !sessionData.url) {
        console.error('Stripe session creation failed', sessionData);
        return null;
      }

      const stripeRef = sessionData.id as string;

      const { data: payment } = await opts.supabase.from('payments').insert({
        booking_id: opts.bookingId || null,
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

      if (payment && opts.bookingId) {
        await opts.supabase.from('bookings').update({ payment_id: payment.id }).eq('id', opts.bookingId);
      }

      return { url: sessionData.url as string, reference: stripeRef };
    } catch (error) {
      console.error('Stripe init error:', (error as Error).message);
      return null;
    }
  }

  async verifyPayment(supabase: SupabaseClient, reference: string): Promise<boolean> {
    if (!stripeSecretKey || reference.startsWith('mock_')) {
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
      console.error('Stripe verify error:', (error as Error).message);
      return false;
    }
  }
}
