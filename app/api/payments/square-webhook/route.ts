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

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  let eventId: string | null = null;
  try {
    const rawBody = await request.text();
    const signature = request.headers.get('x-square-hmacsha256-signature') || '';

    // Fail-closed: reject if webhook secret is not configured
    if (!squareWebhookSignatureKey) {
      return NextResponse.json({ message: 'Webhook not configured' }, { status: 500 });
    }
    if (!verifySquareSignature(rawBody, signature)) {
      return NextResponse.json({ message: 'Invalid signature' }, { status: 400 });
    }

    const body = JSON.parse(rawBody);
    const eventType = body.type as string;
    const data = body.data?.object as Record<string, unknown>;

    if (!data) {
      return NextResponse.json({ received: true });
    }

    const supabase = createServiceClient();

    // Idempotency: check if already processed (mark AFTER processing succeeds)
    eventId = (body.event_id as string) || null;
    if (eventId) {
      const { data: existingEvent } = await supabase
        .from('processed_webhook_events')
        .select('id')
        .eq('event_id', eventId)
        .maybeSingle();

      if (existingEvent) {
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
        .select('id, booking_id, invoice_id, campaign_id, reservation_id, order_id, amount, status, metadata')
        .eq('gateway', 'square')
        .neq('status', 'success');

      const matchedPayment = payments?.find(p => {
        const meta = p.metadata as Record<string, string> | null;
        return meta?.square_order_id === orderId;
      });

      if (!matchedPayment) return NextResponse.json({ received: true });

      if (paymentStatus === 'COMPLETED' && matchedPayment.status !== 'success') {
        // Verify amount matches (Square amount is in cents)
        const totalMoney = payment.total_money as { amount?: number } | undefined;
        const squareAmountCents = (totalMoney?.amount as number) || 0;
        const expectedCents = Math.round(matchedPayment.amount * 100);
        if (squareAmountCents > 0 && Math.abs(squareAmountCents - expectedCents) > 1) {
          console.error(`[SQUARE-WEBHOOK] Amount mismatch: Square=${squareAmountCents}, expected=${expectedCents} for payment ${matchedPayment.id}`);
          await supabase.from('payments').update({ status: 'failed', gateway_status: 'amount_mismatch' }).eq('id', matchedPayment.id);
          return NextResponse.json({ received: true, error: 'amount_mismatch' });
        }

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

        // Extract Square processing fee from webhook payload
        let squareGatewayFee = 0;
        try {
          const processingFee = (payment.processing_fee as Array<{ amount_money?: { amount?: number } }>) || [];
          const totalFeeCents = processingFee.reduce((sum: number, f) => sum + (f.amount_money?.amount || 0), 0);
          // Square fees are in cents — convert to dollars
          squareGatewayFee = Math.round(totalFeeCents) / 100;
        } catch {
          logger.warn('[SQUARE WEBHOOK] Failed to extract processing fee');
        }

        // Confirm booking, record platform fees
        await processSuccessfulPayment(supabase, {
          id: matchedPayment.id,
          amount: matchedPayment.amount,
          booking_id: matchedPayment.booking_id,
          invoice_id: matchedPayment.invoice_id || null,
          campaign_id: matchedPayment.campaign_id || null,
          reservation_id: matchedPayment.reservation_id || null,
          order_id: matchedPayment.order_id || null,
          gateway_fee: squareGatewayFee,
        });

        // Proactive confirmation: send WhatsApp message + post-completion
        try {
          await sendProactiveConfirmation(supabase, {
            id: matchedPayment.id,
            amount: matchedPayment.amount,
            booking_id: matchedPayment.booking_id,
            invoice_id: matchedPayment.invoice_id || null,
            campaign_id: matchedPayment.campaign_id || null,
            reservation_id: matchedPayment.reservation_id || null,
            order_id: matchedPayment.order_id || null,
          }, '[SQUARE WEBHOOK]');
        } catch (confirmErr) {
          logger.error('[SQUARE WEBHOOK] Proactive confirmation error:', confirmErr);
        }
      } else if (paymentStatus === 'FAILED') {
        await supabase
          .from('payments')
          .update({ status: 'failed', gateway_status: 'failed' })
          .eq('id', matchedPayment.id);
      }
    }

    // Mark event as processed AFTER all financial writes succeeded
    if (eventId) {
      await supabase
        .from('processed_webhook_events')
        .upsert(
          { event_id: eventId, gateway: 'square', event_type: `square_${eventType}`, processed_at: new Date().toISOString() },
          { onConflict: 'event_id', ignoreDuplicates: true },
        );
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    Sentry.captureException(error);

    // Mark event as failed so Square retries
    if (eventId) {
      try {
        const supabase = createServiceClient();
        await supabase.from('processed_webhook_events')
          .update({
            status: 'failed',
            last_error: String(error).slice(0, 500),
            last_attempted_at: new Date().toISOString(),
          })
          .eq('event_id', eventId);
      } catch {
        // Best-effort — don't mask the original error
      }
    }

    // Return 500 so Square retries
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
  }
}

