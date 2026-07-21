import { NextResponse, type NextRequest } from 'next/server';
import { createHmac, timingSafeEqual, randomUUID } from 'crypto';
import * as Sentry from '@sentry/nextjs';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';
import { processSuccessfulPayment } from '@/lib/payments/process-success';
import { sendProactiveConfirmation } from '@/lib/payments/send-confirmation';

const squareWebhookSignatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';
const squareWebhookNotificationUrl = process.env.SQUARE_WEBHOOK_NOTIFICATION_URL || '';

function verifySquareSignature(rawBody: string, signature: string): boolean {
  if (!squareWebhookSignatureKey || !signature) return false;
  const payload = squareWebhookNotificationUrl + rawBody;
  const expected = createHmac('sha256', squareWebhookSignatureKey)
    .update(payload).digest('base64');
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch { return false; }
}

/** Mark event completed. Throws if the claim-token-guarded update affects zero rows. */
async function markEventCompleted(
  supabase: ReturnType<typeof createServiceClient>,
  eventId: string,
  claimToken: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('processed_webhook_events')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      last_attempted_at: new Date().toISOString(),
    })
    .eq('event_id', eventId)
    .eq('claim_token', claimToken)
    .eq('status', 'processing')
    .select('id')
    .maybeSingle();

  if (error) throw new Error(`Event completion DB error: ${error.message}`);
  if (!data) throw new Error('Event completion matched zero rows — lease may have been reclaimed');
}

async function markEventFailed(
  supabase: ReturnType<typeof createServiceClient>,
  eventId: string,
  claimToken: string,
  errorCategory: string,
): Promise<void> {
  await supabase
    .from('processed_webhook_events')
    .update({
      status: 'failed',
      last_error: errorCategory.slice(0, 100),
      last_attempted_at: new Date().toISOString(),
    })
    .eq('event_id', eventId)
    .eq('claim_token', claimToken)
    .eq('status', 'processing');
}

/** Resolve merchant_id → payout_account. Throws on missing/unknown merchant. */
async function resolveMerchant(
  supabase: ReturnType<typeof createServiceClient>,
  webhookMerchantId: string | undefined,
): Promise<{ id: string; business_id: string }> {
  if (!webhookMerchantId) {
    logger.warn('[SQUARE-WEBHOOK] Missing merchant_id — fail closed');
    throw new Error('Missing merchant_id in webhook payload');
  }

  const { data: conn, error: connErr } = await supabase
    .from('payout_accounts')
    .select('id, business_id')
    .eq('gateway', 'square')
    .eq('square_merchant_id', webhookMerchantId)
    .eq('is_active', true)
    .maybeSingle();

  if (connErr) throw new Error(`Connection lookup error: ${connErr.message}`);
  if (!conn) {
    logger.warn('[SQUARE-WEBHOOK] No active Square connection for merchant');
    throw new Error('Unknown merchant — no active connection');
  }
  return conn;
}

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  let eventId: string | null = null;
  let claimToken: string | null = null;
  try {
    const rawBody = await request.text();
    const signature = request.headers.get('x-square-hmacsha256-signature') || '';

    if (!squareWebhookSignatureKey) {
      return NextResponse.json({ message: 'Webhook not configured' }, { status: 500 });
    }
    if (!verifySquareSignature(rawBody, signature)) {
      return NextResponse.json({ message: 'Invalid signature' }, { status: 400 });
    }

    const body = JSON.parse(rawBody);
    const eventType = body.type as string;
    const data = body.data?.object as Record<string, unknown>;
    if (!data) {
      return NextResponse.json({ received: true });
    }

    const supabase = createServiceClient();

    // ── Atomic event claim ──
    eventId = (body.event_id as string) || null;
    if (eventId) {
      claimToken = randomUUID();
      const { data: claimResult, error: claimErr } = await supabase.rpc('claim_webhook_event', {
        p_event_id: eventId,
        p_gateway: 'square',
        p_event_type: `square_${eventType}`,
        p_claim_token: claimToken,
        p_lease_seconds: 120,
      });

      if (claimErr) {
        logger.error('[SQUARE-WEBHOOK] Claim RPC error');
        return NextResponse.json({ error: 'Claim failed' }, { status: 500 });
      }

      const outcome = claimResult?.outcome;
      if (outcome === 'duplicate') {
        return NextResponse.json({ received: true, duplicate: true });
      }
      if (outcome === 'lease_active') {
        return NextResponse.json({ error: 'Event being processed' }, { status: 500 });
      }
      if (outcome !== 'claimed' && outcome !== 'retry') {
        return NextResponse.json({ error: 'Unexpected claim outcome' }, { status: 500 });
      }
    }

    const webhookMerchantId = body.merchant_id as string | undefined;

    // ── Payment events ──
    if (eventType === 'payment.updated' || eventType === 'payment.created') {
      const payment = data.payment as Record<string, unknown> | undefined;
      if (!payment?.order_id) {
        if (eventId && claimToken) await markEventCompleted(supabase, eventId, claimToken);
        return NextResponse.json({ received: true });
      }

      const orderId = payment.order_id as string;
      const paymentStatus = payment.status as string | undefined;

      // Resolve merchant — fails closed on missing/unknown
      const conn = await resolveMerchant(supabase, webhookMerchantId);

      // Scoped payment lookup — ALWAYS requires resolved payout account
      const { data: matchedPayment, error: payLookupErr } = await supabase
        .from('payments')
        .select('id, booking_id, invoice_id, campaign_id, reservation_id, order_id, amount, currency, status, metadata, business_id, payout_account_id, gateway_reference, waaiio_fee, collection_mode')
        .eq('gateway', 'square')
        .eq('payout_account_id', conn.id)
        .eq('provider_order_ref', orderId)
        .maybeSingle();

      if (payLookupErr) throw new Error(`Payment lookup error: ${payLookupErr.message}`);
      if (!matchedPayment) {
        if (eventId && claimToken) await markEventCompleted(supabase, eventId, claimToken);
        return NextResponse.json({ received: true });
      }

      if (paymentStatus === 'COMPLETED') {
        const totalMoney = payment.total_money as { amount?: number; currency?: string } | undefined;
        const squareAmountCents = totalMoney?.amount as number | undefined;
        const squareCurrency = totalMoney?.currency as string | undefined;
        const squarePaymentId = payment.id as string | undefined;
        const expectedCents = Math.round(matchedPayment.amount * 100);
        const expectedCurrency = (matchedPayment.currency as string || 'USD').toUpperCase();

        // Require nonempty Square payment ID for COMPLETED events
        if (!squarePaymentId) {
          throw new Error('COMPLETED event missing Square payment.id — fail closed');
        }

        // Missing currency — fail closed
        if (!squareCurrency) {
          throw new Error('COMPLETED event missing currency — fail closed');
        }

        // Currency mismatch — fail closed
        if (squareCurrency !== expectedCurrency) {
          logger.error('[SQUARE-WEBHOOK] Currency mismatch');
          throw new Error('Currency mismatch — fail closed');
        }

        // Missing or zero provider amount — fail closed
        if (squareAmountCents == null || squareAmountCents <= 0) {
          throw new Error('COMPLETED event missing or zero provider amount — fail closed');
        }

        // Amount mismatch — NEVER downgrade success/refunded
        if (Math.abs(squareAmountCents - expectedCents) > 1) {
          const isTerminal = matchedPayment.status === 'success' || matchedPayment.status === 'refunded';
          if (!isTerminal) {
            const { error: mismatchErr } = await supabase.from('payments')
              .update({ gateway_status: 'amount_mismatch' })
              .eq('id', matchedPayment.id)
              .in('status', ['pending', 'failed']);
            if (mismatchErr) throw new Error(`Mismatch update error: ${mismatchErr.message}`);
          }
          if (eventId && claimToken) await markEventCompleted(supabase, eventId, claimToken);
          return NextResponse.json({ received: true, error: 'amount_mismatch' });
        }

        const sourceType = payment.source_type as string | undefined;

        // Extract fees for accounting
        let squareGatewayFee = 0;
        let squareAppFee = 0;
        try {
          const processingFee = (payment.processing_fee as Array<{ amount_money?: { amount?: number } }>) || [];
          squareGatewayFee = Math.round(
            processingFee.reduce((sum: number, f) => sum + (f.amount_money?.amount || 0), 0),
          ) / 100;
        } catch { /* non-blocking */ }
        try {
          const appFeeMoney = payment.app_fee_money as { amount?: number } | undefined;
          if (appFeeMoney?.amount) squareAppFee = appFeeMoney.amount / 100;
        } catch { /* non-blocking */ }

        const paymentMethod = sourceType === 'CASH_APP' ? 'cash_app_pay' : sourceType?.toLowerCase() || 'card';
        const merchantNet = matchedPayment.amount - squareGatewayFee - squareAppFee;
        const existingMeta = (matchedPayment.metadata as Record<string, unknown>) || {};
        const reconciledMetadata = {
          ...existingMeta,
          square_payment_id: squarePaymentId,
          square_payment_link_id: existingMeta.square_payment_link_id || matchedPayment.gateway_reference,
          square_app_fee: squareAppFee,
          square_merchant_net: merchantNet > 0 ? merchantNet : null,
        };

        // ── STEP 1: Terminal-safe payment status transition ──
        // Only transitions pending/failed → success. Already-success/refunded are unaffected.
        const { error: transitionErr } = await supabase
          .from('payments')
          .update({
            status: 'success',
            gateway_status: 'completed',
            gateway_reference: squarePaymentId,
            payment_method: paymentMethod,
            paid_at: new Date().toISOString(),
            actual_gateway_fee: squareGatewayFee,
            metadata: reconciledMetadata,
          })
          .eq('id', matchedPayment.id)
          .in('status', ['pending', 'failed']);

        if (transitionErr) throw new Error(`Payment transition error: ${transitionErr.message}`);

        // ── STEP 2: Accounting reconciliation (runs even if already success) ──
        // Persists Square payment.id, fees, payment method, and provider status
        // without regressing the payment state.
        if (matchedPayment.status === 'success' || matchedPayment.status === 'refunded') {
          // Already terminal — reconcile accounting data only (no status change)
          const { error: reconErr } = await supabase
            .from('payments')
            .update({
              gateway_reference: squarePaymentId,
              gateway_status: 'completed',
              payment_method: paymentMethod,
              actual_gateway_fee: squareGatewayFee,
              metadata: reconciledMetadata,
            })
            .eq('id', matchedPayment.id);

          if (reconErr) throw new Error(`Accounting reconciliation error: ${reconErr.message}`);
        }

        // Financial work — only for non-terminal state (idempotent via UNIQUE constraints)
        // If bot "I've Paid" already confirmed, the UNIQUE constraints prevent double-recording.
        await processSuccessfulPayment(supabase, {
          id: matchedPayment.id,
          amount: matchedPayment.amount,
          booking_id: matchedPayment.booking_id,
          invoice_id: matchedPayment.invoice_id || null,
          campaign_id: matchedPayment.campaign_id || null,
          reservation_id: matchedPayment.reservation_id || null,
          order_id: matchedPayment.order_id || null,
          gateway_fee: squareGatewayFee,
        }, { strict: true });

        // Atomic notification via sendProactiveConfirmation.
        // It uses an atomic claim (UPDATE ... WHERE confirmation_sent_at IS NULL)
        // so only one caller sends. No metadata-based dedup needed.
        try {
          await sendProactiveConfirmation(supabase, {
            id: matchedPayment.id,
            amount: matchedPayment.amount,
            booking_id: matchedPayment.booking_id,
            invoice_id: matchedPayment.invoice_id || null,
            campaign_id: matchedPayment.campaign_id || null,
            reservation_id: matchedPayment.reservation_id || null,
            order_id: matchedPayment.order_id || null,
          }, '[SQUARE WEBHOOK]');
        } catch (confirmErr) {
          logger.error('[SQUARE WEBHOOK] Notification error (non-fatal):', confirmErr);
        }
      } else if (paymentStatus === 'FAILED') {
        // Only from pending — NEVER downgrade success/refunded
        const { error: failErr } = await supabase
          .from('payments')
          .update({ status: 'failed', gateway_status: 'failed' })
          .eq('id', matchedPayment.id)
          .in('status', ['pending']);
        if (failErr) throw new Error(`Failed transition error: ${failErr.message}`);
      }
    }

    // ── Refund events ──
    if (eventType === 'refund.created' || eventType === 'refund.updated') {
      const refund = data.refund as Record<string, unknown> | undefined;
      if (refund) {
        const squareRefundId = refund.id as string;
        const refundStatus = refund.status as string | undefined;

        if (squareRefundId && refundStatus) {
          // Refund events MUST be scoped through merchant → payout_account → payment
          const conn = await resolveMerchant(supabase, webhookMerchantId);

          // Look up the refund via its payment's payout_account/business
          const { data: localRefund, error: refLookupErr } = await supabase
            .from('refunds')
            .select('id, status, payment_id')
            .eq('gateway', 'square')
            .eq('gateway_refund_reference', squareRefundId)
            .maybeSingle();

          if (refLookupErr) throw new Error(`Refund lookup error: ${refLookupErr.message}`);

          // Verify refund belongs to this merchant's business
          if (localRefund?.payment_id) {
            const { data: refPayment } = await supabase
              .from('payments')
              .select('payout_account_id')
              .eq('id', localRefund.payment_id)
              .eq('payout_account_id', conn.id)
              .maybeSingle();

            if (!refPayment) {
              throw new Error('Refund payment does not belong to this merchant — scoping violation');
            }
          }

          if (localRefund && !['success', 'failed'].includes(localRefund.status)) {
            const finalStatus = refundStatus === 'COMPLETED' ? 'success'
              : (refundStatus === 'FAILED' || refundStatus === 'REJECTED') ? 'failed'
              : null;

            if (finalStatus) {
              const { data: finalResult, error: finalErr } = await supabase.rpc('finalize_square_refund', {
                p_refund_id: localRefund.id,
                p_square_refund_id: squareRefundId,
                p_final_status: finalStatus,
              });
              if (finalErr) throw new Error(`Refund finalization RPC error: ${finalErr.message}`);
              if (!finalResult?.success && finalResult?.reason !== 'already_finalized') {
                throw new Error(`Refund finalization rejected: ${finalResult?.reason}`);
              }
            }
          } else if (!localRefund) {
            // Square-initiated refund: no local row exists yet — reconcile
            const squarePaymentId = refund.payment_id as string | undefined;
            if (squarePaymentId) {
              // Find the local payment by Square payment ID in metadata
              const { data: refPayment, error: refPayErr } = await supabase
                .from('payments')
                .select('id, amount, currency, business_id, payout_account_id, gateway, waaiio_fee')
                .eq('gateway', 'square')
                .eq('payout_account_id', conn.id)
                .filter('metadata->>square_payment_id', 'eq', squarePaymentId)
                .maybeSingle();

              if (refPayErr) throw new Error(`Refund payment lookup error: ${refPayErr.message}`);

              if (refPayment) {
                // Calculate refund amount from Square's amount_money
                const refundAmountMoney = refund.amount_money as { amount?: number; currency?: string } | undefined;
                const refundAmountCents = refundAmountMoney?.amount || 0;
                const refundAmount = refundAmountCents / 100;

                // Calculate fee reversal from app_fee_money if present
                const appFeeMoney = refund.app_fee_money as { amount?: number } | undefined;
                const feeReversalCents = appFeeMoney?.amount || 0;
                const feeReversal = feeReversalCents / 100;

                // Create a local refund row
                const { data: newRefund, error: insertErr } = await supabase
                  .from('refunds')
                  .insert({
                    payment_id: refPayment.id,
                    business_id: refPayment.business_id,
                    amount: refundAmount,
                    status: 'pending',
                    gateway: 'square',
                    gateway_refund_reference: squareRefundId,
                    refund_type: refundAmount >= Number(refPayment.amount) ? 'full' : 'partial',
                    planned_fee_reversal: feeReversal,
                    is_direct_split: true,
                    initiated_by_role: 'admin',
                  })
                  .select('id')
                  .single();

                if (insertErr) throw new Error(`Refund insert error: ${insertErr.message}`);

                // Finalize if COMPLETED or FAILED
                const reconFinalStatus = refundStatus === 'COMPLETED' ? 'success'
                  : (refundStatus === 'FAILED' || refundStatus === 'REJECTED') ? 'failed'
                  : null;

                if (reconFinalStatus && newRefund) {
                  const { data: reconResult, error: reconErr } = await supabase.rpc('finalize_square_refund', {
                    p_refund_id: newRefund.id,
                    p_square_refund_id: squareRefundId,
                    p_final_status: reconFinalStatus,
                    p_fee_reversed: feeReversal > 0 ? feeReversal : null,
                  });
                  if (reconErr) throw new Error(`Refund reconciliation RPC error: ${reconErr.message}`);
                  if (!reconResult?.success && reconResult?.reason !== 'already_finalized') {
                    throw new Error(`Refund reconciliation rejected: ${reconResult?.reason}`);
                  }
                }

                logger.info(`[SQUARE-WEBHOOK] Reconciled Square-initiated refund ${squareRefundId} for payment ${refPayment.id}`);
              }
            }
          }
        }
      }
    }

    // ── OAuth revocation ──
    if (eventType === 'oauth.authorization.revoked') {
      // Missing merchant_id on revocation MUST fail closed — cannot silently complete
      if (!webhookMerchantId) {
        throw new Error('OAuth revocation missing merchant_id — fail closed');
      }
      const { handleOAuthRevocation } = await import('@/lib/payments/square-token');
      await handleOAuthRevocation(supabase, webhookMerchantId);
    }

    // Complete event — throws if claim-token guard fails
    if (eventId && claimToken) {
      await markEventCompleted(supabase, eventId, claimToken);
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    Sentry.captureException(error);

    if (eventId && claimToken) {
      try {
        const supabase = createServiceClient();
        await markEventFailed(supabase, eventId, claimToken, 'processing_error');
      } catch { /* best effort */ }
    }

    return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
  }
}
