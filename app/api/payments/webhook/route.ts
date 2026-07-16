import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createHmac, timingSafeEqual } from 'crypto';
import { createServiceClient } from '@/lib/supabase/service';
import { processPaystackChargeSuccess, processPaystackChargeFailed } from '@/lib/payments/webhook-handler';
import { sendProactiveConfirmation } from '@/lib/payments/send-confirmation';
import { notifyCustomerChargeFailed } from '@/lib/payments/notify-charge-failed';
import { createAlert } from '@/lib/alerts/create-alert';
import { subscriptionRenewalReceiptEmail } from '@/lib/email/templates';
import { sendEmail } from '@/lib/email/client';
import { logger } from '@/lib/logger';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';

export async function POST(request: NextRequest) {
  let eventId: string | null = null;
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

    // ── State machine: atomically claim the event ──
    eventId = `paystack-${reference}`;
    const { data: claimed, error: claimError } = await supabase
      .from('processed_webhook_events')
      .upsert({
        event_id: eventId,
        gateway: 'paystack',
        event_type: event,
        status: 'processing',
        attempts: 1,
        first_received_at: new Date().toISOString(),
        last_attempted_at: new Date().toISOString(),
      }, {
        onConflict: 'event_id',
        ignoreDuplicates: false,
      })
      .select('id, status, attempts')
      .single();

    // Unique constraint violation = another instance is processing
    if (claimError) {
      logger.warn('[PAYSTACK] Event already being processed:', eventId);
      return NextResponse.json({ received: true }, { status: 200 });
    }

    // Already successfully processed — skip
    if (claimed.status === 'completed') {
      return NextResponse.json({ received: true }, { status: 200 });
    }

    // Retry of a previously failed event — allow it, bump attempts
    if (claimed.status === 'processing' && claimed.attempts > 1) {
      await supabase.from('processed_webhook_events')
        .update({ attempts: claimed.attempts + 1, last_attempted_at: new Date().toISOString() })
        .eq('event_id', eventId);
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

    // Recurring charge success: use atomic RPC for booking + payment + fee + subscription update
    if (event === 'charge.success') {
      const authorization = data.authorization as Record<string, string> | undefined;
      const customerData = data.customer as Record<string, string> | undefined;
      const authCode = authorization?.authorization_code;
      const custCode = customerData?.customer_code;

      if ((authCode || custCode) && !existingPayment) {
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
        } else {
          // Call atomic RPC — all financial writes in a single transaction
          const recurringEventId = `paystack-recurring-${reference}`;
          const { data: rpcResult, error: rpcError } = await supabase.rpc('process_recurring_charge', {
            p_event_id: recurringEventId,
            p_event_type: event,
            p_gateway_ref: reference,
            p_auth_code: authCode || null,
            p_cust_code: custCode || null,
            p_amount_kobo: data.amount as number,
            p_currency: (data.currency as string) || 'NGN',
            p_channel: (data.channel as string) || 'card',
            p_card_last_four: authorization?.last4 || null,
            p_card_brand: authorization?.brand || null,
          });

          if (rpcError) {
            logger.error('[PAYSTACK RECURRING] Atomic RPC error:', rpcError);
          } else if (rpcResult?.success) {
            // Non-critical notifications OUTSIDE the transaction
            try {
              await sendProactiveConfirmation(supabase, {
                id: rpcResult.payment_id,
                amount: rpcResult.amount,
                booking_id: rpcResult.booking_id || null,
                invoice_id: null,
                campaign_id: null,
                reservation_id: null,
                order_id: null,
              }, '[PAYSTACK RECURRING]');
            } catch (confirmErr) {
              logger.error('[PAYSTACK RECURRING] Confirmation error:', confirmErr);
            }

            // Send receipt image to customer (non-blocking)
            if (rpcResult.booking_ref && rpcResult.customer_phone) {
              try {
                const resolver = new (await import('@/lib/channels/channel-resolver')).ChannelResolver(supabase);
                const resolved = await resolver.resolveByBusinessId(rpcResult.business_id);
                if (resolved) {
                  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
                  const phone = (rpcResult.customer_phone as string).startsWith('+')
                    ? (rpcResult.customer_phone as string).slice(1)
                    : rpcResult.customer_phone;
                  await resolved.sender.sendImage({
                    to: phone,
                    imageUrl: `${appUrl}/api/receipts/image?ref=${rpcResult.booking_ref}`,
                    caption: `🧾 Receipt — ${rpcResult.booking_ref}`,
                  });
                }
              } catch (receiptErr) {
                logger.error('[PAYSTACK RECURRING] Receipt image error:', receiptErr);
              }
            }
          } else if (rpcResult?.skipped) {
            logger.info(`[PAYSTACK RECURRING] Skipped: ${rpcResult.reason}`);
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

    // ── Mark event as completed after all financial writes succeeded ──
    await supabase.from('processed_webhook_events')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('event_id', eventId);

    return NextResponse.json({ received: true });
  } catch (error) {
    Sentry.captureException(error);

    // Mark event as failed so Paystack can retry
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

    // Return 500 so Paystack retries
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
  }
}
