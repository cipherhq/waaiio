import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createHmac, timingSafeEqual } from 'crypto';
import { createServiceClient } from '@/lib/supabase/service';
import { processPaystackChargeSuccess, processPaystackChargeFailed } from '@/lib/payments/webhook-handler';
import { sendProactiveConfirmation } from '@/lib/payments/send-confirmation';
import { notifyCustomerChargeFailed } from '@/lib/payments/notify-charge-failed';
import { createAlert } from '@/lib/alerts/create-alert';
import { getPlatformFees } from '@/lib/getPlatformFees';
import { subscriptionRenewalReceiptEmail } from '@/lib/email/templates';
import { sendEmail } from '@/lib/email/client';
import type { SubscriptionTier } from '@/lib/constants';
import { logger } from '@/lib/logger';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get('x-paystack-signature') || '';
    const paystackKey = process.env.PAYSTACK_SECRET_KEY;

    // Fail-closed: reject if secret key is not configured
    if (!paystackKey) {
      return NextResponse.json({ message: 'Webhook not configured' }, { status: 500 });
    }

    const hash = createHmac('sha512', paystackKey).update(rawBody).digest('hex');
    try {
      if (!timingSafeEqual(Buffer.from(hash), Buffer.from(signature))) {
        return NextResponse.json({ message: 'Invalid signature' }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ message: 'Invalid signature' }, { status: 400 });
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

    // ── Capture authorization code for customer recurring subscriptions ──
    // When a first payment succeeds, capture the card auth for future auto-charges.
    // This fixes web-initiated subscriptions where auth code wasn't captured at setup.
    if (event === 'charge.success') {
      const chargeAuth = data.authorization as Record<string, string> | undefined;
      const chargeCustomer = data.customer as Record<string, string> | undefined;
      if (chargeAuth?.authorization_code) {
        const custPhone = chargeCustomer?.phone || '';
        const custEmail = chargeCustomer?.email || '';
        // Find subscriptions missing authorization_code for this customer
        const phoneVariants = custPhone ? [custPhone, custPhone.startsWith('+') ? custPhone.slice(1) : `+${custPhone}`] : [];
        let subQuery = supabase
          .from('customer_subscriptions')
          .update({
            authorization_code: chargeAuth.authorization_code,
            card_last_four: chargeAuth.last4 || null,
            card_brand: chargeAuth.brand || null,
            gateway_customer_code: chargeCustomer?.customer_code || null,
          })
          .is('authorization_code', null)
          .in('status', ['active', 'pending']);

        if (phoneVariants.length > 0) {
          subQuery = subQuery.or(phoneVariants.map(p => `customer_phone.eq.${sanitizeFilterValue(p)}`).join(','));
        } else if (custEmail) {
          subQuery = subQuery.eq('customer_email', custEmail);
        }

        const { data: updated } = await subQuery.select('id');
        if (updated && updated.length > 0) {
          logger.info(`[PAYSTACK WEBHOOK] Captured auth code for ${updated.length} subscription(s)`);
        }
      }
    }

    // ── Subscription events (WhatsApp bot plans) ──
    const metadata = data.metadata as Record<string, string> | undefined;
    const isWhatsAppSub = metadata?.type === 'whatsapp_subscription';

    // ── Platform subscription renewal via charge.success ──
    // Paystack recurring charges include plan_object or plan in the data.
    // Look up the subscription by paystack_subscription_code and update period dates.
    if (event === 'charge.success') {
      const planObject = data.plan_object as Record<string, unknown> | undefined;
      const subscriptionRef = data.subscription as Record<string, unknown> | undefined;
      const paystackSubCode = (subscriptionRef?.subscription_code as string)
        || (data.subscription_code as string)
        || undefined;

      // Only process if this charge is tied to a Paystack subscription (has plan or subscription ref)
      if (paystackSubCode || planObject) {
        const { data: platformSub } = await supabase
          .from('subscriptions')
          .select('id, business_id, plan, paystack_subscription_code')
          .eq('paystack_subscription_code', paystackSubCode || '')
          .single();

        // If we found a matching platform subscription, this is a renewal charge
        if (platformSub) {
          const now = new Date();
          const periodEnd = new Date();
          periodEnd.setDate(periodEnd.getDate() + 30);

          // Update subscription period and ensure active status
          await supabase
            .from('subscriptions')
            .update({
              status: 'active',
              current_period_start: now.toISOString(),
              current_period_end: periodEnd.toISOString(),
              updated_at: now.toISOString(),
            })
            .eq('id', platformSub.id);

          // Ensure business stays active
          await supabase
            .from('businesses')
            .update({ status: 'active' })
            .eq('id', platformSub.business_id);

          // Record renewal payment
          const chargeAmountKobo = data.amount as number;
          const chargeAmountNaira = chargeAmountKobo / 100;
          await supabase.from('subscription_payments').insert({
            business_id: platformSub.business_id,
            subscription_id: platformSub.id,
            amount: chargeAmountNaira,
            currency: (data.currency as string) || 'NGN',
            gateway: 'paystack',
            gateway_reference: reference,
            plan: platformSub.plan,
            action: 'renewal',
            status: 'success',
          });

          // Send renewal receipt email to business owner
          try {
            const { data: biz } = await supabase
              .from('businesses')
              .select('name, owner_id')
              .eq('id', platformSub.business_id)
              .single();
            if (biz?.owner_id) {
              const { data: profile } = await supabase
                .from('profiles')
                .select('email')
                .eq('id', biz.owner_id)
                .single();
              if (profile?.email) {
                const periodEnd = new Date();
                periodEnd.setDate(periodEnd.getDate() + 30);
                const { subject, html } = subscriptionRenewalReceiptEmail(
                  biz.name,
                  platformSub.plan,
                  String(chargeAmountNaira),
                  (data.currency as string)?.toUpperCase() || 'NGN',
                  periodEnd.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
                );
                await sendEmail({ to: profile.email, subject, html });
              }
            }
          } catch (emailErr) {
            logger.error('[PAYSTACK] Subscription renewal email error:', emailErr);
          }
        }
      }
    }

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
        .update({ status: 'suspended', subscription_tier: 'free' })
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
        // Check if this charge is for a paused subscription — skip if so
        let pausedCheckQuery = supabase
          .from('customer_subscriptions')
          .select('id')
          .eq('status', 'paused');
        if (authCode) pausedCheckQuery = pausedCheckQuery.eq('authorization_code', authCode);
        else if (custCode) pausedCheckQuery = pausedCheckQuery.eq('gateway_customer_code', custCode);
        const { data: pausedSubs } = await pausedCheckQuery;
        if (pausedSubs && pausedSubs.length > 0) {
          logger.info(`[PAYSTACK WEBHOOK] Skipping charge for paused subscription(s): ${pausedSubs.map(s => s.id).join(', ')}`);
        }

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

          // Record platform fee for recurring payment (non-blocking)
          if (booking?.id) {
            const { data: recBusiness } = await supabase
              .from('businesses')
              .select('subscription_tier, trial_ends_at, payout_mode')
              .eq('id', sub.business_id)
              .single();

            if (recBusiness && recBusiness.payout_mode !== 'direct_split') {
              const recIsInTrial = new Date(recBusiness.trial_ends_at) > new Date();
              const recTier = (recBusiness.subscription_tier || 'free') as SubscriptionTier;
              const { feePercentage, feeFlat, feeTotal } = await getPlatformFees(chargeAmount, recTier, recIsInTrial);

              await supabase.from('platform_fees').insert({
                business_id: sub.business_id,
                booking_id: booking.id,
                transaction_amount: chargeAmount,
                fee_percentage: feePercentage,
                fee_flat: feeFlat,
                fee_total: feeTotal,
                tier: recTier,
              });
            }
          }

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

          // Send WhatsApp + email confirmation to customer
          if (payment) {
            try {
              await sendProactiveConfirmation(supabase, {
                id: payment.id,
                amount: chargeAmount,
                booking_id: booking?.id || null,
                invoice_id: null,
                campaign_id: null,
                reservation_id: null,
                order_id: null,
              }, '[PAYSTACK RECURRING]');
            } catch (confirmErr) {
              logger.error('[PAYSTACK RECURRING] Confirmation error:', confirmErr);
            }

            // Send receipt image to customer (non-blocking)
            if (booking?.reference_code && sub.customer_phone) {
              try {
                const resolver = new (await import('@/lib/channels/channel-resolver')).ChannelResolver(supabase);
                const resolved = await resolver.resolveByBusinessId(sub.business_id);
                if (resolved) {
                  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
                  const phone = sub.customer_phone.startsWith('+') ? sub.customer_phone.slice(1) : sub.customer_phone;
                  await resolved.sender.sendImage({
                    to: phone,
                    imageUrl: `${appUrl}/api/receipts/image?ref=${booking.reference_code}`,
                    caption: `🧾 Receipt — ${booking.reference_code}`,
                  });
                }
              } catch (receiptErr) {
                logger.error('[PAYSTACK RECURRING] Receipt image error:', receiptErr);
              }
            }
          }
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
          .select('id, failure_count, business_id, user_id, customer_phone, customer_name, amount, currency, service_id')
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
            currency: (data.currency as string) || 'NGN',
            status: 'failed',
            gateway: 'paystack',
            failure_reason: (data.gateway_response as string) || 'Payment failed',
            created_at: new Date().toISOString(),
          });

          // Alert business owner
          if (sub.business_id) {
            await createAlert(supabase, {
              businessId: sub.business_id,
              type: 'subscription_payment_failed',
              severity: newFailCount >= 3 ? 'critical' : 'warning',
              title: 'Subscription Payment Failed',
              message: `Recurring payment failed (attempt ${newFailCount}). ${newFailCount >= 3 ? 'Subscription is now past due.' : 'We will retry.'}`,
              metadata: { subscriptionId: sub.id, failureCount: newFailCount, gateway: 'paystack' },
            });
          }

          // Notify customer via WhatsApp about the failed charge
          if (sub.customer_phone && sub.business_id) {
            try {
              await notifyCustomerChargeFailed(supabase, {
                subscriptionId: sub.id,
                businessId: sub.business_id,
                customerPhone: sub.customer_phone,
                amount: sub.amount,
                currency: sub.currency || 'NGN',
                serviceId: sub.service_id,
                gateway: 'paystack',
              });
            } catch (notifyErr) {
              logger.error('[PAYSTACK RECURRING] Customer failure notification error:', notifyErr);
            }
          }
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
  } catch (error) {
    Sentry.captureException(error);
    return NextResponse.json({ received: true }, { status: 200 });
  }
}
