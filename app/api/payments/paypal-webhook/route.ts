import { NextResponse, type NextRequest } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import * as Sentry from '@sentry/nextjs';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';
import { createAlert } from '@/lib/alerts/create-alert';
import { processSuccessfulPayment } from '@/lib/payments/process-success';
import { sendProactiveConfirmation } from '@/lib/payments/send-confirmation';

export const maxDuration = 60;

const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID || '';
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const PAYPAL_ENVIRONMENT = process.env.PAYPAL_ENVIRONMENT || 'sandbox';

function getPayPalBaseUrl(): string {
  return PAYPAL_ENVIRONMENT === 'production'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

/**
 * Verify PayPal webhook signature using PayPal's verification API.
 * PayPal uses a complex CRC32 + certificate chain — easier to use their endpoint.
 */
async function verifyPayPalWebhook(
  headers: Headers,
  rawBody: string,
): Promise<boolean> {
  if (!PAYPAL_WEBHOOK_ID || !PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) return false;

  try {
    // Get access token
    const tokenRes = await fetch(`${getPayPalBaseUrl()}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(10000),
    });
    const tokenData = await tokenRes.json() as { access_token?: string };
    if (!tokenData.access_token) return false;

    // Call PayPal's webhook verification endpoint
    const verifyRes = await fetch(`${getPayPalBaseUrl()}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        auth_algo: headers.get('paypal-auth-algo') || '',
        cert_url: headers.get('paypal-cert-url') || '',
        transmission_id: headers.get('paypal-transmission-id') || '',
        transmission_sig: headers.get('paypal-transmission-sig') || '',
        transmission_time: headers.get('paypal-transmission-time') || '',
        webhook_id: PAYPAL_WEBHOOK_ID,
        webhook_event: JSON.parse(rawBody),
      }),
      signal: AbortSignal.timeout(10000),
    });

    const verifyData = await verifyRes.json() as { verification_status?: string };
    return verifyData.verification_status === 'SUCCESS';
  } catch (err) {
    logger.error('[PAYPAL WEBHOOK] Signature verification error:', err);
    return false;
  }
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();

    // Fail-closed: reject if webhook is not configured
    if (!PAYPAL_WEBHOOK_ID || !PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
      logger.error('[PAYPAL WEBHOOK] PayPal credentials not configured — rejecting');
      return NextResponse.json({ message: 'Webhook not configured' }, { status: 500 });
    }

    const isValid = await verifyPayPalWebhook(request.headers, rawBody);
    if (!isValid) {
      logger.warn('[PAYPAL WEBHOOK] Invalid signature — rejecting');
      return NextResponse.json({ message: 'Invalid signature' }, { status: 401 });
    }

    const body = JSON.parse(rawBody);
    const eventType = body.event_type as string;
    const resource = body.resource as Record<string, unknown> | undefined;

    if (!resource) {
      return NextResponse.json({ received: true });
    }

    const supabase = createServiceClient();

    // Idempotency: atomic dedup
    const eventId = body.id as string | undefined;
    if (eventId) {
      const { data: inserted } = await supabase
        .from('processed_webhook_events')
        .upsert(
          { event_id: `paypal-${eventId}`, gateway: 'paypal', event_type: `paypal_${eventType}`, processed_at: new Date().toISOString() },
          { onConflict: 'event_id', ignoreDuplicates: true },
        )
        .select('id');

      if (!inserted || inserted.length === 0) {
        return NextResponse.json({ received: true, duplicate: true });
      }
    }

    // CHECKOUT.ORDER.APPROVED — customer approved, need to capture
    if (eventType === 'CHECKOUT.ORDER.APPROVED') {
      const orderId = resource.id as string;
      if (!orderId) return NextResponse.json({ received: true });

      // Capture the payment
      try {
        const tokenRes = await fetch(`${getPayPalBaseUrl()}/v1/oauth2/token`, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: 'grant_type=client_credentials',
          signal: AbortSignal.timeout(10000),
        });
        const tokenData = await tokenRes.json() as { access_token?: string };
        if (tokenData.access_token) {
          await fetch(`${getPayPalBaseUrl()}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${tokenData.access_token}`,
              'Content-Type': 'application/json',
            },
            body: '{}',
            signal: AbortSignal.timeout(15000),
          });
        }
      } catch (captureErr) {
        logger.error('[PAYPAL WEBHOOK] Auto-capture failed:', captureErr);
      }
    }

    // PAYMENT.CAPTURE.COMPLETED — payment fully captured (success)
    if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
      const captureAmount = resource.amount as { value?: string; currency_code?: string } | undefined;
      const webhookAmount = captureAmount?.value ? parseFloat(captureAmount.value) : 0;

      // The supplementary_data contains the order ID that links to our payment record
      const supplementaryData = resource.supplementary_data as Record<string, unknown> | undefined;
      const relatedIds = supplementaryData?.related_ids as Record<string, string> | undefined;
      const orderId = relatedIds?.order_id || '';

      // Also check custom_id fallback
      const purchaseUnits = (resource as Record<string, unknown>).purchase_units as Array<{ reference_id?: string }> | undefined;
      const referenceId = purchaseUnits?.[0]?.reference_id;

      // Find payment by PayPal order ID
      let payment: { id: string; booking_id: string | null; order_id: string | null; amount: number; status: string } | null = null;

      if (orderId) {
        const { data } = await supabase
          .from('payments')
          .select('id, booking_id, order_id, amount, status')
          .eq('gateway_reference', orderId)
          .eq('gateway', 'paypal')
          .maybeSingle();
        payment = data;
      }

      // Fallback: search by metadata paypal_order_id
      if (!payment && orderId) {
        const { data: payments } = await supabase
          .from('payments')
          .select('id, booking_id, order_id, amount, status, metadata')
          .eq('gateway', 'paypal')
          .neq('status', 'success');

        payment = payments?.find(p => {
          const meta = p.metadata as Record<string, string> | null;
          return meta?.paypal_order_id === orderId;
        }) || null;
      }

      if (!payment || payment.status === 'success') {
        return NextResponse.json({ received: true });
      }

      // Verify amount matches (allow small rounding tolerance)
      if (Math.abs(webhookAmount - payment.amount) > 0.02) {
        logger.warn(`[PAYPAL WEBHOOK] Amount mismatch: expected ${payment.amount}, got ${webhookAmount}`);
        await supabase
          .from('payments')
          .update({ status: 'failed', gateway_status: 'amount_mismatch' })
          .eq('id', payment.id);
        return NextResponse.json({ received: true });
      }

      // Update payment status
      await supabase
        .from('payments')
        .update({
          status: 'success',
          gateway_status: 'completed',
          payment_method: 'paypal',
          paid_at: new Date().toISOString(),
        })
        .eq('id', payment.id);

      // Fetch invoice_id, campaign_id, reservation_id (not on the initial select)
      const { data: fullPayment } = await supabase
        .from('payments')
        .select('invoice_id, campaign_id, reservation_id')
        .eq('id', payment.id)
        .single();

      // TODO: PayPal processing fees require the Transactions API to retrieve exact fee.
      const paymentForShared = {
        id: payment.id,
        amount: payment.amount,
        booking_id: payment.booking_id,
        invoice_id: fullPayment?.invoice_id || null,
        campaign_id: fullPayment?.campaign_id || null,
        reservation_id: fullPayment?.reservation_id || null,
        order_id: payment.order_id || null,
        gateway_fee: 0,
      };

      // Confirm booking, record platform fees, process invoice/campaign
      await processSuccessfulPayment(supabase, paymentForShared);

      // Proactive confirmation: send WhatsApp message + post-completion
      try {
        await sendProactiveConfirmation(supabase, paymentForShared, '[PAYPAL WEBHOOK]');
      } catch (confirmErr) {
        logger.error('[PAYPAL WEBHOOK] Proactive confirmation error:', confirmErr);
      }
    }

    // PAYMENT.CAPTURE.DENIED — payment failed
    if (eventType === 'PAYMENT.CAPTURE.DENIED' || eventType === 'PAYMENT.CAPTURE.DECLINED') {
      const supplementaryData = resource.supplementary_data as Record<string, unknown> | undefined;
      const relatedIds = supplementaryData?.related_ids as Record<string, string> | undefined;
      const orderId = relatedIds?.order_id || '';

      if (orderId) {
        const { data: failedPayment } = await supabase
          .from('payments')
          .select('id, amount, business_id')
          .eq('gateway_reference', orderId)
          .eq('gateway', 'paypal')
          .neq('status', 'success')
          .maybeSingle();

        if (failedPayment) {
          await supabase
            .from('payments')
            .update({ status: 'failed', gateway_status: 'denied' })
            .eq('id', failedPayment.id);

          if (failedPayment.business_id) {
            await createAlert(supabase, {
              businessId: failedPayment.business_id,
              type: 'payment_failed',
              severity: 'warning',
              title: 'Payment Failed',
              message: `A PayPal payment of ${failedPayment.amount} was denied.`,
              metadata: { paymentId: failedPayment.id, amount: failedPayment.amount, gateway: 'paypal' },
            });
          }
        }
      }
    }

    // PAYMENT.CAPTURE.REFUNDED — refund processed
    if (eventType === 'PAYMENT.CAPTURE.REFUNDED') {
      logger.info('[PAYPAL WEBHOOK] Refund processed:', resource.id);
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    logger.error('[PAYPAL WEBHOOK] Error:', (error as Error).message);
    Sentry.captureException(error);
    return NextResponse.json({ received: true }, { status: 200 });
  }
}

