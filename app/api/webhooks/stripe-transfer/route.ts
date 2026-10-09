import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createHmac, timingSafeEqual } from 'crypto';
import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/client';
import { payoutPaidEmail, payoutFailedEmail } from '@/lib/email/templates';
import { COUNTRIES } from '@/lib/constants';
import { logger } from '@/lib/logger';
export const maxDuration = 60;

const LOG_PREFIX = '[STRIPE-TRANSFER-WH]';

/**
 * POST /api/webhooks/stripe-transfer
 *
 * Handles Stripe payout/transfer webhook events:
 * - payout.paid — payout completed
 * - payout.failed — payout failed
 * - transfer.reversed — transfer reversed (including after prior paid)
 *
 * Uses a separate webhook secret (STRIPE_PAYOUT_WEBHOOK_SECRET) so it can
 * be registered as a separate endpoint in the Stripe Dashboard.
 *
 * Uses atomic claim_webhook_event / complete_webhook_event / fail_webhook_event
 * RPCs (migration 362) for exactly-once processing. The event is only marked
 * complete AFTER the payout status transition succeeds.
 */

const stripePayoutWebhookSecret = process.env.STRIPE_PAYOUT_WEBHOOK_SECRET || '';

function verifyStripeSignature(rawBody: string, signature: string): boolean {
  if (!stripePayoutWebhookSecret || !signature) return false;

  const parts = signature.split(',');
  const timestamp = parts.find((p) => p.startsWith('t='))?.slice(2);
  const sigs = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));

  if (!timestamp || sigs.length === 0) return false;

  const payload = `${timestamp}.${rawBody}`;
  const expected = createHmac('sha256', stripePayoutWebhookSecret).update(payload).digest('hex');

  return sigs.some((sig) => {
    try {
      return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch {
      return false;
    }
  });
}

export async function POST(request: NextRequest) {
  const supabase = createServiceClient();
  let claimToken: string | null = null;
  let eventId: string | null = null;

  try {
    const rawBody = await request.text();
    const signature = request.headers.get('stripe-signature') || '';

    if (!verifyStripeSignature(rawBody, signature)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    const body = JSON.parse(rawBody);
    const eventType = body.type as string;
    const data = body.data?.object as Record<string, unknown>;

    if (!data) {
      return NextResponse.json({ received: true });
    }

    // Only handle payout and transfer events
    const handledEvents = ['payout.paid', 'payout.failed', 'transfer.reversed'];
    if (!handledEvents.includes(eventType)) {
      return NextResponse.json({ received: true });
    }

    // ── Atomic claim via RPC (migration 362) ──
    const stripeEventId = body.id as string;
    eventId = `stripe_transfer:${stripeEventId}`;
    const { data: claimResult, error: claimError } = await supabase.rpc('claim_webhook_event', {
      p_event_id: eventId,
      p_gateway: 'stripe',
      p_event_type: eventType,
    });

    if (claimError) {
      logger.error(`${LOG_PREFIX} Claim RPC error:`, claimError.message);
      return NextResponse.json({ error: 'Claim failed' }, { status: 500 });
    }

    if (!claimResult?.claimed) {
      return NextResponse.json({ received: true, reason: claimResult?.reason });
    }

    claimToken = claimResult.claim_token;

    // For Stripe, the transfer/payout ID is used as the gateway_transfer_code
    const gatewayCode = (data.id as string) || '';
    if (!gatewayCode) {
      await failClaim(supabase, eventId, claimToken!, 'Missing gateway code from event data');
      return NextResponse.json({ error: 'Missing gateway code' }, { status: 400 });
    }

    // ── Find payout — NO currency column (does not exist on business_payouts) ──
    const { data: payout, error: payoutError } = await supabase
      .from('business_payouts')
      .select('id, business_id, net_amount, status')
      .eq('gateway_transfer_code', gatewayCode)
      .maybeSingle();

    if (payoutError) {
      logger.error(`${LOG_PREFIX} Payout lookup error:`, payoutError.message);
      await failClaim(supabase, eventId, claimToken!, `Payout lookup failed: ${payoutError.message}`);
      return NextResponse.json({ error: 'Payout lookup failed' }, { status: 500 });
    }

    if (!payout) {
      logger.warn(`${LOG_PREFIX} No payout found for gateway code: ${gatewayCode}`);
      await failClaim(supabase, eventId, claimToken!, `No payout for gateway_code: ${gatewayCode}`);
      return NextResponse.json({ error: 'Payout not found' }, { status: 500 });
    }

    // ── State transition logic ──
    // Allow transfer.reversed to override 'paid' status (reversal after payment)
    if (eventType === 'transfer.reversed') {
      if (payout.status === 'failed') {
        await completeClaim(supabase, eventId, claimToken!);
        return NextResponse.json({ received: true, already_terminal: true });
      }
    } else if (payout.status === 'paid' || payout.status === 'failed') {
      await completeClaim(supabase, eventId, claimToken!);
      return NextResponse.json({ received: true, already_terminal: true });
    }

    // ── Apply payout status transition ──
    let updateResult;
    if (eventType === 'payout.paid') {
      updateResult = await supabase
        .from('business_payouts')
        .update({
          status: 'paid',
          paid_at: new Date().toISOString(),
        })
        .eq('id', payout.id)
        .select('id');

    } else if (eventType === 'payout.failed') {
      const reason = (data.failure_message as string) || 'Payout failed';
      updateResult = await supabase
        .from('business_payouts')
        .update({
          status: 'failed',
          flags: [reason],
        })
        .eq('id', payout.id)
        .select('id');

    } else if (eventType === 'transfer.reversed') {
      const reason = 'Transfer reversed';
      updateResult = await supabase
        .from('business_payouts')
        .update({
          status: 'failed',
          flags: [reason],
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
    const notifStatus = eventType === 'payout.paid' ? 'success' as const : 'failed' as const;
    const notifReason = eventType === 'payout.failed'
      ? ((data.failure_message as string) || 'Payout failed')
      : eventType === 'transfer.reversed'
        ? 'Transfer reversed'
        : undefined;

    notifyBusinessOwner(supabase, payout.business_id, notifStatus, payout.net_amount, gatewayCode, notifReason).catch(
      (err) => logger.error(`${LOG_PREFIX} Email error:`, err),
    );

    return NextResponse.json({ received: true });
  } catch (error) {
    Sentry.captureException(error);
    logger.error(`${LOG_PREFIX} Unhandled error:`, error);

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
  reference: string,
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

  const countryConfig = COUNTRIES[biz.country_code];
  const displayCurrency = countryConfig?.currencyCode || biz.country_code || '???';
  const formattedAmount = `${displayCurrency} ${amount.toLocaleString()}`;

  if (status === 'success') {
    const email = payoutPaidEmail(biz.name, formattedAmount, reference);
    await sendEmail({ to: profile.email, ...email });
  } else {
    const email = payoutFailedEmail(biz.name, formattedAmount, reason || 'Transfer failed');
    await sendEmail({ to: profile.email, ...email });
  }
}
