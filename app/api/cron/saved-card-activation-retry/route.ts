/**
 * Saved Card Activation Retry Worker
 *
 * Retries failed PIN-activation message delivery using durable claim/fencing.
 * Uses the EXACT originating WhatsApp channel — no business-current fallback.
 * Never repeats Stripe consent, redisplay downgrade, or credential setup.
 *
 * Concurrency: claim_activation_delivery RPC (FOR UPDATE SKIP LOCKED)
 * ensures exactly one worker owns each offer. Completion/release fenced
 * by claim token.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { verifyCronAuth } from '@/lib/cron-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

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

    try {
      // R2-B3: Exact originating channel ONLY — no fallback
      if (!channelId) {
        logger.warn('[ACTIVATION-RETRY] No exact channel_id on offer — fail closed', { offerId });
        await supabase.rpc('release_activation_delivery', {
          p_offer_id: offerId, p_claim_token: claimToken,
        });
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
        await supabase.rpc('release_activation_delivery', {
          p_offer_id: offerId, p_claim_token: claimToken,
        });
        continue;
      }

      // Load exact channel credentials
      const { data: channelCreds } = await supabase
        .from('whatsapp_channels')
        .select('phone_number_id, access_token')
        .eq('id', channelId)
        .maybeSingle();

      if (!channelCreds?.phone_number_id || !channelCreds?.access_token) {
        logger.warn('[ACTIVATION-RETRY] Exact channel credentials unavailable — fail closed', { offerId, channelId });
        await supabase.rpc('release_activation_delivery', {
          p_offer_id: offerId, p_claim_token: claimToken,
        });
        errors++;
        continue;
      }

      // Ensure bot session exists for PIN entry
      const { data: existingSession } = await supabase.from('bot_sessions')
        .select('id, version, current_step')
        .eq('whatsapp_number', customerPhone)
        .eq('business_id', offer.business_id as string)
        .eq('is_active', true)
        .maybeSingle();

      if (!existingSession || existingSession.current_step !== 'save_card_pin') {
        // Re-establish PIN session with Stripe evidence from payment metadata
        const { data: payment } = await supabase.from('payments')
          .select('metadata').eq('id', paymentId).single();

        const pinSessionData: Record<string, unknown> = {
          _save_card_pending: true,
          _save_card_business_id: offer.business_id,
          _save_card_gateway: 'stripe',
          _save_card_payment_id: paymentId,
          _save_card_offer_id: offerId,
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

        if (existingSession) {
          await supabase.rpc('update_session_cas', {
            p_session_id: existingSession.id,
            p_expected_version: existingSession.version ?? 0,
            p_current_step: 'save_card_pin',
            p_session_data: pinSessionData,
          });
        } else {
          await supabase.from('bot_sessions').insert({
            whatsapp_number: customerPhone,
            business_id: offer.business_id,
            current_step: 'save_card_pin',
            session_data: pinSessionData,
            is_active: true,
            expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          });
        }
      }

      // R3-B1: Durable outbound-effect lifecycle
      // Step 1: Mark send started BEFORE provider call — prevents auto-retry after success
      const { data: sendStarted } = await supabase.rpc('mark_activation_send_started', {
        p_offer_id: offerId, p_claim_token: claimToken,
      });
      if (!sendStarted) {
        // Could not mark send started — release claim
        await supabase.rpc('release_activation_delivery', {
          p_offer_id: offerId, p_claim_token: claimToken,
        });
        errors++;
        continue;
      }

      // Step 2: Send activation prompt
      const cardDisplay = (offer.card_display as string) || 'your card';
      const activationMsg = (offer.offer_type as string) === 'save'
        ? `🔒 You chose to save ${cardDisplay} for faster checkout. Create your 4-digit *Waaiio PIN* to activate it.`
        : `🔒 You chose to save ${cardDisplay}. Enter your existing *Waaiio PIN* to update your saved card.`;

      const { MetaCloudSender } = await import('@/lib/channels/message-sender');
      const sender = new MetaCloudSender(channelCreds.phone_number_id, channelCreds.access_token);
      const sendResult = await sender.sendText({ to: customerPhone, text: activationMsg });

      if (!sendResult?.success) {
        // Send FAILED — clear send_started_at to allow retry (send did not succeed)
        await supabase.from('payment_saved_card_offers')
          .update({ activation_send_started_at: null })
          .eq('id', offerId)
          .eq('claim_token', claimToken);
        await supabase.rpc('release_activation_delivery', {
          p_offer_id: offerId, p_claim_token: claimToken,
        });
        errors++;
        continue;
      }

      // Step 3: Send SUCCEEDED — mark durable completion
      const { data: completed } = await supabase.rpc('complete_activation_delivery', {
        p_offer_id: offerId, p_claim_token: claimToken,
      });

      if (!completed) {
        // R3-B1: Send succeeded but durable completion failed.
        // activation_send_started_at is set → offer will NOT be auto-claimed again.
        // The offer is in a non-retryable ambiguous state.
        // Reconciliation/manual repair must finish the state later.
        logger.error('[ACTIVATION-RETRY] AMBIGUOUS: send succeeded but completion write failed — NOT auto-retryable', { offerId });
        // Do NOT release claim — let it expire naturally. The offer won't be reclaimed
        // because activation_send_started_at IS NOT NULL blocks the claim RPC.
        errors++;
        continue;
      }

      retried++;
      logger.info('[ACTIVATION-RETRY] Activation prompt sent and confirmed', { offerId, customerPhone });
    } catch (err) {
      logger.error('[ACTIVATION-RETRY] Processing threw — releasing claim', { offerId, err });
      try {
        await supabase.rpc('release_activation_delivery', {
          p_offer_id: offerId, p_claim_token: claimToken,
        });
      } catch { /* best-effort release */ }
      errors++;
    }
  }

  return NextResponse.json({ retried, errors });
}
