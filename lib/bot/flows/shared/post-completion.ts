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
  const bizName = biz?.name ?? 'Business';
  const meta = (biz?.metadata ?? {}) as Record<string, unknown>;

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

      // Loyalty points updated silently — don't spam customer after payment
      // Customer can check their points anytime by typing "my points"
    } catch (err) {
      console.error('[POST-COMPLETION] Loyalty error:', err);
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
      await sender.sendText({ to, text });
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
