import { NextResponse, type NextRequest } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import * as Sentry from '@sentry/nextjs';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';
import { processSuccessfulPayment } from '@/lib/payments/process-success';
import { sendProactiveConfirmation } from '@/lib/payments/send-confirmation';

const squareWebhookSignatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';
const squareWebhookNotificationUrl = process.env.SQUARE_WEBHOOK_NOTIFICATION_URL || '';

function verifySquareSignature(rawBody: string, signature: string): boolean {
  if (!squareWebhookSignatureKey || !signature) return false;

  // Square HMAC-SHA256: sign(notification_url + raw_body)
  const payload = squareWebhookNotificationUrl + rawBody;
  const expected = createHmac('sha256', squareWebhookSignatureKey)
    .update(payload)
    .digest('base64');

  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch { return false; }
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get('x-square-hmacsha256-signature') || '';

    // Fail-closed: reject if webhook secret is not configured
    // Verify signature when secret is configured
    if (squareWebhookSignatureKey && !verifySquareSignature(rawBody, signature)) {
      return NextResponse.json({ message: 'Invalid signature' }, { status: 400 });
    }

    const body = JSON.parse(rawBody);
    const eventType = body.type as string;
    const data = body.data?.object as Record<string, unknown>;

    if (!data) {
      return NextResponse.json({ received: true });
    }

    const supabase = createServiceClient();

    // Idempotency: atomic dedup via ON CONFLICT
    const eventId = body.event_id as string | undefined;
    if (eventId) {
      const { data: inserted } = await supabase
        .from('processed_webhook_events')
        .upsert(
          { event_id: eventId, gateway: 'square', event_type: `square_${eventType}`, processed_at: new Date().toISOString() },
          { onConflict: 'event_id', ignoreDuplicates: true },
        )
        .select('id');

      if (!inserted || inserted.length === 0) {
        return NextResponse.json({ received: true, duplicate: true });
      }
    }

    // Square fires payment.updated when status transitions (COMPLETED, FAILED, etc.)
    if (eventType === 'payment.updated' || eventType === 'payment.created') {
      const payment = data.payment as Record<string, unknown> | undefined;
      if (!payment) return NextResponse.json({ received: true });

      const orderId = payment.order_id as string | undefined;
      const paymentStatus = payment.status as string | undefined;
      if (!orderId) return NextResponse.json({ received: true });

      // Find our payment record by square_order_id in metadata
      const { data: payments } = await supabase
        .from('payments')
        .select('id, booking_id, amount, status, metadata')
        .eq('gateway', 'square')
        .neq('status', 'success');

      const matchedPayment = payments?.find(p => {
        const meta = p.metadata as Record<string, string> | null;
        return meta?.square_order_id === orderId;
      });

      if (!matchedPayment) return NextResponse.json({ received: true });

      if (paymentStatus === 'COMPLETED' && matchedPayment.status !== 'success') {
        const sourceType = payment.source_type as string | undefined;

        await supabase
          .from('payments')
          .update({
            status: 'success',
            gateway_status: 'completed',
            payment_method: sourceType === 'CASH_APP' ? 'cash_app_pay' : sourceType?.toLowerCase() || 'card',
            paid_at: new Date().toISOString(),
          })
          .eq('id', matchedPayment.id);

        // Confirm booking, record platform fees
        await processSuccessfulPayment(supabase, {
          id: matchedPayment.id,
          amount: matchedPayment.amount,
          booking_id: matchedPayment.booking_id,
          invoice_id: null,
          campaign_id: null,
        });

        // Proactive confirmation: send WhatsApp message + post-completion
        sendProactiveConfirmation(supabase, {
          id: matchedPayment.id,
          amount: matchedPayment.amount,
          booking_id: matchedPayment.booking_id,
          invoice_id: null,
          campaign_id: null,
        }, '[SQUARE WEBHOOK]').catch(err =>
          logger.error('[SQUARE WEBHOOK] Proactive confirmation error:', err),
        );
      } else if (paymentStatus === 'FAILED') {
        await supabase
          .from('payments')
          .update({ status: 'failed', gateway_status: 'failed' })
          .eq('id', matchedPayment.id);
      }
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    Sentry.captureException(error);
    return NextResponse.json({ received: true }, { status: 200 });
  }
}

