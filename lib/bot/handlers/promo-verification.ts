/**
 * Promo code verification handler for WhatsApp bot.
 *
 * Supports two entry patterns:
 * 1. Keyword mode: "PROMO K7PM-4XQ9-N2WF" (keyword + code)
 * 2. Bare code mode: "K7PM-4XQ9-N2WF" (code only)
 *
 * Eligibility flow (campaign-specific):
 * - When claim returns eligibility_required, writes a row to promo_pending_eligibility
 * - On YES reply, looks up the unresolved promo_pending_eligibility row for this phone+business
 * - Records ack for ONLY that campaign — then marks the pending row as resolved
 * - On NO/decline reply, marks the pending row as resolved without recording ack
 * - Unrelated YES/NO (no pending row) falls through to normal routing
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyPromoCode, looksLikePromoCode, hasActiveBareCodeCampaign, hasActiveKeywordCampaign } from '@/lib/promotions/verify';

interface PromoHandlerResult {
  handled: boolean;
}

export async function handlePromoVerification(
  _supabase: SupabaseClient, // kept for signature compat; we use service client for writes
  sendText: (to: string, text: string) => Promise<void>,
  from: string,
  messageText: string,
  businessId: string,
  inboundMessageId?: string,
  effectiveCapabilities?: string[],
): Promise<PromoHandlerResult> {
  const text = messageText.trim();

  if (!effectiveCapabilities || !effectiveCapabilities.includes('promo_verification')) {
    return { handled: false };
  }

  const service = createServiceClient();

  // 1. Check if this is a campaign-specific eligibility acknowledgment or decline
  const isAck = /^(yes|agree|i agree|accept|confirm)$/i.test(text);
  const isDecline = /^(no|decline|disagree|reject|cancel)$/i.test(text);

  if (isAck || isDecline) {
    // Find the unresolved pending eligibility row for this phone+business
    const { data: pending } = await service
      .from('promo_pending_eligibility')
      .select('id, campaign_id')
      .eq('business_id', businessId)
      .eq('phone_e164', from)
      .eq('resolved', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (pending) {
      if (isDecline) {
        // User declined — mark pending context resolved, no ack recorded
        await service
          .from('promo_pending_eligibility')
          .update({ resolved: true })
          .eq('id', pending.id);
        await sendText(from, 'Understood. You can participate in other promotions.');
        return { handled: true };
      }

      // User acknowledged — record ack for this specific campaign
      await service.from('promo_eligibility_acks').upsert(
        {
          campaign_id: pending.campaign_id,
          phone_e164: from,
          eligibility_mode: 'acknowledged',
        },
        { onConflict: 'campaign_id,phone_e164' },
      );
      // Mark pending context as resolved (consumed)
      await service
        .from('promo_pending_eligibility')
        .update({ resolved: true })
        .eq('id', pending.id);
      await sendText(from, 'Thank you for confirming. Please resend your promotion code now.');
      return { handled: true };
    }

    // No pending eligibility context — fall through to normal routing
    return { handled: false };
  }

  // 2. Check for keyword mode: "KEYWORD CODE"
  const parts = text.split(/\s+/);
  if (parts.length >= 2) {
    const potentialKeyword = parts[0].toUpperCase();
    const potentialCode = parts.slice(1).join('');

    const hasKeyword = await hasActiveKeywordCampaign(businessId, potentialKeyword);
    if (hasKeyword && looksLikePromoCode(potentialCode)) {
      logger.info(`[PROMO] Keyword verification: keyword=${potentialKeyword} from=...${from.slice(-4)}`);

      const result = await verifyPromoCode({
        businessId,
        rawCode: potentialCode,
        phoneE164: from,
        inboundMessageId,
        keyword: potentialKeyword,
      });

      if (result.eligibilityRequired) {
        // Record pending eligibility context so the YES/NO handler can find the right campaign
        if (result.campaignId) {
          await service.from('promo_pending_eligibility').upsert(
            {
              campaign_id: result.campaignId,
              business_id: businessId,
              phone_e164: from,
              resolved: false,
            },
            { onConflict: 'campaign_id,phone_e164,business_id' },
          );
        }
        await sendText(from, result.message + '\n\nReply YES to confirm and then resend your code.');
        return { handled: true };
      }

      await sendText(from, result.message);
      return { handled: true };
    }
  }

  // 3. Check for bare code mode
  if (looksLikePromoCode(text)) {
    const hasBareCode = await hasActiveBareCodeCampaign(businessId);
    if (hasBareCode) {
      logger.info(`[PROMO] Bare code verification from=...${from.slice(-4)}`);

      const result = await verifyPromoCode({
        businessId,
        rawCode: text,
        phoneE164: from,
        inboundMessageId,
      });

      if (result.eligibilityRequired) {
        // Record pending eligibility context so the YES/NO handler can find the right campaign
        if (result.campaignId) {
          await service.from('promo_pending_eligibility').upsert(
            {
              campaign_id: result.campaignId,
              business_id: businessId,
              phone_e164: from,
              resolved: false,
            },
            { onConflict: 'campaign_id,phone_e164,business_id' },
          );
        }
        await sendText(from, result.message + '\n\nReply YES to confirm and then resend your code.');
        return { handled: true };
      }

      await sendText(from, result.message);
      return { handled: true };
    }
  }

  return { handled: false };
}
