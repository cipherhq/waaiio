import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createHmac, timingSafeEqual } from 'crypto';
import { createServiceClient } from '@/lib/supabase/service';
import { getPlatformFees } from '@/lib/getPlatformFees';
import { logger } from '@/lib/logger';
import { createAlert } from '@/lib/alerts/create-alert';
import { sendEmail } from '@/lib/email/client';
import { subscriptionRenewalReceiptEmail } from '@/lib/email/templates';
import type { SubscriptionTier } from '@/lib/constants';
import { processSuccessfulPayment } from '@/lib/payments/process-success';
import { sendProactiveConfirmation } from '@/lib/payments/send-confirmation';

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

    // Fail-closed: reject if webhook secret is not configured
    if (!stripeWebhookSecret) {
      return new Response(JSON.stringify({ message: 'Webhook not configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    if (!verifyStripeSignature(rawBody, signature)) {
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
          .select('id, booking_id, invoice_id, campaign_id, reservation_id, order_id, amount, status')
          .eq('gateway_reference', sessionId)
          .single();

        if (payment && payment.status !== 'success') {
          // Verify amount matches (Stripe amount_total is in cents)
          const stripeAmountCents = (data.amount_total as number) || 0;
          const stripeCurrency = ((data.currency as string) || '').toUpperCase();
          // For NGN/GHS amounts are in kobo/pesewas (100x), for USD/GBP/CAD in cents (100x)
          const expectedCents = Math.round(payment.amount * 100);
          if (stripeAmountCents > 0 && Math.abs(stripeAmountCents - expectedCents) > 1) {
            console.error(`[STRIPE-WEBHOOK] Amount mismatch: Stripe=${stripeAmountCents} (${stripeCurrency}), expected=${expectedCents} for payment ${payment.id}`);
            await supabase.from('payments').update({ status: 'failed', gateway_status: 'amount_mismatch' }).eq('id', payment.id);
            return NextResponse.json({ received: true, error: 'amount_mismatch' });
          }
          await supabase
            .from('payments')
            .update({
              status: 'success',
              gateway_status: 'paid',
              payment_method: 'card',
              paid_at: new Date().toISOString(),
            })
            .eq('id', payment.id);

          // Fetch actual Stripe fee from PaymentIntent → Charge → BalanceTransaction
          let stripeGatewayFee = 0;
          try {
            const piId = data.payment_intent as string;
            if (piId && process.env.STRIPE_SECRET_KEY) {
              const piRes = await fetch(
                `https://api.stripe.com/v1/payment_intents/${piId}?expand[]=latest_charge.balance_transaction`,
                {
                  headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
                  signal: AbortSignal.timeout(10000),
                },
              );
              if (piRes.ok) {
                const pi = await piRes.json();
                const bt = pi.latest_charge?.balance_transaction;
                if (bt && typeof bt === 'object' && bt.fee) {
                  // bt.fee is in cents — convert to major unit (dollars)
                  stripeGatewayFee = Math.round(bt.fee) / 100;
                }
              }
            }
          } catch (err) {
            logger.warn('[STRIPE WEBHOOK] Failed to fetch gateway fee:', err);
          }

          const paymentForShared = {
            id: payment.id,
            amount: payment.amount,
            booking_id: payment.booking_id,
            invoice_id: payment.invoice_id || null,
            campaign_id: payment.campaign_id || null,
            reservation_id: payment.reservation_id || null,
            order_id: payment.order_id || null,
            gateway_fee: stripeGatewayFee,
          };

          // Confirm booking, record platform fees, process invoice/campaign
          await processSuccessfulPayment(supabase, paymentForShared);

          // Proactive confirmation: send WhatsApp message + post-completion
          try {
            await sendProactiveConfirmation(supabase, paymentForShared, '[STRIPE WEBHOOK]');
          } catch (confirmErr) {
            logger.error('[STRIPE WEBHOOK] Proactive confirmation error:', confirmErr);
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

          // For subscription mode: store Stripe subscription + customer IDs
          const sessionSubscriptionId = data.subscription as string;
          const sessionCustomerId = data.customer as string;
          if (sessionSubscriptionId) {
            await supabase
              .from('subscriptions')
              .update({
                stripe_subscription_id: sessionSubscriptionId,
                stripe_customer_id: sessionCustomerId || null,
              })
              .eq('business_id', metadata.business_id);
          }
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

    // ── Platform subscription recurring billing events ──

    // Flag to prevent double-processing of invoice.paid events
    // The first invoice.paid block handles both platform AND customer recurring subscriptions.
    // The second block (below) is a legacy duplicate for customer recurring — skip if already handled.
    let invoicePaidHandled = false;

    // Check if a Stripe subscription ID belongs to a platform subscription
    async function findPlatformSubscription(stripeSubId: string) {
      const { data } = await supabase
        .from('subscriptions')
        .select('id, business_id, plan, status, amount, currency')
        .eq('stripe_subscription_id', stripeSubId)
        .maybeSingle();
      return data;
    }

    // Platform subscription: invoice.paid (renewal)
    if (event === 'invoice.paid') {
      const subscriptionId = data.subscription as string;
      if (subscriptionId) {
        const platformSub = await findPlatformSubscription(subscriptionId);
        if (platformSub) {
          const periodStart = data.period_start
            ? new Date((data.period_start as number) * 1000).toISOString()
            : new Date().toISOString();
          const periodEnd = data.period_end
            ? new Date((data.period_end as number) * 1000).toISOString()
            : (() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString(); })();

          await supabase
            .from('subscriptions')
            .update({
              status: 'active',
              current_period_start: periodStart,
              current_period_end: periodEnd,
            })
            .eq('id', platformSub.id);

          await supabase.from('subscription_payments').insert({
            business_id: platformSub.business_id,
            subscription_id: platformSub.id,
            amount: (data.amount_paid as number) || 0,
            currency: ((data.currency as string)?.toUpperCase()) || 'USD',
            gateway: 'stripe',
            gateway_reference: (data.payment_intent as string) || (data.id as string),
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
                const periodEndDate = data.period_end
                  ? new Date((data.period_end as number) * 1000)
                  : (() => { const d = new Date(); d.setDate(d.getDate() + 30); return d; })();
                const amountDisplay = String((data.amount_paid as number) || 0);
                const curr = ((data.currency as string)?.toUpperCase()) || 'USD';
                const { subject, html } = subscriptionRenewalReceiptEmail(
                  biz.name,
                  platformSub.plan,
                  curr === 'USD' || curr === 'GBP' || curr === 'CAD' ? (Number(amountDisplay) / 100).toFixed(2) : amountDisplay,
                  curr,
                  periodEndDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
                );
                await sendEmail({ to: profile.email, subject, html });
              }
            }
          } catch (emailErr) {
            logger.error('[STRIPE WEBHOOK] Subscription renewal email error:', emailErr);
          }

          logger.info(`[STRIPE WEBHOOK] Platform subscription renewed: ${subscriptionId} for business ${platformSub.business_id}`);
          invoicePaidHandled = true;
        } else {
          // Not a platform subscription — check if it's a customer recurring subscription
          const { data: customerSub } = await supabase
            .from('customer_subscriptions')
            .select('*')
            .eq('gateway_subscription_code', subscriptionId)
            .eq('gateway', 'stripe')
            .in('status', ['active', 'past_due'])
            .maybeSingle();

          if (customerSub) {
            const chargeAmount = (data.amount_paid as number) / 100;
            const now = new Date().toISOString();

            // Create booking record for the recurring charge
            const { data: booking } = await supabase
              .from('bookings')
              .insert({
                business_id: customerSub.business_id,
                user_id: customerSub.user_id,
                service_id: customerSub.service_id,
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
                guest_name: customerSub.customer_name || '',
                guest_phone: customerSub.customer_phone || '',
                confirmed_at: now,
                notes: `Recurring ${customerSub.frequency} charge (Stripe)`,
              })
              .select('id, reference_code')
              .single();

            // Create payment record
            const { data: stripePayment } = await supabase
              .from('payments')
              .insert({
                business_id: customerSub.business_id,
                user_id: customerSub.user_id,
                booking_id: booking?.id || null,
                amount: chargeAmount,
                currency: customerSub.currency || 'USD',
                gateway: 'stripe',
                gateway_reference: (data.payment_intent as string) || (data.id as string),
                status: 'success',
                gateway_status: 'success',
                payment_method: 'card',
                card_last_four: customerSub.card_last_four,
                card_brand: customerSub.card_brand,
                paid_at: now,
                metadata: { recurring: true, subscription_id: customerSub.id },
              })
              .select('id')
              .single();

            // Log the charge
            await supabase.from('subscription_charges').insert({
              subscription_id: customerSub.id,
              business_id: customerSub.business_id,
              user_id: customerSub.user_id,
              amount: chargeAmount,
              currency: customerSub.currency || 'USD',
              status: 'success',
              gateway: 'stripe',
              gateway_reference: (data.payment_intent as string) || (data.id as string),
              payment_id: stripePayment?.id || null,
              booking_id: booking?.id || null,
              charged_at: now,
            });

            // Record platform fee
            if (booking?.id) {
              const { data: recBiz } = await supabase
                .from('businesses')
                .select('subscription_tier, trial_ends_at, payout_mode')
                .eq('id', customerSub.business_id)
                .single();

              if (recBiz && recBiz.payout_mode !== 'direct_split') {
                const recIsInTrial = new Date(recBiz.trial_ends_at) > new Date();
                const recTier = (recBiz.subscription_tier || 'free') as SubscriptionTier;
                const { feePercentage, feeFlat, feeTotal } = await getPlatformFees(chargeAmount, recTier, recIsInTrial);

                await supabase.from('platform_fees').insert({
                  business_id: customerSub.business_id,
                  booking_id: booking.id,
                  transaction_amount: chargeAmount,
                  fee_percentage: feePercentage,
                  fee_flat: feeFlat,
                  fee_total: feeTotal,
                  tier: recTier,
                });
              }
            }

            // Update subscription stats
            const nextCharge = new Date();
            if (customerSub.frequency === 'weekly') {
              nextCharge.setDate(nextCharge.getDate() + 7);
            } else {
              nextCharge.setMonth(nextCharge.getMonth() + 1);
            }

            await supabase
              .from('customer_subscriptions')
              .update({
                charge_count: (customerSub.charge_count || 0) + 1,
                total_charged: parseFloat(customerSub.total_charged || '0') + chargeAmount,
                last_charged_at: now,
                next_charge_at: nextCharge.toISOString(),
                failure_count: 0,
                status: 'active',
              })
              .eq('id', customerSub.id);

            // Send confirmation
            if (stripePayment) {
              try {
                await sendProactiveConfirmation(supabase, {
                  id: stripePayment.id,
                  amount: chargeAmount,
                  booking_id: booking?.id || null,
                  invoice_id: null,
                  campaign_id: null,
                  reservation_id: null,
                  order_id: null,
                }, '[STRIPE RECURRING]');
              } catch (confirmErr) {
                logger.error('[STRIPE RECURRING] Confirmation error:', confirmErr);
              }
            }

            logger.info(`[STRIPE WEBHOOK] Customer recurring charge processed: ${subscriptionId}, amount: ${chargeAmount}`);
            invoicePaidHandled = true;
          }
        }
      }
    }

    // Platform subscription: invoice.payment_failed
    if (event === 'invoice.payment_failed') {
      const subscriptionId = data.subscription as string;
      if (subscriptionId) {
        const platformSub = await findPlatformSubscription(subscriptionId);
        if (platformSub) {
          await supabase
            .from('subscriptions')
            .update({ status: 'past_due' })
            .eq('id', platformSub.id);

          // Send warning email to business owner
          const { data: business } = await supabase
            .from('businesses')
            .select('owner_id, name')
            .eq('id', platformSub.business_id)
            .single();

          if (business?.owner_id) {
            const { data: profile } = await supabase
              .from('profiles')
              .select('email')
              .eq('id', business.owner_id)
              .single();

            if (profile?.email) {
              await sendEmail({
                to: profile.email,
                subject: 'Waaiio Subscription Payment Failed',
                html: `<p>Hi,</p><p>We were unable to process the payment for your <strong>${platformSub.plan}</strong> plan for <strong>${business.name}</strong>.</p><p>Please update your payment method to avoid service interruption.</p><p>— The Waaiio Team</p>`,
              });
            }
          }

          await createAlert(supabase, {
            businessId: platformSub.business_id,
            type: 'subscription_payment_failed',
            severity: 'critical',
            title: 'Subscription Payment Failed',
            message: `Your ${platformSub.plan} plan payment failed. Please update your payment method to avoid downgrade.`,
            metadata: { subscriptionId: platformSub.id, gateway: 'stripe' },
          });

          logger.warn(`[STRIPE WEBHOOK] Platform subscription payment failed: ${subscriptionId} for business ${platformSub.business_id}`);
        }
      }
    }

    // Platform subscription: cancelled
    if (event === 'customer.subscription.deleted') {
      const stripeSubId = data.id as string;
      if (stripeSubId) {
        const platformSub = await findPlatformSubscription(stripeSubId);
        if (platformSub) {
          await supabase
            .from('subscriptions')
            .update({
              status: 'cancelled',
              cancelled_at: new Date().toISOString(),
            })
            .eq('id', platformSub.id);

          await supabase
            .from('businesses')
            .update({ subscription_tier: 'free' })
            .eq('id', platformSub.business_id);

          // Send expiry email to business owner
          const { data: business } = await supabase
            .from('businesses')
            .select('owner_id, name')
            .eq('id', platformSub.business_id)
            .single();

          if (business?.owner_id) {
            const { data: profile } = await supabase
              .from('profiles')
              .select('email')
              .eq('id', business.owner_id)
              .single();

            if (profile?.email) {
              await sendEmail({
                to: profile.email,
                subject: 'Waaiio Subscription Cancelled',
                html: `<p>Hi,</p><p>Your <strong>${platformSub.plan}</strong> plan for <strong>${business.name}</strong> has been cancelled.</p><p>Your account has been downgraded to the free tier. You can resubscribe at any time from your dashboard.</p><p>— The Waaiio Team</p>`,
              });
            }
          }

          await createAlert(supabase, {
            businessId: platformSub.business_id,
            type: 'subscription_cancelled',
            severity: 'warning',
            title: 'Subscription Cancelled',
            message: `Your ${platformSub.plan} plan has been cancelled. You have been downgraded to the free tier.`,
            metadata: { subscriptionId: platformSub.id, gateway: 'stripe' },
          });

          logger.info(`[STRIPE WEBHOOK] Platform subscription cancelled: ${stripeSubId} for business ${platformSub.business_id}`);
        }
      }
    }

    // Platform subscription: updated (status change)
    if (event === 'customer.subscription.updated') {
      const stripeSubId = data.id as string;
      const stripeStatus = data.status as string;
      if (stripeSubId && stripeStatus) {
        const platformSub = await findPlatformSubscription(stripeSubId);
        if (platformSub) {
          const statusMap: Record<string, string> = {
            active: 'active',
            past_due: 'past_due',
            canceled: 'cancelled',
            unpaid: 'past_due',
          };
          const mappedStatus = statusMap[stripeStatus];
          if (mappedStatus && mappedStatus !== platformSub.status) {
            await supabase
              .from('subscriptions')
              .update({ status: mappedStatus })
              .eq('id', platformSub.id);

            logger.info(`[STRIPE WEBHOOK] Platform subscription status updated: ${stripeSubId} → ${mappedStatus}`);
          }
        }
      }
    }

    // ── Recurring customer subscription events ──

    // Stripe recurring invoice paid (skip if already handled by the platform subscription block above)
    if (event === 'invoice.paid' && !invoicePaidHandled) {
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

          // Fetch actual Stripe fee for recurring charge
          let recurringGatewayFee = 0;
          try {
            const recurringPiId = (data.payment_intent as string);
            if (recurringPiId && process.env.STRIPE_SECRET_KEY) {
              const piRes = await fetch(
                `https://api.stripe.com/v1/payment_intents/${recurringPiId}?expand[]=latest_charge.balance_transaction`,
                {
                  headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
                  signal: AbortSignal.timeout(10000),
                },
              );
              if (piRes.ok) {
                const pi = await piRes.json();
                const bt = pi.latest_charge?.balance_transaction;
                if (bt && typeof bt === 'object' && bt.fee) {
                  recurringGatewayFee = Math.round(bt.fee) / 100;
                }
              }
            }
          } catch (err) {
            logger.warn('[STRIPE RECURRING] Failed to fetch gateway fee:', err);
          }

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
                gateway_fee: recurringGatewayFee,
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

          // Send WhatsApp + email confirmation to customer
          if (payment) {
            try {
              await sendProactiveConfirmation(supabase, {
                id: payment.id,
                amount: amountPaid,
                booking_id: booking?.id || null,
                invoice_id: null,
                campaign_id: null,
                reservation_id: null,
                order_id: null,
              }, '[STRIPE RECURRING]');
            } catch (confirmErr) {
              logger.error('[STRIPE RECURRING] Confirmation error:', confirmErr);
            }
          }
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

