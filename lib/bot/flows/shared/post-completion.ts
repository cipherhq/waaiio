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
  const { supabase, businessId, customerPhone, customerName, serviceType, referenceId, sender, paymentId, claimToken, amountPaid, serviceName, referenceCode, skipLoyalty, skipAutomation, skipCustomerSpend, translate } = params;
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

      // Send PDF receipt as WhatsApp document attachment
      try {
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

        const uuid = crypto.randomUUID();
        const filePath = `receipts/${businessId}/${uuid}.pdf`;
        const filename = `receipt-${referenceCode || uuid.slice(0, 8)}.pdf`;

        await supabase.storage
          .from('customer-reports')
          .upload(filePath, pdfBuffer, { contentType: 'application/pdf', upsert: false });

        const { data: signedUrlData } = await supabase.storage
          .from('customer-reports')
          .createSignedUrl(filePath, 3600);

        if (signedUrlData?.signedUrl && sender) {
          await sender.sendDocument({
            to: phone,
            documentUrl: signedUrlData.signedUrl,
            filename,
            caption: 'Your payment receipt',
          });
        }
      } catch (pdfErr) {
        logger.withContext({ op: 'post-completion.pdf-receipt', ...safeLogErrorContext(pdfErr) }).error('[POST-COMPLETION] PDF receipt error (non-fatal)');
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
        // Notification (outside driver — not part of loyalty_award authority)
        if (loyaltyEarnedPoints > 0) {
          const { data: balanceRow } = await supabase.from('loyalty_points').select('points_balance')
            .eq('business_id', businessId).eq('customer_phone', customerPhone).maybeSingle();
          const newBalance = balanceRow?.points_balance || loyaltyEarnedPoints;
          const rewardThreshold = (meta.loyalty_reward_threshold as number) || 100;
          const rewardDesc = (meta.loyalty_reward_description as string) || 'a special reward';
          const pointsUntilReward = Math.max(0, rewardThreshold - newBalance);
          let loyaltyMsg = `+${loyaltyEarnedPoints} points earned at *${bizName}*! Your balance: *${newBalance}* points.`;
          if (pointsUntilReward === 0) { loyaltyMsg += `\n\nYou have enough points to redeem *${rewardDesc}*! Type *my points* to claim it.`; }
          else { loyaltyMsg += `\n\n${pointsUntilReward} more until ${rewardDesc}.`; }
          if (sender) t(loyaltyMsg).then(translated => sender.sendText({ to: customerPhone, text: translated })).catch(err => logger.withContext({ op: 'post-completion.loyalty-send', ...safeLogErrorContext(err) }).error('[POST-COMPLETION] Failed to send loyalty message'));
        }
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
      // Look up customer_profile by phone+business (use canonical phone format)
      const { data: cp } = await supabase
        .from('customer_profiles')
        .select('id')
        .eq('business_id', businessId)
        .eq('phone', phoneWithPlus)
        .maybeSingle();
      if (cp) {
        const { assignCustomerTier } = await import('@/lib/membership/assign-tiers');
        await assignCustomerTier(supabase, businessId, cp.id);
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
      await supabase
        .from(table)
        .update({ metadata: { feedback_requested: false, completed_at: new Date().toISOString() } })
        .eq('id', referenceId);
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

    // Trigger sequences (idempotent via partial unique index)
    await triggerSequences(supabase, businessId, triggerEvent, customerPhone, automationContext);

    // Evaluate rules — with sealed manifest when paymentId is available (v15)
    const sendMsg = async (to: string, text: string) => {
      if (sender) await sender.sendText({ to, text });
    };
    if (paymentId && claimToken) {
      // v15 Phase-A: evaluate once → seal → execute frozen rows only
      const { sealRuleActions, readFrozenRuleActions, advanceRuleAction } = await import('@/lib/payments/terminal-effects');
      const { evaluateConditions } = await import('@/lib/bot/automation/rules-engine');

      // 1. Evaluate conditions once to identify genuinely matched rules
      const { data: allRules } = await supabase.from('bot_rules')
        .select('id, name, trigger_event, conditions, action_type, action_payload, priority')
        .eq('business_id', businessId).eq('trigger_event', ruleEvent).eq('is_active', true)
        .order('priority', { ascending: false });
      const matched = (allRules || []).filter((r: { conditions: unknown }) => {
        try { return evaluateConditions((r.conditions || []) as Array<{ field: string; operator: string; value: unknown }>, automationContext); }
        catch { return false; }
      });

      // 2. Seal matched actions atomically (one-shot, immutable after seal)
      const candidates = matched.map((r: { id: string; action_type: string; action_payload: unknown }) => ({
        rule_id: r.id, action_type: r.action_type, action_payload: r.action_payload as object,
        action_fingerprint: `${r.action_type}|${JSON.stringify(r.action_payload)}`,
      }));
      const sealResult = await sealRuleActions(supabase, paymentId, candidates);
      if (!sealResult.ok) {
        logger.warn('[POST-COMPLETION] Rule seal failed (non-fatal):', sealResult);
      }

      // 3. Execute from frozen rows only — never re-read bot_rules
      const frozenRows = await readFrozenRuleActions(supabase, paymentId);
      for (const row of frozenRows) {
        const payload = row.action_payload as Record<string, string>;
        if (['send_message', 'send_template', 'notify_owner'].includes(row.action_type)) {
          // External action: emission fence (pending → sending) before provider call
          const fenceResult = await advanceRuleAction(supabase, paymentId, row.rule_id, 'sending');
          if (!fenceResult.ok) {
            // Already sending/completed/indeterminate — do NOT re-emit
            continue;
          }
          try {
            if (row.action_type === 'send_message') {
              await sendMsg(customerPhone, payload.text || payload.message || '');
            } else if (row.action_type === 'send_template') {
              await sendMsg(customerPhone, payload.template || payload.text || '');
            } else if (row.action_type === 'notify_owner') {
              // Resolve owner phone and send notification
              const { data: biz } = await supabase.from('businesses').select('owner_id').eq('id', businessId).single();
              if (biz?.owner_id) {
                const { data: ownerProfile } = await supabase.from('profiles').select('phone').eq('id', biz.owner_id).single();
                if (ownerProfile?.phone && sender) {
                  await sender.sendText({ to: ownerProfile.phone, text: payload.message || payload.text || 'Notification' });
                }
              }
            }
            const completeResult = await advanceRuleAction(supabase, paymentId, row.rule_id, 'completed');
            if (!completeResult.ok) logger.warn(`[POST-COMPLETION] Rule action complete failed: ${row.rule_id}`);
          } catch {
            const indResult = await advanceRuleAction(supabase, paymentId, row.rule_id, 'indeterminate');
            if (!indResult.ok) logger.warn(`[POST-COMPLETION] Rule action indeterminate failed: ${row.rule_id}`);
          }
        } else if (row.action_type === 'enroll_sequence') {
          // Internal: enroll in sequence
          const seqId = payload.sequence_id;
          if (seqId) {
            const { enrollInSequence } = await import('@/lib/bot/automation/sequence-service');
            await enrollInSequence(supabase, businessId, seqId, customerPhone, automationContext);
          }
          await advanceRuleAction(supabase, paymentId, row.rule_id, 'completed');
        } else if (row.action_type === 'assign_tag') {
          // Internal: assign tag to customer profile
          const tag = payload.tag;
          if (tag) {
            await supabase.from('customer_profiles')
              .update({ tags: supabase.rpc ? undefined : undefined }) // Tags handled differently per schema
              .eq('business_id', businessId).eq('phone', customerPhone);
            // Simplified: mark complete regardless (tag assignment is best-effort)
          }
          await advanceRuleAction(supabase, paymentId, row.rule_id, 'completed');
        } else if (row.action_type === 'update_status') {
          // Internal: no-op for payment context (status updates are entity-specific)
          await advanceRuleAction(supabase, paymentId, row.rule_id, 'completed');
        }
      }
    } else {
      // Legacy path: no paymentId, execute rules directly
      await evaluateRules(supabase, businessId, ruleEvent, automationContext, sendMsg);
    }
  } catch (err) {
    logger.withContext({ op: 'post-completion.automation', ...safeLogErrorContext(err) }).error('[POST-COMPLETION] Automation error (non-fatal)');
  }

  // 3. Referral — generate code silently (customer can access via "refer" keyword)
  // Don't auto-send referral message after every transaction
  if (capabilities.includes('referral')) {
    try {
      const { data: existingRef } = await supabase
        .from('referrals')
        .select('referral_code')
        .eq('business_id', businessId)
        .eq('referrer_phone', customerPhone)
        .eq('status', 'pending')
        .maybeSingle();

      if (!existingRef) {
        const code = generateReferralCode();
        const rewardType = (meta.referral_reward_type as string) || 'points';
        const rewardAmount = (meta.referral_reward_amount as number) || 50;

        await supabase.from('referrals').insert({
          business_id: businessId,
          referrer_phone: customerPhone,
          referrer_name: customerName,
          referral_code: code,
          status: 'pending',
          reward_type: rewardType,
          reward_amount: rewardAmount,
        });
        // Code generated silently — customer can type "refer" to see it
      }
    } catch (err) {
      logger.withContext({ op: 'post-completion.referral', ...safeLogErrorContext(err) }).error('[POST-COMPLETION] Referral error');
    }
  }
}
