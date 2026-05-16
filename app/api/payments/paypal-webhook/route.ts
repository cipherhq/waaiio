import { NextResponse, type NextRequest } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import * as Sentry from '@sentry/nextjs';
import { createServiceClient } from '@/lib/supabase/service';
import { getPlatformFees } from '@/lib/getPlatformFees';
import { logger } from '@/lib/logger';
import { createAlert } from '@/lib/alerts/create-alert';
import { formatCurrency, type CountryCode, type SubscriptionTier } from '@/lib/constants';

export const maxDuration = 60;

const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID || '';
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const PAYPAL_ENVIRONMENT = process.env.PAYPAL_ENVIRONMENT || 'sandbox';

function getPayPalBaseUrl(): string {
  return PAYPAL_ENVIRONMENT === 'production'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

/**
 * Verify PayPal webhook signature using PayPal's verification API.
 * PayPal uses a complex CRC32 + certificate chain — easier to use their endpoint.
 */
async function verifyPayPalWebhook(
  headers: Headers,
  rawBody: string,
): Promise<boolean> {
  if (!PAYPAL_WEBHOOK_ID || !PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) return false;

  try {
    // Get access token
    const tokenRes = await fetch(`${getPayPalBaseUrl()}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(10000),
    });
    const tokenData = await tokenRes.json() as { access_token?: string };
    if (!tokenData.access_token) return false;

    // Call PayPal's webhook verification endpoint
    const verifyRes = await fetch(`${getPayPalBaseUrl()}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        auth_algo: headers.get('paypal-auth-algo') || '',
        cert_url: headers.get('paypal-cert-url') || '',
        transmission_id: headers.get('paypal-transmission-id') || '',
        transmission_sig: headers.get('paypal-transmission-sig') || '',
        transmission_time: headers.get('paypal-transmission-time') || '',
        webhook_id: PAYPAL_WEBHOOK_ID,
        webhook_event: JSON.parse(rawBody),
      }),
      signal: AbortSignal.timeout(10000),
    });

    const verifyData = await verifyRes.json() as { verification_status?: string };
    return verifyData.verification_status === 'SUCCESS';
  } catch (err) {
    logger.error('[PAYPAL WEBHOOK] Signature verification error:', err);
    return false;
  }
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();

    // Verify webhook signature when configured
    if (PAYPAL_WEBHOOK_ID) {
      const isValid = await verifyPayPalWebhook(request.headers, rawBody);
      if (!isValid) {
        logger.warn('[PAYPAL WEBHOOK] Invalid signature — rejecting');
        return NextResponse.json({ message: 'Invalid signature' }, { status: 401 });
      }
    } else {
      logger.warn('[PAYPAL WEBHOOK] PAYPAL_WEBHOOK_ID not configured — skipping verification');
    }

    const body = JSON.parse(rawBody);
    const eventType = body.event_type as string;
    const resource = body.resource as Record<string, unknown> | undefined;

    if (!resource) {
      return NextResponse.json({ received: true });
    }

    const supabase = createServiceClient();

    // Idempotency: atomic dedup
    const eventId = body.id as string | undefined;
    if (eventId) {
      const { data: inserted } = await supabase
        .from('processed_webhook_events')
        .upsert(
          { event_id: `paypal-${eventId}`, gateway: 'paypal', event_type: `paypal_${eventType}`, processed_at: new Date().toISOString() },
          { onConflict: 'event_id', ignoreDuplicates: true },
        )
        .select('id');

      if (!inserted || inserted.length === 0) {
        return NextResponse.json({ received: true, duplicate: true });
      }
    }

    // CHECKOUT.ORDER.APPROVED — customer approved, need to capture
    if (eventType === 'CHECKOUT.ORDER.APPROVED') {
      const orderId = resource.id as string;
      if (!orderId) return NextResponse.json({ received: true });

      // Capture the payment
      try {
        const tokenRes = await fetch(`${getPayPalBaseUrl()}/v1/oauth2/token`, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: 'grant_type=client_credentials',
          signal: AbortSignal.timeout(10000),
        });
        const tokenData = await tokenRes.json() as { access_token?: string };
        if (tokenData.access_token) {
          await fetch(`${getPayPalBaseUrl()}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${tokenData.access_token}`,
              'Content-Type': 'application/json',
            },
            body: '{}',
            signal: AbortSignal.timeout(15000),
          });
        }
      } catch (captureErr) {
        logger.error('[PAYPAL WEBHOOK] Auto-capture failed:', captureErr);
      }
    }

    // PAYMENT.CAPTURE.COMPLETED — payment fully captured (success)
    if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
      const captureAmount = resource.amount as { value?: string; currency_code?: string } | undefined;
      const webhookAmount = captureAmount?.value ? parseFloat(captureAmount.value) : 0;

      // The supplementary_data contains the order ID that links to our payment record
      const supplementaryData = resource.supplementary_data as Record<string, unknown> | undefined;
      const relatedIds = supplementaryData?.related_ids as Record<string, string> | undefined;
      const orderId = relatedIds?.order_id || '';

      // Also check custom_id fallback
      const purchaseUnits = (resource as Record<string, unknown>).purchase_units as Array<{ reference_id?: string }> | undefined;
      const referenceId = purchaseUnits?.[0]?.reference_id;

      // Find payment by PayPal order ID
      let payment: { id: string; booking_id: string | null; amount: number; status: string } | null = null;

      if (orderId) {
        const { data } = await supabase
          .from('payments')
          .select('id, booking_id, amount, status')
          .eq('gateway_reference', orderId)
          .eq('gateway', 'paypal')
          .maybeSingle();
        payment = data;
      }

      // Fallback: search by metadata paypal_order_id
      if (!payment && orderId) {
        const { data: payments } = await supabase
          .from('payments')
          .select('id, booking_id, amount, status, metadata')
          .eq('gateway', 'paypal')
          .neq('status', 'success');

        payment = payments?.find(p => {
          const meta = p.metadata as Record<string, string> | null;
          return meta?.paypal_order_id === orderId;
        }) || null;
      }

      if (!payment || payment.status === 'success') {
        return NextResponse.json({ received: true });
      }

      // Verify amount matches (allow small rounding tolerance)
      if (Math.abs(webhookAmount - payment.amount) > 0.02) {
        logger.warn(`[PAYPAL WEBHOOK] Amount mismatch: expected ${payment.amount}, got ${webhookAmount}`);
        await supabase
          .from('payments')
          .update({ status: 'failed', gateway_status: 'amount_mismatch' })
          .eq('id', payment.id);
        return NextResponse.json({ received: true });
      }

      // Update payment status
      await supabase
        .from('payments')
        .update({
          status: 'success',
          gateway_status: 'completed',
          payment_method: 'paypal',
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
          .select('raised_amount, donor_count')
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
      sendPayPalPaymentConfirmation(supabase, {
        ...payment,
        invoice_id: fullPayment?.invoice_id || null,
        campaign_id: fullPayment?.campaign_id || null,
      }).catch(err =>
        logger.error('[PAYPAL WEBHOOK] Proactive confirmation error:', err),
      );
    }

    // PAYMENT.CAPTURE.DENIED — payment failed
    if (eventType === 'PAYMENT.CAPTURE.DENIED' || eventType === 'PAYMENT.CAPTURE.DECLINED') {
      const supplementaryData = resource.supplementary_data as Record<string, unknown> | undefined;
      const relatedIds = supplementaryData?.related_ids as Record<string, string> | undefined;
      const orderId = relatedIds?.order_id || '';

      if (orderId) {
        const { data: failedPayment } = await supabase
          .from('payments')
          .select('id, amount, business_id')
          .eq('gateway_reference', orderId)
          .eq('gateway', 'paypal')
          .neq('status', 'success')
          .maybeSingle();

        if (failedPayment) {
          await supabase
            .from('payments')
            .update({ status: 'failed', gateway_status: 'denied' })
            .eq('id', failedPayment.id);

          if (failedPayment.business_id) {
            await createAlert(supabase, {
              businessId: failedPayment.business_id,
              type: 'payment_failed',
              severity: 'warning',
              title: 'Payment Failed',
              message: `A PayPal payment of ${failedPayment.amount} was denied.`,
              metadata: { paymentId: failedPayment.id, amount: failedPayment.amount, gateway: 'paypal' },
            });
          }
        }
      }
    }

    // PAYMENT.CAPTURE.REFUNDED — refund processed
    if (eventType === 'PAYMENT.CAPTURE.REFUNDED') {
      logger.info('[PAYPAL WEBHOOK] Refund processed:', resource.id);
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    logger.error('[PAYPAL WEBHOOK] Error:', (error as Error).message);
    Sentry.captureException(error);
    return NextResponse.json({ received: true }, { status: 200 });
  }
}

/**
 * Send proactive WhatsApp confirmation after PayPal payment success.
 */
async function sendPayPalPaymentConfirmation(
  supabase: ReturnType<typeof createServiceClient>,
  payment: { id: string; booking_id: string | null; invoice_id: string | null; campaign_id: string | null; amount: number },
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
    logger.warn('[PAYPAL WEBHOOK] Proactive confirmation skipped — no phone or business');
    return;
  }

  logger.info(`[PAYPAL WEBHOOK] Sending proactive confirmation to ${customerPhone} for ${businessName}`);

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
    const resolved = await resolver.resolveByBusinessId(businessId);
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
      logger.error('[PAYPAL WEBHOOK] Post-completion error:', pcErr);
    }

    // Reset session to capability selection so user stays with this business
    await supabase
      .from('bot_sessions')
      .update({ current_step: 'select_capability', session_data: {} })
      .eq('whatsapp_number', customerPhone)
      .eq('business_id', businessId)
      .eq('is_active', true);
  } catch (err) {
    logger.error('[PAYPAL WEBHOOK] Send confirmation error:', err);
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
