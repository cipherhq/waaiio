import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createHmac, timingSafeEqual } from 'crypto';
import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/client';
import { payoutPaidEmail, payoutFailedEmail } from '@/lib/email/templates';
import { logger } from '@/lib/logger';
export const maxDuration = 60;

/**
 * POST /api/webhooks/paystack-transfer
 *
 * Handles Paystack transfer webhook events:
 * - transfer.success — payout completed
 * - transfer.failed — payout failed
 * - transfer.reversed — payout reversed
 *
 * Must be registered in the Paystack Dashboard under Webhook URL.
 */
export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get('x-paystack-signature') || '';
    const paystackKey = process.env.PAYSTACK_SECRET_KEY;

    if (!paystackKey) {
      logger.error('[PAYSTACK-TRANSFER-WH] Missing PAYSTACK_SECRET_KEY');
      return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    }

    // Verify HMAC signature
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

    const supabase = createServiceClient();

    // Idempotency: atomic dedup via ON CONFLICT
    const eventId = `${event}:${transferCode}`;
    const { data: inserted } = await supabase
      .from('processed_webhook_events')
      .upsert(
        {
          event_id: eventId,
          gateway: 'paystack',
          event_type: `paystack_${event}`,
          processed_at: new Date().toISOString(),
        },
        { onConflict: 'event_id', ignoreDuplicates: true },
      )
      .select('id');

    if (!inserted || inserted.length === 0) {
      return NextResponse.json({ received: true, duplicate: true });
    }

    // Find the payout by gateway_transfer_code
    const { data: payout } = await supabase
      .from('business_payouts')
      .select('id, business_id, net_amount, currency, status')
      .eq('gateway_transfer_code', transferCode)
      .maybeSingle();

    if (!payout) {
      logger.warn(`[PAYSTACK-TRANSFER-WH] No payout found for transfer_code: ${transferCode}`);
      return NextResponse.json({ received: true });
    }

    // Don't re-process if already in a terminal state
    if (payout.status === 'paid' || payout.status === 'failed') {
      return NextResponse.json({ received: true, already_terminal: true });
    }

    if (event === 'transfer.success') {
      await supabase
        .from('business_payouts')
        .update({
          status: 'paid',
          paid_at: new Date().toISOString(),
        })
        .eq('id', payout.id);

      // Send success email (non-blocking)
      notifyBusinessOwner(supabase, payout.business_id, 'success', payout.net_amount, payout.currency, transferCode).catch(
        (err) => logger.error('[PAYSTACK-TRANSFER-WH] Email error:', err),
      );
    } else if (event === 'transfer.failed') {
      const reason = (data.reason as string) || (data.gateway_response as string) || 'Transfer failed';
      await supabase
        .from('business_payouts')
        .update({
          status: 'failed',
          flags: [reason],
        })
        .eq('id', payout.id);

      notifyBusinessOwner(supabase, payout.business_id, 'failed', payout.net_amount, payout.currency, transferCode, reason).catch(
        (err) => logger.error('[PAYSTACK-TRANSFER-WH] Email error:', err),
      );
    } else if (event === 'transfer.reversed') {
      const reason = (data.reason as string) || 'Transfer reversed';
      await supabase
        .from('business_payouts')
        .update({
          status: 'failed',
          flags: [`Reversed: ${reason}`],
        })
        .eq('id', payout.id);

      notifyBusinessOwner(supabase, payout.business_id, 'failed', payout.net_amount, payout.currency, transferCode, reason).catch(
        (err) => logger.error('[PAYSTACK-TRANSFER-WH] Email error:', err),
      );
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    Sentry.captureException(error);
    logger.error('[PAYSTACK-TRANSFER-WH] Error:', error);
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
  transferCode: string,
  reason?: string,
) {
  // Fetch business name and owner email
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
    const email = payoutPaidEmail(biz.name, formattedAmount, transferCode);
    await sendEmail({ to: profile.email, ...email });
  } else {
    const email = payoutFailedEmail(biz.name, formattedAmount, reason || 'Transfer failed');
    await sendEmail({ to: profile.email, ...email });
  }
}
