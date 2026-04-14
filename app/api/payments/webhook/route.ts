import { NextResponse, type NextRequest } from 'next/server';
import { createHmac } from 'crypto';
import { createServiceClient } from '@/lib/supabase/service';
import { processPaystackChargeSuccess, processPaystackChargeFailed } from '@/lib/payments/webhook-handler';

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

    // Idempotency: atomic dedup via ON CONFLICT
    const eventId = `${event}:${reference}`;
    const { data: inserted } = await supabase
      .from('processed_webhook_events')
      .upsert(
        { event_id: eventId, gateway: 'paystack', event_type: `paystack_${event}`, processed_at: new Date().toISOString() },
        { onConflict: 'event_id', ignoreDuplicates: true },
      )
      .select('id');

    if (!inserted || inserted.length === 0) {
      return NextResponse.json({ received: true, duplicate: true });
    }

    // ── Payment events (deposit bookings) — delegated to shared handler ──
    const { data: existingPayment } = await supabase
      .from('payments')
      .select('id, status, amount, booking_id, gateway')
      .eq('gateway_reference', reference)
      .single();

    if (event === 'charge.success') {
      await processPaystackChargeSuccess(data, reference, supabase);
    } else if (event === 'charge.failed') {
      await processPaystackChargeFailed(data, reference, supabase);
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

    // ── Recurring customer subscription events ──

    // Recurring charge success: log charge, create booking + payment records
    if (event === 'charge.success') {
      const authorization = data.authorization as Record<string, string> | undefined;
      const customerData = data.customer as Record<string, string> | undefined;
      const authCode = authorization?.authorization_code;
      const custCode = customerData?.customer_code;

      if (authCode || custCode) {
        // Find matching customer_subscription by authorization or customer code
        let subQuery = supabase
          .from('customer_subscriptions')
          .select('*')
          .eq('status', 'active');

        if (authCode) {
          subQuery = subQuery.eq('authorization_code', authCode);
        } else if (custCode) {
          subQuery = subQuery.eq('gateway_customer_code', custCode);
        }

        const { data: subs } = await subQuery;
        const sub = subs?.[0];

        // Only process if this is a recurring charge (subscription exists and payment was not already handled above)
        if (sub && !existingPayment) {
          const chargeAmount = (data.amount as number) / 100; // kobo to naira
          const now = new Date().toISOString();

          // Create a booking record for the recurring charge
          const { data: booking } = await supabase
            .from('bookings')
            .insert({
              business_id: sub.business_id,
              user_id: sub.user_id,
              service_id: sub.service_id,
              date: new Date().toISOString().split('T')[0],
              time: new Date().toTimeString().split(' ')[0].slice(0, 5),
              party_size: 1,
              flow_type: 'payment',
              channel: 'recurring',
              deposit_amount: chargeAmount,
              deposit_status: 'paid',
              status: 'confirmed',
              total_amount: chargeAmount,
              quantity: 1,
              guest_name: sub.customer_name || '',
              guest_phone: sub.customer_phone || '',
              confirmed_at: now,
              notes: `Recurring ${sub.frequency} charge`,
            })
            .select('id, reference_code')
            .single();

          // Create payment record
          const { data: payment } = await supabase
            .from('payments')
            .insert({
              business_id: sub.business_id,
              user_id: sub.user_id,
              booking_id: booking?.id || null,
              amount: chargeAmount,
              currency: sub.currency,
              gateway: 'paystack',
              gateway_reference: reference,
              status: 'success',
              gateway_status: 'success',
              payment_method: (data.channel as string) || 'card',
              card_last_four: authorization?.last4 || sub.card_last_four,
              card_brand: authorization?.brand || sub.card_brand,
              paid_at: now,
              metadata: { recurring: true, subscription_id: sub.id },
            })
            .select('id')
            .single();

          // Log the subscription charge
          await supabase.from('subscription_charges').insert({
            subscription_id: sub.id,
            business_id: sub.business_id,
            user_id: sub.user_id,
            amount: chargeAmount,
            currency: sub.currency,
            status: 'success',
            gateway: 'paystack',
            gateway_reference: reference,
            payment_id: payment?.id || null,
            booking_id: booking?.id || null,
            charged_at: now,
          });

          // Update subscription totals and next charge date
          const nextCharge = new Date();
          if (sub.frequency === 'weekly') {
            nextCharge.setDate(nextCharge.getDate() + 7);
          } else {
            nextCharge.setMonth(nextCharge.getMonth() + 1);
          }

          await supabase
            .from('customer_subscriptions')
            .update({
              charge_count: (sub.charge_count || 0) + 1,
              total_charged: parseFloat(sub.total_charged || '0') + chargeAmount,
              last_charged_at: now,
              next_charge_at: nextCharge.toISOString(),
              failure_count: 0,
            })
            .eq('id', sub.id);
        }
      }
    }

    // Recurring invoice payment failed
    if (event === 'invoice.payment_failed') {
      const customerData = data.customer as Record<string, string> | undefined;
      const custCode = customerData?.customer_code;

      if (custCode && !isWhatsAppSub) {
        const { data: subs } = await supabase
          .from('customer_subscriptions')
          .select('id, failure_count, business_id, user_id')
          .eq('gateway_customer_code', custCode)
          .in('status', ['active', 'past_due']);

        for (const sub of subs || []) {
          const newFailCount = (sub.failure_count || 0) + 1;
          await supabase
            .from('customer_subscriptions')
            .update({
              failure_count: newFailCount,
              status: newFailCount >= 3 ? 'past_due' : 'active',
            })
            .eq('id', sub.id);

          // Log failed charge
          await supabase.from('subscription_charges').insert({
            subscription_id: sub.id,
            business_id: sub.business_id || '',
            user_id: sub.user_id || '',
            amount: 0,
            currency: 'NGN',
            status: 'failed',
            gateway: 'paystack',
            failure_reason: (data.gateway_response as string) || 'Payment failed',
            created_at: new Date().toISOString(),
          });
        }
      }
    }

    // Subscription disabled/cancelled
    if (event === 'subscription.disable') {
      const subCode = (data as Record<string, unknown>).subscription_code as string;
      if (subCode) {
        await supabase
          .from('customer_subscriptions')
          .update({
            status: 'cancelled',
            cancelled_at: new Date().toISOString(),
          })
          .eq('gateway_subscription_code', subCode)
          .in('status', ['active', 'paused', 'past_due']);
      }
    }

    return NextResponse.json({ received: true });
  } catch {
    return NextResponse.json({ received: true }, { status: 200 });
  }
}
