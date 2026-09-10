import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';
import { processSuccessfulPayment } from '@/lib/payments/process-success';

/** Validate a resumable checkout URL: must be a parseable http(s) URL string. */
function isValidCheckoutUrl(v: unknown): v is string {
  if (typeof v !== 'string' || !v) return false;
  try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}
import { sendProactiveConfirmation } from '@/lib/payments/send-confirmation';
import { logger } from '@/lib/logger';
import { createCronLogger } from '@/lib/observability/cron';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Payment Reconciliation Cron
 *
 * Finds payments stuck in 'pending' for 2+ hours and verifies them against
 * the payment gateway. If the gateway says paid, we process the payment.
 * If the gateway says failed/expired, we mark it failed.
 *
 * Runs every 4 hours: "0 *​/4 * * *"
 */
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const cron = createCronLogger('payment-reconciliation');
  cron.started();

  try {
  const supabase = createServiceClient();

  const twoHoursAgo = new Date();
  twoHoursAgo.setHours(twoHoursAgo.getHours() - 2);

  // Find payments needing reconciliation:
  // A. Stale pending payments (provider may have been paid)
  // B. New-authority success + incomplete Stage 2 (finalization_completed_at IS NULL)
  // C. New-authority success + Stage 2 complete + incomplete Stage 3 (confirmation_sent_at IS NULL)
  //    but NOT not_deliverable (terminal — no contact info to retry with)
  const { data: stalePayments, error: queryError } = await supabase
    .from('payments')
    .select('id, amount, gateway, gateway_reference, booking_id, invoice_id, campaign_id, order_id, metadata, status, payment_authority_version, finalization_completed_at, confirmation_sent_at, fee_policy_version, provider_init_state')
    .or(`status.eq.pending,and(status.eq.success,payment_authority_version.not.is.null,finalization_completed_at.is.null),and(status.eq.success,payment_authority_version.not.is.null,finalization_completed_at.not.is.null,confirmation_sent_at.is.null,confirmation_terminal_reason.is.null)`)
    .lt('created_at', twoHoursAgo.toISOString())
    .limit(50);

  if (queryError) {
    cron.failed(queryError);
    return NextResponse.json({ ok: false, error: 'Query failed' }, { status: 500 });
  }

  if (!stalePayments || stalePayments.length === 0) {
    cron.completed({ processedCount: 0 });
    return NextResponse.json({ ok: true, processed: 0 });
  }

  // ── #264: V1 dispatched recovery ──
  // Three-way outcome per payment: found / definitively absent / ambiguous.
  // found+paid → CAS+reconcile. found+artifact → CAS+URL. found+terminal → CAS to failed.
  // absent → exact replay on same row if init params available, else quarantine.
  // ambiguous → no action (quarantine after 24h).
  const { data: dispatchedPayments, error: dispatchQueryErr } = await supabase
    .from('payments')
    .select('id, gateway, gateway_reference, metadata, provider_init_state, fee_policy_version, created_at, amount, currency')
    .eq('fee_policy_version', 1)
    .eq('provider_init_state', 'dispatched')
    .eq('status', 'pending')
    .neq('gateway_status', 'dispatched_quarantine')
    .lt('created_at', twoHoursAgo.toISOString())
    .limit(20);

  // Structural skip on query error (even if partial data returned)
  if (dispatchQueryErr) {
    logger.error('[CRON] Dispatched recovery query error — skipping all recovery', { dispatchQueryErr });
  } else if (dispatchedPayments && dispatchedPayments.length > 0) {
    for (const dp of dispatchedPayments) {
      try {
        const meta = (dp.metadata || {}) as Record<string, unknown>;
        const clientRef = (meta.reference_code as string) || dp.gateway_reference;
        const paymentAge = Date.now() - new Date(dp.created_at as string).getTime();

        // Helper: checked CAS — returns true only on exactly one affected row
        const checkedCAS = async (updates: Record<string, unknown>): Promise<boolean> => {
          const { data: rows, error: casErr } = await supabase.from('payments')
            .update(updates)
            .eq('id', dp.id).eq('provider_init_state', 'dispatched')
            .select('id');
          return !casErr && rows != null && rows.length === 1;
        };

        // Helper: checked terminal transition for provider-proven failure
        const checkedTerminal = async (reason: string): Promise<boolean> => {
          const { data: rows, error: err } = await supabase.from('payments')
            .update({ status: 'failed', gateway_status: `provider_terminal_${reason}` })
            .eq('id', dp.id).eq('provider_init_state', 'dispatched').eq('status', 'pending')
            .select('id');
          return !err && rows != null && rows.length === 1;
        };

        // Track outcome so quarantine runs regardless of provider path
        let resolved = false; // true if CAS/terminal succeeded

        if (dp.gateway === 'paystack') {
          const paystackKey = process.env.PAYSTACK_SECRET_KEY;
          if (paystackKey) {
            try {
              const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(clientRef)}`, {
                headers: { Authorization: `Bearer ${paystackKey}` },
                signal: AbortSignal.timeout(15000),
              });
              if (res.ok) {
                const data = await res.json();
                if (data?.data?.status === 'success') {
                  // Found + paid → CAS to provider_confirmed + reconcile
                  resolved = await checkedCAS({ provider_init_state: 'provider_confirmed' });
                  if (resolved) {
                    const { reconcilePayment: rp } = await import('@/lib/payments/reconcile');
                    await rp(supabase, dp.id, 'cron');
                  }
                } else if (data?.data?.status === 'abandoned' || data?.data?.status === 'failed') {
                  // Found + terminal provider failure → checked terminal transition
                  resolved = await checkedTerminal(data.data.status);
                } else if (isValidCheckoutUrl(data?.data?.authorization_url)) {
                  // Found + unpaid with valid resumable artifact → CAS with URL
                  resolved = await checkedCAS({ provider_init_state: 'provider_confirmed', metadata: { ...meta, checkout_url: data.data.authorization_url } });
                } else if (data?.status === false && data?.message === 'Transaction reference not found') {
                  // Definitively absent — no replay in this PR (exact request-builder not yet factored).
                  // Remain dispatched → quarantine-eligible. No POST, no fresh logical payment.
                }
                // else: unrecognized → ambiguous
              }
              // else: HTTP error → ambiguous (resolved stays false, quarantine may apply)
            } catch { /* fetch error → ambiguous */ }
          }
        } else if (dp.gateway === 'flutterwave') {
          const fwKey = process.env.FLUTTERWAVE_SECRET_KEY;
          if (fwKey) {
            try {
              const res = await fetch(`https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(clientRef)}`, {
                headers: { Authorization: `Bearer ${fwKey}` },
                signal: AbortSignal.timeout(15000),
              });
              if (res.ok) {
                const data = await res.json();
                if (data?.data?.status === 'successful') {
                  resolved = await checkedCAS({ provider_init_state: 'provider_confirmed' });
                  if (resolved) {
                    const { reconcilePayment: rp } = await import('@/lib/payments/reconcile');
                    await rp(supabase, dp.id, 'cron');
                  }
                } else if (data?.data?.status === 'failed') {
                  resolved = await checkedTerminal('failed');
                } else if (isValidCheckoutUrl(data?.data?.link)) {
                  resolved = await checkedCAS({ provider_init_state: 'provider_confirmed', metadata: { ...meta, checkout_url: data.data.link } });
                } else if (data?.status === 'error' && data?.message === 'No transaction was found for this id') {
                  // Definitively absent — no replay in this PR (exact request-builder not yet factored).
                  // Remain dispatched → quarantine-eligible.
                }
              }
            } catch { /* ambiguous */ }
          }
        } else if (dp.gateway === 'stripe') {
          // Stripe: read-only bounded session listing with deterministic pagination.
          const stripeKey = process.env.STRIPE_SECRET_KEY;
          if (stripeKey) {
            try {
              const createdAt = Math.floor(new Date(dp.created_at as string).getTime() / 1000);
              const matches: Array<{ id: string; url: string }> = [];
              let malformedCandidates = 0; // matching client_reference_id but invalid id/url
              let startingAfter: string | undefined;
              let pages = 0;
              const MAX_PAGES = 5;
              let searchComplete = true;

              // Bounded pagination over narrow created window
              while (pages < MAX_PAGES) {
                pages++;
                let url = `https://api.stripe.com/v1/checkout/sessions?created[gte]=${createdAt - 60}&created[lte]=${createdAt + 300}&limit=20`;
                if (startingAfter) url += `&starting_after=${startingAfter}`;
                const res = await fetch(url, {
                  headers: { Authorization: `Bearer ${stripeKey}` },
                  signal: AbortSignal.timeout(15000),
                });
                if (!res.ok) { searchComplete = false; break; }
                let list: Record<string, unknown>;
                try { list = await res.json(); } catch { searchComplete = false; break; }
                // Validate List response shape — malformed provider shape is ambiguous
                if (!Array.isArray(list.data) || typeof list.has_more !== 'boolean') {
                  searchComplete = false; break;
                }
                const sessions = list.data as Array<Record<string, unknown>>;
                for (const s of sessions) {
                  if (s.client_reference_id === clientRef) {
                    if (typeof s.id === 'string' && s.id && isValidCheckoutUrl(s.url)) {
                      matches.push({ id: s.id, url: s.url as string });
                    } else {
                      // Matching reference but malformed identity/artifact → ambiguous
                      malformedCandidates++;
                    }
                  }
                }
                // has_more=true + empty page = ambiguous (no valid continuation)
                if (list.has_more && sessions.length === 0) { searchComplete = false; break; }
                if (!list.has_more) break; // search exhausted normally
                const lastId = sessions[sessions.length - 1]?.id;
                if (typeof lastId !== 'string' || !lastId) { searchComplete = false; break; }
                startingAfter = lastId;
                // If this is the last allowed page and has_more is true → incomplete
                if (pages >= MAX_PAGES && list.has_more) { searchComplete = false; break; }
              }

              // Only CAS when search completed + exactly one valid match + no malformed candidates
              if (searchComplete && matches.length === 1 && malformedCandidates === 0) {
                resolved = await checkedCAS({
                  gateway_reference: matches[0].id,
                  provider_init_state: 'provider_confirmed',
                  metadata: { ...meta, checkout_url: matches[0].url, stripe_session_id: matches[0].id },
                });
              }
              // zero, multiple, no url, or pagination error → ambiguous
            } catch { /* ambiguous */ }
          }
        }
        // Square/PayPal: no cron recovery (cannot safely re-POST). Webhook-only.

        // Quarantine: old dispatched rows that were not resolved by any path above
        if (!resolved && paymentAge > 24 * 60 * 60 * 1000) {
          const { data: stillRow, error: rereadErr } = await supabase.from('payments')
            .select('provider_init_state').eq('id', dp.id).single();
          if (!rereadErr && stillRow?.provider_init_state === 'dispatched') {
            const { error: qErr, data: qRows } = await supabase.from('payments')
              .update({ gateway_status: 'dispatched_quarantine' })
              .eq('id', dp.id).eq('provider_init_state', 'dispatched')
              .select('id');
            if (qErr || !qRows || qRows.length !== 1) {
              logger.error('[CRON] Quarantine CAS failed', { paymentId: dp.id, qErr, rows: qRows?.length });
            }
          }
        }
      } catch (recoveryErr) {
        logger.error('[CRON] V1 dispatched recovery error', { paymentId: dp.id, error: String(recoveryErr) });
      }
    }
  }

  let reconciled = 0;
  let markedFailed = 0;
  let errors = 0;

  const { reconcilePayment } = await import('@/lib/payments/reconcile');

  for (const payment of stalePayments) {
    // #264: Skip v1 dispatched rows — the dedicated dispatched-recovery block owns them.
    // They must not enter ordinary reconciliation until the exact checked transition succeeds.
    const sp = payment as Record<string, unknown>;
    if (sp.fee_policy_version === 1 && sp.provider_init_state === 'dispatched') {
      continue;
    }

    try {
      // Use canonical reconciliation (provider adapter + Payment Authority)
      const result = await reconcilePayment(supabase, payment.id, 'cron');

      if (result.lifecycle?.status === 'completed' || result.lifecycle?.status === 'already_completed') {
        reconciled++;
        logger.info(`[PAYMENT-RECONCILIATION] Reconciled payment ${payment.id} (${payment.gateway})`);
      } else if (result.providerOutcome === 'not_paid') {
        // Generic not_paid is NOT proof of terminal failure.
        // Leave as pending — provider may still be processing, or the check was ambiguous.
        // Do NOT destructively mark as failed from ambiguous provider state.
        logger.info(`[PAYMENT-RECONCILIATION] Payment ${payment.id} not confirmed by provider — leaving for next cycle`);
      } else if (result.providerOutcome === 'retryable_error' || result.providerOutcome === 'config_error') {
        // Transient/config error — leave for next cycle, do not mark failed
        logger.info(`[PAYMENT-RECONCILIATION] Payment ${payment.id} provider ${result.providerOutcome} — leaving for next cycle`);
      }
      // retryable/config errors: leave payment for next cron cycle
    } catch (err) {
      errors++;
      logger.error(`[PAYMENT-RECONCILIATION] Error reconciling payment ${payment.id}:`, err);
      Sentry.captureException(err, {
        tags: { component: 'payment-reconciliation', gateway: payment.gateway },
        extra: { paymentId: payment.id, reference: payment.gateway_reference },
      });
    }
  }

  cron.completed({
    processedCount: stalePayments.length,
    successCount: reconciled,
    failureCount: markedFailed + errors,
    skippedCount: stalePayments.length - reconciled - markedFailed - errors,
  });

  return NextResponse.json({
    ok: true,
    total: stalePayments.length,
    reconciled,
    markedFailed,
    errors,
  });
  } catch (error) {
    cron.failed(error);
    throw error; // Preserve existing propagation behavior
  }
}

type GatewayVerifyResult = 'paid' | 'pending' | 'failed' | 'expired';

async function verifyWithGateway(
  gateway: string,
  reference: string,
): Promise<GatewayVerifyResult> {
  if (gateway === 'stripe') {
    return verifyStripePayment(reference);
  }
  if (gateway === 'paystack') {
    return verifyPaystackPayment(reference);
  }
  return 'pending'; // Unknown gateway — leave as-is
}

async function verifyStripePayment(reference: string): Promise<GatewayVerifyResult> {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return 'pending'; // Can't verify without key

  // Determine if reference is a checkout session (cs_) or payment intent (pi_)
  const isSession = reference.startsWith('cs_');
  const endpoint = isSession
    ? `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(reference)}`
    : `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(reference)}`;

  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${stripeKey}` },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    // If 404, the session/intent doesn't exist — treat as failed
    if (response.status === 404) return 'failed';
    throw new Error(`Stripe API error: ${response.status}`);
  }

  const data = await response.json();

  if (isSession) {
    // Checkout session statuses
    if (data.payment_status === 'paid') return 'paid';
    if (data.status === 'expired') return 'expired';
    return 'pending';
  } else {
    // Payment intent statuses
    if (data.status === 'succeeded') return 'paid';
    if (data.status === 'canceled') return 'failed';
    if (data.status === 'requires_payment_method') return 'failed';
    return 'pending';
  }
}

async function verifyPaystackPayment(reference: string): Promise<GatewayVerifyResult> {
  const paystackKey = process.env.PAYSTACK_SECRET_KEY;
  if (!paystackKey) return 'pending'; // Can't verify without key

  const response = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    {
      headers: { Authorization: `Bearer ${paystackKey}` },
      signal: AbortSignal.timeout(15000),
    },
  );

  if (!response.ok) {
    if (response.status === 404) return 'failed';
    throw new Error(`Paystack API error: ${response.status}`);
  }

  const data = await response.json();
  const status = data?.data?.status;

  if (status === 'success') return 'paid';
  if (status === 'failed' || status === 'abandoned') return 'failed';
  if (status === 'reversed') return 'failed';
  return 'pending';
}
