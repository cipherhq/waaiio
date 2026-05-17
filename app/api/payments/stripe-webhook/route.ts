import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createHmac, timingSafeEqual } from 'crypto';
import { createServiceClient } from '@/lib/supabase/service';
import { getPlatformFees } from '@/lib/getPlatformFees';
import { logger } from '@/lib/logger';
import { createAlert } from '@/lib/alerts/create-alert';
import { formatCurrency, type CountryCode, type SubscriptionTier } from '@/lib/constants';

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
                .select('subscription_tier, trial_ends_at, payout_mode')
                .eq('id', booking.business_id)
                .single();

              if (business && business.payout_mode !== 'direct_split') {
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

          // Handle invoice payments (with partial payment accumulation)
          if (payment.invoice_id) {
            const { data: invoice } = await supabase
              .from('invoices')
              .select('business_id, total_amount, amount_paid')
              .eq('id', payment.invoice_id)
              .single();

            const newAmountPaid = (Number(invoice?.amount_paid) || 0) + payment.amount;
            const totalAmount = Number(invoice?.total_amount) || 0;
            const isFullyPaid = newAmountPaid >= totalAmount;

            await supabase
              .from('invoices')
              .update({
                status: isFullyPaid ? 'paid' : 'sent',
                amount_paid: newAmountPaid,
                paid_at: isFullyPaid ? new Date().toISOString() : null,
              })
              .eq('id', payment.invoice_id);

            // Record platform fee for invoice using centralized calculator
            if (invoice?.business_id) {
              const { data: invBusiness } = await supabase
                .from('businesses')
                .select('subscription_tier, trial_ends_at, payout_mode')
                .eq('id', invoice.business_id)
                .single();

              if (invBusiness && invBusiness.payout_mode !== 'direct_split') {
                const invIsInTrial = new Date(invBusiness.trial_ends_at) > new Date();
                const invTier = (invBusiness.subscription_tier || 'free') as SubscriptionTier;
                const invAmount = invoice.total_amount || payment.amount;
                const { feePercentage, feeFlat, feeTotal } = await getPlatformFees(invAmount, invTier, invIsInTrial);

                await supabase.from('platform_fees').insert({
                  business_id: invoice.business_id,
                  invoice_id: payment.invoice_id,
                  transaction_amount: invAmount,
                  fee_percentage: feePercentage,
                  fee_flat: feeFlat,
                  fee_total: feeTotal,
                  tier: invTier,
                });
              }
            }
          }

          // ── Proactive confirmation: send WhatsApp message + post-completion ──
          sendStripePaymentConfirmation(supabase, payment).catch(err =>
            logger.error('[STRIPE WEBHOOK] Proactive confirmation error:', err),
          );
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

            logger.info(`[STRIPE WEBHOOK] Recurring subscription activated: ${stripeSubId} (session ${sessionId})`);
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

          // Record platform fee for recurring payment
          if (booking?.id) {
            const { data: recBusiness } = await supabase
              .from('businesses')
              .select('subscription_tier, trial_ends_at, payout_mode')
              .eq('id', sub.business_id)
              .single();

            if (recBusiness && recBusiness.payout_mode !== 'direct_split') {
              const recIsInTrial = new Date(recBusiness.trial_ends_at) > new Date();
              const recTier = (recBusiness.subscription_tier || 'free') as SubscriptionTier;
              const { feePercentage, feeFlat, feeTotal } = await getPlatformFees(amountPaid, recTier, recIsInTrial);

              await supabase.from('platform_fees').insert({
                business_id: sub.business_id,
                booking_id: booking.id,
                transaction_amount: amountPaid,
                fee_percentage: feePercentage,
                fee_flat: feeFlat,
                fee_total: feeTotal,
                tier: recTier,
              });
            }
          }

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
            currency: ((data.currency as string)?.toUpperCase()) || 'USD',
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

/**
 * Send proactive WhatsApp confirmation after Stripe payment success.
 * Same logic as the Paystack webhook's sendPaymentConfirmation.
 */
async function sendStripePaymentConfirmation(
  supabase: ReturnType<typeof createServiceClient>,
  payment: { id: string; booking_id: string | null; invoice_id: string | null; amount: number },
): Promise<void> {
  let customerPhone: string | null = null;
  let businessId: string | null = null;
  let businessName = 'Business';
  let serviceName = 'Payment';
  let referenceCode = '';
  let countryCode: CountryCode = 'US';

  if (payment.booking_id) {
    const { data: booking } = await supabase
      .from('bookings')
      .select('guest_phone, reference_code, business_id, businesses(name, country_code), services(name)')
      .eq('id', payment.booking_id)
      .single();

    if (booking) {
      customerPhone = booking.guest_phone;
      businessId = booking.business_id;
      referenceCode = booking.reference_code || '';
      const biz = booking.businesses as unknown as { name: string; country_code?: string } | null;
      const svc = booking.services as unknown as { name: string } | null;
      if (biz?.name) businessName = biz.name;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
      if (svc?.name) serviceName = svc.name;
    }
  }

  if (!customerPhone && payment.invoice_id) {
    const { data: invoice } = await supabase
      .from('invoices')
      .select('customer_phone, reference_code, business_id, businesses:business_id(name, country_code)')
      .eq('id', payment.invoice_id)
      .single();

    if (invoice) {
      customerPhone = invoice.customer_phone;
      businessId = invoice.business_id;
      referenceCode = invoice.reference_code || '';
      const biz = invoice.businesses as unknown as { name: string; country_code?: string } | null;
      if (biz?.name) businessName = biz.name;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
      serviceName = 'Invoice';
    }
  }

  // Fallback: check orders via payment metadata
  if (!customerPhone) {
    const { data: paymentFull } = await supabase
      .from('payments')
      .select('user_id, metadata')
      .eq('id', payment.id)
      .single();

    const meta = (paymentFull?.metadata || {}) as Record<string, unknown>;
    if (meta.order_id) {
      const { data: order } = await supabase
        .from('orders')
        .select('delivery_phone, reference_code, business_id, businesses(name, country_code)')
        .eq('id', meta.order_id as string)
        .maybeSingle();
      if (order) {
        customerPhone = order.delivery_phone;
        businessId = order.business_id;
        referenceCode = order.reference_code || '';
        const biz = order.businesses as unknown as { name: string; country_code?: string } | null;
        if (biz?.name) businessName = biz.name;
        if (biz?.country_code) countryCode = biz.country_code as CountryCode;
        serviceName = 'Order';
      }
    }

    if (!customerPhone && paymentFull?.user_id) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('phone')
        .eq('id', paymentFull.user_id)
        .single();
      customerPhone = profile?.phone || null;
    }
  }

  if (!customerPhone || !businessId) {
    logger.warn('[STRIPE WEBHOOK] Proactive confirmation skipped — no phone or business');
    return;
  }

  logger.info(`[STRIPE WEBHOOK] Sending proactive confirmation to ${customerPhone} for ${businessName}`);

  const lines = [
    `✅ *Payment Confirmed!*`,
    '',
    `🏢 ${businessName}`,
    `📋 ${serviceName}`,
    `💰 Amount: ${formatCurrency(payment.amount, countryCode)}`,
    referenceCode ? `🔑 Ref: *${referenceCode}*` : '',
    '',
    'Thank you for your payment!',
    '',
    'Type *receipt* to get your receipt',
    'Type *my bookings* to view your bookings',
  ].filter(Boolean);

  try {
    const { ChannelResolver } = await import('@/lib/channels/channel-resolver');
    const resolver = new ChannelResolver(supabase);

    let resolved = null;
    const { data: activeSession } = await supabase
      .from('bot_sessions').select('session_data')
      .eq('whatsapp_number', customerPhone).eq('business_id', businessId).eq('is_active', true).maybeSingle();
    const inboundChId = (activeSession?.session_data as Record<string, unknown>)?._inbound_channel_id as string | undefined;
    if (inboundChId) resolved = await resolver.resolveByChannelId(inboundChId);
    if (!resolved) resolved = await resolver.resolveByBusinessId(businessId);
    if (!resolved) return;

    const phone = customerPhone.startsWith('+') ? customerPhone.slice(1) : customerPhone;
    await resolved.sender.sendText({ to: phone, text: lines.join('\n') });

    // Run post-completion (loyalty, feedback, referral)
    try {
      const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
      const customerName = await getCustomerName(supabase, customerPhone);
      await handlePostCompletion({
        supabase, businessId, customerPhone, customerName,
        serviceType: payment.booking_id ? 'booking' : 'order',
        referenceId: payment.booking_id || undefined,
        sender: resolved.sender,
        amountPaid: payment.amount,
        serviceName, referenceCode,
      });
    } catch (pcErr) {
      logger.error('[STRIPE WEBHOOK] Post-completion error:', pcErr);
    }

    // Reset session to capability selection so user stays with this business
    await supabase
      .from('bot_sessions')
      .update({ current_step: 'select_capability', session_data: {} })
      .eq('whatsapp_number', customerPhone)
      .eq('business_id', businessId)
      .eq('is_active', true);
  } catch (err) {
    logger.error('[STRIPE WEBHOOK] Send confirmation error:', err);
  }
}

async function getCustomerName(supabase: ReturnType<typeof createServiceClient>, phone: string): Promise<string | null> {
  const phoneP = phone.startsWith('+') ? phone : `+${phone}`;
  const phoneN = phone.startsWith('+') ? phone.slice(1) : phone;
  const { data } = await supabase
    .from('profiles')
    .select('first_name, last_name')
    .or(`phone.eq.${phoneP},phone.eq.${phoneN}`)
    .limit(1)
    .maybeSingle();
  if (data?.first_name) return `${data.first_name} ${data.last_name || ''}`.trim();
  return null;
}
