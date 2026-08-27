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

/** Format fulfillment_status for human display (no internal codes leaked). */
function formatFulfillmentStatus(status: string): string {
  switch (status) {
    case 'pending': return 'Pending';
    case 'processing': return 'Processing';
    case 'fulfilled': return 'Fulfilled';
    case 'rejected': return 'Rejected';
    case 'cancelled': return 'Cancelled';
    default: return 'Unknown';
  }
}

export async function handlePromoVerification(
  _supabase: SupabaseClient, // kept for signature compat; we use service client for writes
  sendText: (to: string, text: string) => Promise<void>,
  from: string,
  messageText: string,
  businessId: string,
  inboundMessageId?: string,
  effectiveCapabilities?: string[],
  bizResolution?: string, // ACC-204: trusted provenance for CLAIM/STATUS self-service
): Promise<PromoHandlerResult> {
  const text = messageText.trim();

  if (!effectiveCapabilities || !effectiveCapabilities.includes('promo_verification')) {
    return { handled: false };
  }

  const service = createServiceClient();

  // 1.5. CLAIM/STATUS self-service commands (ACC-204)
  const claimMatch = text.match(/^CLAIM\s+(WAA-[A-Z0-9-]+)$/i);
  const statusMatch = text.match(/^STATUS\s+(WAA-[A-Z0-9-]+)$/i);

  if (claimMatch || statusMatch) {
    // Require trusted business provenance — fuzzy/returning_customer cannot self-service
    const TRUSTED_PROVENANCES = new Set(['pre_resolved', 'dedicated_number', 'restart', 'active_session']);
    if (!bizResolution || !TRUSTED_PROVENANCES.has(bizResolution)) {
      return { handled: false };
    }

    const reference = (claimMatch?.[1] || statusMatch?.[1])!.toUpperCase();

    const { data: redemption } = await service
      .from('promo_redemptions')
      .select('id, claim_reference, fulfillment_status, verification_mode, verification_status, campaign_id, promo_code_id')
      .eq('claim_reference', reference)
      .eq('phone_e164', from)
      .eq('business_id', businessId)
      .eq('outcome', 'winner')
      .maybeSingle();

    if (!redemption) {
      await sendText(from, "We couldn't find that claim. Please check the reference and try again.");
      return { handled: true };
    }

    // Verify campaign belongs to this business
    const { data: campaign } = await service
      .from('promo_campaigns')
      .select('name')
      .eq('id', redemption.campaign_id)
      .eq('business_id', businessId)
      .maybeSingle();

    if (!campaign) {
      await sendText(from, "We couldn't find that claim. Please check the reference and try again.");
      return { handled: true };
    }

    // Fetch prize name via code -> prize_id
    let prizeName = 'Prize';
    if (redemption.promo_code_id) {
      const { data: codeRow } = await service
        .from('promo_campaign_codes')
        .select('prize_id')
        .eq('id', redemption.promo_code_id)
        .maybeSingle();
      if (codeRow?.prize_id) {
        const { data: prize } = await service
          .from('promo_prizes')
          .select('name')
          .eq('id', codeRow.prize_id)
          .maybeSingle();
        if (prize?.name) prizeName = prize.name;
      }
    }

    // Build response (no sensitive data — no phone, OTP, or internal notes)
    const lines = [
      `📋 *Claim Reference:* ${redemption.claim_reference}`,
      `🏆 *Prize:* ${prizeName}`,
      `📊 *Status:* ${formatFulfillmentStatus(redemption.fulfillment_status)}`,
    ];

    if (redemption.verification_mode === 'secure_pickup') {
      if (redemption.verification_status === 'verified') {
        lines.push('✅ Verification: Complete');
      } else {
        lines.push('🔐 Verification: Pending (OTP required at pickup)');
      }
    }

    await sendText(from, lines.join('\n'));
    return { handled: true };
  }

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
