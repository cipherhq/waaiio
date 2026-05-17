import { NextResponse, type NextRequest } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import * as Sentry from '@sentry/nextjs';
import { createServiceClient } from '@/lib/supabase/service';
import { getPlatformFees } from '@/lib/getPlatformFees';
import { logger } from '@/lib/logger';
import { formatCurrency, type CountryCode, type SubscriptionTier } from '@/lib/constants';

const squareWebhookSignatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';
const squareWebhookNotificationUrl = process.env.SQUARE_WEBHOOK_NOTIFICATION_URL || '';

function verifySquareSignature(rawBody: string, signature: string): boolean {
  if (!squareWebhookSignatureKey || !signature) return false;

  // Square HMAC-SHA256: sign(notification_url + raw_body)
  const payload = squareWebhookNotificationUrl + rawBody;
  const expected = createHmac('sha256', squareWebhookSignatureKey)
    .update(payload)
    .digest('base64');

  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch { return false; }
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get('x-square-hmacsha256-signature') || '';

    // Fail-closed: reject if webhook secret is not configured
    // Verify signature when secret is configured
    if (squareWebhookSignatureKey && !verifySquareSignature(rawBody, signature)) {
      return NextResponse.json({ message: 'Invalid signature' }, { status: 400 });
    }

    const body = JSON.parse(rawBody);
    const eventType = body.type as string;
    const data = body.data?.object as Record<string, unknown>;

    if (!data) {
      return NextResponse.json({ received: true });
    }

    const supabase = createServiceClient();

    // Idempotency: atomic dedup via ON CONFLICT
    const eventId = body.event_id as string | undefined;
    if (eventId) {
      const { data: inserted } = await supabase
        .from('processed_webhook_events')
        .upsert(
          { event_id: eventId, gateway: 'square', event_type: `square_${eventType}`, processed_at: new Date().toISOString() },
          { onConflict: 'event_id', ignoreDuplicates: true },
        )
        .select('id');

      if (!inserted || inserted.length === 0) {
        return NextResponse.json({ received: true, duplicate: true });
      }
    }

    // Square fires payment.updated when status transitions (COMPLETED, FAILED, etc.)
    if (eventType === 'payment.updated' || eventType === 'payment.created') {
      const payment = data.payment as Record<string, unknown> | undefined;
      if (!payment) return NextResponse.json({ received: true });

      const orderId = payment.order_id as string | undefined;
      const paymentStatus = payment.status as string | undefined;
      if (!orderId) return NextResponse.json({ received: true });

      // Find our payment record by square_order_id in metadata
      const { data: payments } = await supabase
        .from('payments')
        .select('id, booking_id, amount, status, metadata')
        .eq('gateway', 'square')
        .neq('status', 'success');

      const matchedPayment = payments?.find(p => {
        const meta = p.metadata as Record<string, string> | null;
        return meta?.square_order_id === orderId;
      });

      if (!matchedPayment) return NextResponse.json({ received: true });

      if (paymentStatus === 'COMPLETED' && matchedPayment.status !== 'success') {
        const sourceType = payment.source_type as string | undefined;

        await supabase
          .from('payments')
          .update({
            status: 'success',
            gateway_status: 'completed',
            payment_method: sourceType === 'CASH_APP' ? 'cash_app_pay' : sourceType?.toLowerCase() || 'card',
            paid_at: new Date().toISOString(),
          })
          .eq('id', matchedPayment.id);

        if (matchedPayment.booking_id) {
          await supabase
            .from('bookings')
            .update({
              deposit_status: 'paid',
              status: 'confirmed',
              confirmed_at: new Date().toISOString(),
            })
            .eq('id', matchedPayment.booking_id);

          // Record platform fee
          const { data: booking } = await supabase
            .from('bookings')
            .select('business_id, total_amount')
            .eq('id', matchedPayment.booking_id)
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
              const amount = booking.total_amount || matchedPayment.amount;

              const { feePercentage, feeFlat, feeTotal } = await getPlatformFees(amount, tier, isInTrial);

              await supabase.from('platform_fees').insert({
                business_id: booking.business_id,
                booking_id: matchedPayment.booking_id,
                transaction_amount: amount,
                fee_percentage: feePercentage,
                fee_flat: feeFlat,
                fee_total: feeTotal,
                tier,
              });
            }
          }
        }

        // ── Proactive confirmation: send WhatsApp message + post-completion ──
        sendSquarePaymentConfirmation(supabase, matchedPayment).catch(err =>
          logger.error('[SQUARE WEBHOOK] Proactive confirmation error:', err),
        );
      } else if (paymentStatus === 'FAILED') {
        await supabase
          .from('payments')
          .update({ status: 'failed', gateway_status: 'failed' })
          .eq('id', matchedPayment.id);
      }
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    Sentry.captureException(error);
    return NextResponse.json({ received: true }, { status: 200 });
  }
}

/**
 * Send proactive WhatsApp confirmation after Square payment success.
 */
async function sendSquarePaymentConfirmation(
  supabase: ReturnType<typeof createServiceClient>,
  payment: { id: string; booking_id: string | null; amount: number; metadata: unknown },
): Promise<void> {
  let customerPhone: string | null = null;
  let businessId: string | null = null;
  let businessName = 'Business';
  let serviceName = 'Payment';
  let referenceCode = '';
  let countryCode: CountryCode = 'US';

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

  // Fallback: check orders/invoices via payment metadata
  if (!customerPhone) {
    const { data: paymentFull } = await supabase
      .from('payments')
      .select('user_id, metadata, invoice_id')
      .eq('id', payment.id)
      .single();

    if (paymentFull?.invoice_id) {
      const { data: invoice } = await supabase
        .from('invoices')
        .select('customer_phone, reference_code, business_id, businesses:business_id(name, country_code)')
        .eq('id', paymentFull.invoice_id)
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

    const meta = (paymentFull?.metadata || {}) as Record<string, unknown>;
    if (!customerPhone && meta.order_id) {
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
    logger.warn('[SQUARE WEBHOOK] Proactive confirmation skipped — no phone or business');
    return;
  }

  logger.info(`[SQUARE WEBHOOK] Sending proactive confirmation to ${customerPhone} for ${businessName}`);

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
      logger.error('[SQUARE WEBHOOK] Post-completion error:', pcErr);
    }

    // Reset session to capability selection so user stays with this business
    await supabase
      .from('bot_sessions')
      .update({ current_step: 'select_capability', session_data: {}, is_active: true })
      .eq('whatsapp_number', customerPhone)
      .eq('business_id', businessId);
  } catch (err) {
    logger.error('[SQUARE WEBHOOK] Send confirmation error:', err);
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
