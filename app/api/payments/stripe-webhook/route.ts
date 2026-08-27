import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createHmac, timingSafeEqual } from 'crypto';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';
import { createAlert } from '@/lib/alerts/create-alert';
import { sendEmail } from '@/lib/email/client';
import { subscriptionRenewalReceiptEmail } from '@/lib/email/templates';
import { sendProactiveConfirmation } from '@/lib/payments/send-confirmation';
import { notifyCustomerChargeFailed } from '@/lib/payments/notify-charge-failed';
import { classifyInvoiceSubscription, extractInvoicePaymentIdentity } from '@/lib/payments/stripe-invoice-extractors';

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

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  let eventId: string | null = null;
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
    eventId = body.id as string;
    const data = body.data?.object as Record<string, unknown>;

    if (!data) {
      return NextResponse.json({ received: true });
    }

    const supabase = createServiceClient();

    // Idempotency: check if already processed (mark AFTER processing succeeds)
    if (eventId) {
      const { data: existingEvent } = await supabase
        .from('processed_webhook_events')
        .select('id')
        .eq('event_id', `stripe-${eventId}`)
        .maybeSingle();

      if (existingEvent) {
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
          .select('id, booking_id, invoice_id, campaign_id, reservation_id, order_id, amount, status, gateway_reference, payment_authority_version, finalization_completed_at')
          .eq('gateway_reference', sessionId)
          .single();

        // Allow new-authority success payments through for Stage 2/3 resume
        const needsReconciliation = payment && (
          payment.status !== 'success'
          || (payment.payment_authority_version != null && !payment.finalization_completed_at)
        );
        if (payment && needsReconciliation) {
          // Verify amount matches (Stripe amount_total is in cents)
          const stripeAmountCents = (data.amount_total as number) || 0;
          const stripeCurrency = ((data.currency as string) || '').toUpperCase();
          // For NGN/GHS amounts are in kobo/pesewas (100x), for USD/GBP/CAD in cents (100x)
          const expectedCents = Math.round(payment.amount * 100);
          if (stripeAmountCents > 0 && Math.abs(stripeAmountCents - expectedCents) > 1) {
            logger.withContext({ op: 'stripe-webhook.amount-mismatch', paymentId: payment.id, expectedCents, actualCents: stripeAmountCents, currency: stripeCurrency }).error('[STRIPE-WEBHOOK] Amount mismatch');
            await supabase.from('payments').update({ status: 'failed', gateway_status: 'amount_mismatch' }).eq('id', payment.id);
            return NextResponse.json({ received: true, error: 'amount_mismatch' });
          }
          // Persist non-authoritative metadata only — authority owns Stage 1 transition
          await supabase
            .from('payments')
            .update({ payment_method: 'card' })
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
            logger.withContext({ op: 'stripe-webhook.gateway-fee', ...safeLogErrorContext(err) }).warn('[STRIPE WEBHOOK] Failed to fetch gateway fee');
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

          // ── Canonical Payment Authority ──
          const { reconcilePayment } = await import('@/lib/payments/reconcile');
          await reconcilePayment(supabase, payment.id, 'webhook', {
            status: 'verified',
            result: {
              provider: 'stripe', waaiioReference: payment.gateway_reference,
              providerTransactionId: (data.payment_intent as string) || sessionId,
              amount: ((data.amount_total as number) || 0) / 100,
              currency: ((data.currency as string) || '').toUpperCase(),
              paymentMethod: 'card', gatewayFee: stripeGatewayFee,
              providerStatus: 'success', verifiedAt: new Date().toISOString(),
            },
          });
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
            const { activateStripeSubscription } = await import('@/lib/recurring/activate-subscription');
            const activation = await activateStripeSubscription(supabase, sessionId, stripeSubId);

            if (activation.result === 'db_error' || activation.result === 'inconsistent') {
              return NextResponse.json({ error: activation.detail || 'Activation failed' }, { status: 500 });
            }
            if (activation.result === 'ambiguous') {
              return NextResponse.json({ error: 'Ambiguous pending subscriptions for session' }, { status: 500 });
            }

            // Also update the payment record
            await supabase
              .from('payments')
              .update({ status: 'success', payment_method: 'card', paid_at: new Date().toISOString() })
              .eq('gateway_reference', sessionId)
              .neq('status', 'success');
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

        // Cancel any pending subscription created during this checkout.
        // Only affects pending rows — already-active rows are not touched.
        await supabase
          .from('customer_subscriptions')
          .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
          .eq('gateway_subscription_code', sessionId)
          .eq('status', 'pending');

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

    // ── invoice.paid — unified subscription role resolution (#177) ──

    // Check if a Stripe subscription ID belongs to a platform subscription
    async function findPlatformSubscription(stripeSubId: string) {
      const { data, error } = await supabase
        .from('subscriptions')
        .select('id, business_id, plan, status, amount, currency')
        .eq('stripe_subscription_id', stripeSubId)
        .maybeSingle();
      return { data, error };
    }

    if (event === 'invoice.paid') {
      // ── Step 1: Tri-state subscription classification ──
      const subClass = classifyInvoiceSubscription(data);

      if (subClass.type === 'malformed_or_conflicting') {
        logger.error('[STRIPE WEBHOOK] Subscription classification failed:', subClass);
        return NextResponse.json(
          { error: `Subscription: ${subClass.error}` },
          { status: 500 },
        );
      }

      if (subClass.type === 'not_subscription') {
        // Not a subscription invoice — skip recurring processing entirely.
        // Falls through to normal event marking.
        logger.info(`[STRIPE WEBHOOK] Non-subscription invoice.paid: ${subClass.reason}`);
      }

      if (subClass.type === 'subscription') {
        const subscriptionId = subClass.subscriptionId;

        // ── Step 2: Error-aware role resolution ──
        const { data: platformSub, error: platformErr } = await findPlatformSubscription(subscriptionId);

        if (platformErr) {
          logger.error('[STRIPE WEBHOOK] Platform subscription lookup error:', platformErr);
          return NextResponse.json({ error: 'Role resolution failed' }, { status: 500 });
        }

        const { data: customerSub, error: customerErr } = await supabase
          .from('customer_subscriptions')
          .select('*')
          .eq('gateway_subscription_code', subscriptionId)
          .eq('gateway', 'stripe')
          .in('status', ['active', 'past_due'])
          .maybeSingle();

        if (customerErr) {
          logger.error('[STRIPE WEBHOOK] Customer subscription lookup error:', customerErr);
          return NextResponse.json({ error: 'Role resolution failed' }, { status: 500 });
        }

        // Conflict: both tables match the same subscription ID
        if (platformSub && customerSub) {
          logger.error('[STRIPE WEBHOOK] CONFLICT: subscription matches both platform and customer:', subscriptionId);
          return NextResponse.json({ error: 'Ambiguous subscription role' }, { status: 500 });
        }

        if (platformSub) {
          // ── Platform subscription renewal (unchanged behavior) ──
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
        } else if (customerSub) {
          // ── Customer recurring: atomic finalization via RPC (#177) ──

          // Step 3: Validate invoice fields — reject malformed data before RPC
          const stripeInvoiceId = data.id as string;
          if (!stripeInvoiceId || typeof stripeInvoiceId !== 'string' || !stripeInvoiceId.startsWith('in_')) {
            logger.error('[STRIPE RECURRING] Malformed invoice ID:', stripeInvoiceId);
            return NextResponse.json({ error: 'Malformed invoice ID' }, { status: 500 });
          }

          const rawAmountPaid = data.amount_paid;
          if (rawAmountPaid == null || typeof rawAmountPaid !== 'number' || !Number.isInteger(rawAmountPaid) || rawAmountPaid <= 0) {
            logger.error('[STRIPE RECURRING] Malformed/missing amount_paid:', rawAmountPaid);
            return NextResponse.json({ error: 'Malformed invoice amount' }, { status: 500 });
          }
          const invoiceAmountCents = rawAmountPaid;

          const rawCurrency = data.currency;
          if (!rawCurrency || typeof rawCurrency !== 'string' || rawCurrency.trim() === '') {
            logger.error('[STRIPE RECURRING] Malformed/missing currency:', rawCurrency);
            return NextResponse.json({ error: 'Malformed invoice currency' }, { status: 500 });
          }
          const invoiceCurrency = rawCurrency.toUpperCase();

          // Extract payment identity (version-tolerant)
          const paymentIdentity = extractInvoicePaymentIdentity(data, invoiceAmountCents, invoiceCurrency);
          if ('error' in paymentIdentity) {
            logger.error('[STRIPE RECURRING] Payment identity extraction failed:', paymentIdentity);
            return NextResponse.json(
              { error: `Unsupported invoice payment shape: ${paymentIdentity.error}` },
              { status: 500 },
            );
          }

          const { paymentIntentId } = paymentIdentity;

          // Step 4: Atomic finalization RPC
          const { data: finResult, error: finErr } = await supabase.rpc(
            'finalize_stripe_recurring_charge', {
              p_subscription_id: customerSub.id,
              p_stripe_invoice_id: stripeInvoiceId,
              p_stripe_subscription_code: subscriptionId,
              p_amount_cents: invoiceAmountCents,
              p_currency: invoiceCurrency,
              p_payment_intent_id: paymentIntentId,
            });

          // Transport/DB error → retryable 5xx
          if (finErr) {
            logger.error('[STRIPE RECURRING] Finalization RPC transport error:', finErr);
            return NextResponse.json({ error: 'Finalization transport error' }, { status: 500 });
          }

          // Missing/malformed result → retryable 5xx
          if (!finResult || typeof finResult !== 'object') {
            logger.error('[STRIPE RECURRING] Finalization returned malformed result:', finResult);
            return NextResponse.json({ error: 'Finalization malformed result' }, { status: 500 });
          }

          // Accept only explicit success === true with boolean already_finalized
          if (finResult.success !== true || typeof finResult.already_finalized !== 'boolean') {
            logger.error('[STRIPE RECURRING] Finalization rejected or malformed:', finResult.reason ?? finResult);
            return NextResponse.json(
              { error: `Finalization rejected: ${finResult.reason ?? 'malformed_success'}` },
              { status: 500 },
            );
          }

          // Validate canonical fields before Stage 3
          if (typeof finResult.payment_id !== 'string' ||
              typeof finResult.booking_id !== 'string' ||
              typeof finResult.booking_ref !== 'string' ||
              typeof finResult.amount !== 'number' ||
              typeof finResult.currency !== 'string') {
            logger.error('[STRIPE RECURRING] Finalization missing canonical fields:', finResult);
            return NextResponse.json({ error: 'Finalization incomplete canonical result' }, { status: 500 });
          }

          // ── Step 5: Stage 3 — runs on BOTH fresh and replay finalization ──
          try {
            const confirmResult = await sendProactiveConfirmation(supabase, {
              id: finResult.payment_id,
              amount: finResult.amount,
              booking_id: finResult.booking_id,
              invoice_id: null,
              campaign_id: null,
              reservation_id: null,
              order_id: null,
            }, '[STRIPE RECURRING]');

            // Terminal outcomes: safe to mark event processed
            if (confirmResult.status === 'completed' ||
                confirmResult.status === 'already_completed' ||
                confirmResult.status === 'not_deliverable') {
              // Stage 3 terminal — proceed to event marking
            } else {
              // 'processing' or 'retryable_failed' — leave event retryable
              logger.warn('[STRIPE RECURRING] Stage 3 not terminal:', confirmResult.status);
              return NextResponse.json(
                { error: 'Confirmation pending' },
                { status: 500 },
              );
            }
          } catch (confirmErr) {
            logger.error('[STRIPE RECURRING] Stage 3 error:', confirmErr);
            return NextResponse.json(
              { error: 'Confirmation error' },
              { status: 500 },
            );
          }

          logger.info(`[STRIPE WEBHOOK] Customer recurring charge ${finResult.already_finalized ? 'replayed' : 'finalized'}: ${subscriptionId}, invoice: ${stripeInvoiceId}`);
        }
        // else: no Waaiio-managed subscription match — skip safely (reads succeeded)
      }
    }

    // Platform subscription: invoice.payment_failed
    if (event === 'invoice.payment_failed') {
      const subscriptionId = data.subscription as string;
      if (subscriptionId) {
        const { data: platformSub } = await findPlatformSubscription(subscriptionId);
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
        const { data: platformSub } = await findPlatformSubscription(stripeSubId);
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
        const { data: platformSub } = await findPlatformSubscription(stripeSubId);
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

    // Stripe recurring invoice payment failed
    if (event === 'invoice.payment_failed') {
      const subscriptionId = data.subscription as string;
      if (subscriptionId) {
        const { data: subs } = await supabase
          .from('customer_subscriptions')
          .select('id, failure_count, business_id, user_id, customer_phone, customer_name, amount, currency, service_id')
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

          // Notify customer via WhatsApp about the failed charge
          if (sub.customer_phone && sub.business_id) {
            try {
              await notifyCustomerChargeFailed(supabase, {
                subscriptionId: sub.id,
                businessId: sub.business_id,
                customerPhone: sub.customer_phone,
                amount: sub.amount,
                currency: sub.currency || 'USD',
                serviceId: sub.service_id,
                gateway: 'stripe',
              });
            } catch (notifyErr) {
              logger.error('[STRIPE RECURRING] Customer failure notification error:', notifyErr);
            }
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

    // Mark event as processed AFTER all financial writes succeeded
    if (eventId) {
      await supabase
        .from('processed_webhook_events')
        .upsert(
          { event_id: `stripe-${eventId}`, gateway: 'stripe', event_type: `stripe_${event}`, processed_at: new Date().toISOString() },
          { onConflict: 'event_id', ignoreDuplicates: true },
        );
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    Sentry.captureException(error);

    // Mark event as failed so Stripe retries
    if (eventId) {
      try {
        const supabase = createServiceClient();
        await supabase.from('processed_webhook_events')
          .update({
            status: 'failed',
            last_error: String(error).slice(0, 500),
            last_attempted_at: new Date().toISOString(),
          })
          .eq('event_id', `stripe-${eventId}`);
      } catch {
        // Best-effort — don't mask the original error
      }
    }

    // Return 500 so Stripe retries
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
  }
}

