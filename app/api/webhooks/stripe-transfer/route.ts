import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createHmac, timingSafeEqual } from 'crypto';
import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/client';
import { payoutTransferStatusEmail, payoutTransferFailureEmail } from '@/lib/email/templates';
import { logger } from '@/lib/logger';
export const maxDuration = 60;

const LOG_PREFIX = '[STRIPE-TRANSFER-WH]';

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

    // Stripe Transfer (tr_...) events are NOT bank payouts (po_...).
    // A Transfer object has no status field. transfer.updated is a metadata edit,
    // not a settlement notification. Keep 'processing' until the separate,
    // reconciled connected-account bank payout flow establishes finality.
    const handledEvents = ['transfer.created', 'transfer.updated', 'transfer.reversed'];
    if (!handledEvents.includes(eventType)) {
      return NextResponse.json({ received: true });
    }

    // Reject malformed signed transfer payloads before any financial lookup.
    if (data.object !== 'transfer' || typeof data.id !== 'string' || !data.id.startsWith('tr_') ||
        typeof body.id !== 'string' || !body.id.startsWith('evt_')) {
      return NextResponse.json({ error: 'Malformed transfer event' }, { status: 400 });
    }

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
      const reason = claimResult?.reason;
      if (reason === 'already_completed') {
        return NextResponse.json({ received: true, reason });
      }
      logger.warn(`${LOG_PREFIX} Claim not granted: ${reason || 'unknown'}`);
      return NextResponse.json({ error: `Event not claimable: ${reason}` }, { status: 503 });
    }

    claimToken = claimResult.claim_token as string;

    const gatewayCode = (data.id as string) || '';
    if (!gatewayCode) {
      await failClaimChecked(supabase, eventId, claimToken, 'Missing gateway code from event data');
      return NextResponse.json({ error: 'Missing gateway code' }, { status: 400 });
    }

    const { data: payout, error: payoutError } = await supabase
      .from('business_payouts')
      .select('id, business_id, net_amount, status')
      .eq('gateway_transfer_code', gatewayCode)
      .maybeSingle();

    if (payoutError) {
      logger.error(`${LOG_PREFIX} Payout lookup error:`, payoutError.message);
      await failClaimChecked(supabase, eventId, claimToken, `Payout lookup failed: ${payoutError.message}`);
      return NextResponse.json({ error: 'Payout lookup failed' }, { status: 500 });
    }

    if (!payout) {
      logger.warn(`${LOG_PREFIX} No payout found for gateway code: ${gatewayCode}`);
      await failClaimChecked(supabase, eventId, claimToken, `No payout for gateway_code: ${gatewayCode}`);
      return NextResponse.json({ error: 'Payout not found' }, { status: 500 });
    }

    const transitionResult = await applyStatusTransition(supabase, payout, eventType, data);

    if (transitionResult.skipped) {
      const completed = await completeClaimChecked(supabase, eventId, claimToken);
      if (!completed) {
        return NextResponse.json({ error: 'Claim completion failed' }, { status: 500 });
      }
      return NextResponse.json({ received: true, already_terminal: true });
    }

    if (transitionResult.error) {
      await failClaimChecked(supabase, eventId, claimToken, transitionResult.error);
      return NextResponse.json({ error: 'Status transition failed' }, { status: 500 });
    }

    const completed = await completeClaimChecked(supabase, eventId, claimToken);
    if (!completed) {
      logger.error(`${LOG_PREFIX} Status transitioned but claim completion failed for ${eventId}`);
      return NextResponse.json({ error: 'Claim completion failed' }, { status: 500 });
    }

    // Only reversals change the business's financial risk state here; ordinary
    // Stripe Transfer creation/metadata events never claim bank settlement.
    if (transitionResult.issueReason) {
      notifyBusinessOwner(supabase, payout.business_id, 'failed', gatewayCode, transitionResult.issueReason).catch(
        (err) => logger.error(`${LOG_PREFIX} Email error:`, err),
      );
    }

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

async function applyStatusTransition(
  supabase: ReturnType<typeof createServiceClient>,
  payout: { id: string; status: string },
  eventType: string,
  data: Record<string, unknown>,
): Promise<{ skipped?: boolean; error?: string; issueReason?: string }> {
  // Stripe's Transfer object has no 'paid' status. Creation confirms only an
  // internal Stripe balance transfer, NOT business-bank settlement. Updating
  // a Transfer's description/metadata is also not a financial state change.
  if (eventType === 'transfer.created' || eventType === 'transfer.updated') {
    return { skipped: true };
  }

  if (eventType !== 'transfer.reversed') return { skipped: true };

  // Stripe sends the cumulative amount_reversed in the same minor units as
  // amount; reversed=true only when the entire Transfer is reversed.
  // Unknown or partial reversal MUST NOT be represented as a full failure.
  const amount = data.amount;
  const amountReversed = data.amount_reversed;
  const validAmounts = typeof amount === 'number' && Number.isSafeInteger(amount) && amount > 0 &&
    typeof amountReversed === 'number' && Number.isSafeInteger(amountReversed) &&
    amountReversed > 0 && amountReversed <= amount;
  const fullyReversed = validAmounts && data.reversed === true && amountReversed === amount;
  const partiallyReversed = validAmounts && data.reversed === false && amountReversed < amount;
  const targetStatus = fullyReversed ? 'failed' : 'review_required';
  const reason = fullyReversed
    ? 'Stripe transfer fully reversed; review payout liabilities and historical paid_at'
    : partiallyReversed
      ? 'Stripe transfer partially reversed; amount requires financial reconciliation'
      : 'Stripe transfer reversal amount unverified; manual financial review required';

  if (payout.status === 'failed') return { skipped: true };
  if (payout.status === 'review_required' && !fullyReversed) return { skipped: true };

  // CAS guards prevent a concurrent success/error update from overwriting the
  // reversal. review_required is a HOLD, not 'paid' or a fresh transfer request.
  const allowedStatuses = fullyReversed
    ? ['paid', 'approved', 'processing', 'review_required', 'pending']
    : ['paid', 'approved', 'processing', 'pending'];
  const { data: updated, error } = await supabase
    .from('business_payouts')
    .update({ status: targetStatus, flags: [reason] })
    .eq('id', payout.id)
    .in('status', allowedStatuses)
    .select('id');

  if (error) return { error: `DB error: ${error.message}` };
  if (!updated?.length) return { error: `CAS conflict: payout ${payout.id} status changed` };
  return { issueReason: reason };
}

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
    logger.error(`${LOG_PREFIX} complete_webhook_event returned false for ${eventId}`);
    return false;
  }
  return true;
}

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

async function notifyBusinessOwner(
  supabase: ReturnType<typeof createServiceClient>,
  businessId: string,
  status: 'success' | 'failed',
  reference: string,
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
    const email = payoutTransferStatusEmail(biz.name, reference);
    await sendEmail({ to: profile.email, ...email });
  } else {
    const email = payoutTransferFailureEmail(biz.name, reference, reason || 'Transfer failed');
    await sendEmail({ to: profile.email, ...email });
  }
}
