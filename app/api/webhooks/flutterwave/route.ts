import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'crypto';
import * as Sentry from '@sentry/nextjs';
import { createServiceClient } from '@/lib/supabase/service';
import { getPlatformFees } from '@/lib/getPlatformFees';
import { logger } from '@/lib/logger';
import { createAlert } from '@/lib/alerts/create-alert';
import { formatCurrency, type CountryCode, type SubscriptionTier } from '@/lib/constants';
export const maxDuration = 60;

const FLUTTERWAVE_SECRET_HASH = process.env.FLUTTERWAVE_WEBHOOK_HASH || '';

export async function POST(request: NextRequest) {
  try {
    // Validate webhook signature (timing-safe)
    const verifHash = request.headers.get('verif-hash') || '';
    if (!FLUTTERWAVE_SECRET_HASH) {
      logger.error('[FLUTTERWAVE] FLUTTERWAVE_WEBHOOK_HASH not configured — rejecting request');
      return NextResponse.json({ message: 'Webhook not configured' }, { status: 500 });
    }
    try {
      if (!verifHash || !timingSafeEqual(Buffer.from(verifHash), Buffer.from(FLUTTERWAVE_SECRET_HASH))) {
        return NextResponse.json({ message: 'Invalid hash' }, { status: 401 });
      }
    } catch {
      return NextResponse.json({ message: 'Invalid hash' }, { status: 401 });
    }

    const body = await request.json();
    const event = body.event;
    const data = body.data;

    if (event !== 'charge.completed' || !data) {
      return NextResponse.json({ message: 'Ignored' }, { status: 200 });
    }

    if (data.status !== 'successful') {
      // Alert on non-successful Flutterwave charges
      const txRef = data.tx_ref as string;
      if (txRef) {
        const flwSupabase = createServiceClient();
        const { data: failedPayment } = await flwSupabase
          .from('payments')
          .select('id, amount, business_id')
          .eq('gateway_reference', txRef)
          .maybeSingle();

        if (failedPayment?.business_id) {
          await createAlert(flwSupabase, {
            businessId: failedPayment.business_id,
            type: 'payment_failed',
            severity: 'warning',
            title: 'Payment Failed',
            message: `A Flutterwave payment of ${failedPayment.amount} was not successful (status: ${data.status}).`,
            metadata: { paymentId: failedPayment.id, amount: failedPayment.amount, gateway: 'flutterwave', status: data.status },
          });
        }
      }
      return NextResponse.json({ message: 'Payment not successful' }, { status: 200 });
    }

    const txRef = data.tx_ref as string;
    if (!txRef) {
      return NextResponse.json({ message: 'Missing tx_ref' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Find the payment record
    const { data: payment } = await supabase
      .from('payments')
      .select('id, booking_id, amount')
      .eq('gateway_reference', txRef)
      .single();

    if (!payment) {
      return NextResponse.json({ message: 'Payment not found' }, { status: 404 });
    }

    // Verify amount matches
    const webhookAmount = data.amount as number;
    if (webhookAmount !== payment.amount) {
      return NextResponse.json({ message: 'Amount mismatch' }, { status: 400 });
    }

    // Update payment status
    await supabase
      .from('payments')
      .update({
        status: 'success',
        gateway_status: 'successful',
        payment_method: (data.payment_type as string) || 'card',
        card_last_four: data.card?.last_4digits || null,
        card_brand: data.card?.type || null,
        paid_at: new Date().toISOString(),
      })
      .eq('id', payment.id);

    // Confirm booking if applicable
    if (payment.booking_id) {
      await supabase
        .from('bookings')
        .update({
          deposit_status: 'paid',
          status: 'confirmed',
          confirmed_at: new Date().toISOString(),
        })
        .eq('id', payment.booking_id);

      // Record platform fee
      const { data: booking } = await supabase
        .from('bookings')
        .select('business_id, total_amount')
        .eq('id', payment.booking_id)
        .single();

      if (booking?.business_id) {
        const { data: business } = await supabase
          .from('businesses')
          .select('subscription_tier, trial_ends_at, payout_mode')
          .eq('id', booking.business_id)
          .single();

        if (business && business.payout_mode !== 'direct_split') {
          const isInTrial = new Date(business.trial_ends_at) > new Date();
          const tier = (business.subscription_tier || 'free') as SubscriptionTier;
          const amount = booking.total_amount || payment.amount;

          const { feePercentage, feeFlat, feeTotal } = await getPlatformFees(amount, tier, isInTrial);

          await supabase.from('platform_fees').insert({
            business_id: booking.business_id,
            booking_id: payment.booking_id,
            transaction_amount: amount,
            fee_percentage: feePercentage,
            fee_flat: feeFlat,
            fee_total: feeTotal,
            tier,
          });
        }
      }
    }

    // Handle invoice payments
    const { data: fullPayment } = await supabase
      .from('payments')
      .select('invoice_id, campaign_id')
      .eq('id', payment.id)
      .single();

    if (fullPayment?.invoice_id) {
      const { data: invoice } = await supabase
        .from('invoices')
        .select('business_id, total_amount, amount_paid')
        .eq('id', fullPayment.invoice_id)
        .single();

      const newAmountPaid = (Number(invoice?.amount_paid) || 0) + payment.amount;
      const totalAmount = Number(invoice?.total_amount) || 0;
      const isFullyPaid = newAmountPaid >= totalAmount;

      await supabase
        .from('invoices')
        .update({
          status: isFullyPaid ? 'paid' : 'sent',
          amount_paid: newAmountPaid,
          paid_at: isFullyPaid ? new Date().toISOString() : null,
        })
        .eq('id', fullPayment.invoice_id);
    }

    // Update campaign donation
    if (fullPayment?.campaign_id) {
      const { data: updated } = await supabase
        .from('campaign_donations')
        .update({ status: 'success' })
        .eq('payment_id', payment.id)
        .eq('status', 'pending')
        .select('id')
        .maybeSingle();

      if (!updated) {
        await supabase
          .from('campaign_donations')
          .update({ status: 'success', payment_id: payment.id })
          .eq('campaign_id', fullPayment.campaign_id)
          .eq('status', 'pending')
          .is('payment_id', null);
      }

      const { data: campaign } = await supabase
        .from('campaigns')
        .select('raised_amount, donor_count, business_id')
        .eq('id', fullPayment.campaign_id)
        .single();

      if (campaign) {
        await supabase
          .from('campaigns')
          .update({
            raised_amount: Number(campaign.raised_amount || 0) + payment.amount,
            donor_count: (campaign.donor_count || 0) + 1,
          })
          .eq('id', fullPayment.campaign_id);
      }
    }

    // ── Proactive confirmation: send WhatsApp message + post-completion ──
    sendFlutterwavePaymentConfirmation(supabase, {
      ...payment,
      invoice_id: fullPayment?.invoice_id || null,
      campaign_id: fullPayment?.campaign_id || null,
    }).catch(err =>
      logger.error('[FLUTTERWAVE WEBHOOK] Proactive confirmation error:', err),
    );

    return NextResponse.json({ message: 'OK' }, { status: 200 });
  } catch (error) {
    logger.error('Flutterwave webhook error:', (error as Error).message);
    Sentry.captureException(error);
    return NextResponse.json({ message: 'Internal error' }, { status: 500 });
  }
}

/**
 * Send proactive WhatsApp confirmation after Flutterwave payment success.
 */
async function sendFlutterwavePaymentConfirmation(
  supabase: ReturnType<typeof createServiceClient>,
  payment: { id: string; booking_id: string | null; invoice_id: string | null; campaign_id: string | null; amount: number },
): Promise<void> {
  let customerPhone: string | null = null;
  let businessId: string | null = null;
  let businessName = 'Business';
  let serviceName = 'Payment';
  let referenceCode = '';
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
      referenceCode = booking.reference_code || '';
      const biz = booking.businesses as unknown as { name: string; country_code?: string } | null;
      const svc = booking.services as unknown as { name: string } | null;
      if (biz?.name) businessName = biz.name;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
      if (svc?.name) serviceName = svc.name;
    }
  }

  if (!customerPhone && payment.invoice_id) {
    const { data: invoice } = await supabase
      .from('invoices')
      .select('customer_phone, reference_code, business_id, businesses:business_id(name, country_code)')
      .eq('id', payment.invoice_id)
      .single();

    if (invoice) {
      customerPhone = invoice.customer_phone;
      businessId = invoice.business_id;
      referenceCode = invoice.reference_code || '';
      const biz = invoice.businesses as unknown as { name: string; country_code?: string } | null;
      if (biz?.name) businessName = biz.name;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
      serviceName = 'Invoice';
    }
  }

  // Fallback: check orders via payment metadata
  if (!customerPhone) {
    const { data: paymentFull } = await supabase
      .from('payments')
      .select('user_id, metadata')
      .eq('id', payment.id)
      .single();

    const meta = (paymentFull?.metadata || {}) as Record<string, unknown>;
    if (meta.order_id) {
      const { data: order } = await supabase
        .from('orders')
        .select('delivery_phone, reference_code, business_id, businesses(name, country_code)')
        .eq('id', meta.order_id as string)
        .maybeSingle();
      if (order) {
        customerPhone = order.delivery_phone;
        businessId = order.business_id;
        referenceCode = order.reference_code || '';
        const biz = order.businesses as unknown as { name: string; country_code?: string } | null;
        if (biz?.name) businessName = biz.name;
        if (biz?.country_code) countryCode = biz.country_code as CountryCode;
        serviceName = 'Order';
      }
    }

    if (!customerPhone && paymentFull?.user_id) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('phone')
        .eq('id', paymentFull.user_id)
        .single();
      customerPhone = profile?.phone || null;
    }
  }

  if (!customerPhone || !businessId) {
    logger.warn('[FLUTTERWAVE WEBHOOK] Proactive confirmation skipped — no phone or business');
    return;
  }

  logger.info(`[FLUTTERWAVE WEBHOOK] Sending proactive confirmation to ${customerPhone} for ${businessName}`);

  const lines = [
    `✅ *Payment Confirmed!*`,
    '',
    `🏢 ${businessName}`,
    `📋 ${serviceName}`,
    `💰 Amount: ${formatCurrency(payment.amount, countryCode)}`,
    referenceCode ? `🔑 Ref: *${referenceCode}*` : '',
    '',
    'Thank you for your payment!',
    '',
    'Type *receipt* to get your receipt',
    'Type *my bookings* to view your bookings',
  ].filter(Boolean);

  try {
    const { ChannelResolver } = await import('@/lib/channels/channel-resolver');
    const resolver = new ChannelResolver(supabase);

    let resolved = null;
    const { data: activeSession } = await supabase
      .from('bot_sessions').select('session_data')
      .eq('whatsapp_number', customerPhone).eq('business_id', businessId).eq('is_active', true).maybeSingle();
    const inboundChId = (activeSession?.session_data as Record<string, unknown>)?._inbound_channel_id as string | undefined;
    if (inboundChId) resolved = await resolver.resolveByChannelId(inboundChId);
    if (!resolved) resolved = await resolver.resolveByBusinessId(businessId);
    if (!resolved) return;

    const phone = customerPhone.startsWith('+') ? customerPhone.slice(1) : customerPhone;
    await resolved.sender.sendText({ to: phone, text: lines.join('\n') });

    // Run post-completion (loyalty, feedback, referral)
    try {
      const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
      const customerName = await getCustomerName(supabase, customerPhone);
      await handlePostCompletion({
        supabase, businessId, customerPhone, customerName,
        serviceType: payment.booking_id ? 'booking' : 'order',
        referenceId: payment.booking_id || undefined,
        sender: resolved.sender,
        amountPaid: payment.amount,
        serviceName, referenceCode,
      });
    } catch (pcErr) {
      logger.error('[FLUTTERWAVE WEBHOOK] Post-completion error:', pcErr);
    }

    // Reset session to capability selection so user stays with this business
    await supabase
      .from('bot_sessions')
      .update({ current_step: 'select_capability', session_data: {}, is_active: true })
      .eq('whatsapp_number', customerPhone)
      .eq('business_id', businessId);
  } catch (err) {
    logger.error('[FLUTTERWAVE WEBHOOK] Send confirmation error:', err);
  }
}

async function getCustomerName(supabase: ReturnType<typeof createServiceClient>, phone: string): Promise<string | null> {
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
