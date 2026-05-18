import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import type { PaymentGateway, InitPaymentOpts, InitPaymentResult, RefundPaymentOpts, RefundResult } from './types';
import { logger } from '@/lib/logger';

const paypalClientId = process.env.PAYPAL_CLIENT_ID || '';
const paypalClientSecret = process.env.PAYPAL_CLIENT_SECRET || '';
const paypalEnvironment = process.env.PAYPAL_ENVIRONMENT || 'sandbox';

function getPayPalBaseUrl(): string {
  return paypalEnvironment === 'production'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  // Reuse token if not expired (with 60s buffer)
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  const response = await fetch(`${getPayPalBaseUrl()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${paypalClientId}:${paypalClientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15000),
  });

  const data = await response.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error('Failed to get PayPal access token');
  }

  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };

  return cachedToken.token;
}

async function paypalRequest(path: string, body: Record<string, unknown>, method = 'POST'): Promise<Record<string, unknown>> {
  const token = await getAccessToken();
  const response = await fetch(`${getPayPalBaseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': randomUUID(),
    },
    ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  return response.json() as Promise<Record<string, unknown>>;
}

async function paypalGet(path: string): Promise<Record<string, unknown>> {
  const token = await getAccessToken();
  const response = await fetch(`${getPayPalBaseUrl()}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  return response.json() as Promise<Record<string, unknown>>;
}

export class PayPalGateway implements PaymentGateway {
  name = 'paypal' as const;

  async initializePayment(opts: InitPaymentOpts): Promise<InitPaymentResult | null> {
    try {
      if (!paypalClientId || !paypalClientSecret) {
        if (process.env.NODE_ENV === 'production') {
          throw new Error('Payment gateway not configured: missing PayPal credentials');
        }
        const mockRef = `mock_paypal_${randomUUID()}`;
        await opts.supabase.from('payments').insert({
          booking_id: opts.bookingId || null,
          invoice_id: opts.invoiceId || null,
          campaign_id: opts.campaignId || null,
          user_id: opts.userId,
          amount: opts.amount,
          currency: opts.currency,
          gateway: 'paypal',
          gateway_reference: mockRef,
          status: 'pending',
          metadata: { reference_code: opts.referenceCode, channel: 'whatsapp', order_id: opts.orderId || null },
        });
        return { url: `${process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com'}/pay?ref=${mockRef}`, reference: mockRef };
      }

      const callbackUrl = opts.callbackUrl || process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';

      // Build PayPal order with platform fee via payment_instruction
      const orderBody: Record<string, unknown> = {
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: opts.referenceCode,
          description: `${opts.businessName} - ${opts.referenceCode}`,
          amount: {
            currency_code: opts.currency.toUpperCase(),
            value: opts.amount.toFixed(2),
          },
          // PayPal Commerce Platform split: payee is merchant, platform_fees go to platform
          ...(opts.platformFeeAmount != null && opts.platformFeeAmount > 0 ? {
            payment_instruction: {
              disbursement_mode: 'INSTANT',
              platform_fees: [{
                amount: {
                  currency_code: opts.currency.toUpperCase(),
                  value: opts.platformFeeAmount.toFixed(2),
                },
              }],
            },
          } : {}),
        }],
        payment_source: {
          paypal: {
            experience_context: {
              payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
              brand_name: 'Waaiio',
              locale: 'en-US',
              landing_page: 'LOGIN',
              user_action: 'PAY_NOW',
              return_url: `${callbackUrl}/payment-success?ref=${opts.referenceCode}`,
              cancel_url: callbackUrl,
            },
          },
        },
      };

      let orderData: Record<string, unknown>;
      try {
        orderData = await paypalRequest('/v2/checkout/orders', orderBody);
      } catch (fetchErr) {
        logger.error('[PAYPAL] Order API fetch failed:', (fetchErr as Error).message);
        // Store debug info for troubleshooting
        (globalThis as Record<string, unknown>).__paypalDebug = {
          error: (fetchErr as Error).message,
          clientIdPresent: !!paypalClientId,
          clientIdPrefix: paypalClientId?.slice(0, 10),
          environment: paypalEnvironment,
          currency: opts.currency,
          amount: opts.amount,
        };
        return null;
      }

      if (!orderData.id || orderData.status === 'error') {
        logger.error('[PAYPAL] Order creation failed:', JSON.stringify(orderData).slice(0, 500));
        (globalThis as Record<string, unknown>).__paypalDebug = {
          response: JSON.stringify(orderData).slice(0, 500),
          currency: opts.currency,
          amount: opts.amount,
        };
        return null;
      }

      const paypalOrderId = orderData.id as string;

      // Find the approve URL from HATEOAS links
      const links = (orderData.links || []) as Array<{ rel: string; href: string }>;
      const approveLink = links.find(l => l.rel === 'payer-action')?.href
        || links.find(l => l.rel === 'approve')?.href;

      if (!approveLink) {
        logger.error('[PAYPAL] No approve link in order response:', JSON.stringify(links).slice(0, 300));
        return null;
      }

      const { data: payment } = await opts.supabase.from('payments').insert({
        booking_id: opts.bookingId || null,
        invoice_id: opts.invoiceId || null,
        campaign_id: opts.campaignId || null,
        user_id: opts.userId,
        amount: opts.amount,
        currency: opts.currency,
        gateway: 'paypal',
        gateway_reference: paypalOrderId,
        status: 'pending',
        metadata: {
          paypal_order_id: paypalOrderId,
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

      return { url: approveLink, reference: paypalOrderId };
    } catch (error) {
      const err = error as Error;
      logger.error('[PAYPAL] init error:', err.message, err.stack?.split('\n').slice(0, 3).join(' '));
      (globalThis as Record<string, unknown>).__paypalDebug = {
        error: err.message,
        stack: err.stack?.split('\n').slice(0, 5),
        clientIdPresent: !!paypalClientId,
        secretPresent: !!paypalClientSecret,
        environment: paypalEnvironment,
      };
      return null;
    }
  }

  async verifyPayment(supabase: SupabaseClient, reference: string): Promise<boolean> {
    if (!paypalClientId || !paypalClientSecret || reference.startsWith('mock_')) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Payment gateway not configured: missing PayPal credentials');
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
      const orderData = await paypalGet(`/v2/checkout/orders/${encodeURIComponent(reference)}`);

      if (orderData.status === 'COMPLETED') {
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
              gateway_status: 'completed',
              payment_method: 'paypal',
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

      // If order is APPROVED but not yet captured, capture it now
      if (orderData.status === 'APPROVED') {
        const captureData = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(reference)}/capture`, {});
        if (captureData.status === 'COMPLETED') {
          const { data: payment } = await supabase
            .from('payments')
            .select('id, booking_id')
            .eq('gateway_reference', reference)
            .single();

          if (payment) {
            await supabase
              .from('payments')
              .update({
                status: 'success',
                gateway_status: 'completed',
                payment_method: 'paypal',
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
      }

      return false;
    } catch (error) {
      logger.error('[PAYPAL] verify error:', (error as Error).message);
      return false;
    }
  }

  async refundPayment(opts: RefundPaymentOpts): Promise<RefundResult> {
    if (!paypalClientId || !paypalClientSecret || opts.gatewayReference.startsWith('mock_')) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Payment gateway not configured: missing PayPal credentials');
      }
      return {
        success: true,
        gatewayRefundReference: `mock_refund_paypal_${Date.now()}`,
        gatewayResponse: { mock: true },
      };
    }

    try {
      // Get the capture ID from the completed order
      const orderData = await paypalGet(`/v2/checkout/orders/${encodeURIComponent(opts.gatewayReference)}`);
      const purchaseUnits = (orderData.purchase_units || []) as Array<{ payments?: { captures?: Array<{ id: string }> } }>;
      const captureId = purchaseUnits[0]?.payments?.captures?.[0]?.id;

      if (!captureId) {
        return { success: false, errorMessage: 'Could not find PayPal capture ID for refund' };
      }

      const refundBody: Record<string, unknown> = {};
      if (opts.amount != null) {
        refundBody.amount = {
          value: opts.amount.toFixed(2),
          currency_code: opts.currency.toUpperCase(),
        };
      }
      if (opts.reason) {
        refundBody.note_to_payer = opts.reason.slice(0, 255);
      }

      const refundData = await paypalRequest(`/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, refundBody);

      if (refundData.id && refundData.status === 'COMPLETED') {
        return {
          success: true,
          gatewayRefundReference: refundData.id as string,
          gatewayResponse: refundData,
        };
      }

      return {
        success: false,
        errorMessage: (refundData.message as string) || 'PayPal refund failed',
        gatewayResponse: refundData,
      };
    } catch (error) {
      return {
        success: false,
        errorMessage: `PayPal refund error: ${(error as Error).message}`,
      };
    }
  }
}
