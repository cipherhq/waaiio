import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { logger } from '@/lib/logger';
import { getEnabledCapabilities } from '@/lib/capabilities/service';
import type { CapabilityId } from '@/lib/capabilities/types';
import { generateReceiptPdf } from '@/lib/pdf/receipt-generator';
import { getCurrencySymbol, PRICING_TIERS, type CountryCode, type SubscriptionTier } from '@/lib/constants';
import { triggerSequences } from '@/lib/bot/automation/sequence-service';
import { evaluateRules } from '@/lib/bot/automation/rules-engine';

interface PostCompletionParams {
  supabase: SupabaseClient;
  businessId: string;
  customerPhone: string;
  customerName: string | null;
  serviceType?: string;
  referenceId?: string;
  sender?: MessageSender;
  /** Amount paid (in smallest currency unit) for auto-receipt */
  amountPaid?: number;
  /** Service/product name for receipt */
  serviceName?: string;
  /** Reference code (e.g. BW-1234) for receipt */
  referenceCode?: string;
  /** If true, skip loyalty points (e.g. giving/donation transactions) */
  skipLoyalty?: boolean;
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
  const { supabase, businessId, customerPhone, customerName, serviceType, referenceId, sender, amountPaid, serviceName, referenceCode, skipLoyalty, translate } = params;
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
  } catch {
    return;
  }

  const phone = customerPhone.startsWith('+') ? customerPhone.slice(1) : customerPhone;
  const phoneWithPlus = customerPhone.startsWith('+') ? customerPhone : `+${customerPhone}`;
  const bizName = biz?.name ?? 'Business';
  const meta = (biz?.metadata ?? {}) as Record<string, unknown>;

  // Auto-create customer profile if not exists (so Customers tab has data immediately)
  try {
    const { data: existing } = await supabase
      .from('customer_profiles')
      .select('id')
      .eq('business_id', businessId)
      .eq('phone', phoneWithPlus)
      .maybeSingle();

    if (existing) {
      // Update existing — increment counters
      const { error: rpcErr } = await supabase.rpc('increment_customer_visit', {
        p_business_id: businessId,
        p_phone: phoneWithPlus,
        p_amount: amountPaid || 0,
      });
      if (rpcErr) {
        // Fallback if RPC doesn't exist — just update last_seen
        await supabase.from('customer_profiles')
          .update({ last_seen_at: new Date().toISOString(), name: customerName || undefined })
          .eq('id', existing.id);
      }
    } else {
      // Create new
      await supabase.from('customer_profiles').insert({
        business_id: businessId,
        phone: phoneWithPlus,
        name: customerName || null,
        total_bookings: 1,
        total_visits: 1,
        total_spent: amountPaid || 0,
        last_seen_at: new Date().toISOString(),
        first_seen_at: new Date().toISOString(),
      });
    }
  } catch {
    // Non-critical — don't block the flow
  }

  // 0. Auto-receipt — send payment confirmation with receipt details
  if (amountPaid && amountPaid > 0) {
    try {
      const cc = (biz?.country_code || 'NG') as CountryCode;
      const currencySymbol = getCurrencySymbol(cc);
      const isWhitelabel = PRICING_TIERS[(biz?.subscription_tier || 'free') as SubscriptionTier]?.whitelabel === true;
      const formattedAmount = `${currencySymbol}${amountPaid.toLocaleString()}`;
      const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
      const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

      const receiptLines = [
        `✅ *Payment Receipt*`,
        ``,
        `🏢 *${bizName}*`,
        serviceName ? `📎 ${serviceName}` : null,
        referenceCode ? `🔑 Ref: ${referenceCode}` : null,
        `💰 Amount: *${formattedAmount}*`,
        `📅 ${date} at ${time}`,
        ``,
        `Thank you for your payment, ${customerName || 'there'}! 🙏`,
      ].filter(Boolean).join('\n');

      if (sender) await sender.sendText({ to: phone, text: await t(receiptLines) });

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
        console.error('[POST-COMPLETION] PDF receipt error (non-fatal):', pdfErr);
      }
    } catch (err) {
      console.error('[POST-COMPLETION] Auto-receipt error:', err);
    }
  }

  // 1. Loyalty — award points (skip for giving/donation, and require explicit opt-in)
  const loyaltyEnabled = meta.loyalty_earning_enabled === true;
  if (capabilities.includes('loyalty') && loyaltyEnabled && !skipLoyalty) {
    try {
      const pointsMode = (meta.loyalty_points_mode as string) || 'per_visit';
      const pointsPerVisit = (meta.loyalty_points_per_visit as number) || 10;
      const pointsPerCurrency = (meta.loyalty_points_per_currency as number) || 0; // e.g. 1 point per 100 spent

      // Calculate points: flat per-visit OR amount-based
      let earnedPoints = pointsPerVisit;
      let reason: string = 'visit';
      if (pointsMode === 'per_amount' && pointsPerCurrency > 0 && amountPaid && amountPaid > 0) {
        earnedPoints = Math.floor(amountPaid / pointsPerCurrency);
        reason = 'purchase';
        if (earnedPoints < 1) earnedPoints = 1; // minimum 1 point
      }

      // Upsert loyalty_points
      const { data: existing } = await supabase
        .from('loyalty_points')
        .select('id, points_balance, total_earned, visit_count')
        .eq('business_id', businessId)
        .eq('customer_phone', customerPhone)
        .maybeSingle();

      if (existing) {
        await supabase
          .from('loyalty_points')
          .update({
            points_balance: existing.points_balance + earnedPoints,
            total_earned: existing.total_earned + earnedPoints,
            visit_count: existing.visit_count + 1,
            customer_name: customerName || undefined,
          })
          .eq('id', existing.id);
      } else {
        await supabase
          .from('loyalty_points')
          .insert({
            business_id: businessId,
            customer_phone: customerPhone,
            customer_name: customerName,
            points_balance: earnedPoints,
            total_earned: earnedPoints,
            visit_count: 1,
          });
      }

      // Insert transaction
      await supabase.from('loyalty_transactions').insert({
        business_id: businessId,
        customer_phone: customerPhone,
        points_change: earnedPoints,
        reason,
        reference_id: referenceId || null,
        reference_type: serviceType || null,
      });

      const newBalance = (existing?.points_balance || 0) + earnedPoints;
      const rewardThreshold = (meta.loyalty_reward_threshold as number) || 100;
      const rewardDesc = (meta.loyalty_reward_description as string) || 'a special reward';

      // Notify customer about earned points
      const pointsUntilReward = Math.max(0, rewardThreshold - newBalance);
      let loyaltyMsg = `+${earnedPoints} points earned at *${bizName}*! Your balance: *${newBalance}* points.`;
      if (pointsUntilReward === 0) {
        loyaltyMsg += `\n\nYou have enough points to redeem *${rewardDesc}*! Type *my points* to claim it.`;
      } else {
        loyaltyMsg += `\n\n${pointsUntilReward} more until ${rewardDesc}.`;
      }
      if (sender) t(loyaltyMsg).then(translated => sender.sendText({ to: customerPhone, text: translated })).catch(() => {});
    } catch (err) {
      logger.error('[POST-COMPLETION] Loyalty error:', err);
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
    } catch { /* non-critical */ }
  }

  // 2.5. Sequences & Rules — trigger automation after completion
  try {
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

    // Trigger sequences
    await triggerSequences(supabase, businessId, triggerEvent, customerPhone, automationContext);

    // Evaluate rules
    const sendMsg = async (to: string, text: string) => {
      if (sender) await sender.sendText({ to, text });
    };
    await evaluateRules(supabase, businessId, ruleEvent, automationContext, sendMsg);
  } catch (err) {
    console.error('[POST-COMPLETION] Automation error (non-fatal):', err);
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
      console.error('[POST-COMPLETION] Referral error:', err);
    }
  }
}
