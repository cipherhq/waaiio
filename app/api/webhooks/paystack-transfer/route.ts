import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createHmac, timingSafeEqual } from 'crypto';
import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/client';
import { payoutPaidEmail, payoutFailedEmail } from '@/lib/email/templates';
import { COUNTRIES } from '@/lib/constants';
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
 * complete AFTER the payout status transition succeeds. On any transient
 * failure, the handler returns non-2xx so the provider retries.
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
      // Transient DB error — return 500 so provider retries
      return NextResponse.json({ error: 'Claim failed' }, { status: 500 });
    }

    if (!claimResult?.claimed) {
      // Already completed or actively processing — safe to acknowledge
      return NextResponse.json({ received: true, reason: claimResult?.reason });
    }

    claimToken = claimResult.claim_token;

    // ── Find payout — NO currency column (does not exist on business_payouts) ──
    const { data: payout, error: payoutError } = await supabase
      .from('business_payouts')
      .select('id, business_id, net_amount, status')
      .eq('gateway_transfer_code', transferCode)
      .maybeSingle();

    if (payoutError) {
      logger.error(`${LOG_PREFIX} Payout lookup error:`, payoutError.message);
      await failClaim(supabase, eventId, claimToken!, `Payout lookup failed: ${payoutError.message}`);
      return NextResponse.json({ error: 'Payout lookup failed' }, { status: 500 });
    }

    if (!payout) {
      logger.warn(`${LOG_PREFIX} No payout found for transfer_code: ${transferCode}`);
      await failClaim(supabase, eventId, claimToken!, `No payout for transfer_code: ${transferCode}`);
      // Return 500 — the payout may not have been created yet (race condition).
      // Provider will retry; if payout genuinely doesn't exist, stale claim reclaim
      // after 90s allows re-processing.
      return NextResponse.json({ error: 'Payout not found' }, { status: 500 });
    }

    // ── State transition logic ──
    // Allow transfer.reversed to override 'paid' status (reversal after payment)
    if (event === 'transfer.reversed') {
      // Reversals can happen after paid — always process them
      if (payout.status === 'failed') {
        // Already in a failure state — complete the claim without re-updating
        await completeClaim(supabase, eventId, claimToken!);
        return NextResponse.json({ received: true, already_terminal: true });
      }
    } else if (payout.status === 'paid' || payout.status === 'failed') {
      // For success/failed events: don't re-process terminal states
      await completeClaim(supabase, eventId, claimToken!);
      return NextResponse.json({ received: true, already_terminal: true });
    }

    // ── Apply payout status transition ──
    let updateResult;
    if (event === 'transfer.success') {
      updateResult = await supabase
        .from('business_payouts')
        .update({
          status: 'paid',
          paid_at: new Date().toISOString(),
        })
        .eq('id', payout.id)
        .select('id');

    } else if (event === 'transfer.failed') {
      const reason = (data.reason as string) || (data.gateway_response as string) || 'Transfer failed';
      updateResult = await supabase
        .from('business_payouts')
        .update({
          status: 'failed',
          flags: [reason],
        })
        .eq('id', payout.id)
        .select('id');

    } else if (event === 'transfer.reversed') {
      const reason = (data.reason as string) || 'Transfer reversed';
      updateResult = await supabase
        .from('business_payouts')
        .update({
          status: 'failed',
          flags: [`Reversed: ${reason}`],
        })
        .eq('id', payout.id)
        .select('id');
    }

    // Verify the UPDATE succeeded
    if (!updateResult?.data?.length) {
      const errMsg = updateResult?.error?.message || 'No rows updated';
      logger.error(`${LOG_PREFIX} Payout status update failed:`, errMsg);
      await failClaim(supabase, eventId, claimToken!, `Update failed: ${errMsg}`);
      return NextResponse.json({ error: 'Status update failed' }, { status: 500 });
    }

    // ── Complete the claim AFTER successful status transition ──
    await completeClaim(supabase, eventId, claimToken!);

    // ── Send notification (non-blocking, never corrupts financial status) ──
    const notifStatus = event === 'transfer.success' ? 'success' as const : 'failed' as const;
    const notifReason = event === 'transfer.failed'
      ? ((data.reason as string) || (data.gateway_response as string) || 'Transfer failed')
      : event === 'transfer.reversed'
        ? ((data.reason as string) || 'Transfer reversed')
        : undefined;

    notifyBusinessOwner(supabase, payout.business_id, notifStatus, payout.net_amount, transferCode, notifReason).catch(
      (err) => logger.error(`${LOG_PREFIX} Email error:`, err),
    );

    return NextResponse.json({ received: true });
  } catch (error) {
    Sentry.captureException(error);
    logger.error(`${LOG_PREFIX} Unhandled error:`, error);

    // Fail the claim so it can be reclaimed after 90s
    if (eventId && claimToken) {
      await failClaim(supabase, eventId, claimToken!, String(error)).catch(
        (e) => logger.error(`${LOG_PREFIX} Fail-claim error:`, e),
      );
    }

    // Return 500 — provider retries
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

async function completeClaim(
  supabase: ReturnType<typeof createServiceClient>,
  eventId: string,
  claimToken: string,
): Promise<void> {
  const { data: ok } = await supabase.rpc('complete_webhook_event', {
    p_event_id: eventId,
    p_claim_token: claimToken,
  });
  if (!ok) {
    logger.warn(`${LOG_PREFIX} complete_webhook_event returned false for ${eventId}`);
  }
}

async function failClaim(
  supabase: ReturnType<typeof createServiceClient>,
  eventId: string,
  claimToken: string,
  errorMsg: string,
): Promise<void> {
  const { data: ok } = await supabase.rpc('fail_webhook_event', {
    p_event_id: eventId,
    p_claim_token: claimToken,
    p_error: errorMsg,
  });
  if (!ok) {
    logger.warn(`${LOG_PREFIX} fail_webhook_event returned false for ${eventId}`);
  }
}

/**
 * Send email notification to the business owner about payout status.
 * Resolves currency from the business's country — notification only,
 * not used for financial accounting.
 */
async function notifyBusinessOwner(
  supabase: ReturnType<typeof createServiceClient>,
  businessId: string,
  status: 'success' | 'failed',
  amount: number,
  transferCode: string,
  reason?: string,
) {
  const { data: biz } = await supabase
    .from('businesses')
    .select('name, owner_id, country_code')
    .eq('id', businessId)
    .single();

  if (!biz) return;

  const { data: profile } = await supabase
    .from('profiles')
    .select('email')
    .eq('id', biz.owner_id)
    .single();

  if (!profile?.email) return;

  // Resolve currency from static country config for notification display only
  const countryConfig = COUNTRIES[biz.country_code];
  const displayCurrency = countryConfig?.currencyCode || biz.country_code || '???';
  const formattedAmount = `${displayCurrency} ${amount.toLocaleString()}`;

  if (status === 'success') {
    const email = payoutPaidEmail(biz.name, formattedAmount, transferCode);
    await sendEmail({ to: profile.email, ...email });
  } else {
    const email = payoutFailedEmail(biz.name, formattedAmount, reason || 'Transfer failed');
    await sendEmail({ to: profile.email, ...email });
  }
}
