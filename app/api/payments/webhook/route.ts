import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createHmac, timingSafeEqual } from 'crypto';
import { createServiceClient } from '@/lib/supabase/service';
import { processPaystackChargeSuccess, processPaystackChargeFailed } from '@/lib/payments/webhook-handler';
import { normalizePaystackCardAuthorization, persistPaystackCardAuthorization } from '@/lib/payments/paystack-card-authorization';
import { sendProactiveConfirmation } from '@/lib/payments/send-confirmation';
import { notifyCustomerChargeFailed } from '@/lib/payments/notify-charge-failed';
import { createAlert } from '@/lib/alerts/create-alert';
import { subscriptionRenewalReceiptEmail } from '@/lib/email/templates';
import { sendEmail } from '@/lib/email/client';
import { logger } from '@/lib/logger';
import { getRequestId } from '@/lib/observability';
import { createWebhookLogger } from '@/lib/observability/webhooks';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';
import { resolveChargeRole, type ResolverResult } from '@/lib/payments/charge-role-resolver';

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

    // ── Subscription lifecycle events ──
    // R8: Route ALL recognized subscription lifecycle events through this handler,
    // regardless of whether data.reference is present. Paystack subscription events
    // typically lack data.reference, but invoice events may include one. Without
    // this routing, reference-bearing lifecycle events would fall through to legacy
    // handlers that set past_due (dead-end) or immediate cancellation/suspension,
    // bypassing our paid-through protections.
    //
    // Idempotency: uses subscription_code-based keys (separate from the reference-
    // based keys used by charge.success). charge.success events are NOT in this
    // list and continue through the established reference-based path.
    const SUBSCRIPTION_LIFECYCLE_EVENTS = ['subscription.create', 'subscription.not_renew', 'subscription.disable', 'invoice.payment_failed'];
    if (SUBSCRIPTION_LIFECYCLE_EVENTS.includes(event)) {
      const supabase = createServiceClient();
      // Paystack places subscription_code at top-level for subscription events,
      // but invoice events may nest it under data.subscription.subscription_code.
      const subCode = (data.subscription_code as string | undefined)
        || (data.subscription as Record<string, unknown> | undefined)?.subscription_code as string | undefined;
      // Invoice events: use invoice_code (provider-assigned, unique per billing cycle).
      // Fall back to id if invoice_code absent; reject if neither exists.
      const invoiceId = (event === 'invoice.payment_failed')
        ? (data.invoice_code as string || '')
        : '';
      const subEventId = subCode
        ? `paystack-${event}-${subCode}${invoiceId ? `-${invoiceId}` : ''}`
        : null;

      if (!subEventId) {
        // Authentically signed but missing subscription_code — log and accept.
        // Paystack sends subscription_code on all subscription events; absence
        // indicates a malformed but genuine event. Accept to prevent infinite retries.
        wh.ignored('Subscription event without subscription_code');
        return NextResponse.json({ received: true });
      }

      // R7: invoice.payment_failed without invoice_code — cannot safely deduplicate
      // across billing cycles. Use a stable Paystack-provided identity if available
      // (data.id is the Paystack event/object ID, deterministic across retries).
      // Must confirm durable recording before acknowledging with HTTP 200.
      if (event === 'invoice.payment_failed' && !invoiceId) {
        const paystackId = data.id as string | number | undefined;
        // R8: stable quarantine key. With data.id → unique per provider event.
        // Without data.id → falls back to subscription_code only. This merges
        // distinct billing cycles into one quarantine record. This is a documented
        // limitation: manual reconciliation is required to distinguish cycles.
        // Full per-cycle dedup is only possible with invoice_code or data.id.
        const quarantineId = paystackId
          ? `paystack-invoice.payment_failed-${subCode}-pid-${paystackId}`
          : `paystack-invoice.payment_failed-${subCode}-nocode`;
        logger.warn('[PAYSTACK-WEBHOOK] invoice.payment_failed missing invoice_code — quarantining', { subCode, quarantineId });

        const supabase = createServiceClient();
        const { error: qErr } = await supabase.from('processed_webhook_events').upsert({
          event_id: quarantineId,
          gateway: 'paystack',
          event_type: 'invoice.payment_failed',
          status: 'failed',
          attempts: 1,
          first_received_at: new Date().toISOString(),
          last_attempted_at: new Date().toISOString(),
          last_error: 'Missing invoice_code — cannot safely deduplicate. Quarantined for manual review.',
          correlation_id: subCode || null,
        }, { onConflict: 'event_id', ignoreDuplicates: true });

        if (qErr) {
          // R7: durable recording failed — return 500 so Paystack retries
          logger.error('[PAYSTACK-WEBHOOK] quarantine insert failed — returning 500', { quarantineId, error: qErr.message });
          return NextResponse.json({ error: 'Quarantine failed' }, { status: 500 });
        }
        // Durably recorded — safe to acknowledge
        return NextResponse.json({ received: true });
      }

      // Atomic idempotency claim via established M362 claim_webhook_event RPC.
      // INSERT-or-reclaim with FOR UPDATE row lock: never overwrites completed events,
      // rejects concurrent processing, allows retry of stale/failed events.
      const { data: claimResult, error: claimErr } = await supabase.rpc('claim_webhook_event', {
        p_event_id: subEventId,
        p_gateway: 'paystack',
        p_event_type: event,
      });

      if (claimErr) {
        // Transient DB failure — return 500 so Paystack retries later.
        // The event is not claimed, so a retry will attempt a fresh claim.
        logger.error('[PAYSTACK-WEBHOOK] claim_webhook_event RPC failed', { subEventId, error: claimErr.message });
        return NextResponse.json({ error: 'Claim failed' }, { status: 500 });
      }

      const claim = claimResult as { claimed: boolean; reason?: string; claim_token?: string };
      if (!claim.claimed) {
        wh.duplicate({ webhookEventId: subEventId });
        if (claim.reason === 'already_completed') {
          // R6-2: Event durably completed — safe to ACK and stop retries
          logger.info('[PAYSTACK-WEBHOOK] subscription event already completed', { subEventId });
          return NextResponse.json({ received: true });
        }
        // R6-2: active_processing or other non-completed reason — return 500 so
        // Paystack retries. If the in-flight worker crashes without completing,
        // the 90s stale threshold allows the retry to reclaim the event.
        logger.info('[PAYSTACK-WEBHOOK] subscription event not claimable', { subEventId, reason: claim.reason });
        return NextResponse.json({ error: 'Event in progress' }, { status: 500 });
      }

      let processingSucceeded = false;
      try {
        // ── Dual-table subscription routing ──
        // Query BOTH platform (subscriptions) and customer (customer_subscriptions)
        // tables in parallel. No platform-first preference. Detect ambiguous matches.
        // No status filter — handler logic decides what to do with terminal states.
        // subscription.create uses customer_code linking (no subCode match required).
        const isCreateEvent = event === 'subscription.create';

        const [platformResult, customerResult] = await Promise.all([
          // For subscription.create, match by customer_code (subCode not yet persisted).
          // For other events, match by persisted subscription_code.
          isCreateEvent
            ? (async () => {
                const custCode = (data.customer as Record<string, string> | undefined)?.customer_code;
                if (!custCode) return { data: null, error: null } as { data: null; error: null };
                return supabase
                  .from('subscriptions')
                  .select('id, business_id, paystack_subscription_code, current_period_end, status')
                  .eq('paystack_customer_code', custCode)
                  .eq('gateway', 'paystack')
                  .eq('status', 'active')
                  .maybeSingle();
              })()
            : subCode
              ? supabase
                  .from('subscriptions')
                  .select('id, business_id, paystack_subscription_code, current_period_end, status')
                  .eq('paystack_subscription_code', subCode)
                  .maybeSingle()
              : Promise.resolve({ data: null, error: null } as { data: null; error: null }),
          // Customer subscriptions always match by gateway_subscription_code.
          // subscription.create does not need customer matching (codes set app-side).
          (isCreateEvent || !subCode)
            ? Promise.resolve({ data: null, error: null } as { data: null; error: null })
            : supabase
                .from('customer_subscriptions')
                .select('id, business_id, user_id, service_id, amount, currency, customer_phone, customer_name, failure_count, gateway_subscription_code, next_charge_at, status')
                .eq('gateway_subscription_code', subCode)
                .eq('gateway', 'paystack')
                .maybeSingle(),
        ]);

        // Distinguish DB errors from zero matches
        if (platformResult.error || customerResult.error) {
          logger.error('[PAYSTACK-WEBHOOK] subscription lookup DB error', {
            subCode, event,
            platformError: platformResult.error?.message,
            customerError: customerResult.error?.message,
          });
          // Return 500 without marking event as failed — claim stays active,
          // stale threshold allows retry reclaim after 90s.
          return NextResponse.json({ error: 'Subscription lookup failed' }, { status: 500 });
        }

        // Detect ambiguous match (same code in both tables) — fail-closed
        if (platformResult.data && customerResult.data) {
          logger.error('[PAYSTACK-WEBHOOK] AMBIGUOUS: subscription_code matches both tables', {
            subCode, event,
            platformId: platformResult.data.id,
            customerId: customerResult.data.id,
          });
          // Do not process — leave as retryable failure for manual reconciliation.
          // processingSucceeded stays false → event marked failed with evidence.
        }

        const targetModel: 'platform' | 'customer' | null =
          (platformResult.data && !customerResult.data) ? 'platform'
          : (customerResult.data && !platformResult.data) ? 'customer'
          : null; // null = unmatched or ambiguous

        // ── subscription.create — platform only ──
        // Customer subscription codes are set during app-side activation
        // (lib/recurring/activate-subscription.ts), not via webhook.
        if (event === 'subscription.create') {
          if (targetModel === 'platform') {
            const sub = platformResult.data!;
            const custCode = (data.customer as Record<string, string> | undefined)?.customer_code;

            if (sub.paystack_subscription_code && sub.paystack_subscription_code !== subCode) {
              logger.warn('[PAYSTACK-WEBHOOK] subscription.create: existing code differs, skipping', {
                subCode, existing: sub.paystack_subscription_code, subscriptionId: sub.id,
              });
            } else {
              const updateResult = await supabase
                .from('subscriptions')
                .update({ paystack_subscription_code: subCode, updated_at: new Date().toISOString() }, { count: 'exact' })
                .eq('id', sub.id)
                .is('paystack_subscription_code', null);

              if (updateResult.error) {
                logger.error('[PAYSTACK-WEBHOOK] subscription.create: update failed', { error: updateResult.error.message, subscriptionId: sub.id });
              } else if (updateResult.count === 1) {
                processingSucceeded = true;
                logger.info('[PAYSTACK-WEBHOOK] subscription.create: linked by customer_code', { subCode, custCode, subscriptionId: sub.id });
              } else {
                const { data: verify } = await supabase
                  .from('subscriptions')
                  .select('paystack_subscription_code')
                  .eq('id', sub.id)
                  .single();
                if (verify?.paystack_subscription_code === subCode) {
                  processingSucceeded = true;
                  logger.info('[PAYSTACK-WEBHOOK] subscription.create: already set to same code', { subCode, subscriptionId: sub.id });
                } else {
                  logger.warn('[PAYSTACK-WEBHOOK] subscription.create: conditional update affected 0 rows', {
                    subCode, subscriptionId: sub.id, storedCode: verify?.paystack_subscription_code,
                  });
                }
              }
            }
          }
          if (!processingSucceeded) {
            // No platform match by customer_code — leave as failed for manual reconciliation.
            // No customer subscription.create handler needed (codes set app-side).
            const custCode = (data.customer as Record<string, string> | undefined)?.customer_code;
            logger.warn('[PAYSTACK-WEBHOOK] subscription.create: no matching DB subscription by customer_code', {
              subCode, custCode,
              custEmail: (data.customer as Record<string, string> | undefined)?.email,
            });
          }
        }

        // ── subscription.not_renew / subscription.disable ──
        if (event === 'subscription.not_renew' || event === 'subscription.disable') {
          if (targetModel === 'platform') {
            // Platform: record cancellation intent, keep status active (paid-through).
            // Expiry cron handles downgrade after current_period_end.
            const sub = platformResult.data!;
            if (['active', 'past_due'].includes(sub.status)) {
              const { error: updateErr } = await supabase
                .from('subscriptions')
                .update({
                  cancelled_at: new Date().toISOString(),
                  cancellation_reason: event === 'subscription.disable' ? 'provider_disabled' : 'customer_cancelled',
                  updated_at: new Date().toISOString(),
                })
                .eq('id', sub.id);

              if (updateErr) {
                logger.error(`[PAYSTACK-WEBHOOK] ${event}: platform update failed`, { error: updateErr.message, subscriptionId: sub.id });
              } else {
                processingSucceeded = true;
                logger.info(`[PAYSTACK-WEBHOOK] ${event}: platform cancellation recorded (paid through ${sub.current_period_end})`, {
                  subCode, subscriptionId: sub.id, businessId: sub.business_id,
                });
              }
            } else {
              // Already cancelled/expired — idempotent accept
              processingSucceeded = true;
              logger.info(`[PAYSTACK-WEBHOOK] ${event}: platform subscription already terminal (${sub.status})`, { subCode, subscriptionId: sub.id });
            }
          } else if (targetModel === 'customer') {
            const cs = customerResult.data!;
            if (['active', 'paused', 'past_due'].includes(cs.status)) {
              if (event === 'subscription.disable') {
                // Provider-terminated: immediately cancel (legacy behavior, lines 1205-1217)
                const { error: updateErr } = await supabase
                  .from('customer_subscriptions')
                  .update({
                    status: 'cancelled',
                    cancelled_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                  })
                  .eq('id', cs.id);

                if (updateErr) {
                  logger.error(`[PAYSTACK-WEBHOOK] subscription.disable: customer update failed`, { error: updateErr.message, subscriptionId: cs.id });
                } else {
                  processingSucceeded = true;
                  logger.info('[PAYSTACK-WEBHOOK] subscription.disable: customer subscription cancelled', { subCode, subscriptionId: cs.id });
                }
              } else {
                // subscription.not_renew: customer-initiated graceful cancellation.
                // Record cancellation intent; preserve status if within paid period
                // (next_charge_at is the paid-through boundary for customer subs).
                // Cron retry-failed-charges handles terminal cancellation at failure_count >= 3.
                const { error: updateErr } = await supabase
                  .from('customer_subscriptions')
                  .update({
                    cancelled_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                  })
                  .eq('id', cs.id);

                if (updateErr) {
                  logger.error('[PAYSTACK-WEBHOOK] subscription.not_renew: customer update failed', { error: updateErr.message, subscriptionId: cs.id });
                } else {
                  processingSucceeded = true;
                  logger.info('[PAYSTACK-WEBHOOK] subscription.not_renew: customer cancellation recorded', {
                    subCode, subscriptionId: cs.id, paidThrough: cs.next_charge_at,
                  });
                }
              }
            } else {
              // Already cancelled/expired — idempotent accept
              processingSucceeded = true;
              logger.info(`[PAYSTACK-WEBHOOK] ${event}: customer subscription already terminal (${cs.status})`, { subCode, subscriptionId: cs.id });
            }
          }
        }

        // ── invoice.payment_failed ──
        if (event === 'invoice.payment_failed') {
          if (targetModel === 'platform') {
            // R5-1: Platform subs — do NOT set past_due. Keep active, create alert.
            // Cron expiry handles downgrade after current_period_end.
            const sub = platformResult.data!;
            if (['active', 'past_due'].includes(sub.status)) {
              try {
                await createAlert(supabase, {
                  businessId: sub.business_id,
                  type: 'payment_failed',
                  title: 'Subscription payment failed',
                  message: 'Your subscription renewal payment failed. We will retry automatically.',
                  severity: 'warning',
                });
              } catch (alertErr) {
                logger.warn('[PAYSTACK-WEBHOOK] invoice.payment_failed: platform alert creation failed (non-critical)', {
                  error: alertErr instanceof Error ? alertErr.message : 'unknown',
                });
              }
              processingSucceeded = true;
              logger.info('[PAYSTACK-WEBHOOK] invoice.payment_failed: platform alert recorded (subscription stays active)', { subCode, subscriptionId: sub.id });
            } else {
              processingSucceeded = true; // Terminal state — accept idempotently
            }
          } else if (targetModel === 'customer') {
            // Customer subs: increment failure_count, use past_due at threshold (legacy behavior).
            // Cron retry-failed-charges retries past_due subs; cancels at failure_count >= 3.
            const cs = customerResult.data!;
            if (['active', 'past_due'].includes(cs.status)) {
              // ── Idempotent failure recording ──
              // If a previous attempt incremented failure_count but crashed before
              // complete_webhook_event, the claim becomes stale and Paystack retries.
              // Use the charge record (keyed by subEventId in gateway_reference) as
              // the durable marker: if it exists, this event was already processed.
              const { data: existingCharge, error: chargeLookupErr } = await supabase
                .from('subscription_charges')
                .select('id')
                .eq('gateway_reference', subEventId)
                .maybeSingle();

              if (chargeLookupErr) {
                logger.error('[PAYSTACK-WEBHOOK] invoice.payment_failed: charge lookup failed', { error: chargeLookupErr.message });
                // Cannot determine if already processed — fail safely for retry
              } else if (existingCharge) {
                // Already processed by a prior attempt that crashed before completion.
                // Skip increment and side effects — just complete the webhook event.
                processingSucceeded = true;
                logger.info('[PAYSTACK-WEBHOOK] invoice.payment_failed: idempotent replay — charge record exists', {
                  subCode, subscriptionId: cs.id, chargeId: existingCharge.id,
                });
              } else {
                // First time processing this event.
                // Insert the charge record FIRST (durable marker), then increment failure_count.
                const newFailCount = (cs.failure_count || 0) + 1;

                const { error: chargeErr } = await supabase.from('subscription_charges').insert({
                  subscription_id: cs.id,
                  business_id: cs.business_id || '',
                  user_id: cs.user_id || '',
                  amount: 0,
                  currency: (data.currency as string) || 'NGN',
                  status: 'failed',
                  gateway: 'paystack',
                  gateway_reference: subEventId,
                  failure_reason: (data.gateway_response as string) || 'Payment failed',
                  created_at: new Date().toISOString(),
                });

                if (chargeErr) {
                  logger.error('[PAYSTACK-WEBHOOK] invoice.payment_failed: charge insert failed', { error: chargeErr.message });
                  // Cannot safely increment without durable marker — fail for retry
                } else {
                  // Charge record is durable — now safe to increment failure_count.
                  // On replay, the charge lookup above will detect the existing record.
                  const { error: updateErr } = await supabase
                    .from('customer_subscriptions')
                    .update({
                      failure_count: newFailCount,
                      status: newFailCount >= 3 ? 'past_due' : cs.status,
                      updated_at: new Date().toISOString(),
                    })
                    .eq('id', cs.id);

                  if (updateErr) {
                    logger.error('[PAYSTACK-WEBHOOK] invoice.payment_failed: customer update failed', { error: updateErr.message, subscriptionId: cs.id });
                    // Charge record exists but failure_count not incremented.
                    // On retry, charge lookup finds existing record → skips increment.
                    // This leaves failure_count potentially under-counted by 1 for this event,
                    // but avoids double-increment. Manual reconciliation if needed.
                  } else {
                    // Alert business owner (best-effort — durable state already committed)
                    if (cs.business_id) {
                      try {
                        await createAlert(supabase, {
                          businessId: cs.business_id,
                          type: 'subscription_payment_failed',
                          severity: newFailCount >= 3 ? 'critical' : 'warning',
                          title: 'Subscription Payment Failed',
                          message: `Recurring payment failed (attempt ${newFailCount}). ${newFailCount >= 3 ? 'Subscription is now past due.' : 'We will retry.'}`,
                          metadata: { subscriptionId: cs.id, failureCount: newFailCount, gateway: 'paystack' },
                        });
                      } catch (alertErr) {
                        logger.warn('[PAYSTACK-WEBHOOK] invoice.payment_failed: customer alert failed (non-critical)', {
                          error: alertErr instanceof Error ? alertErr.message : 'unknown',
                        });
                      }
                    }

                    // Notify customer via WhatsApp (best-effort)
                    if (cs.customer_phone && cs.business_id) {
                      try {
                        await notifyCustomerChargeFailed(supabase, {
                          subscriptionId: cs.id,
                          businessId: cs.business_id,
                          customerPhone: cs.customer_phone,
                          amount: cs.amount,
                          currency: cs.currency || 'NGN',
                          serviceId: cs.service_id,
                          gateway: 'paystack',
                        });
                      } catch (notifyErr) {
                        logger.error('[PAYSTACK-WEBHOOK] invoice.payment_failed: customer notification failed (non-critical)', notifyErr);
                      }
                    }

                    processingSucceeded = true;
                    logger.info('[PAYSTACK-WEBHOOK] invoice.payment_failed: customer failure recorded', {
                      subCode, subscriptionId: cs.id, failureCount: newFailCount,
                      escalated: newFailCount >= 3,
                    });
                  }
                }
              }
            } else {
              processingSucceeded = true; // Terminal state — accept idempotently
            }
          }
        }

        // R6-1: Durable completion before HTTP acknowledgment.
        // Only return 200 after confirmed durable completion. If the completion
        // RPC fails or the claim was lost, return 500 so Paystack retries.
        if (processingSucceeded) {
          const { data: completed, error: completeErr } = await supabase.rpc('complete_webhook_event', {
            p_event_id: subEventId,
            p_claim_token: claim.claim_token,
          });
          if (completeErr) {
            logger.error('[PAYSTACK-WEBHOOK] complete_webhook_event RPC failed', { subEventId, error: completeErr.message });
            return NextResponse.json({ error: 'Completion failed' }, { status: 500 });
          }
          if (!completed) {
            // Claim lost — another instance may have completed it. Check actual state.
            logger.warn('[PAYSTACK-WEBHOOK] complete_webhook_event returned false — claim lost', { subEventId });
            // If another instance already completed it, that's fine — return 200
            // If the claim was stolen, returning 500 is safe (Paystack retries, claim_webhook_event
            // will see 'completed' and return already_completed → 200 next time)
            return NextResponse.json({ error: 'Claim lost' }, { status: 500 });
          }
          return NextResponse.json({ received: true });
        }

        // Processing did not succeed — record failure and return 500 for retry
        const { error: failErr } = await supabase.rpc('fail_webhook_event', {
          p_event_id: subEventId,
          p_claim_token: claim.claim_token,
          p_error: 'Processing did not confirm success',
        });
        if (failErr) {
          logger.error('[PAYSTACK-WEBHOOK] fail_webhook_event RPC failed', { subEventId, error: failErr.message });
        }
        return NextResponse.json({ error: 'Processing incomplete' }, { status: 500 });

      } catch (subErr) {
        const msg = subErr instanceof Error ? subErr.message : 'Unknown error';
        logger.error(`[PAYSTACK-WEBHOOK] ${event} handler failed`, { subEventId, error: msg });
        try {
          await supabase.rpc('fail_webhook_event', {
            p_event_id: subEventId,
            p_claim_token: claim.claim_token,
            p_error: msg.slice(0, 500),
          });
        } catch { /* best-effort failure recording */ }
        return NextResponse.json({ error: 'Handler failed' }, { status: 500 });
      }
    }

    // ── Charge/transaction events require data.reference ──
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
      // A replay can carry authorization data omitted from the first delivery.
      // Enrich the canonical payment only; do not replay confirmation effects.
      if (event === 'charge.success') {
        const authorization = normalizePaystackCardAuthorization(data.authorization, data.customer);
        if (authorization) {
          const { data: payment } = await supabase.from('payments')
            .select('id')
            .eq('gateway_reference', reference)
            .eq('gateway', 'paystack')
            .maybeSingle();
          if (payment) {
            await persistPaystackCardAuthorization(
              supabase, payment.id, Number(data.amount) / 100,
              typeof data.currency === 'string' ? data.currency : '', authorization,
            );
          }
        }
      }
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
    // Bridge v3.1 (#191): Use .maybeSingle() so resolver can distinguish
    // "no payment exists" (data:null, error:null) from "query failed" (error:{...}).
    const { data: existingPayment, error: paymentLookupError } = await supabase
      .from('payments')
      .select('id, status, amount, booking_id, gateway')
      .eq('gateway_reference', reference)
      .maybeSingle();

    // ── Bridge v3.1: Read-only role resolver for charge.success (#191) ──
    // Classifies charge.success into roles A–F BEFORE financial mutation.
    // Only D/E require migration-337. A/B/C/F preserve existing behavior.
    let chargeRole: ResolverResult | null = null;
    if (event === 'charge.success') {
      chargeRole = await resolveChargeRole(reference, data, existingPayment, paymentLookupError, supabase);

      if (!chargeRole.ok) {
        // RESOLVER_ERROR (503 retryable) or CONFLICT (500 data integrity)
        const httpStatus = chargeRole.reason === 'CONFLICT' ? 500 : 503;
        await supabase.from('processed_webhook_events').update({
          status: 'failed',
          last_error: `Bridge ${chargeRole.reason}: ${chargeRole.detail.slice(0, 300)}`,
          last_attempted_at: new Date().toISOString(),
        }).eq('event_id', eventId);
        return NextResponse.json(
          { error: `Bridge: ${chargeRole.detail}` },
          { status: httpStatus },
        );
      }
    }

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

      const _successOutcome = await processPaystackChargeSuccess(data, reference, supabase);
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
    // Bridge v3.1 (#191): Only role C (platform renewal) enters this block.
    // Resolver confirmed subscriptions.paystack_subscription_code match before any mutation.
    if (event === 'charge.success' && chargeRole?.ok && chargeRole.role === 'C') {
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
          // Require provider payment timestamp — no wall-clock fallbacks
          const paidAt = (data.paid_at as string) || (data.created_at as string);
          if (!paidAt) {
            logger.error('[PAYSTACK-WEBHOOK] Missing provider payment timestamp for renewal', { reference });
            return NextResponse.json({ error: 'Missing provider timestamp' }, { status: 500 });
          }
          const periodStartDate = new Date(paidAt);
          const periodEndDate = new Date(periodStartDate);
          periodEndDate.setDate(periodEndDate.getDate() + 30);
          const periodStartIso = periodStartDate.toISOString();
          const periodEndIso = periodEndDate.toISOString();

          // NO pre-write of periods to subscriptions — activate_paid_subscription RPC
          // performs authoritative period synchronization after all validation succeeds.

          const renewalProviderTimestamp = new Date(paidAt).toISOString();

          // Resolve effective config version at provider payment time
          const { data: renewalConfig } = await supabase
            .from('platform_config_versions')
            .select('id')
            .lte('effective_from', renewalProviderTimestamp)
            .order('effective_from', { ascending: false })
            .limit(1)
            .single();

          if (!renewalConfig) {
            logger.error('[PAYSTACK-WEBHOOK] No config version found at renewal time', { renewalProviderTimestamp });
            return NextResponse.json({ error: 'Config version not found' }, { status: 500 });
          }

          // Require currency from provider — no defaults
          const renewalCurrency = (data.currency as string)?.toUpperCase();
          if (!renewalCurrency) {
            logger.error('[PAYSTACK-WEBHOOK] Missing provider currency for renewal', { reference });
            return NextResponse.json({ error: 'Missing provider currency' }, { status: 500 });
          }
          const chargeAmountKobo = data.amount as number;
          if (!chargeAmountKobo || chargeAmountKobo <= 0) {
            logger.error('[PAYSTACK-WEBHOOK] Missing or invalid charge amount', { reference, amount: chargeAmountKobo });
            return NextResponse.json({ error: 'Missing or invalid provider amount' }, { status: 500 });
          }

          // Persist payment evidence BEFORE calling activation RPC
          // Store amount in smallest unit (kobo) — NOT converted to naira
          const { data: renewalEvidence, error: renewalEvidenceErr } = await supabase.from('subscription_payments').insert({
            business_id: platformSub.business_id,
            subscription_id: platformSub.id,
            amount: chargeAmountKobo,
            currency: renewalCurrency,
            billing_interval: 'month',
            gateway: 'paystack',
            gateway_reference: reference,
            provider_reference: reference,
            plan: platformSub.plan,
            action: 'renewal',
            status: 'success',
            config_version_id: renewalConfig.id,
            period_start: periodStartIso,
            period_end: periodEndIso,
          }).select('id').single();

          let renewalEvidenceId: string | null = null;
          if (renewalEvidenceErr) {
            const isDuplicate = renewalEvidenceErr.code === '23505'
              || renewalEvidenceErr.message?.includes('duplicate')
              || renewalEvidenceErr.message?.includes('unique');
            if (isDuplicate) {
              const { data: existing } = await supabase
                .from('subscription_payments')
                .select('id')
                .eq('subscription_id', platformSub.id)
                .eq('provider_reference', reference)
                .eq('gateway', 'paystack')
                .eq('status', 'success')
                .single();
              if (existing) {
                renewalEvidenceId = existing.id;
              } else {
                logger.error('[PAYSTACK-WEBHOOK] Duplicate renewal evidence but exact lookup failed:', renewalEvidenceErr);
                return NextResponse.json({ error: 'Conflicting renewal evidence for period' }, { status: 500 });
              }
            } else {
              logger.error('[PAYSTACK-WEBHOOK] Renewal evidence insert failed:', renewalEvidenceErr);
              return NextResponse.json({ error: 'Renewal evidence insert failed' }, { status: 500 });
            }
          } else if (!renewalEvidence) {
            logger.error('[PAYSTACK-WEBHOOK] Renewal evidence insert returned no data');
            return NextResponse.json({ error: 'Renewal evidence insert failed' }, { status: 500 });
          } else {
            renewalEvidenceId = renewalEvidence.id;
          }

          // Atomic activation: restores tier if downgraded + grants period allowance
          const { data: activationResult, error: activateErr } = await supabase.rpc(
            'activate_paid_subscription', { p_payment_id: renewalEvidenceId },
          );
          if (activateErr) {
            logger.error('[PAYSTACK-WEBHOOK] Paid activation RPC error:', activateErr);
            return NextResponse.json({ error: 'Activation RPC failed' }, { status: 500 });
          }
          if (!activationResult || activationResult.activated !== true) {
            logger.error('[PAYSTACK-WEBHOOK] Paid renewal activation not confirmed:', activationResult);
            return NextResponse.json({ error: 'Paid renewal activation not confirmed' }, { status: 500 });
          }

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
                const chargeAmountDisplay = chargeAmountKobo / 100;
                const { subject, html } = subscriptionRenewalReceiptEmail(
                  biz.name,
                  platformSub.plan,
                  String(chargeAmountDisplay),
                  renewalCurrency,
                  periodEndDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
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
    // Bridge v3.1 (#191): Only roles D (cron) and E (provider-managed) enter this block.
    // Schema probe ensures paystack_billing_attempts exists before any #176 access.
    if (event === 'charge.success' && chargeRole?.ok && (chargeRole.role === 'D' || chargeRole.role === 'E')) {
      // ── Schema probe: verify migration-337 prerequisites before #176 access ──
      const { error: schemaProbe } = await supabase
        .from('paystack_billing_attempts')
        .select('id')
        .limit(0);

      if (schemaProbe) {
        // #176 schema prerequisites absent — fail closed with retryable 5xx.
        await supabase.from('processed_webhook_events').update({
          status: 'failed',
          last_error: `Recurring #176 (role ${chargeRole.role}) blocked: schema prerequisites absent (${
            String(schemaProbe.message).slice(0, 200)
          })`,
          last_attempted_at: new Date().toISOString(),
        }).eq('event_id', eventId);
        return NextResponse.json(
          { error: '#176 prerequisites not deployed' },
          { status: 503 },
        );
      }

      // Schema ready — existing #176 authoritative path (unchanged)
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

          if (!invoiceCode) {
            // Invoice identity unresolved — DO NOT finalize normal accounting.
            // Preserve durable reconciliation evidence for later replay.
            await supabase.from('processed_webhook_events').upsert({
              event_id: `paystack-unresolved-invoice-${reference}`,
              gateway: 'paystack',
              event_type: 'provider_managed_invoice_unresolved',
              status: 'reconciliation_required',
              first_received_at: new Date().toISOString(),
              last_attempted_at: new Date().toISOString(),
              last_error: JSON.stringify({
                reference,
                subscription_code: webhookSubscriptionCode,
                subscription_id: localSub.id,
                amount_kobo: webhookAmountKobo,
                currency: webhookCurrency,
                transaction_id: webhookTransactionId || null,
              }),
            }, { onConflict: 'event_id', ignoreDuplicates: true });
            logger.warn(`[PAYSTACK RECURRING] Invoice unresolved for provider-managed charge — ref: ${reference}, sub: ${webhookSubscriptionCode}. Preserved as reconciliation_required.`);
          } else {
            // Authoritative invoice_code resolved — proceed with finalization
            const providerCycleKey = `ps-auto-${localSub.id}-${invoiceCode}`;

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
    } // end schema-ready block

    // ── Bridge v3.1: Role F — Unresolved charge.success (#191) ──
    // No authoritative signal matched. Park as reconciliation_required
    // WITHOUT touching paystack_billing_attempts.
    if (event === 'charge.success' && chargeRole?.ok && chargeRole.role === 'F') {
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
          amount_kobo: (data.amount as number),
          currency: ((data.currency as string) || 'NGN'),
          auth_code: authorization?.authorization_code,
          customer_code: customerData?.customer_code,
        }),
      }, { onConflict: 'event_id', ignoreDuplicates: true });
      logger.warn(`[PAYSTACK RECURRING] Unresolved charge.success (role F) preserved as reconciliation_required — ref: ${reference}`);
    }

    // ── Messaging top-up via charge.success (#491) ──
    if (event === 'charge.success' && metadata?.type === 'messaging_topup') {
      const purchaseId = metadata.purchase_id;
      const topupBusinessId = metadata.business_id;

      if (!purchaseId || !topupBusinessId) {
        logger.error('[PAYSTACK-WEBHOOK] messaging_topup charge missing purchase_id or business_id', { reference, metadata });
        await supabase.from('processed_webhook_events').update({
          status: 'failed',
          last_error: 'messaging_topup charge missing required metadata',
          last_attempted_at: new Date().toISOString(),
        }).eq('event_id', eventId);
        return NextResponse.json({ error: 'messaging_topup charge missing required metadata' }, { status: 500 });
      }

      // Verify the purchase exists and belongs to this business
      const { data: purchase, error: purchaseLookupErr } = await supabase
        .from('messaging_topup_purchases')
        .select('id, business_id, status, package_amount_minor, currency_code')
        .eq('id', purchaseId)
        .single();

      if (purchaseLookupErr || !purchase) {
        logger.error('[PAYSTACK-WEBHOOK] messaging_topup purchase not found', { purchaseId, error: purchaseLookupErr });
        await supabase.from('processed_webhook_events').update({
          status: 'failed',
          last_error: `Top-up purchase not found: ${purchaseId}`,
          last_attempted_at: new Date().toISOString(),
        }).eq('event_id', eventId);
        return NextResponse.json({ error: 'Top-up purchase not found' }, { status: 500 });
      }

      if (purchase.business_id !== topupBusinessId) {
        logger.error('[PAYSTACK-WEBHOOK] messaging_topup business_id mismatch', { purchaseId, expected: topupBusinessId, actual: purchase.business_id });
        await supabase.from('processed_webhook_events').update({
          status: 'failed',
          last_error: `Top-up purchase business mismatch: ${purchaseId}`,
          last_attempted_at: new Date().toISOString(),
        }).eq('event_id', eventId);
        return NextResponse.json({ error: 'Top-up purchase business mismatch' }, { status: 500 });
      }

      // Fail-closed: provider-confirmed amount/currency must exactly match durable purchase
      const paystackAmount = data.amount as number | undefined;
      const paystackCurrency = (data.currency as string | undefined)?.toUpperCase();
      if (paystackAmount !== purchase.package_amount_minor || paystackCurrency !== purchase.currency_code) {
        logger.error('[PAYSTACK-WEBHOOK] messaging_topup amount/currency mismatch', {
          purchaseId,
          paystackAmount, paystackCurrency,
          purchaseAmount: purchase.package_amount_minor, purchaseCurrency: purchase.currency_code,
        });
        await supabase.from('processed_webhook_events').update({
          status: 'failed',
          last_error: `Top-up amount/currency mismatch: provider=${paystackAmount}/${paystackCurrency} purchase=${purchase.package_amount_minor}/${purchase.currency_code}`,
          last_attempted_at: new Date().toISOString(),
        }).eq('event_id', eventId);
        return NextResponse.json({ error: 'Top-up amount/currency mismatch' }, { status: 400 });
      }

      // Update provider_reference with the Paystack reference
      await supabase
        .from('messaging_topup_purchases')
        .update({ provider_reference: reference })
        .eq('id', purchaseId)
        .is('provider_reference', null);

      // Grant the purchased allowance (RPC handles idempotent replay)
      const { data: grantResult, error: grantErr } = await supabase.rpc(
        'grant_purchased_messaging_allowance',
        { p_purchase_id: purchaseId },
      );

      if (grantErr) {
        logger.error('[PAYSTACK-WEBHOOK] messaging_topup grant RPC error', { purchaseId, error: grantErr });
        await supabase.from('processed_webhook_events').update({
          status: 'failed',
          last_error: `Top-up grant RPC failed: ${String(grantErr.message).slice(0, 200)}`,
          last_attempted_at: new Date().toISOString(),
        }).eq('event_id', eventId);
        return NextResponse.json({ error: 'Top-up grant RPC failed' }, { status: 500 });
      }

      if (grantResult?.granted) {
        logger.info('[PAYSTACK-WEBHOOK] messaging_topup granted', {
          purchaseId,
          businessId: topupBusinessId,
          allowanceId: grantResult.allowance_id,
          amount: grantResult.amount_minor,
          idempotent: grantResult.idempotent ?? false,
        });
      } else {
        logger.error('[PAYSTACK-WEBHOOK] messaging_topup grant not confirmed', { purchaseId, result: grantResult });
        await supabase.from('processed_webhook_events').update({
          status: 'failed',
          last_error: `Top-up grant not confirmed: ${JSON.stringify(grantResult).slice(0, 200)}`,
          last_attempted_at: new Date().toISOString(),
        }).eq('event_id', eventId);
        return NextResponse.json({ error: 'Top-up grant not confirmed' }, { status: 500 });
      }
    }

    // LEGACY: customer subscription invoice.payment_failed handler.
    // Unreachable after lifecycle routing fix (subscription lifecycle events are
    // intercepted at line 66 and routed to platform/customer via subCode lookup).
    // Retained until parity tests confirm the lifecycle router handles all cases.
    // Remove after: paystack-subscription-lifecycle-routing.test.ts covers scenarios 5-9.
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

    // LEGACY: customer subscription.disable handler.
    // Unreachable after lifecycle routing fix (see legacy comment above).
    // Retained until parity tests confirm the lifecycle router handles all cases.
    // Remove after: paystack-subscription-lifecycle-routing.test.ts covers scenarios 10-11.
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

    // ── Messaging top-up refund handling (#491) ──
    // Paystack fires 'refund.processed' when a refund is completed
    if (event === 'refund.processed') {
      const txnObj = data.transaction as Record<string, unknown> | undefined;
      const originalTxnReference = (txnObj?.reference as string) || (data.transaction_reference as string) || reference;
      const refundAmountKobo = data.amount as number;
      const paystackRefundId = (data.id as string) || reference || `paystack_refund_${eventId}`;

      if (originalTxnReference && refundAmountKobo > 0) {
        // Look up purchase (completed or partially_refunded — both accept further refunds)
        const { data: topupPurchase } = await supabase
          .from('messaging_topup_purchases')
          .select('id, status, package_amount_minor, gateway')
          .eq('gateway', 'paystack')
          .or(`provider_checkout_id.eq.${sanitizeFilterValue(originalTxnReference)},provider_reference.eq.${sanitizeFilterValue(originalTxnReference)}`)
          .in('status', ['completed', 'partially_refunded', 'review'])
          .maybeSingle();

        if (topupPurchase) {
          const { data: refundResult, error: refundErr } = await supabase.rpc(
            'process_topup_refund',
            { p_purchase_id: topupPurchase.id, p_provider_refund_id: paystackRefundId, p_this_refund_amount_minor: refundAmountKobo },
          );

          if (refundErr) {
            logger.error('[PAYSTACK-WEBHOOK] messaging_topup refund RPC error', { purchaseId: topupPurchase.id, error: refundErr });
            return NextResponse.json({ error: 'Top-up refund RPC failed' }, { status: 500 });
          }

          logger.info('[PAYSTACK-WEBHOOK] messaging_topup refund processed', {
            purchaseId: topupPurchase.id,
            refundId: paystackRefundId,
            refundAmount: refundAmountKobo,
            result: refundResult,
          });
        }
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
