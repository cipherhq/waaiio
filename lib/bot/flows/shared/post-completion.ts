import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
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
  sender: MessageSender;
  /** Amount paid (in smallest currency unit) for auto-receipt */
  amountPaid?: number;
  /** Service/product name for receipt */
  serviceName?: string;
  /** Reference code (e.g. BW-1234) for receipt */
  referenceCode?: string;
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
  const { supabase, businessId, customerPhone, customerName, serviceType, referenceId, sender, amountPaid, serviceName, referenceCode } = params;

  let capabilities: CapabilityId[];
  try {
    capabilities = await getEnabledCapabilities(supabase, businessId);
  } catch {
    return;
  }

  const phone = customerPhone.startsWith('+') ? customerPhone.slice(1) : customerPhone;

  // 0. Auto-receipt — send payment confirmation with receipt details
  if (amountPaid && amountPaid > 0) {
    try {
      const { data: biz } = await supabase
        .from('businesses')
        .select('name, country_code, subscription_tier')
        .eq('id', businessId)
        .single();

      const cc = (biz?.country_code || 'NG') as CountryCode;
      const currencySymbol = getCurrencySymbol(cc);
      const bizName = biz?.name || 'Business';
      const isWhitelabel = PRICING_TIERS[(biz?.subscription_tier || 'free') as SubscriptionTier]?.whitelabel === true;
      const formattedAmount = `${currencySymbol}${amountPaid.toLocaleString()}`;
      const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
      const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

      const receiptLines = [
        `\u2705 *Payment Receipt*`,
        ``,
        `\ud83c\udfe2 *${bizName}*`,
        serviceName ? `\ud83d\udcce ${serviceName}` : null,
        referenceCode ? `\ud83d\udd11 Ref: ${referenceCode}` : null,
        `\ud83d\udcb0 Amount: *${formattedAmount}*`,
        `\ud83d\udcc5 ${date} at ${time}`,
        ``,
        `Thank you for your payment, ${customerName || 'there'}! \ud83d\ude4f`,
      ].filter(Boolean).join('\n');

      await sender.sendText({ to: phone, text: receiptLines });

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

        if (signedUrlData?.signedUrl) {
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

  // 1. Loyalty — award points
  if (capabilities.includes('loyalty')) {
    try {
      // Get loyalty config from business metadata
      const { data: biz } = await supabase
        .from('businesses')
        .select('metadata, name')
        .eq('id', businessId)
        .single();

      const meta = (biz?.metadata || {}) as Record<string, unknown>;
      const pointsPerVisit = (meta.loyalty_points_per_visit as number) || 10;

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
            points_balance: existing.points_balance + pointsPerVisit,
            total_earned: existing.total_earned + pointsPerVisit,
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
            points_balance: pointsPerVisit,
            total_earned: pointsPerVisit,
            visit_count: 1,
          });
      }

      // Insert transaction
      await supabase.from('loyalty_transactions').insert({
        business_id: businessId,
        customer_phone: customerPhone,
        points_change: pointsPerVisit,
        reason: 'visit',
        reference_id: referenceId || null,
        reference_type: serviceType || null,
      });

      const newBalance = (existing?.points_balance || 0) + pointsPerVisit;
      const rewardThreshold = (meta.loyalty_reward_threshold as number) || 100;
      const rewardDesc = (meta.loyalty_reward_description as string) || 'a special reward';

      let pointsMsg = `You earned *${pointsPerVisit} loyalty points*! Your balance: *${newBalance} points*.`;
      if (newBalance >= rewardThreshold) {
        pointsMsg += `\n\nYou've reached *${rewardThreshold} points* — you qualify for ${rewardDesc}! Ask staff to redeem.`;
      }

      await sender.sendText({ to: phone, text: pointsMsg });
    } catch (err) {
      console.error('[POST-COMPLETION] Loyalty error:', err);
    }
  }

  // 2. Feedback — start feedback session
  if (capabilities.includes('feedback')) {
    try {
      // Create a new bot session at feedback_rating step
      await supabase.from('bot_sessions').insert({
        whatsapp_number: customerPhone,
        business_id: businessId,
        current_step: 'feedback_rating',
        session_data: {
          active_capability: 'feedback',
          business_id: businessId,
          customer_name: customerName,
          service_type: serviceType || null,
          reference_id: referenceId || null,
        },
        is_active: true,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });

      // Send the rating prompt
      const { data: bizData } = await supabase
        .from('businesses')
        .select('name')
        .eq('id', businessId)
        .single();

      const bizName = bizData?.name || 'us';
      await sender.sendButtons({
        to: phone,
        body: `How was your experience at ${bizName}? Rate us:`,
        buttons: [
          { id: 'rate_5', title: '5 - Excellent' },
          { id: 'rate_4', title: '4 - Good' },
          { id: 'rate_3', title: '3 - Average' },
        ],
      });
    } catch (err) {
      console.error('[POST-COMPLETION] Feedback error:', err);
    }
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

    // Load business name for rule messages
    const { data: bizInfo } = await supabase
      .from('businesses')
      .select('name')
      .eq('id', businessId)
      .single();
    if (bizInfo) automationContext.business_name = bizInfo.name;

    // Trigger sequences
    await triggerSequences(supabase, businessId, triggerEvent, customerPhone, automationContext);

    // Evaluate rules
    const sendMsg = async (to: string, text: string) => {
      await sender.sendText({ to, text });
    };
    await evaluateRules(supabase, businessId, ruleEvent, automationContext, sendMsg);
  } catch (err) {
    console.error('[POST-COMPLETION] Automation error (non-fatal):', err);
  }

  // 3. Referral — generate code and send share link
  if (capabilities.includes('referral')) {
    try {
      // Check if customer already has a referral code for this business
      const { data: existingRef } = await supabase
        .from('referrals')
        .select('referral_code')
        .eq('business_id', businessId)
        .eq('referrer_phone', customerPhone)
        .eq('status', 'pending')
        .maybeSingle();

      if (!existingRef) {
        const code = generateReferralCode();

        const { data: biz } = await supabase
          .from('businesses')
          .select('name, metadata')
          .eq('id', businessId)
          .single();

        const meta = (biz?.metadata || {}) as Record<string, unknown>;
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

        const bizName = biz?.name || 'us';
        await sender.sendText({
          to: phone,
          text: `Share ${bizName} with friends! Your referral code: *${code}*\n\nWhen a friend uses your code, you both earn rewards.`,
        });
      }
    } catch (err) {
      console.error('[POST-COMPLETION] Referral error:', err);
    }
  }
}
