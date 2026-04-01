import { NextResponse, type NextRequest } from 'next/server';
import { createHmac } from 'crypto';
import { createServiceClient } from '@/lib/supabase/service';

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get('x-paystack-signature') || '';
    const paystackKey = process.env.PAYSTACK_SECRET_KEY;

    if (paystackKey) {
      const hash = createHmac('sha512', paystackKey)
        .update(rawBody)
        .digest('hex');

      if (hash !== signature) {
        return NextResponse.json(
          { message: 'Invalid signature' },
          { status: 400 },
        );
      }
    }

    const body = JSON.parse(rawBody);
    const event = body.event as string;
    const data = body.data as Record<string, unknown>;
    const reference = data.reference as string;

    if (!reference) {
      return NextResponse.json({ received: true });
    }

    const supabase = createServiceClient();

    // ── Payment events (deposit bookings) ──
    const { data: existingPayment } = await supabase
      .from('payments')
      .select('id, status, amount, booking_id, gateway')
      .eq('gateway_reference', reference)
      .single();

    if (existingPayment && existingPayment.status !== 'success') {
      if (event === 'charge.success') {
        const webhookAmountKobo = data.amount as number;
        const expectedKobo = existingPayment.amount * 100;

        if (webhookAmountKobo !== expectedKobo) {
          await supabase
            .from('payments')
            .update({ status: 'failed', gateway_status: 'amount_mismatch' })
            .eq('gateway_reference', reference);
          return NextResponse.json({ received: true });
        }

        const authorization = data.authorization as Record<string, string> | undefined;
        await supabase
          .from('payments')
          .update({
            status: 'success',
            gateway_status: 'success',
            payment_method: (data.channel as string) || 'card',
            card_last_four: authorization?.last4 || null,
            card_brand: authorization?.brand || null,
            paid_at: new Date().toISOString(),
          })
          .eq('gateway_reference', reference);

        if (existingPayment.booking_id) {
          await supabase
            .from('bookings')
            .update({
              deposit_status: 'paid',
              status: 'confirmed',
              confirmed_at: new Date().toISOString(),
            })
            .eq('id', existingPayment.booking_id);

          // Record platform fee for confirmed payment
          const { data: booking } = await supabase
            .from('bookings')
            .select('business_id, total_amount')
            .eq('id', existingPayment.booking_id)
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

              // Import fee calculation inline to avoid circular deps
              const feePercentage = isInTrial ? 0 : (tier === 'business' ? 1.0 : tier === 'growth' ? 1.5 : 2.5);
              const feeFlat = isInTrial ? 0 : (tier === 'business' ? 50 : tier === 'growth' ? 50 : 100);
              const amount = booking.total_amount || existingPayment.amount;
              const feeTotal = isInTrial ? 0 : Math.round(amount * feePercentage / 100) + feeFlat;

              await supabase.from('platform_fees').insert({
                business_id: booking.business_id,
                booking_id: existingPayment.booking_id,
                transaction_amount: amount,
                fee_percentage: feePercentage,
                fee_flat: feeFlat,
                fee_total: feeTotal,
                tier,
              });
            }
          }
        }
      } else if (event === 'charge.failed') {
        await supabase
          .from('payments')
          .update({
            status: 'failed',
            gateway_status: (data.gateway_response as string) || 'failed',
          })
          .eq('gateway_reference', reference);
      }
    }

    // ── Subscription events (WhatsApp bot plans) ──
    const metadata = data.metadata as Record<string, string> | undefined;
    const isWhatsAppSub = metadata?.type === 'whatsapp_subscription';

    if (event === 'subscription.create' && isWhatsAppSub && metadata?.business_id) {
      const subCode = (data as Record<string, unknown>).subscription_code as string | undefined;
      const custCode = ((data as Record<string, unknown>).customer as Record<string, string> | undefined)?.customer_code;

      if (subCode) {
        await supabase
          .from('subscriptions')
          .update({
            paystack_subscription_code: subCode,
            paystack_customer_code: custCode || null,
            updated_at: new Date().toISOString(),
          })
          .eq('business_id', metadata.business_id)
          .eq('status', 'active');
      }
    }

    if (event === 'invoice.payment_failed' && isWhatsAppSub && metadata?.business_id) {
      await supabase
        .from('subscriptions')
        .update({ status: 'past_due', updated_at: new Date().toISOString() })
        .eq('business_id', metadata.business_id)
        .eq('status', 'active');
    }

    if (event === 'subscription.not_renew' && isWhatsAppSub && metadata?.business_id) {
      await supabase
        .from('subscriptions')
        .update({
          status: 'cancelled',
          cancelled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('business_id', metadata.business_id)
        .eq('status', 'active');

      await supabase
        .from('businesses')
        .update({ status: 'suspended' })
        .eq('id', metadata.business_id);
    }

    return NextResponse.json({ received: true });
  } catch {
    return NextResponse.json({ received: true }, { status: 200 });
  }
}
