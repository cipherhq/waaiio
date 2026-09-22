/**
 * Saved Card Activation Retry Worker
 *
 * Retries failed PIN-activation message delivery for provider-consented
 * saved-card offers (Stripe) that have consent recorded but activation
 * prompt not yet delivered.
 *
 * Uses the exact originating WhatsApp channel stored on the offer.
 * Never repeats Stripe consent, redisplay downgrade, or credential setup.
 * Only retries the missing activation delivery.
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

  // Find accepted offers where activation prompt was NOT sent
  // and redisplay fence is proven (no pending set_allow_redisplay_limited cleanup)
  const { data: pendingOffers } = await supabase
    .from('payment_saved_card_offers')
    .select('id, customer_phone, business_id, offer_type, card_display, channel_id, consent_source, payment_id')
    .eq('state', 'accepted')
    .eq('consent_source', 'provider_checkout')
    .is('activation_prompt_sent_at', null)
    .order('created_at', { ascending: true })
    .limit(5);

  if (!pendingOffers || pendingOffers.length === 0) {
    return NextResponse.json({ retried: 0, errors: 0 });
  }

  for (const offer of pendingOffers) {
    try {
      // Verify redisplay fence is proven (no pending cleanup for this offer)
      const { data: pendingCleanup } = await supabase
        .from('provider_cleanup_operations')
        .select('id')
        .eq('source_offer_id', offer.id)
        .eq('operation_type', 'set_allow_redisplay_limited')
        .is('completed_at', null)
        .maybeSingle();

      if (pendingCleanup) {
        // Redisplay fence not yet proven — skip, let cleanup worker handle it first
        continue;
      }

      // Resolve the exact originating WhatsApp channel
      let channelPhone: string | null = null;
      if (offer.channel_id) {
        const { data: channel } = await supabase
          .from('whatsapp_channels')
          .select('phone_number')
          .eq('id', offer.channel_id)
          .maybeSingle();
        channelPhone = channel?.phone_number || null;
      }

      if (!channelPhone && offer.business_id) {
        // Fallback: resolve channel from business
        const { data: biz } = await supabase
          .from('businesses')
          .select('assigned_channel_id, whatsapp_channel_id')
          .eq('id', offer.business_id)
          .maybeSingle();
        const chId = biz?.assigned_channel_id || biz?.whatsapp_channel_id;
        if (chId) {
          const { data: ch } = await supabase
            .from('whatsapp_channels')
            .select('phone_number')
            .eq('id', chId)
            .maybeSingle();
          channelPhone = ch?.phone_number || null;
        }
      }

      if (!channelPhone) {
        logger.warn('[ACTIVATION-RETRY] No channel phone for offer — skipping', { offerId: offer.id });
        errors++;
        continue;
      }

      // Build activation message
      const cardDisplay = offer.card_display || 'your card';
      const activationMsg = offer.offer_type === 'save'
        ? `🔒 You chose to save ${cardDisplay} for faster checkout. Create your 4-digit *Waaiio PIN* to activate it.`
        : `🔒 You chose to save ${cardDisplay}. Enter your existing *Waaiio PIN* to update your saved card.`;

      // Ensure bot session exists for PIN entry
      const { data: existingSession } = await supabase.from('bot_sessions')
        .select('id, version, current_step')
        .eq('whatsapp_number', offer.customer_phone)
        .eq('business_id', offer.business_id)
        .eq('is_active', true)
        .maybeSingle();

      if (!existingSession || existingSession.current_step !== 'save_card_pin') {
        // Re-establish session for PIN activation
        const pinSessionData = {
          _save_card_pending: true,
          _save_card_business_id: offer.business_id,
          _save_card_gateway: 'stripe',
          _save_card_payment_id: offer.payment_id,
          _save_card_offer_id: offer.id,
        };

        // Read Stripe evidence from payment metadata
        const { data: payment } = await supabase.from('payments')
          .select('metadata')
          .eq('id', offer.payment_id)
          .single();

        if (payment?.metadata) {
          const meta = payment.metadata as Record<string, unknown>;
          (pinSessionData as Record<string, unknown>)._save_card_auth = {
            stripe_payment_method_id: meta.stripe_pm_id,
            stripe_customer_id: meta.stripe_customer_id,
            card_last4: (offer.card_display || '').match(/\*{4}(\d{4})/)?.[1] || '',
            card_brand: (offer.card_display || '').split(' ')[0] || '',
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
            whatsapp_number: offer.customer_phone,
            business_id: offer.business_id,
            current_step: 'save_card_pin',
            session_data: pinSessionData,
            is_active: true,
            expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          });
        }
      }

      // Send activation prompt via the resolved channel
      // Look up channel credentials for the exact originating channel
      const resolvedChannelId = offer.channel_id || channelPhone;
      if (!resolvedChannelId) {
        errors++;
        continue;
      }
      const { data: channelCreds } = await supabase
        .from('whatsapp_channels')
        .select('phone_number_id, access_token')
        .eq('id', offer.channel_id || '')
        .maybeSingle();

      if (!channelCreds?.phone_number_id || !channelCreds?.access_token) {
        logger.warn('[ACTIVATION-RETRY] Channel credentials not found — will retry', { offerId: offer.id });
        errors++;
        continue;
      }
      const { MetaCloudSender } = await import('@/lib/channels/message-sender');
      const sender = new MetaCloudSender(channelCreds.phone_number_id, channelCreds.access_token);
      const sendResult = await sender.sendText({ to: offer.customer_phone, text: activationMsg });
      if (!sendResult?.success) {
        logger.warn('[ACTIVATION-RETRY] Send failed — will retry next cycle', { offerId: offer.id });
        errors++;
        continue;
      }

      // Mark activation prompt sent
      await supabase.from('payment_saved_card_offers')
        .update({ activation_prompt_sent_at: new Date().toISOString() })
        .eq('id', offer.id)
        .eq('state', 'accepted')
        .is('activation_prompt_sent_at', null);

      retried++;
      logger.info('[ACTIVATION-RETRY] Activation prompt sent', { offerId: offer.id, phone: offer.customer_phone });
    } catch (err) {
      logger.error('[ACTIVATION-RETRY] Retry failed — offer stays retryable', { offerId: offer.id, err });
      errors++;
    }
  }

  return NextResponse.json({ retried, errors });
}
