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
import { getRequestId } from '@/lib/observability';
import { createWebhookLogger } from '@/lib/observability/webhooks';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const wh = createWebhookLogger('paystack', getRequestId(request));
  const startTime = performance.now();
  let eventId: string | null = null;
  try {
    const rawBody = await request.text();
    const signature = request.headers.get('x-paystack-signature') || '';
    const paystackKey = process.env.PAYSTACK_SECRET_KEY;

    // Fail-closed: reject if secret key is not configured
    if (!paystackKey) {
      wh.rejected('Webhook secret not configured');
      return NextResponse.json({ message: 'Webhook not configured' }, { status: 500 });
    }

    const hash = createHmac('sha512', paystackKey).update(rawBody).digest('hex');
    try {
      if (!timingSafeEqual(Buffer.from(hash), Buffer.from(signature))) {
        wh.rejected('Invalid signature');
        return NextResponse.json({ message: 'Invalid signature' }, { status: 400 });
      }
    } catch {
      wh.rejected('Signature comparison failed');
      return NextResponse.json({ message: 'Invalid signature' }, { status: 400 });
    }

    wh.verified();

    const body = JSON.parse(rawBody);
    const event = body.event as string;
    const data = body.data as Record<string, unknown>;
    const reference = data.reference as string;

    wh.received({ gateway: 'paystack', eventType: event, providerRef: reference });

    if (!reference) {
      wh.ignored('Missing reference');
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
      wh.duplicate({ webhookEventId: eventId || undefined });
      return NextResponse.json({ received: true }, { status: 200 });
    }

    // Already successfully processed — skip
    if (claimed.status === 'completed') {
      wh.duplicate({ webhookEventId: eventId || undefined });
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
      // Verify payment amount matches expected (Paystack sends amount in kobo)
      if (existingPayment && existingPayment.amount) {
        const webhookAmount = data.amount as number; // kobo
        const expectedAmount = Math.round(existingPayment.amount * 100); // convert to kobo
        if (Math.abs(webhookAmount - expectedAmount) > 1) {
          logger.error('[PAYSTACK] Amount mismatch', {
            expected: expectedAmount,
            received: webhookAmount,
            reference,
          });
          // Mark as failed — don't process
          await supabase.from('processed_webhook_events')
            .update({
              status: 'failed',
              last_error: `Amount mismatch: expected ${expectedAmount}, got ${webhookAmount}`,
            })
            .eq('event_id', eventId);
          return NextResponse.json({ error: 'Amount mismatch' }, { status: 200 });
        }
      }

      await processPaystackChargeSuccess(data, reference, supabase);
    } else if (event === 'charge.failed') {
      await processPaystackChargeFailed(data, reference, supabase);
    }

    // ── Capture authorization code + activate pending Paystack subscriptions ──
    // When the initial setup payment succeeds, capture the card auth and activate the subscription.
    // Uses exact reference correlation first (metadata.payment_reference), then broad phone/email fallback.
    if (event === 'charge.success') {
      const chargeAuth = data.authorization as Record<string, string> | undefined;
      const chargeCustomer = data.customer as Record<string, string> | undefined;
      const chargeReference = data.reference as string | undefined;

      if (chargeAuth?.authorization_code) {
        const authUpdate = {
          authorization_code: chargeAuth.authorization_code,
          card_last_four: chargeAuth.last4 || null,
          card_brand: chargeAuth.brand || null,
          gateway_customer_code: chargeCustomer?.customer_code || null,
        };

        // 1. Exact reference activation: find and activate the pending subscription matching the setup reference
        if (chargeReference && chargeAuth.reusable) {
          const { activatePaystackSubscription } = await import('@/lib/recurring/activate-subscription');
          const activation = await activatePaystackSubscription(supabase, chargeReference, authUpdate);

          if (activation.result === 'db_error' || activation.result === 'inconsistent') {
            return NextResponse.json({ error: activation.detail || 'Activation failed' }, { status: 500 });
          }
          if (activation.result === 'ambiguous') {
            return NextResponse.json({ error: 'Ambiguous pending subscriptions' }, { status: 500 });
          }
          // 'activated', 'idempotent', 'skipped' — all safe to continue
        }

        // 2. Legacy broad match: capture auth for any remaining subscriptions missing it
        // This does NOT activate — it only enriches auth data for already-active subs
        const custPhone = chargeCustomer?.phone || '';
        const custEmail = chargeCustomer?.email || '';
        const phoneVariants = custPhone ? [custPhone, custPhone.startsWith('+') ? custPhone.slice(1) : `+${custPhone}`] : [];
        let subQuery = supabase
          .from('customer_subscriptions')
          .update(authUpdate)
          .is('authorization_code', null)
          .eq('status', 'active'); // Only active — pending activation is handled above via exact reference

        if (phoneVariants.length > 0) {
          subQuery = subQuery.or(phoneVariants.map(p => `customer_phone.eq.${sanitizeFilterValue(p)}`).join(','));
        } else if (custEmail) {
          subQuery = subQuery.eq('customer_email', custEmail);
        }

        const { data: updated } = await subQuery.select('id');
        if (updated && updated.length > 0) {
          logger.info(`[PAYSTACK WEBHOOK] Captured auth code for ${updated.length} active subscription(s)`);
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

    // ── Recurring customer subscription events (#176) ──
    // Identity resolution: provider_reference → attempt → subscription (authoritative)
    // Provider-managed: subscription_code → exact subscription (authoritative)
    // No auth_code/customer_code best-match financial finalization.

    if (event === 'charge.success' && !existingPayment) {
      const webhookAmountKobo = data.amount as number;
      const webhookCurrency = ((data.currency as string) || 'NGN').toUpperCase();
      const webhookMetadata = data.metadata as Record<string, unknown> | undefined;
      const subscriptionRef = data.subscription as Record<string, unknown> | undefined;
      const webhookSubscriptionCode = (subscriptionRef?.subscription_code as string) || undefined;

      // Step 1: Look up existing attempt by provider_reference (covers cron-initiated + redelivery)
      const { data: existingAttempt } = await supabase
        .from('paystack_billing_attempts')
        .select('id, customer_subscription_id, intended_amount_minor, intended_currency, status')
        .eq('provider_reference', reference)
        .maybeSingle();

      if (existingAttempt) {
        if (existingAttempt.status === 'finalized') {
          logger.info(`[PAYSTACK RECURRING] Already finalized for reference ${reference}`);
        } else {
          // Metadata consistency check for cron-initiated charges
          const metaSubId = webhookMetadata?.customer_subscription_id as string | undefined;
          if (metaSubId && metaSubId !== existingAttempt.customer_subscription_id) {
            logger.error(`[PAYSTACK RECURRING] Identity conflict: attempt sub=${existingAttempt.customer_subscription_id} metadata sub=${metaSubId}`);
          } else {
            const webhookTransactionId = data.id ? String(data.id) : null;

            // Fetch invoice_code for cron-initiated attempts if subscription_code available
            let cronInvoiceCode: string | null = null;
            if (webhookSubscriptionCode && webhookTransactionId) {
              try {
                const { fetchSubscriptionInvoice } = await import('@/lib/payments/paystack-recurring');
                const invoice = await fetchSubscriptionInvoice(webhookSubscriptionCode, webhookTransactionId);
                if (invoice) cronInvoiceCode = invoice.invoiceCode;
              } catch { /* non-fatal */ }
            }

            // Finalize with full identity
            const { data: finResult, error: finErr } = await supabase.rpc('finalize_paystack_recurring_charge', {
              p_attempt_id: existingAttempt.id,
              p_provider_amount_minor: webhookAmountKobo,
              p_provider_currency: webhookCurrency,
              p_provider_transaction_id: webhookTransactionId,
              p_provider_invoice_code: cronInvoiceCode,
            });

            if (finErr) {
              logger.error('[PAYSTACK RECURRING] Finalizer RPC error:', finErr);
            } else if (finResult?.success && !finResult.already_finalized) {
              // Stage 3 confirmation (non-blocking, after commit)
              try {
                const { data: paymentRec } = await supabase.from('payments')
                  .select('id, amount, booking_id, invoice_id, campaign_id, reservation_id, order_id')
                  .eq('id', finResult.payment_id).single();
                if (paymentRec) {
                  await sendProactiveConfirmation(supabase, paymentRec, '[PAYSTACK RECURRING]');
                }
              } catch { /* non-fatal */ }
            }
          }
        }
      } else if (webhookSubscriptionCode) {
        // Step 2: Provider-managed auto-renewal — resolve by subscription_code
        const { data: localSub } = await supabase
          .from('customer_subscriptions')
          .select('id, amount, currency, frequency')
          .eq('gateway_subscription_code', webhookSubscriptionCode)
          .eq('gateway', 'paystack')
          .maybeSingle();

        if (localSub) {
          const webhookTransactionId = data.id ? String(data.id) : undefined;

          // Fetch authoritative invoice_code for billing-cycle identity (#176)
          let invoiceCode: string | null = null;
          try {
            const { fetchSubscriptionInvoice } = await import('@/lib/payments/paystack-recurring');
            const invoice = await fetchSubscriptionInvoice(webhookSubscriptionCode, webhookTransactionId);
            if (invoice) invoiceCode = invoice.invoiceCode;
          } catch (invoiceErr) {
            logger.error('[PAYSTACK RECURRING] Invoice fetch error:', invoiceErr);
          }

          // Cycle key: invoice_code is authoritative cycle discriminator.
          // Falls back to reference if invoice unavailable (each reference treated as distinct cycle).
          const cycleDiscriminator = invoiceCode || reference;
          const providerCycleKey = `ps-auto-${localSub.id}-${cycleDiscriminator}`;

          // Check if already finalized for this cycle
          const { data: existingFinalized } = await supabase
            .from('paystack_billing_attempts')
            .select('id, canonical_payment_id')
            .eq('customer_subscription_id', localSub.id)
            .eq('cycle_key', providerCycleKey)
            .eq('status', 'finalized')
            .maybeSingle();

          if (existingFinalized) {
            logger.info(`[PAYSTACK RECURRING] Already finalized for cycle ${providerCycleKey}`);
          } else {
            // Check for existing unresolved attempt for this cycle (same invoice, possibly different ref)
            const { data: existingUnresolved } = await supabase
              .from('paystack_billing_attempts')
              .select('id, provider_reference, status')
              .eq('customer_subscription_id', localSub.id)
              .eq('cycle_key', providerCycleKey)
              .in('status', ['reserved', 'dispatched', 'charged'])
              .maybeSingle();

            let attemptIdToFinalize: string | undefined;

            if (existingUnresolved) {
              // Same cycle (invoice), convergence — finalize existing attempt
              // Mark as charged with latest provider evidence
              await supabase.from('paystack_billing_attempts')
                .update({
                  status: 'charged',
                  charged_at: new Date().toISOString(),
                  provider_transaction_id: webhookTransactionId || null,
                  provider_invoice_code: invoiceCode,
                })
                .eq('id', existingUnresolved.id)
                .in('status', ['reserved', 'dispatched', 'charged']);
              attemptIdToFinalize = existingUnresolved.id;
              logger.info(`[PAYSTACK RECURRING] Converging ref ${reference} into existing attempt ${existingUnresolved.id} for cycle ${providerCycleKey}`);
            } else {
              // Create new attempt for this cycle
              const { error: insertErr } = await supabase.from('paystack_billing_attempts').insert({
                customer_subscription_id: localSub.id,
                cycle_key: providerCycleKey,
                scheduled_at: new Date().toISOString(),
                attempt_number: 1,
                provider_reference: reference,
                intended_amount_minor: Math.round(localSub.amount * 100),
                intended_currency: localSub.currency || 'NGN',
                status: 'charged',
                charged_at: new Date().toISOString(),
                provider_transaction_id: webhookTransactionId || null,
                provider_invoice_code: invoiceCode,
              });

              if (!insertErr) {
                const { data: newAttempt } = await supabase
                  .from('paystack_billing_attempts')
                  .select('id')
                  .eq('provider_reference', reference)
                  .single();
                if (newAttempt) attemptIdToFinalize = newAttempt.id;
              } else {
                // Unique constraint (likely concurrent delivery) — check if already finalized
                const { data: raceFinalized } = await supabase
                  .from('paystack_billing_attempts')
                  .select('id')
                  .eq('customer_subscription_id', localSub.id)
                  .eq('cycle_key', providerCycleKey)
                  .eq('status', 'finalized')
                  .maybeSingle();
                if (raceFinalized) {
                  logger.info(`[PAYSTACK RECURRING] Race: cycle ${providerCycleKey} already finalized by concurrent worker`);
                } else {
                  logger.info(`[PAYSTACK RECURRING] Attempt insert failed (concurrent processing): ${reference}`);
                }
              }
            }

            // Finalize with full mutually-consistent identity
            if (attemptIdToFinalize) {
              const { data: finResult, error: finErr } = await supabase.rpc('finalize_paystack_recurring_charge', {
                p_attempt_id: attemptIdToFinalize,
                p_provider_amount_minor: webhookAmountKobo,
                p_provider_currency: webhookCurrency,
                p_provider_transaction_id: webhookTransactionId || null,
                p_provider_invoice_code: invoiceCode,
              });

              if (finErr) {
                logger.error('[PAYSTACK RECURRING] Provider-managed finalizer error:', finErr);
              } else if (finResult?.success && !finResult.already_finalized) {
                try {
                  const { data: paymentRec } = await supabase.from('payments')
                    .select('id, amount, booking_id, invoice_id, campaign_id, reservation_id, order_id')
                    .eq('id', finResult.payment_id).single();
                  if (paymentRec) {
                    await sendProactiveConfirmation(supabase, paymentRec, '[PAYSTACK RECURRING]');
                  }
                } catch { /* non-fatal */ }
              }
            }
          }
        } else {
          logger.warn(`[PAYSTACK RECURRING] No local subscription for subscription_code: ${webhookSubscriptionCode}`);
        }
      } else {
        // No matching attempt AND no subscription_code → fail closed
        // Preserve as durable unresolved evidence for reconciliation
        const authorization = data.authorization as Record<string, string> | undefined;
        const customerData = data.customer as Record<string, string> | undefined;
        await supabase.from('processed_webhook_events').upsert({
          event_id: `paystack-unresolved-${reference}`,
          gateway: 'paystack',
          event_type: 'unresolved_recurring_charge',
          status: 'reconciliation_required',
          first_received_at: new Date().toISOString(),
          last_attempted_at: new Date().toISOString(),
          last_error: JSON.stringify({
            reference,
            amount_kobo: webhookAmountKobo,
            currency: webhookCurrency,
            auth_code: authorization?.authorization_code,
            customer_code: customerData?.customer_code,
          }),
        }, { onConflict: 'event_id', ignoreDuplicates: true });
        logger.warn(`[PAYSTACK RECURRING] Unresolved charge.success preserved as reconciliation_required — ref: ${reference}`);
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

    wh.processed({ webhookEventId: eventId || undefined, durationMs: Math.round(performance.now() - startTime) });
    return NextResponse.json({ received: true });
  } catch (error) {
    Sentry.captureException(error);
    wh.failed(error, { webhookEventId: eventId || undefined, durationMs: Math.round(performance.now() - startTime) });

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
