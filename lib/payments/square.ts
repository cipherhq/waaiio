import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import type { PaymentGateway, InitPaymentOpts, InitPaymentResult, RefundPaymentOpts, RefundResult } from './types';
import { logger } from '@/lib/logger';

const squareAccessToken = process.env.SQUARE_ACCESS_TOKEN || '';
const squareLocationId = process.env.SQUARE_LOCATION_ID || '';
const squareEnvironment = process.env.SQUARE_ENVIRONMENT || 'sandbox';

function getSquareBaseUrl(): string {
  return squareEnvironment === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
}

async function squareRequest(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${getSquareBaseUrl()}${path}`, {
    method: 'POST',
    headers: {
      'Square-Version': '2024-12-18',
      Authorization: `Bearer ${squareAccessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return response.json() as Promise<Record<string, unknown>>;
}

async function squareGet(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${getSquareBaseUrl()}${path}`, {
    headers: {
      'Square-Version': '2024-12-18',
      Authorization: `Bearer ${squareAccessToken}`,
    },
  });
  return response.json() as Promise<Record<string, unknown>>;
}

export class SquareGateway implements PaymentGateway {
  name = 'square' as const;

  async initializePayment(opts: InitPaymentOpts): Promise<InitPaymentResult | null> {
    const idempotencyKey = randomUUID();

    try {
      if (!squareAccessToken) {
        if (process.env.NODE_ENV === 'production') {
          throw new Error('Payment gateway not configured: missing Square access token');
        }
        const mockRef = `mock_square_${idempotencyKey}`;
        await opts.supabase.from('payments').insert({
          booking_id: opts.bookingId || null,
          invoice_id: opts.invoiceId || null,
          user_id: opts.userId,
          amount: opts.amount,
          currency: opts.currency,
          gateway: 'square',
          gateway_reference: mockRef,
          status: 'pending',
          metadata: { reference_code: opts.referenceCode, channel: 'whatsapp', order_id: opts.orderId || null },
        });
        return { url: `https://waaiio.com/pay?ref=${mockRef}`, reference: mockRef };
      }

      // Square uses smallest currency unit (cents for USD)
      const amountInCents = Math.round(opts.amount * 100);
      const callbackUrl = opts.callbackUrl || process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';

      const paymentLinkBody: Record<string, unknown> = {
        idempotency_key: idempotencyKey,
        quick_pay: {
          name: `${opts.businessName} - ${opts.referenceCode}`,
          price_money: {
            amount: amountInCents,
            currency: opts.currency.toUpperCase(),
          },
          location_id: squareLocationId,
        },
        checkout_options: {
          redirect_url: `${callbackUrl}/api/payments/square-callback?ref=${idempotencyKey}`,
          accepted_payment_methods: {
            cash_app_pay: true,
            apple_pay: true,
            google_pay: true,
          },
        },
        pre_populated_data: {
          buyer_email: opts.userEmail || undefined,
          buyer_phone_number: opts.phone || undefined,
        },
      };

      const result = await squareRequest('/v2/online-checkout/payment-links', paymentLinkBody);

      const paymentLink = result.payment_link as Record<string, unknown> | undefined;
      if (!paymentLink?.id || !paymentLink?.url) {
        logger.error('[SQUARE] Payment link creation failed:', JSON.stringify(result).slice(0, 500));
        return null;
      }

      const squareRef = paymentLink.id as string;
      const orderId = paymentLink.order_id as string | undefined;

      const { data: payment } = await opts.supabase.from('payments').insert({
        booking_id: opts.bookingId || null,
        invoice_id: opts.invoiceId || null,
        user_id: opts.userId,
        amount: opts.amount,
        currency: opts.currency,
        gateway: 'square',
        gateway_reference: squareRef,
        status: 'pending',
        metadata: {
          square_payment_link_id: squareRef,
          square_order_id: orderId || null,
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

      return { url: paymentLink.url as string, reference: squareRef };
    } catch (error) {
      logger.error('[SQUARE] init error:', (error as Error).message);
      return null;
    }
  }

  async verifyPayment(supabase: SupabaseClient, reference: string): Promise<boolean> {
    if (!squareAccessToken || reference.startsWith('mock_')) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Payment gateway not configured: missing Square access token');
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
      // Look up the order ID from the payment metadata
      const { data: paymentRecord } = await supabase
        .from('payments')
        .select('id, booking_id, amount, metadata')
        .eq('gateway_reference', reference)
        .single();

      if (!paymentRecord) return false;

      const metadata = paymentRecord.metadata as Record<string, string> | null;
      const squareOrderId = metadata?.square_order_id;

      if (!squareOrderId) return false;

      const orderResult = await squareGet(`/v2/orders/${encodeURIComponent(squareOrderId)}`);
      const order = orderResult.order as Record<string, unknown> | undefined;

      if (order?.state === 'COMPLETED') {
        await supabase
          .from('payments')
          .update({
            status: 'success',
            gateway_status: 'completed',
            payment_method: 'cash_app_pay',
            paid_at: new Date().toISOString(),
          })
          .eq('id', paymentRecord.id);

        if (paymentRecord.booking_id) {
          await supabase
            .from('bookings')
            .update({ deposit_status: 'paid', status: 'confirmed', confirmed_at: new Date().toISOString() })
            .eq('id', paymentRecord.booking_id);
        }
        return true;
      }
      return false;
    } catch (error) {
      logger.error('Square verify error:', (error as Error).message);
      return false;
    }
  }

  async refundPayment(_opts: RefundPaymentOpts): Promise<RefundResult> {
    return {
      success: false,
      errorMessage: 'Square refunds not yet supported',
    };
  }
}
