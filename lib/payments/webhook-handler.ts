import type { SupabaseClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/nextjs';
import { getPlatformFees } from '@/lib/getPlatformFees';
import { getServerPostHog } from '@/lib/posthog/server';
import { createAlert } from '@/lib/alerts/create-alert';
import { formatCurrency, type CountryCode, type SubscriptionTier } from '@/lib/constants';
import { logger } from '@/lib/logger';

/**
 * Shared webhook processing logic for both platform and BYO payment webhooks.
 * Handles charge.success and charge.failed events for deposit bookings.
 */

export async function processPaystackChargeSuccess(
  data: Record<string, unknown>,
  reference: string,
  supabase: SupabaseClient,
): Promise<void> {
  const { data: existingPayment } = await supabase
    .from('payments')
    .select('id, status, amount, booking_id, invoice_id, campaign_id, gateway')
    .eq('gateway_reference', reference)
    .single();

  if (!existingPayment || existingPayment.status === 'success') return;

  const webhookAmountKobo = data.amount as number;
  const expectedKobo = existingPayment.amount * 100;

  if (webhookAmountKobo !== expectedKobo) {
    Sentry.captureMessage('Payment amount mismatch', { level: 'warning', extra: { reference, webhookAmountKobo, expectedKobo } });
    await supabase
      .from('payments')
      .update({ status: 'failed', gateway_status: 'amount_mismatch' })
      .eq('gateway_reference', reference);
    return;
  }

  const authorization = data.authorization as Record<string, unknown> | undefined;
  await supabase
    .from('payments')
    .update({
      status: 'success',
      gateway_status: 'success',
      payment_method: (data.channel as string) || 'card',
      card_last_four: (authorization?.last4 as string) || null,
      card_brand: (authorization?.brand as string) || null,
      paid_at: new Date().toISOString(),
    })
    .eq('gateway_reference', reference);

  // Save reusable payment method for future one-tap payments
  if (authorization?.reusable && authorization?.authorization_code) {
    const customer = data.customer as Record<string, string> | undefined;
    const metadata = data.metadata as Record<string, string> | undefined;
    const businessId = metadata?.business_id;
    const phone = customer?.phone;

    if (businessId && phone) {
      await supabase.from('saved_payment_methods').upsert({
        business_id: businessId,
        customer_phone: phone,
        gateway: 'paystack',
        authorization_code: authorization.authorization_code as string,
        customer_code: (customer?.customer_code as string) || null,
        card_last4: (authorization.last4 as string) || null,
        card_brand: (authorization.brand as string) || null,
        card_exp_month: authorization.exp_month ? Number(authorization.exp_month) : null,
        card_exp_year: authorization.exp_year ? Number(authorization.exp_year) : null,
        card_type: (authorization.card_type as string) || null,
        bank_name: (authorization.bank as string) || null,
        is_active: true,
        last_used_at: new Date().toISOString(),
      }, { onConflict: 'business_id,customer_phone,gateway' });
      // Non-blocking — ignore upsert errors
    }
  }

  // Track payment success
  const posthog = getServerPostHog();
  posthog?.capture({ distinctId: reference, event: 'payment_success', properties: { gateway: 'paystack', amount: existingPayment.amount } });

  // Run fraud detection (non-blocking)
  import('@/lib/fraud/detect').then(({ checkPaymentFraud }) => {
    const customer = data.customer as Record<string, string> | undefined;
    const ipAddress = data.ip_address as string | undefined;
    const metadata = data.metadata as Record<string, string> | undefined;
    checkPaymentFraud(supabase, {
      paymentId: existingPayment.id,
      businessId: metadata?.business_id || '',
      amount: existingPayment.amount,
      currency: (data.currency as string) || 'NGN',
      customerPhone: customer?.phone || '',
      payerIp: ipAddress,
      payerCountry: (data.authorization as Record<string, string>)?.country_code,
    });
  }).catch(() => {});

  if (existingPayment.booking_id) {
    await supabase
      .from('bookings')
      .update({
        deposit_status: 'paid',
        status: 'confirmed',
        confirmed_at: new Date().toISOString(),
      })
      .eq('id', existingPayment.booking_id);

    // Record platform fee for confirmed payment
    await recordPlatformFeeForBooking(supabase, existingPayment.booking_id, existingPayment.amount);
  }

  if (existingPayment.invoice_id) {
    // Get current amount_paid for partial payment accumulation
    const { data: invoice } = await supabase
      .from('invoices')
      .select('amount_paid, total_amount')
      .eq('id', existingPayment.invoice_id)
      .single();

    const newAmountPaid = (Number(invoice?.amount_paid) || 0) + existingPayment.amount;
    const totalAmount = Number(invoice?.total_amount) || 0;
    const isFullyPaid = newAmountPaid >= totalAmount;

    await supabase
      .from('invoices')
      .update({
        status: isFullyPaid ? 'paid' : 'sent', // Stay 'sent' if partial
        amount_paid: newAmountPaid,
        paid_at: isFullyPaid ? new Date().toISOString() : null,
      })
      .eq('id', existingPayment.invoice_id);

    await recordPlatformFeeForInvoice(supabase, existingPayment.invoice_id, existingPayment.amount);
  }

  // Update campaign donation on successful payment
  if (existingPayment.campaign_id) {
    // Mark donation as success — match by payment_id (set at donation creation)
    // Falls back to campaign_id match for older donations created before this fix
    const { data: updated } = await supabase
      .from('campaign_donations')
      .update({ status: 'success' })
      .eq('payment_id', existingPayment.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();

    if (!updated) {
      // Fallback: match by campaign_id + pending status for donations without payment_id
      await supabase
        .from('campaign_donations')
        .update({ status: 'success', payment_id: existingPayment.id })
        .eq('campaign_id', existingPayment.campaign_id)
        .eq('status', 'pending')
        .is('payment_id', null);
    }

    // Increment campaign raised_amount and donor_count.
    // Note: this SELECT+UPDATE pattern has a potential race condition if two donations
    // succeed concurrently. A true atomic fix would require a DB-level RPC
    // (e.g. increment_campaign_stats). Acceptable for now as concurrent donations
    // to the same campaign are rare and webhook retries re-use the same payment record.
    const { data: campaign } = await supabase
      .from('campaigns')
      .select('raised_amount, donor_count, business_id')
      .eq('id', existingPayment.campaign_id)
      .single();

    if (campaign) {
      await supabase
        .from('campaigns')
        .update({
          raised_amount: Number(campaign.raised_amount || 0) + existingPayment.amount,
          donor_count: (campaign.donor_count || 0) + 1,
        })
        .eq('id', existingPayment.campaign_id);

      // Record platform fee for campaign donation (non-blocking)
      if (campaign.business_id) {
        recordPlatformFeeForCampaign(supabase, existingPayment.campaign_id, campaign.business_id, existingPayment.amount).catch(() => {});
      }
    }
  }

  // ── Proactive confirmation: send WhatsApp message to customer after payment ──
  // This ensures customers get confirmation even if they never tap "I've Paid"
  sendPaymentConfirmation(supabase, existingPayment, reference).catch(err =>
    logger.error('[WEBHOOK] Proactive confirmation error:', err),
  );
}

/**
 * Send a WhatsApp confirmation to the customer after successful payment.
 * Runs as fire-and-forget from the webhook handler.
 */
async function sendPaymentConfirmation(
  supabase: SupabaseClient,
  payment: { id: string; booking_id: string | null; invoice_id: string | null; campaign_id: string | null; amount: number },
  reference: string,
): Promise<void> {
  // Find the customer's phone and business from the booking, order, or session
  let customerPhone: string | null = null;
  let businessId: string | null = null;
  let businessName = 'Business';
  let serviceName = 'Payment';
  let referenceCode = reference;
  let countryCode: CountryCode = 'NG';

  if (payment.booking_id) {
    const { data: booking } = await supabase
      .from('bookings')
      .select('guest_phone, reference_code, business_id, businesses(name, country_code), services(name)')
      .eq('id', payment.booking_id)
      .single();

    if (booking) {
      customerPhone = booking.guest_phone;
      businessId = booking.business_id;
      referenceCode = booking.reference_code || reference;
      const biz = booking.businesses as unknown as { name: string; country_code?: string } | null;
      const svc = booking.services as unknown as { name: string } | null;
      if (biz?.name) businessName = biz.name;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
      if (svc?.name) serviceName = svc.name;
    }
  }

  // Also check orders (ordering flow)
  if (!customerPhone) {
    const { data: order } = await supabase
      .from('orders')
      .select('delivery_phone, reference_code, business_id, businesses(name, country_code)')
      .eq('id', payment.booking_id || '')
      .maybeSingle();

    if (!order) {
      // Try matching by payment metadata
      const { data: paymentFull } = await supabase
        .from('payments')
        .select('user_id, metadata')
        .eq('id', payment.id)
        .single();

      if (paymentFull?.user_id) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('phone')
          .eq('id', paymentFull.user_id)
          .single();
        customerPhone = profile?.phone || null;
      }

      const meta = (paymentFull?.metadata || {}) as Record<string, unknown>;
      if (meta.order_id) {
        const { data: orderByMeta } = await supabase
          .from('orders')
          .select('delivery_phone, reference_code, business_id, businesses(name, country_code)')
          .eq('id', meta.order_id as string)
          .maybeSingle();
        if (orderByMeta) {
          customerPhone = orderByMeta.delivery_phone || customerPhone;
          businessId = orderByMeta.business_id;
          referenceCode = orderByMeta.reference_code || reference;
          const biz = orderByMeta.businesses as unknown as { name: string; country_code?: string } | null;
          if (biz?.name) businessName = biz.name;
          if (biz?.country_code) countryCode = biz.country_code as CountryCode;
          serviceName = 'Order';
        }
      }
    } else {
      customerPhone = order.delivery_phone;
      businessId = order.business_id;
      referenceCode = order.reference_code || reference;
      const biz = order.businesses as unknown as { name: string; country_code?: string } | null;
      if (biz?.name) businessName = biz.name;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
      serviceName = 'Order';
    }
  }

  if (!customerPhone || !businessId) {
    logger.warn('[WEBHOOK] Proactive confirmation skipped — no phone or business', { customerPhone: !!customerPhone, businessId: !!businessId, paymentId: payment.id });
    return;
  }

  logger.info(`[WEBHOOK] Sending proactive confirmation to ${customerPhone} for business ${businessId}`);

  // Build confirmation message
  const lines = [
    `✅ *Payment Confirmed!*`,
    '',
    `🏢 ${businessName}`,
    `📋 ${serviceName}`,
    `💰 Amount: ${formatCurrency(payment.amount, countryCode)}`,
    `🔑 Ref: *${referenceCode}*`,
    '',
    'Thank you for your payment!',
    '',
    'Type *receipt* to get your receipt',
    'Type *my bookings* to view your bookings',
  ];

  // Send via channel resolver
  try {
    const { ChannelResolver } = await import('@/lib/channels/channel-resolver');
    const resolver = new ChannelResolver(supabase);
    const resolved = await resolver.resolveByBusinessId(businessId);
    if (!resolved) return;

    const phone = customerPhone.startsWith('+') ? customerPhone.slice(1) : customerPhone;
    await resolved.sender.sendText({ to: phone, text: lines.join('\n') });

    // Run post-completion: loyalty, receipts, referral, owner notification
    try {
      const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
      const customerName = await getCustomerName(supabase, customerPhone);

      await handlePostCompletion({
        supabase,
        businessId,
        customerPhone: customerPhone,
        customerName,
        serviceType: payment.booking_id ? 'booking' : 'order',
        referenceId: payment.booking_id || undefined,
        sender: resolved.sender,
        amountPaid: payment.amount,
        serviceName,
        referenceCode,
      });
    } catch (pcErr) {
      logger.error('[WEBHOOK] Post-completion error:', pcErr);
    }

    // Notify business owner
    try {
      if (payment.booking_id) {
        const { notifyOwnerNewBooking } = await import('@/lib/bot/flows/shared/notify-owner');
        const { data: booking } = await supabase.from('bookings')
          .select('date, time, party_size, guest_name')
          .eq('id', payment.booking_id).single();

        if (booking) {
          await notifyOwnerNewBooking({
            supabase, sender: resolved.sender, businessId, businessName, countryCode,
            referenceCode, customerName: booking.guest_name || 'Customer',
            date: booking.date, time: booking.time,
            quantity: booking.party_size || 1, quantityLabel: 'guest(s)',
            amount: payment.amount,
          });
        }
      }
    } catch (notifyErr) {
      logger.error('[WEBHOOK] Owner notification error:', notifyErr);
    }

    // Deactivate the bot session waiting for "I've Paid"
    await supabase
      .from('bot_sessions')
      .update({ is_active: false })
      .eq('whatsapp_number', customerPhone)
      .eq('business_id', businessId)
      .eq('is_active', true);
  } catch (err) {
    logger.error('[WEBHOOK] Failed to send confirmation:', err);
  }
}

async function getCustomerName(supabase: SupabaseClient, phone: string): Promise<string | null> {
  const phoneP = phone.startsWith('+') ? phone : `+${phone}`;
  const phoneN = phone.startsWith('+') ? phone.slice(1) : phone;
  const { data } = await supabase
    .from('profiles')
    .select('first_name, last_name')
    .or(`phone.eq.${phoneP},phone.eq.${phoneN}`)
    .limit(1)
    .maybeSingle();
  if (data?.first_name) return `${data.first_name} ${data.last_name || ''}`.trim();
  return null;
}

export async function processPaystackChargeFailed(
  data: Record<string, unknown>,
  reference: string,
  supabase: SupabaseClient,
): Promise<void> {
  const { data: existingPayment } = await supabase
    .from('payments')
    .select('id, status, amount, business_id')
    .eq('gateway_reference', reference)
    .single();

  if (!existingPayment || existingPayment.status === 'success') return;

  await supabase
    .from('payments')
    .update({
      status: 'failed',
      gateway_status: (data.gateway_response as string) || 'failed',
    })
    .eq('gateway_reference', reference);

  // Track payment failure
  const posthog = getServerPostHog();
  posthog?.capture({ distinctId: reference, event: 'payment_failed', properties: { gateway: 'paystack', reason: (data.gateway_response as string) || 'unknown' } });

  // Create alert for business owner
  if (existingPayment.business_id) {
    const reason = (data.gateway_response as string) || 'Payment failed';
    await createAlert(supabase, {
      businessId: existingPayment.business_id,
      type: 'payment_failed',
      severity: 'warning',
      title: 'Payment Failed',
      message: `A payment of ${existingPayment.amount} failed: ${reason}`,
      metadata: { paymentId: existingPayment.id, amount: existingPayment.amount, gateway: 'paystack', reference, reason },
    });
  }
}

async function recordPlatformFeeForBooking(
  supabase: SupabaseClient,
  bookingId: string,
  paymentAmount: number,
): Promise<void> {
  const { data: booking } = await supabase
    .from('bookings')
    .select('business_id, total_amount')
    .eq('id', bookingId)
    .single();

  if (!booking?.business_id) return;

  const { data: business } = await supabase
    .from('businesses')
    .select('subscription_tier, trial_ends_at, payout_mode')
    .eq('id', booking.business_id)
    .single();

  if (!business) return;

  // Don't record fee for direct_split — gateway already collected it
  if (business.payout_mode === 'direct_split') return;

  const isInTrial = new Date(business.trial_ends_at) > new Date();
  const tier = (business.subscription_tier || 'free') as SubscriptionTier;
  const amount = booking.total_amount || paymentAmount;

  const { feePercentage, feeFlat, feeTotal } = await getPlatformFees(amount, tier, isInTrial);

  await supabase.from('platform_fees').insert({
    business_id: booking.business_id,
    booking_id: bookingId,
    transaction_amount: amount,
    fee_percentage: feePercentage,
    fee_flat: feeFlat,
    fee_total: feeTotal,
    tier,
  });
}

async function recordPlatformFeeForInvoice(
  supabase: SupabaseClient,
  invoiceId: string,
  paymentAmount: number,
): Promise<void> {
  const { data: invoice } = await supabase
    .from('invoices')
    .select('business_id, total_amount')
    .eq('id', invoiceId)
    .single();

  if (!invoice?.business_id) return;

  const { data: business } = await supabase
    .from('businesses')
    .select('subscription_tier, trial_ends_at, payout_mode')
    .eq('id', invoice.business_id)
    .single();

  if (!business) return;

  // Don't record fee for direct_split — gateway already collected it
  if (business.payout_mode === 'direct_split') return;

  const isInTrial = new Date(business.trial_ends_at) > new Date();
  const tier = (business.subscription_tier || 'free') as SubscriptionTier;
  const amount = invoice.total_amount || paymentAmount;

  const { feePercentage, feeFlat, feeTotal } = await getPlatformFees(amount, tier, isInTrial);

  await supabase.from('platform_fees').insert({
    business_id: invoice.business_id,
    invoice_id: invoiceId,
    transaction_amount: amount,
    fee_percentage: feePercentage,
    fee_flat: feeFlat,
    fee_total: feeTotal,
    tier,
  });
}

async function recordPlatformFeeForCampaign(
  supabase: SupabaseClient,
  campaignId: string,
  businessId: string,
  paymentAmount: number,
): Promise<void> {
  const { data: business } = await supabase
    .from('businesses')
    .select('subscription_tier, trial_ends_at, payout_mode')
    .eq('id', businessId)
    .single();

  if (!business) return;

  // Don't record fee for direct_split — gateway already collected it
  if (business.payout_mode === 'direct_split') return;

  const isInTrial = new Date(business.trial_ends_at) > new Date();
  const tier = (business.subscription_tier || 'free') as SubscriptionTier;

  const { feePercentage, feeFlat, feeTotal } = await getPlatformFees(paymentAmount, tier, isInTrial);

  await supabase.from('platform_fees').insert({
    business_id: businessId,
    campaign_id: campaignId,
    transaction_amount: paymentAmount,
    fee_percentage: feePercentage,
    fee_flat: feeFlat,
    fee_total: feeTotal,
    tier,
  });
}
