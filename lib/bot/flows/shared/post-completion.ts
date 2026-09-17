import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';
import { getEnabledCapabilities } from '@/lib/capabilities/service';
import type { CapabilityId } from '@/lib/capabilities/types';
import { generateReceiptPdf } from '@/lib/pdf/receipt-generator';
import { PRICING_TIERS, type CountryCode, type SubscriptionTier } from '@/lib/constants';
import { triggerSequences } from '@/lib/bot/automation/sequence-service';
import { evaluateRules } from '@/lib/bot/automation/rules-engine';
import { calculateLtvTier } from '@/lib/bot/customer-intelligence';

interface PostCompletionParams {
  supabase: SupabaseClient;
  businessId: string;
  customerPhone: string;
  customerName: string | null;
  serviceType?: string;
  referenceId?: string;
  sender?: MessageSender;
  /** Payment ID for exactly-once RPCs (loyalty, CRM visit). Optional for backward compat. */
  paymentId?: string;
  /** Master claim token for manifest lifecycle drivers. Required when paymentId is set. */
  claimToken?: string;
  /** True when the WhatsApp channel is temporarily unavailable for a WhatsApp-origin payment.
   *  WhatsApp-dependent effects must NOT be skipped — they stay pending for retry. */
  whatsappOriginMissingChannel?: boolean;
  /** Amount paid (in smallest currency unit) for auto-receipt */
  amountPaid?: number;
  /** Service/product name for receipt */
  serviceName?: string;
  /** Reference code (e.g. BW-1234) for receipt */
  referenceCode?: string;
  /** If true, skip loyalty points (e.g. giving/donation transactions) */
  skipLoyalty?: boolean;
  /** If true, skip automation triggers (order_created/after_order already fired at creation) */
  skipAutomation?: boolean;
  /** If true, suppress only the monetary customer-spend mutation (Stage 2 owns spend).
   *  Visit counters, last_seen, booking counts, and receipts still use real amountPaid. */
  skipCustomerSpend?: boolean;
  /** Optional translation function for customer-facing messages (from ctx.t) */
  translate?: (text: string) => Promise<string>;
}

function generateReferralCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * Called after any service is completed (queue, booking, order).
 * Checks enabled capabilities and triggers loyalty, feedback, and referral actions.
 */
export async function handlePostCompletion(params: PostCompletionParams): Promise<void> {
  const { supabase, businessId, customerPhone, customerName, serviceType, referenceId, sender, paymentId, claimToken, whatsappOriginMissingChannel, amountPaid, serviceName, referenceCode, skipLoyalty, skipAutomation, skipCustomerSpend, translate } = params;
  const t = translate ?? ((text: string) => Promise.resolve(text));

  // Parallel: load capabilities + business data in one round-trip
  let capabilities: CapabilityId[];
  let biz: { name: string; country_code: string | null; subscription_tier: string | null; metadata: Record<string, unknown> | null } | null;
  try {
    const [caps, bizResult] = await Promise.all([
      getEnabledCapabilities(supabase, businessId),
      supabase
        .from('businesses')
        .select('name, country_code, subscription_tier, metadata')
        .eq('id', businessId)
        .single(),
    ]);
    capabilities = caps;
    biz = (bizResult.data ?? null) as typeof biz;
  } catch (err) {
    logger.withContext({ op: 'post-completion.capabilities-load', ...safeLogErrorContext(err) }).warn('[POST-COMPLETION] Failed to load capabilities/business data');
    return;
  }

  const phone = customerPhone.startsWith('+') ? customerPhone.slice(1) : customerPhone;
  const phoneWithPlus = customerPhone.startsWith('+') ? customerPhone : `+${customerPhone}`;
  const bizName = biz?.name ?? 'Business';
  const meta = (biz?.metadata ?? {}) as Record<string, unknown>;

  // Auto-create customer profile if not exists (so Customers tab has data immediately)
  try {
    // v13: exactly-once CRM visit via DB RPC + manifest lifecycle driver
    if (paymentId) {
      // Import manifest driver — the real CRM mutation happens INSIDE the driver callback
      const { driveInternalEffect } = await import('@/lib/payments/terminal-effects');
      const token = claimToken || paymentId; // claimToken required for manifest; fallback for non-manifest callers
      await driveInternalEffect(supabase, paymentId, 'crm_visit_increment', token, async () => {
        // REAL MUTATION: the exactly-once RPC is the authoritative internal effect
        const { data: visitResult, error: visitErr } = await supabase.rpc('apply_payment_customer_visit_once', {
          p_payment_id: paymentId,
        });
        if (visitErr) throw new Error(`apply_payment_customer_visit_once failed: ${visitErr.message}`);
        // Recalculate LTV tier from the now-updated profile
        if (visitResult?.applied) {
          const { data: updatedProfile } = await supabase.from('customer_profiles')
            .select('id, total_spent, total_visits, first_seen_at')
            .eq('business_id', businessId)
            .eq('phone', phoneWithPlus)
            .maybeSingle();
          if (updatedProfile) {
            const tier = calculateLtvTier(updatedProfile.total_spent || 0, updatedProfile.total_visits || 0, updatedProfile.first_seen_at);
            await supabase.from('customer_profiles').update({ ltv_tier: tier }).eq('id', updatedProfile.id);
          }
        }
      });
    }
    // Legacy path (no paymentId) or RPC fallback
    if (!paymentId) {
      const { data: existing } = await supabase
        .from('customer_profiles')
        .select('id')
        .eq('business_id', businessId)
        .eq('phone', phoneWithPlus)
        .maybeSingle();

      if (existing) {
        const spendAmount = skipCustomerSpend ? 0 : (amountPaid || 0);
        const { error: rpcErr } = await supabase.rpc('increment_customer_visit', {
          p_business_id: businessId,
          p_phone: phoneWithPlus,
          p_amount: spendAmount,
        });
        if (rpcErr) {
          await supabase.from('customer_profiles')
            .update({ last_seen_at: new Date().toISOString(), name: customerName || undefined })
            .eq('id', existing.id);
        }
        const { data: updatedProfile } = await supabase.from('customer_profiles')
          .select('total_spent, total_visits, first_seen_at')
          .eq('id', existing.id)
          .maybeSingle();
        if (updatedProfile) {
          const tier = calculateLtvTier(updatedProfile.total_spent || 0, updatedProfile.total_visits || 0, updatedProfile.first_seen_at);
          await supabase.from('customer_profiles').update({ ltv_tier: tier }).eq('id', existing.id);
        }
      } else {
        const newTotalSpent = skipCustomerSpend ? 0 : (amountPaid || 0);
        const newLtvTier = calculateLtvTier(newTotalSpent, 1);
        await supabase.from('customer_profiles').insert({
          business_id: businessId,
          phone: phoneWithPlus,
          name: customerName || null,
          total_bookings: 1,
          total_visits: 1,
          total_spent: newTotalSpent,
          ltv_tier: newLtvTier,
          last_seen_at: new Date().toISOString(),
          first_seen_at: new Date().toISOString(),
        });
      }
    }
  } catch (err) {
    logger.warn('[POST-COMPLETION] Customer profile handling failed (non-critical):', err);
  }

  // 0. Auto-receipt — send PDF receipt (text receipt removed in #268 — PDF is sufficient,
  // and sendProactiveConfirmation already sends a confirmation text with amount/ref/tips)
  if (amountPaid && amountPaid > 0) {
    try {
      const cc = (biz?.country_code || 'NG') as CountryCode;
      const isWhitelabel = PRICING_TIERS[(biz?.subscription_tier || 'free') as SubscriptionTier]?.whitelabel === true;
      const generateAndStoreReceipt = async () => {
        const pdfBuffer = await generateReceiptPdf({
          businessName: bizName,
          referenceCode: referenceCode || '-',
          date: new Date().toISOString(),
          serviceName: serviceName || 'Service',
          amount: amountPaid,
          paymentStatus: 'paid',
          customerName: customerName || 'Customer',
          customerPhone,
          countryCode: (cc as CountryCode) || 'NG',
          whitelabel: isWhitelabel,
        });

        const stableId = paymentId || crypto.randomUUID();
        const filePath = `receipts/${businessId}/${stableId}.pdf`;
        const { error: uploadError } = await supabase.storage
          .from('customer-reports')
          .upload(filePath, pdfBuffer, { contentType: 'application/pdf', upsert: !!paymentId });
        if (uploadError) throw new Error(`receipt_upload_failed:${uploadError.message}`);
        if (paymentId) {
          const { error: markerError } = await supabase.from('payment_receipt_applications').upsert({
            payment_id: paymentId,
            file_path: filePath,
            generation_state: 'completed',
          }, { onConflict: 'payment_id' });
          if (markerError) throw new Error(`receipt_marker_failed:${markerError.message}`);
        }
        return filePath;
      };

      if (paymentId && claimToken) {
        const { driveInternalEffect, driveExternalEffect, skipOptionalEffect } = await import('@/lib/payments/terminal-effects');
        const generation = await driveInternalEffect(
          supabase, paymentId, 'receipt_pdf_generation', claimToken,
          async () => { await generateAndStoreReceipt(); },
        );
        if (!generation.ok) throw new Error(`receipt_generation_effect_failed:${generation.error}`);

        const { data: marker, error: markerReadError } = await supabase
          .from('payment_receipt_applications')
          .select('file_path, generation_state')
          .eq('payment_id', paymentId)
          .maybeSingle();
        if (markerReadError || !marker || marker.generation_state !== 'completed') {
          throw new Error(`receipt_marker_read_failed:${markerReadError?.message || 'missing'}`);
        }
        if (sender) {
          const delivery = await driveExternalEffect(
            supabase, paymentId, 'receipt_pdf_delivery', claimToken,
            async () => {
              const { data: signedUrlData, error: signedUrlError } = await supabase.storage
                .from('customer-reports')
                .createSignedUrl(marker.file_path, 3600);
              if (signedUrlError || !signedUrlData?.signedUrl) throw new Error('receipt_signed_url_failed');
              await sender.sendDocument({
                to: phone,
                documentUrl: signedUrlData.signedUrl,
                filename: `receipt-${referenceCode || paymentId.slice(0, 8)}.pdf`,
                caption: 'Your payment receipt',
              });
              return true;
            },
          );
          if (!delivery.ok) throw new Error(`receipt_delivery_effect_failed:${delivery.error}`);
        } else if (!whatsappOriginMissingChannel) {
          // Genuine non-WhatsApp flow: skip is valid
          const skipped = await skipOptionalEffect(
            supabase, paymentId, 'receipt_pdf_delivery', claimToken, 'no_resolved_whatsapp_sender',
          );
          if (!skipped.ok) throw new Error(`receipt_delivery_skip_failed:${skipped.error}`);
        }
        // else: WhatsApp-origin missing channel — leave pending for retry
      } else {
        const filePath = await generateAndStoreReceipt();
        const { data: signedUrlData, error: signedUrlError } = await supabase.storage
          .from('customer-reports')
          .createSignedUrl(filePath, 3600);
        if (!signedUrlError && signedUrlData?.signedUrl && sender) {
          await sender.sendDocument({
            to: phone,
            documentUrl: signedUrlData.signedUrl,
            filename: `receipt-${referenceCode || 'payment'}.pdf`,
            caption: 'Your payment receipt',
          });
        }
      }
    } catch (err) {
      logger.withContext({ op: 'post-completion.auto-receipt', ...safeLogErrorContext(err) }).error('[POST-COMPLETION] Auto-receipt error');
    }
  }

  // 1. Loyalty — award points (skip for giving/donation, and require explicit opt-in)
  const loyaltyEnabled = meta.loyalty_earning_enabled === true;
  if (capabilities.includes('loyalty') && loyaltyEnabled && !skipLoyalty) {
    try {
      // v13: exactly-once loyalty via DB RPC + manifest lifecycle driver
      // The REAL loyalty mutation happens INSIDE the driver callback.
      if (paymentId) {
        const { driveInternalEffect } = await import('@/lib/payments/terminal-effects');
        const loyaltyToken = claimToken || paymentId;
        let loyaltyEarnedPoints = 0;
        await driveInternalEffect(supabase, paymentId, 'loyalty_award', loyaltyToken, async () => {
          // REAL MUTATION inside lifecycle authority
          const { data: loyaltyResult, error: loyaltyErr } = await supabase.rpc('apply_payment_loyalty_once', {
            p_payment_id: paymentId,
          });
          if (loyaltyErr) throw new Error(`apply_payment_loyalty_once failed: ${loyaltyErr.message}`);
          if (loyaltyResult?.applied && !loyaltyResult?.already_applied) {
            loyaltyEarnedPoints = loyaltyResult.points_awarded || 0;
          }
        });
        // Read the durable award marker so a retry can notify using the original award.
        const { data: loyaltyMarker, error: markerError } = await supabase
          .from('payment_loyalty_applications')
          .select('points_awarded')
          .eq('payment_id', paymentId)
          .maybeSingle();
        if (markerError) throw new Error(`loyalty_marker_read_failed:${markerError.message}`);
        loyaltyEarnedPoints = loyaltyMarker?.points_awarded || loyaltyEarnedPoints;
        if (loyaltyEarnedPoints > 0 && sender && claimToken) {
          const { data: balanceRow } = await supabase.from('loyalty_points').select('points_balance')
            .eq('business_id', businessId).eq('customer_phone', customerPhone).maybeSingle();
          const newBalance = balanceRow?.points_balance || loyaltyEarnedPoints;
          const rewardThreshold = (meta.loyalty_reward_threshold as number) || 100;
          const rewardDesc = (meta.loyalty_reward_description as string) || 'a special reward';
          const pointsUntilReward = Math.max(0, rewardThreshold - newBalance);
          let loyaltyMsg = `+${loyaltyEarnedPoints} points earned at *${bizName}*! Your balance: *${newBalance}* points.`;
          if (pointsUntilReward === 0) { loyaltyMsg += `\n\nYou have enough points to redeem *${rewardDesc}*! Type *my points* to claim it.`; }
          else { loyaltyMsg += `\n\n${pointsUntilReward} more until ${rewardDesc}.`; }
          const { driveExternalEffect } = await import('@/lib/payments/terminal-effects');
          const notifyResult = await driveExternalEffect(
            supabase, paymentId, 'customer_loyalty_whatsapp', claimToken,
            async () => {
              await sender.sendText({ to: customerPhone, text: await t(loyaltyMsg) });
              return true;
            },
          );
          if (!notifyResult.ok) throw new Error(`loyalty_notification_effect_failed:${notifyResult.error}`);
        } else if (loyaltyEarnedPoints > 0 && claimToken && !whatsappOriginMissingChannel) {
          // Genuine non-WhatsApp flow: skip is valid
          const { skipOptionalEffect } = await import('@/lib/payments/terminal-effects');
          const skipped = await skipOptionalEffect(
            supabase, paymentId, 'customer_loyalty_whatsapp', claimToken, 'no_resolved_whatsapp_sender',
          );
          if (!skipped.ok) throw new Error(`loyalty_notification_skip_failed:${skipped.error}`);
        }
        // else: WhatsApp-origin missing channel — leave pending for retry
      } else {
        // Legacy path (no paymentId): use inline loyalty logic
        const pointsMode = (meta.loyalty_points_mode as string) || 'per_visit';
        const pointsPerVisit = (meta.loyalty_points_per_visit as number) || 10;
        const pointsPerCurrency = (meta.loyalty_points_per_currency as number) || 0;
        let earnedPoints = pointsPerVisit;
        if (pointsMode === 'per_amount' && pointsPerCurrency > 0 && amountPaid && amountPaid > 0) {
          earnedPoints = Math.floor(amountPaid / pointsPerCurrency);
          if (earnedPoints < 1) earnedPoints = 1;
        }
        const { data: existing } = await supabase.from('loyalty_points').select('id, points_balance, total_earned, visit_count').eq('business_id', businessId).eq('customer_phone', customerPhone).maybeSingle();
        if (existing) {
          await supabase.from('loyalty_points').update({ points_balance: existing.points_balance + earnedPoints, total_earned: existing.total_earned + earnedPoints, visit_count: existing.visit_count + 1, customer_name: customerName || undefined }).eq('id', existing.id);
        } else {
          await supabase.from('loyalty_points').insert({ business_id: businessId, customer_phone: customerPhone, customer_name: customerName, points_balance: earnedPoints, total_earned: earnedPoints, visit_count: 1 });
        }
        await supabase.from('loyalty_transactions').insert({ business_id: businessId, customer_phone: customerPhone, points_change: earnedPoints, reason: 'visit', reference_id: referenceId || null, reference_type: serviceType || null });
        const newBalance = (existing?.points_balance || 0) + earnedPoints;
        const rewardThreshold = (meta.loyalty_reward_threshold as number) || 100;
        const rewardDesc = (meta.loyalty_reward_description as string) || 'a special reward';
        const pointsUntilReward = Math.max(0, rewardThreshold - newBalance);
        let loyaltyMsg = `+${earnedPoints} points earned at *${bizName}*! Your balance: *${newBalance}* points.`;
        if (pointsUntilReward === 0) { loyaltyMsg += `\n\nYou have enough points to redeem *${rewardDesc}*! Type *my points* to claim it.`; }
        else { loyaltyMsg += `\n\n${pointsUntilReward} more until ${rewardDesc}.`; }
        if (sender) t(loyaltyMsg).then(translated => sender.sendText({ to: customerPhone, text: translated })).catch(err => logger.withContext({ op: 'post-completion.loyalty-send', ...safeLogErrorContext(err) }).error('[POST-COMPLETION] Failed to send loyalty message'));
      }
    } catch (err) {
      logger.withContext({ op: 'post-completion.loyalty', ...safeLogErrorContext(err) }).error('[POST-COMPLETION] Loyalty error');
    }
  }

  // 1b. Membership — auto-assign loyalty tier based on lifetime spend
  // Runs after loyalty points but before feedback, so the tier is current for next visit's multiplier.
  // Safe on retry: assignCustomerTier is idempotent (reads total_spent, assigns highest qualifying tier).
  if (capabilities.includes('membership')) {
    try {
      const assignTier = async () => {
        const { data: cp, error: cpError } = await supabase
          .from('customer_profiles')
          .select('id')
          .eq('business_id', businessId)
          .eq('phone', phoneWithPlus)
          .maybeSingle();
        if (cpError) throw new Error(`membership_profile_lookup_failed:${cpError.message}`);
        if (!cp) throw new Error('membership_profile_missing');
        const { assignCustomerTier } = await import('@/lib/membership/assign-tiers');
        await assignCustomerTier(supabase, businessId, cp.id, true);
      };
      if (paymentId && claimToken) {
        const { driveInternalEffect } = await import('@/lib/payments/terminal-effects');
        const result = await driveInternalEffect(supabase, paymentId, 'membership_tier_assignment', claimToken, assignTier);
        if (!result.ok) throw new Error(result.error);
      } else {
        await assignTier();
      }
    } catch (err) {
      logger.withContext({ op: 'post-completion.tier-assign', ...safeLogErrorContext(err) }).error('[POST-COMPLETION] Tier assignment error');
    }
  }

  // 2. Feedback — mark booking for feedback request (sent 24h later by reminder cron)
  // Customer can also type "feedback" or "rate" anytime
  if (referenceId && capabilities.includes('feedback')) {
    try {
      const table = serviceType === 'order' ? 'orders' : 'bookings';
      const markFeedback = async () => {
        const { error } = await supabase
          .from(table)
          .update({ metadata: { feedback_requested: false, completed_at: new Date().toISOString() } })
          .eq('id', referenceId);
        if (error) throw new Error(`feedback_marker_update_failed:${error.message}`);
      };
      if (paymentId && claimToken) {
        const { driveInternalEffect } = await import('@/lib/payments/terminal-effects');
        const result = await driveInternalEffect(supabase, paymentId, 'feedback_marker', claimToken, markFeedback);
        if (!result.ok) throw new Error(result.error);
      } else {
        await markFeedback();
      }
    } catch (err) { logger.warn('[POST-COMPLETION] Failed to mark feedback requested (non-critical):', err); }
  }

  // 2.5. Sequences & Rules — trigger automation after completion
  // Skip for orders when automation already fired at creation (order_created + after_order).
  // For paid orders, sendProactiveConfirmation sets skipAutomation=true to prevent duplicates.
  if (skipAutomation) {
    // Automation already fired at order creation — skip to avoid duplicate events
  } else try {
    const triggerEvent = serviceType === 'order' ? 'after_order' : 'after_booking';
    const ruleEvent = serviceType === 'order' ? 'order_created' : 'booking_completed';

    const automationContext: Record<string, unknown> = {
      customer_phone: customerPhone,
      customer_name: customerName,
      service_name: serviceName,
      amount_paid: amountPaid,
      reference_code: referenceCode,
      reference_id: referenceId,
      service_type: serviceType,
    };

    if (bizName) automationContext.business_name = bizName;

    if (paymentId && claimToken) {
      const { driveInternalEffect } = await import('@/lib/payments/terminal-effects');
      const sequenceResult = await driveInternalEffect(
        supabase, paymentId, 'automation_sequences', claimToken,
        () => triggerSequences(supabase, businessId, triggerEvent, customerPhone, automationContext),
      );
      if (!sequenceResult.ok) throw new Error(`automation_sequences_failed:${sequenceResult.error}`);

      const ruleResult = await driveInternalEffect(
        supabase, paymentId, 'automation_rule_handoff', claimToken,
        async () => {
          const { runSealedRuleActions } = await import('@/lib/bot/automation/sealed-rule-actions');
          await runSealedRuleActions({ supabase, paymentId, businessId, event: ruleEvent, context: automationContext, sender });
        },
      );
      if (!ruleResult.ok) throw new Error(`automation_rule_handoff_failed:${ruleResult.error}`);
    } else {
      // Legacy path: no paymentId, execute rules directly
      await triggerSequences(supabase, businessId, triggerEvent, customerPhone, automationContext);
      const sendMsg = async (to: string, text: string) => {
        if (!sender) throw new Error('rule_sender_unavailable');
        await sender.sendText({ to, text });
      };
      await evaluateRules(supabase, businessId, ruleEvent, automationContext, sendMsg);
    }
  } catch (err) {
    logger.withContext({ op: 'post-completion.automation', ...safeLogErrorContext(err) }).error('[POST-COMPLETION] Automation error (non-fatal)');
  }

  // 3. Referral — generate code silently (customer can access via "refer" keyword)
  // Don't auto-send referral message after every transaction
  if (capabilities.includes('referral')) {
    try {
      const ensureReferral = async () => {
        const { data: existingRef, error: lookupError } = await supabase
          .from('referrals')
          .select('referral_code')
          .eq('business_id', businessId)
          .eq('referrer_phone', customerPhone)
          .eq('status', 'pending')
          .maybeSingle();
        if (lookupError) throw new Error(`referral_lookup_failed:${lookupError.message}`);

        if (!existingRef) {
          const { error: insertError } = await supabase.from('referrals').insert({
            business_id: businessId,
            referrer_phone: customerPhone,
            referrer_name: customerName,
            referral_code: generateReferralCode(),
            status: 'pending',
            reward_type: (meta.referral_reward_type as string) || 'points',
            reward_amount: (meta.referral_reward_amount as number) || 50,
          });
          if (insertError && insertError.code !== '23505') {
            throw new Error(`referral_insert_failed:${insertError.message}`);
          }
        }
      };
      if (paymentId && claimToken) {
        const { driveInternalEffect } = await import('@/lib/payments/terminal-effects');
        const result = await driveInternalEffect(supabase, paymentId, 'referral_generation', claimToken, ensureReferral);
        if (!result.ok) throw new Error(result.error);
      } else {
        await ensureReferral();
      }
    } catch (err) {
      logger.withContext({ op: 'post-completion.referral', ...safeLogErrorContext(err) }).error('[POST-COMPLETION] Referral error');
    }
  }
}
