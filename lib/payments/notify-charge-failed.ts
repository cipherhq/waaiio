import type { SupabaseClient } from '@supabase/supabase-js';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { sendOrEmail, findCustomerEmail } from '@/lib/channels/send-or-email';
import { logger } from '@/lib/logger';

interface NotifyChargeFailedOpts {
  subscriptionId: string;
  businessId: string;
  customerPhone: string;
  amount: number;
  currency: string;
  serviceId?: string | null;
  gateway: string;
}

/**
 * Notify a customer via WhatsApp (with email/SMS fallback) when their recurring
 * charge fails. Includes dedup to prevent multiple notifications on the same day.
 */
export async function notifyCustomerChargeFailed(
  supabase: SupabaseClient,
  opts: NotifyChargeFailedOpts,
): Promise<void> {
  const { subscriptionId, businessId, customerPhone, amount, currency, serviceId, gateway } = opts;

  // Dedup: check if we already sent a failure notification today for this subscription
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { data: existingNotification } = await supabase
    .from('subscription_charges')
    .select('id')
    .eq('subscription_id', subscriptionId)
    .eq('status', 'failed')
    .gte('created_at', todayStart.toISOString())
    .limit(2);

  // If there are already 2+ failed charge records today, we already notified on the first one
  if (existingNotification && existingNotification.length > 1) {
    logger.info(`[NOTIFY_CHARGE_FAILED] Skipping duplicate notification for subscription ${subscriptionId} (already notified today)`);
    return;
  }

  // Look up business name
  const { data: business } = await supabase
    .from('businesses')
    .select('name')
    .eq('id', businessId)
    .single();

  const businessName = business?.name || 'the business';

  // Look up service name if available
  let serviceName = 'your subscription';
  if (serviceId) {
    const { data: service } = await supabase
      .from('services')
      .select('name')
      .eq('id', serviceId)
      .single();
    if (service?.name) {
      serviceName = service.name;
    }
  }

  // Format amount
  const formattedAmount = `${currency} ${amount.toLocaleString()}`;

  // Resolve WhatsApp channel for this business
  const resolver = new ChannelResolver(supabase);
  const resolved = await resolver.resolveByBusinessId(businessId);

  if (!resolved) {
    logger.warn(`[NOTIFY_CHARGE_FAILED] No WhatsApp channel found for business ${businessId}`);
    return;
  }

  const phone = customerPhone.startsWith('+') ? customerPhone.slice(1) : customerPhone;

  const messageText =
    `Your recurring payment of ${formattedAmount} for ${serviceName} at *${businessName}* was not successful. ` +
    `Please update your payment method or contact the business.\n\n` +
    `Type *subscriptions* to manage your active subscriptions.`;

  // Find customer email for fallback
  const customerEmail = await findCustomerEmail(supabase, phone, businessId);

  await sendOrEmail({
    supabase,
    sender: resolved.sender,
    to: phone,
    text: messageText,
    email: customerEmail
      ? {
          address: customerEmail,
          subject: `Payment failed for ${serviceName} at ${businessName}`,
          html: `<p>Hi,</p><p>Your recurring payment of <strong>${formattedAmount}</strong> for <strong>${serviceName}</strong> at <strong>${businessName}</strong> was not successful.</p><p>Please update your payment method or contact the business to avoid service interruption.</p><p>— Waaiio</p>`,
        }
      : null,
    businessName,
    smsFallback: true,
  });

  logger.info(`[NOTIFY_CHARGE_FAILED] Sent failure notification to ${phone} for subscription ${subscriptionId} (${gateway})`);
}
