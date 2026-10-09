import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createHmac, timingSafeEqual } from 'crypto';
import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/client';
import { payoutPaidEmail, payoutFailedEmail } from '@/lib/email/templates';
import { logger } from '@/lib/logger';
export const maxDuration = 60;

const LOG_PREFIX = '[PAYSTACK-TRANSFER-WH]';

/**
 * POST /api/webhooks/paystack-transfer
 *
 * Handles Paystack transfer webhook events:
 * - transfer.success — payout completed
 * - transfer.failed — payout failed
 * - transfer.reversed — payout reversed (including after prior paid)
 *
 * Uses atomic claim_webhook_event / complete_webhook_event / fail_webhook_event
 * RPCs (migration 362) for exactly-once processing. The event is only marked
 * complete AFTER the payout status transition succeeds.
 *
 * CTO 600-A: completeClaim/failClaim propagate errors; callers handle.
 * CTO 600-B: UPDATE uses CAS guard (.eq('status', expectedStatus)) to prevent
 *            concurrent overwrites. Reversal has precedence over success.
 * CTO 600-C: Only already_completed returns 200. active_processing returns 503.
 * CTO 600-D: Notification omits monetary denomination until PR-A2 currency design.
 */
export async function POST(request: NextRequest) {
  const supabase = createServiceClient();
  let claimToken: string | null = null;
  let eventId: string | null = null;

  try {
    const rawBody = await request.text();
    const signature = request.headers.get('x-paystack-signature') || '';
    const paystackKey = process.env.PAYSTACK_SECRET_KEY;

    if (!paystackKey) {
      logger.error(`${LOG_PREFIX} Missing PAYSTACK_SECRET_KEY`);
      return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    }

    // Verify HMAC-SHA512 signature
    const hash = createHmac('sha512', paystackKey).update(rawBody).digest('hex');
    try {
      if (!timingSafeEqual(Buffer.from(hash), Buffer.from(signature))) {
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
      }
    } catch {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    const body = JSON.parse(rawBody);
    const event = body.event as string;
    const data = body.data as Record<string, unknown>;

    // Only handle transfer events
    if (!event.startsWith('transfer.')) {
      return NextResponse.json({ received: true });
    }

    const transferCode = data.transfer_code as string;
    if (!transferCode) {
      return NextResponse.json({ received: true });
    }

    // ── Atomic claim via RPC (migration 362) ──
    eventId = `paystack_transfer:${event}:${transferCode}`;
    const { data: claimResult, error: claimError } = await supabase.rpc('claim_webhook_event', {
      p_event_id: eventId,
      p_gateway: 'paystack',
      p_event_type: `paystack_${event}`,
    });

    if (claimError) {
      logger.error(`${LOG_PREFIX} Claim RPC error:`, claimError.message);
      return NextResponse.json({ error: 'Claim failed' }, { status: 500 });
    }

    if (!claimResult?.claimed) {
      const reason = claimResult?.reason;
      // 600-C: Only already_completed warrants unconditional 200.
      // active_processing, not_found, or malformed responses need retryable status.
      if (reason === 'already_completed') {
        return NextResponse.json({ received: true, reason });
      }
      // active_processing: another worker is handling — return 503 so provider
      // retries after backoff. The M362 RPC reclaims stale processing after 90s.
      logger.warn(`${LOG_PREFIX} Claim not granted: ${reason || 'unknown'}`);
      return NextResponse.json({ error: `Event not claimable: ${reason}` }, { status: 503 });
    }

    claimToken = claimResult.claim_token as string;

    // ── Find payout — NO currency column (does not exist on business_payouts) ──
    const { data: payout, error: payoutError } = await supabase
      .from('business_payouts')
      .select('id, business_id, net_amount, status')
      .eq('gateway_transfer_code', transferCode)
      .maybeSingle();

    if (payoutError) {
      logger.error(`${LOG_PREFIX} Payout lookup error:`, payoutError.message);
      await failClaimChecked(supabase, eventId, claimToken, `Payout lookup failed: ${payoutError.message}`);
      return NextResponse.json({ error: 'Payout lookup failed' }, { status: 500 });
    }

    if (!payout) {
      logger.warn(`${LOG_PREFIX} No payout found for transfer_code: ${transferCode}`);
      await failClaimChecked(supabase, eventId, claimToken, `No payout for transfer_code: ${transferCode}`);
      return NextResponse.json({ error: 'Payout not found' }, { status: 500 });
    }

    // ── State transition with CAS guard (600-B) ──
    const transitionResult = await applyStatusTransition(supabase, payout, event, data);

    if (transitionResult.skipped) {
      // Already in a valid terminal state — complete the claim
      const completed = await completeClaimChecked(supabase, eventId, claimToken);
      if (!completed) {
        return NextResponse.json({ error: 'Claim completion failed' }, { status: 500 });
      }
      return NextResponse.json({ received: true, already_terminal: true });
    }

    if (transitionResult.error) {
      // CAS conflict or DB error — fail the claim for retry
      await failClaimChecked(supabase, eventId, claimToken, transitionResult.error);
      return NextResponse.json({ error: 'Status transition failed' }, { status: 500 });
    }

    // ── Complete the claim AFTER verified status transition (600-A) ──
    const completed = await completeClaimChecked(supabase, eventId, claimToken);
    if (!completed) {
      // Status was transitioned but claim completion failed.
      // The status is durable; the claim will be reclaimed as stale after 90s
      // and re-processed (hitting already_terminal). Log and return 500
      // so provider doesn't assume success.
      logger.error(`${LOG_PREFIX} Status transitioned but claim completion failed for ${eventId}`);
      return NextResponse.json({ error: 'Claim completion failed' }, { status: 500 });
    }

    // ── Send notification (non-blocking, never corrupts financial status) ──
    // 600-D: Omit monetary denomination until PR-A2 currency design.
    const notifStatus = event === 'transfer.success' ? 'success' as const : 'failed' as const;
    const notifReason = event === 'transfer.failed'
      ? ((data.reason as string) || (data.gateway_response as string) || 'Transfer failed')
      : event === 'transfer.reversed'
        ? ((data.reason as string) || 'Transfer reversed')
        : undefined;

    notifyBusinessOwner(supabase, payout.business_id, notifStatus, transferCode, notifReason).catch(
      (err) => logger.error(`${LOG_PREFIX} Email error:`, err),
    );

    return NextResponse.json({ received: true });
  } catch (error) {
    Sentry.captureException(error);
    logger.error(`${LOG_PREFIX} Unhandled error:`, error);

    if (eventId && claimToken) {
      await failClaimChecked(supabase, eventId, claimToken, String(error)).catch(
        (e) => logger.error(`${LOG_PREFIX} Fail-claim error:`, e),
      );
    }

    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

/**
 * 600-B: Apply status transition with CAS guard.
 * Uses .eq('status', expectedStatus) on UPDATE to prevent concurrent overwrites.
 * Reversal has precedence: can override 'paid' (expectedStatus includes 'paid').
 * Returns { skipped: true } for valid terminal states, { error } for failures.
 */
async function applyStatusTransition(
  supabase: ReturnType<typeof createServiceClient>,
  payout: { id: string; status: string },
  event: string,
  data: Record<string, unknown>,
): Promise<{ skipped?: boolean; error?: string }> {
  if (event === 'transfer.success') {
    // Can only transition from non-terminal states
    if (payout.status === 'paid' || payout.status === 'failed') {
      return { skipped: true };
    }
    // CAS: only update if still in expected pre-terminal state
    const { data: updated, error } = await supabase
      .from('business_payouts')
      .update({ status: 'paid', paid_at: new Date().toISOString() })
      .eq('id', payout.id)
      .in('status', ['approved', 'processing', 'review_required', 'pending'])
      .select('id');

    if (error) return { error: `DB error: ${error.message}` };
    if (!updated?.length) return { error: `CAS conflict: payout ${payout.id} status changed` };
    return {};

  } else if (event === 'transfer.failed') {
    if (payout.status === 'paid' || payout.status === 'failed') {
      return { skipped: true };
    }
    const reason = (data.reason as string) || (data.gateway_response as string) || 'Transfer failed';
    const { data: updated, error } = await supabase
      .from('business_payouts')
      .update({ status: 'failed', flags: [reason] })
      .eq('id', payout.id)
      .in('status', ['approved', 'processing', 'review_required', 'pending'])
      .select('id');

    if (error) return { error: `DB error: ${error.message}` };
    if (!updated?.length) return { error: `CAS conflict: payout ${payout.id} status changed` };
    return {};

  } else if (event === 'transfer.reversed') {
    // Reversal has precedence — can override 'paid' status
    if (payout.status === 'failed') {
      return { skipped: true }; // Already failed, no action needed
    }
    const reason = (data.reason as string) || 'Transfer reversed';
    // CAS: allow transition from 'paid' (reversal after payment) AND pre-terminal
    const { data: updated, error } = await supabase
      .from('business_payouts')
      .update({ status: 'failed', flags: [`Reversed: ${reason}`] })
      .eq('id', payout.id)
      .in('status', ['paid', 'approved', 'processing', 'review_required', 'pending'])
      .select('id');

    if (error) return { error: `DB error: ${error.message}` };
    if (!updated?.length) return { error: `CAS conflict: payout ${payout.id} status changed` };
    return {};
  }

  return { skipped: true }; // Unknown event type
}

/**
 * 600-A: Complete claim with error propagation.
 * Returns true if completion succeeded, false if RPC returned false/error.
 */
async function completeClaimChecked(
  supabase: ReturnType<typeof createServiceClient>,
  eventId: string,
  claimToken: string,
): Promise<boolean> {
  const { data: ok, error } = await supabase.rpc('complete_webhook_event', {
    p_event_id: eventId,
    p_claim_token: claimToken,
  });
  if (error) {
    logger.error(`${LOG_PREFIX} complete_webhook_event RPC error for ${eventId}:`, error.message);
    Sentry.captureException(error);
    return false;
  }
  if (!ok) {
    logger.error(`${LOG_PREFIX} complete_webhook_event returned false for ${eventId} (token mismatch or not processing)`);
    return false;
  }
  return true;
}

/**
 * 600-A: Fail claim with error propagation.
 * Returns true if failure was recorded, false if RPC returned false/error.
 */
async function failClaimChecked(
  supabase: ReturnType<typeof createServiceClient>,
  eventId: string,
  claimToken: string,
  errorMsg: string,
): Promise<boolean> {
  const { data: ok, error } = await supabase.rpc('fail_webhook_event', {
    p_event_id: eventId,
    p_claim_token: claimToken,
    p_error: errorMsg,
  });
  if (error) {
    logger.error(`${LOG_PREFIX} fail_webhook_event RPC error for ${eventId}:`, error.message);
    Sentry.captureException(error);
    return false;
  }
  if (!ok) {
    logger.warn(`${LOG_PREFIX} fail_webhook_event returned false for ${eventId}`);
    return false;
  }
  return true;
}

/**
 * Send email notification to the business owner about payout status.
 * 600-D: Does NOT include monetary amount or denomination. Until PR-A2
 * establishes verified currency provenance, notifications use reference
 * and status only. Never fabricate currency from business country.
 */
async function notifyBusinessOwner(
  supabase: ReturnType<typeof createServiceClient>,
  businessId: string,
  status: 'success' | 'failed',
  transferCode: string,
  reason?: string,
) {
  const { data: biz } = await supabase
    .from('businesses')
    .select('name, owner_id')
    .eq('id', businessId)
    .single();

  if (!biz) return;

  const { data: profile } = await supabase
    .from('profiles')
    .select('email')
    .eq('id', biz.owner_id)
    .single();

  if (!profile?.email) return;

  if (status === 'success') {
    const email = payoutPaidEmail(biz.name, `Ref: ${transferCode}`, transferCode);
    await sendEmail({ to: profile.email, ...email });
  } else {
    const email = payoutFailedEmail(biz.name, `Ref: ${transferCode}`, reason || 'Transfer failed');
    await sendEmail({ to: profile.email, ...email });
  }
}
