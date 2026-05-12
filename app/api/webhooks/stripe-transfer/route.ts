import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createHmac, timingSafeEqual } from 'crypto';
import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/client';
import { payoutPaidEmail, payoutFailedEmail } from '@/lib/email/templates';
import { logger } from '@/lib/logger';
export const maxDuration = 60;

/**
 * POST /api/webhooks/stripe-transfer
 *
 * Handles Stripe payout/transfer webhook events:
 * - payout.paid — payout completed
 * - payout.failed — payout failed
 * - transfer.reversed — transfer reversed
 *
 * Uses a separate webhook secret (STRIPE_PAYOUT_WEBHOOK_SECRET) so it can
 * be registered as a separate endpoint in the Stripe Dashboard.
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

    const supabase = createServiceClient();

    // Idempotency
    const stripeEventId = body.id as string;
    const eventId = `stripe_${stripeEventId}`;
    const { data: inserted } = await supabase
      .from('processed_webhook_events')
      .upsert(
        {
          event_id: eventId,
          gateway: 'stripe',
          event_type: eventType,
          processed_at: new Date().toISOString(),
        },
        { onConflict: 'event_id', ignoreDuplicates: true },
      )
      .select('id');

    if (!inserted || inserted.length === 0) {
      return NextResponse.json({ received: true, duplicate: true });
    }

    // For Stripe, the transfer/payout ID is used as the gateway_transfer_code
    const gatewayCode = (data.id as string) || '';
    if (!gatewayCode) {
      return NextResponse.json({ received: true });
    }

    // Find the payout by gateway_transfer_code
    const { data: payout } = await supabase
      .from('business_payouts')
      .select('id, business_id, net_amount, currency, status')
      .eq('gateway_transfer_code', gatewayCode)
      .maybeSingle();

    if (!payout) {
      logger.warn(`[STRIPE-TRANSFER-WH] No payout found for gateway code: ${gatewayCode}`);
      return NextResponse.json({ received: true });
    }

    // Don't re-process if already in a terminal state
    if (payout.status === 'paid' || payout.status === 'failed') {
      return NextResponse.json({ received: true, already_terminal: true });
    }

    if (eventType === 'payout.paid') {
      await supabase
        .from('business_payouts')
        .update({
          status: 'paid',
          paid_at: new Date().toISOString(),
        })
        .eq('id', payout.id);

      notifyBusinessOwner(supabase, payout.business_id, 'success', payout.net_amount, payout.currency, gatewayCode).catch(
        (err) => logger.error('[STRIPE-TRANSFER-WH] Email error:', err),
      );
    } else if (eventType === 'payout.failed') {
      const reason = (data.failure_message as string) || 'Payout failed';
      await supabase
        .from('business_payouts')
        .update({
          status: 'failed',
          flags: [reason],
        })
        .eq('id', payout.id);

      notifyBusinessOwner(supabase, payout.business_id, 'failed', payout.net_amount, payout.currency, gatewayCode, reason).catch(
        (err) => logger.error('[STRIPE-TRANSFER-WH] Email error:', err),
      );
    } else if (eventType === 'transfer.reversed') {
      const reason = 'Transfer reversed';
      await supabase
        .from('business_payouts')
        .update({
          status: 'failed',
          flags: [reason],
        })
        .eq('id', payout.id);

      notifyBusinessOwner(supabase, payout.business_id, 'failed', payout.net_amount, payout.currency, gatewayCode, reason).catch(
        (err) => logger.error('[STRIPE-TRANSFER-WH] Email error:', err),
      );
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    Sentry.captureException(error);
    logger.error('[STRIPE-TRANSFER-WH] Error:', error);
    return NextResponse.json({ received: true }, { status: 200 });
  }
}

/**
 * Send email notification to the business owner about payout status.
 */
async function notifyBusinessOwner(
  supabase: ReturnType<typeof createServiceClient>,
  businessId: string,
  status: 'success' | 'failed',
  amount: number,
  currency: string,
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

  const formattedAmount = `${currency} ${amount.toLocaleString()}`;

  if (status === 'success') {
    const email = payoutPaidEmail(biz.name, formattedAmount, reference);
    await sendEmail({ to: profile.email, ...email });
  } else {
    const email = payoutFailedEmail(biz.name, formattedAmount, reason || 'Transfer failed');
    await sendEmail({ to: profile.email, ...email });
  }
}
