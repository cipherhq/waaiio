/**
 * Saved Card Activation Retry Worker
 *
 * Retries failed PIN-activation message delivery using durable claim/fencing.
 * Uses the EXACT originating WhatsApp channel via resolveByChannelIdForBusiness.
 * Never repeats Stripe consent, redisplay downgrade, or credential setup.
 *
 * #370: Uses establish_saved_card_session RPC for normalized digits-only phone,
 * sendWithFencedDelivery for activation sends, and release_activation_pre_emission
 * for proven pre-emission failures.
 *
 * Concurrency: claim_activation_delivery RPC (FOR UPDATE SKIP LOCKED)
 * ensures exactly one worker owns each offer. Completion/release fenced
 * by claim token.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { verifyCronAuth } from '@/lib/cron-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';
import { canonicalSavedCardPhone } from '@/lib/payments/saved-card-compat';

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();
  let retried = 0;
  let errors = 0;

  for (let i = 0; i < 5; i++) {
    // Atomic claim: one offer, durable ownership
    const { data: claimed, error: claimErr } = await supabase.rpc('claim_activation_delivery', {
      p_lease_seconds: 120,
    });

    if (claimErr || !claimed) break;

    const offer = claimed as Record<string, unknown>;
    const offerId = offer.offer_id as string;
    const claimToken = offer.claim_token as string;
    const channelId = offer.channel_id as string | null;
    const customerPhone = offer.customer_phone as string;
    const paymentId = offer.payment_id as string;
    const businessId = offer.business_id as string;

    try {
      // R2-B3: Exact originating channel ONLY — no fallback
      if (!channelId) {
        logger.warn('[ACTIVATION-RETRY] No exact channel_id on offer — fail closed', { offerId });
        const { data: released, error: relErr } = await supabase.rpc('release_activation_delivery', {
          p_offer_id: offerId, p_claim_token: claimToken,
        });
        if (relErr || !released) {
          logger.error('[SAVED-CARD-CRON] Activation release failed', { relErr, released, offerId });
        }
        errors++;
        continue;
      }

      // Verify redisplay fence is proven (no pending cleanup for this offer)
      const { data: pendingCleanup } = await supabase
        .from('provider_cleanup_operations')
        .select('id')
        .eq('source_offer_id', offerId)
        .eq('operation_type', 'set_allow_redisplay_limited')
        .is('completed_at', null)
        .maybeSingle();

      if (pendingCleanup) {
        // Fence not proven — release for retry later
        const { data: released, error: relErr } = await supabase.rpc('release_activation_delivery', {
          p_offer_id: offerId, p_claim_token: claimToken,
        });
        if (relErr || !released) {
          logger.error('[SAVED-CARD-CRON] Activation release failed', { relErr, released, offerId });
          errors++;
        }
        continue;
      }

      // Ensure bot session exists for PIN entry using normalized phone
      const canonPhone = canonicalSavedCardPhone(customerPhone);
      if (!canonPhone) {
        logger.warn('[ACTIVATION-RETRY] Invalid phone — fail closed', { offerId, customerPhone });
        const { data: released, error: relErr } = await supabase.rpc('release_activation_delivery', {
          p_offer_id: offerId, p_claim_token: claimToken,
        });
        if (relErr || !released) {
          logger.error('[SAVED-CARD-CRON] Activation release failed', { relErr, released, offerId });
        }
        errors++;
        continue;
      }

      // Check for existing normalized session
      const { savedCardSessionPhone } = await import('@/lib/payments/saved-card-compat');
      const sessionPhone = savedCardSessionPhone(canonPhone);
      const { data: existingSession } = await supabase.from('bot_sessions')
        .select('id, version, current_step')
        .eq('whatsapp_number', sessionPhone)
        .eq('business_id', businessId)
        .eq('is_active', true)
        .maybeSingle();

      if (!existingSession || existingSession.current_step !== 'save_card_pin') {
        // Re-establish PIN session with Stripe evidence from payment metadata
        const { data: payment } = await supabase.from('payments')
          .select('metadata').eq('id', paymentId).single();

        const pinSessionData: Record<string, unknown> = {
          _save_card_pending: true,
          _save_card_business_id: businessId,
          _save_card_gateway: 'stripe',
          _save_card_payment_id: paymentId,
          _save_card_offer_id: offerId,
          _saved_card_channel_id: channelId,
        };

        if (payment?.metadata) {
          const meta = payment.metadata as Record<string, unknown>;
          pinSessionData._save_card_auth = {
            stripe_payment_method_id: meta.stripe_pm_id,
            stripe_customer_id: meta.stripe_customer_id,
            card_last4: ((offer.card_display as string) || '').match(/\*{4}(\d{4})/)?.[1] || '',
            card_brand: ((offer.card_display as string) || '').split(' ')[0] || '',
          };
        }

        // Use establish_saved_card_session for normalized digits-only phone
        const { error: sessionErr } = await supabase.rpc('establish_saved_card_session', {
          p_canon_phone: canonPhone,
          p_business_id: businessId,
          p_current_step: 'save_card_pin',
          p_session_data: pinSessionData,
        });

        if (sessionErr) {
          logger.error('[ACTIVATION-RETRY] Session establishment failed', { offerId, sessionErr });
          const { data: released, error: relErr } = await supabase.rpc('release_activation_delivery', {
            p_offer_id: offerId, p_claim_token: claimToken,
          });
          if (relErr || !released) {
            logger.error('[SAVED-CARD-CRON] Activation release failed', { relErr, released, offerId });
          }
          errors++;
          continue;
        }
      }

      // Send activation prompt using shared fenced delivery helper
      const cardDisplay = (offer.card_display as string) || 'your card';
      const activationMsg = (offer.offer_type as string) === 'save'
        ? `🔒 You chose to save ${cardDisplay} for faster checkout. Create your 4-digit *Waaiio PIN* to activate it.`
        : `🔒 You chose to save ${cardDisplay}. Enter your existing *Waaiio PIN* to update your saved card.`;

      const { sendWithFencedDelivery } = await import('@/lib/payments/saved-card-delivery');
      const activationOutcome = await sendWithFencedDelivery({
        supabase,
        offerId,
        claimToken,
        customerPhone: canonPhone,
        businessId,
        channelId,
        messageText: activationMsg,
        markStarted: (id, token) => supabase.rpc('mark_activation_send_started', { p_offer_id: id, p_claim_token: token }),
        // complete_activation_delivery (M395) takes exactly 2 args — no p_customer_phone
        complete: (id, token) => supabase.rpc('complete_activation_delivery', { p_offer_id: id, p_claim_token: token }),
        releasePreEmission: (id, token) => supabase.rpc('release_activation_pre_emission', { p_offer_id: id, p_claim_token: token }),
      });

      if (activationOutcome === 'delivered') {
        // Mark activation prompt sent for legacy tracking
        await supabase.from('payment_saved_card_offers')
          .update({ activation_prompt_sent_at: new Date().toISOString() })
          .eq('id', offerId);
        retried++;
        logger.info('[ACTIVATION-RETRY] Activation prompt sent and confirmed', { offerId, customerPhone });
      } else {
        errors++;
      }
    } catch (err) {
      logger.error('[ACTIVATION-RETRY] Processing threw — releasing claim', { offerId, err });
      try {
        const { data: released, error: relErr } = await supabase.rpc('release_activation_delivery', {
          p_offer_id: offerId, p_claim_token: claimToken,
        });
        if (relErr || !released) {
          logger.error('[SAVED-CARD-CRON] Activation release failed in catch', { relErr, released, offerId });
        }
      } catch { /* best-effort release */ }
      errors++;
    }
  }

  // ── R5-B3: Confirmation recovery loop (extracted to shared helper) ──
  const { processSavedCardConfirmationRecovery } = await import('@/lib/payments/saved-card-delivery');
  const { recovered: confirmRetried, errors: confirmErrors } = await processSavedCardConfirmationRecovery(supabase, 10);

  return NextResponse.json({ retried, errors, confirmRetried, confirmErrors });
}
