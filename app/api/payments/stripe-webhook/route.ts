import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createHmac, timingSafeEqual } from 'crypto';
import { createServiceClient } from '@/lib/supabase/service';
import { getPlatformFees } from '@/lib/getPlatformFees';
import { createAlert } from '@/lib/alerts/create-alert';
import type { SubscriptionTier } from '@/lib/constants';

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

  return sigs.some(sig => {
    try {
      return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch { return false; }
  });
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get('stripe-signature') || '';

    // Verify signature when secret is configured
    if (stripeWebhookSecret && !verifyStripeSignature(rawBody, signature)) {
      return NextResponse.json({ message: 'Invalid signature' }, { status: 400 });
    }

    const body = JSON.parse(rawBody);
    const event = body.type as string;
    const eventId = body.id as string;
    const data = body.data?.object as Record<string, unknown>;

    if (!data) {
      return NextResponse.json({ received: true });
    }

    const supabase = createServiceClient();

    // Idempotency: atomic dedup via ON CONFLICT
    if (eventId) {
      const { data: inserted } = await supabase
        .from('processed_webhook_events')
        .upsert(
          { event_id: `stripe-${eventId}`, gateway: 'stripe', event_type: `stripe_${event}`, processed_at: new Date().toISOString() },
          { onConflict: 'event_id', ignoreDuplicates: true },
        )
        .select('id');

      if (!inserted || inserted.length === 0) {
        return NextResponse.json({ received: true, duplicate: true });
      }
    }

    if (event === 'checkout.session.completed') {
      const sessionId = data.id as string;
      const paymentStatus = data.payment_status as string;
      const metadata = data.metadata as Record<string, string> | undefined;

      if (paymentStatus === 'paid' && sessionId) {
        const { data: payment } = await supabase
          .from('payments')
          .select('id, booking_id, invoice_id, amount, status')
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
                const tier = (business.subscription_tier || 'free') as SubscriptionTier;
                const amount = booking.total_amount || payment.amount;

                const { feePercentage, feeFlat, feeTotal } = await getPlatformFees(amount, tier, isInTrial);

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

          // Handle invoice payments
          if (payment.invoice_id) {
            await supabase
              .from('invoices')
              .update({
                status: 'paid',
                amount_paid: payment.amount,
                paid_at: new Date().toISOString(),
              })
              .eq('id', payment.invoice_id);

            // Record platform fee for invoice
            const { data: invoice } = await supabase
              .from('invoices')
              .select('business_id, total_amount')
              .eq('id', payment.invoice_id)
              .single();

            if (invoice?.business_id) {
              const { data: invBusiness } = await supabase
                .from('businesses')
                .select('subscription_tier, trial_ends_at')
                .eq('id', invoice.business_id)
                .single();

              if (invBusiness) {
                const invIsInTrial = new Date(invBusiness.trial_ends_at) > new Date();
                const invTier = invBusiness.subscription_tier || 'free';
                const invFeePercentage = invIsInTrial ? 0 : (invTier === 'business' ? 1.0 : invTier === 'growth' ? 1.5 : 2.5);
                const invFeeFlat = invIsInTrial ? 0 : (invTier === 'business' ? 0.25 : invTier === 'growth' ? 0.25 : 0.50);
                const invAmount = invoice.total_amount || payment.amount;
                const invFeeTotal = invIsInTrial ? 0 : Math.round((invAmount * invFeePercentage / 100 + invFeeFlat) * 100) / 100;

                await supabase.from('platform_fees').insert({
                  business_id: invoice.business_id,
                  invoice_id: payment.invoice_id,
                  transaction_amount: invAmount,
                  fee_percentage: invFeePercentage,
                  fee_flat: invFeeFlat,
                  fee_total: invFeeTotal,
                  tier: invTier,
                });
              }
            }
          }
        }

        // Handle subscription payments (business tier upgrades)
        if (metadata?.type === 'whatsapp_subscription' && metadata.business_id) {
          await supabase
            .from('businesses')
            .update({
              subscription_tier: metadata.plan || 'growth',
              status: 'active',
            })
            .eq('id', metadata.business_id);
        }

        // Handle customer recurring subscription activation
        if (metadata?.type === 'customer_recurring') {
          const stripeSubId = data.subscription as string;
          if (stripeSubId && sessionId) {
            // Activate the pending subscription
            await supabase
              .from('customer_subscriptions')
              .update({
                status: 'active',
                gateway_subscription_code: stripeSubId,
              })
              .eq('gateway_subscription_code', sessionId)
              .eq('status', 'pending');

            // Also update the payment record
            await supabase
              .from('payments')
              .update({ status: 'success', payment_method: 'card', paid_at: new Date().toISOString() })
              .eq('gateway_reference', sessionId)
              .neq('status', 'success');

            console.log(`[STRIPE WEBHOOK] Recurring subscription activated: ${stripeSubId} (session ${sessionId})`);
          }
        }
      }
    }

    if (event === 'checkout.session.expired') {
      const sessionId = data.id as string;
      if (sessionId) {
        const { data: expiredPayment } = await supabase
          .from('payments')
          .select('id, amount, business_id')
          .eq('gateway_reference', sessionId)
          .neq('status', 'success')
          .maybeSingle();

        await supabase
          .from('payments')
          .update({ status: 'failed', gateway_status: 'expired' })
          .eq('gateway_reference', sessionId)
          .neq('status', 'success');

        if (expiredPayment?.business_id) {
          await createAlert(supabase, {
            businessId: expiredPayment.business_id,
            type: 'payment_failed',
            severity: 'warning',
            title: 'Payment Expired',
            message: `A Stripe checkout session expired before payment was completed.`,
            metadata: { paymentId: expiredPayment.id, amount: expiredPayment.amount, gateway: 'stripe' },
          });
        }
      }
    }

    // ── Recurring customer subscription events ──

    // Stripe recurring invoice paid
    if (event === 'invoice.paid') {
      const subscriptionId = data.subscription as string;
      const amountPaid = (data.amount_paid as number) / 100; // cents to dollars
      const currency = (data.currency as string)?.toUpperCase() || 'USD';

      if (subscriptionId) {
        const { data: subs } = await supabase
          .from('customer_subscriptions')
          .select('*')
          .eq('gateway_subscription_code', subscriptionId)
          .in('status', ['active', 'pending']);

        const sub = subs?.[0];
        if (sub) {
          const now = new Date().toISOString();

          // Create booking record
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
              deposit_amount: amountPaid,
              deposit_status: 'paid',
              status: 'confirmed',
              total_amount: amountPaid,
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
              amount: amountPaid,
              currency,
              gateway: 'stripe',
              gateway_reference: (data.payment_intent as string) || (data.id as string),
              status: 'success',
              gateway_status: 'paid',
              payment_method: 'card',
              paid_at: now,
              metadata: { recurring: true, subscription_id: sub.id },
            })
            .select('id')
            .single();

          // Log subscription charge
          await supabase.from('subscription_charges').insert({
            subscription_id: sub.id,
            business_id: sub.business_id,
            user_id: sub.user_id,
            amount: amountPaid,
            currency,
            status: 'success',
            gateway: 'stripe',
            gateway_reference: (data.payment_intent as string) || (data.id as string),
            payment_id: payment?.id || null,
            booking_id: booking?.id || null,
            charged_at: now,
          });

          // Update subscription totals
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
              total_charged: parseFloat(sub.total_charged || '0') + amountPaid,
              last_charged_at: now,
              next_charge_at: nextCharge.toISOString(),
              failure_count: 0,
            })
            .eq('id', sub.id);
        }
      }
    }

    // Stripe recurring invoice payment failed
    if (event === 'invoice.payment_failed') {
      const subscriptionId = data.subscription as string;
      if (subscriptionId) {
        const { data: subs } = await supabase
          .from('customer_subscriptions')
          .select('id, failure_count, business_id, user_id')
          .eq('gateway_subscription_code', subscriptionId)
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

          await supabase.from('subscription_charges').insert({
            subscription_id: sub.id,
            business_id: sub.business_id,
            user_id: sub.user_id,
            amount: 0,
            currency: 'USD',
            status: 'failed',
            gateway: 'stripe',
            failure_reason: 'Payment failed',
            created_at: new Date().toISOString(),
          });

          if (sub.business_id) {
            await createAlert(supabase, {
              businessId: sub.business_id,
              type: 'subscription_payment_failed',
              severity: newFailCount >= 3 ? 'critical' : 'warning',
              title: 'Subscription Payment Failed',
              message: `Recurring Stripe payment failed (attempt ${newFailCount}). ${newFailCount >= 3 ? 'Subscription is now past due.' : 'We will retry.'}`,
              metadata: { subscriptionId: sub.id, failureCount: newFailCount, gateway: 'stripe' },
            });
          }
        }
      }
    }

    // Stripe subscription cancelled
    if (event === 'customer.subscription.deleted') {
      const subscriptionId = data.id as string;
      if (subscriptionId) {
        await supabase
          .from('customer_subscriptions')
          .update({
            status: 'cancelled',
            cancelled_at: new Date().toISOString(),
          })
          .eq('gateway_subscription_code', subscriptionId)
          .in('status', ['active', 'paused', 'past_due']);
      }
    }

    // Already marked as processed via upsert above

    return NextResponse.json({ received: true });
  } catch (error) {
    Sentry.captureException(error);
    return NextResponse.json({ received: true }, { status: 200 });
  }
}
