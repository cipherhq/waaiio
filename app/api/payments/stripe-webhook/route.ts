import { NextResponse, type NextRequest } from 'next/server';
import { createHmac } from 'crypto';
import { createServiceClient } from '@/lib/supabase/service';

const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

function verifyStripeSignature(rawBody: string, signature: string): boolean {
  if (!stripeWebhookSecret || !signature) return false;

  // Stripe sends: t=timestamp,v1=signature[,v1=signature...]
  const parts = signature.split(',');
  const timestamp = parts.find(p => p.startsWith('t='))?.slice(2);
  const sigs = parts.filter(p => p.startsWith('v1=')).map(p => p.slice(3));

  if (!timestamp || sigs.length === 0) return false;

  const payload = `${timestamp}.${rawBody}`;
  const expected = createHmac('sha256', stripeWebhookSecret)
    .update(payload)
    .digest('hex');

  return sigs.some(sig => sig === expected);
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get('stripe-signature') || '';

    if (stripeWebhookSecret && !verifyStripeSignature(rawBody, signature)) {
      return NextResponse.json({ message: 'Invalid signature' }, { status: 400 });
    }

    const body = JSON.parse(rawBody);
    const event = body.type as string;
    const data = body.data?.object as Record<string, unknown>;

    if (!data) {
      return NextResponse.json({ received: true });
    }

    const supabase = createServiceClient();

    if (event === 'checkout.session.completed') {
      const sessionId = data.id as string;
      const paymentStatus = data.payment_status as string;
      const metadata = data.metadata as Record<string, string> | undefined;

      if (paymentStatus === 'paid' && sessionId) {
        const { data: payment } = await supabase
          .from('payments')
          .select('id, booking_id, amount, status')
          .eq('gateway_reference', sessionId)
          .single();

        if (payment && payment.status !== 'success') {
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
              .update({
                deposit_status: 'paid',
                status: 'confirmed',
                confirmed_at: new Date().toISOString(),
              })
              .eq('id', payment.booking_id);

            // Record platform fee
            const { data: booking } = await supabase
              .from('bookings')
              .select('business_id, total_amount')
              .eq('id', payment.booking_id)
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
                const amount = booking.total_amount || payment.amount;
                const feeTotal = isInTrial ? 0 : Math.round((amount * feePercentage / 100 + feeFlat) * 100) / 100;

                await supabase.from('platform_fees').insert({
                  business_id: booking.business_id,
                  booking_id: payment.booking_id,
                  transaction_amount: amount,
                  fee_percentage: feePercentage,
                  fee_flat: feeFlat,
                  fee_total: feeTotal,
                  tier,
                });
              }
            }
          }
        }

        // Handle subscription payments
        if (metadata?.type === 'whatsapp_subscription' && metadata.business_id) {
          await supabase
            .from('businesses')
            .update({
              subscription_tier: metadata.plan || 'growth',
              status: 'active',
            })
            .eq('id', metadata.business_id);
        }
      }
    }

    if (event === 'checkout.session.expired') {
      const sessionId = data.id as string;
      if (sessionId) {
        await supabase
          .from('payments')
          .update({ status: 'failed', gateway_status: 'expired' })
          .eq('gateway_reference', sessionId)
          .neq('status', 'success');
      }
    }

    return NextResponse.json({ received: true });
  } catch {
    return NextResponse.json({ received: true }, { status: 200 });
  }
}
