import { NextResponse, type NextRequest } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { createServiceClient } from '@/lib/supabase/service';

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
    if (!squareWebhookSignatureKey) {
      return NextResponse.json({ message: 'Webhook secret not configured' }, { status: 500 });
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

    // Idempotency: atomic dedup via ON CONFLICT
    const eventId = body.event_id as string | undefined;
    if (eventId) {
      const { data: inserted } = await supabase
        .from('processed_webhook_events')
        .upsert(
          { event_id: eventId, event_type: `square_${eventType}`, processed_at: new Date().toISOString() },
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

        if (matchedPayment.booking_id) {
          await supabase
            .from('bookings')
            .update({
              deposit_status: 'paid',
              status: 'confirmed',
              confirmed_at: new Date().toISOString(),
            })
            .eq('id', matchedPayment.booking_id);

          // Record platform fee
          const { data: booking } = await supabase
            .from('bookings')
            .select('business_id, total_amount')
            .eq('id', matchedPayment.booking_id)
            .single();

          if (booking?.business_id) {
            const { data: business } = await supabase
              .from('businesses')
              .select('subscription_tier, trial_ends_at')
              .eq('id', booking.business_id)
              .single();

            if (business) {
              const isInTrial = new Date(business.trial_ends_at) > new Date();
              const tier = business.subscription_tier || 'free';
              const feePercentage = isInTrial ? 0 : (tier === 'business' ? 1.0 : tier === 'growth' ? 1.5 : 2.5);
              const feeFlat = isInTrial ? 0 : (tier === 'business' ? 0.25 : tier === 'growth' ? 0.25 : 0.50);
              const amount = booking.total_amount || matchedPayment.amount;
              const feeTotal = isInTrial ? 0 : Math.round((amount * feePercentage / 100 + feeFlat) * 100) / 100;

              await supabase.from('platform_fees').insert({
                business_id: booking.business_id,
                booking_id: matchedPayment.booking_id,
                transaction_amount: amount,
                fee_percentage: feePercentage,
                fee_flat: feeFlat,
                fee_total: feeTotal,
                tier,
              });
            }
          }
        }
      } else if (paymentStatus === 'FAILED') {
        await supabase
          .from('payments')
          .update({ status: 'failed', gateway_status: 'failed' })
          .eq('id', matchedPayment.id);
      }
    }

    return NextResponse.json({ received: true });
  } catch {
    return NextResponse.json({ received: true }, { status: 200 });
  }
}
