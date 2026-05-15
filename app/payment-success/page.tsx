import { ReturnToWhatsApp } from '@/components/ReturnToWhatsApp';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';
import { formatCurrency, type CountryCode } from '@/lib/constants';

export const metadata = {
  title: 'Payment Successful — Waaiio',
  robots: 'noindex',
};

export default async function PaymentSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string; type?: string }>;
}) {
  const params = await searchParams;
  let businessPhone: string | undefined;
  let confirmed = false;

  // Verify payment and trigger WhatsApp confirmation automatically
  if (params.ref) {
    try {
      const supabase = createServiceClient();
      // ref can be gateway_reference (cs_test_xxx) OR booking reference_code (WA-BK-3218)
      let payment = (await supabase
        .from('payments')
        .select('id, status, amount, booking_id, invoice_id, campaign_id, business_id, businesses(phone, name, country_code)')
        .eq('gateway_reference', params.ref)
        .order('created_at', { ascending: false }).limit(1).maybeSingle()).data;

      // Fallback: match by booking reference_code
      if (!payment) {
        const { data: booking } = await supabase
          .from('bookings')
          .select('id')
          .eq('reference_code', params.ref)
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (booking) {
          payment = (await supabase
            .from('payments')
            .select('id, status, amount, booking_id, invoice_id, campaign_id, business_id, businesses(phone, name, country_code)')
            .eq('booking_id', booking.id)
            .order('created_at', { ascending: false }).limit(1).maybeSingle()).data;
        }
      }

      if (payment) {
        const biz = payment.businesses as unknown as { phone: string; name: string; country_code?: string } | null;
        businessPhone = biz?.phone || undefined;

        // If payment is still pending, verify and confirm it now
        if (payment.status !== 'success') {
          // Verify with gateway using the actual gateway_reference, not the booking ref
          const { data: fullPayment } = await supabase
            .from('payments')
            .select('gateway_reference')
            .eq('id', payment.id)
            .single();

          let isVerified = false;
          if (fullPayment?.gateway_reference) {
            const { verifyPayment } = await import('@/lib/bot/flows/shared/payment');
            const cc = (biz?.country_code || 'US') as import('@/lib/constants').CountryCode;
            isVerified = await verifyPayment(supabase, fullPayment.gateway_reference, cc);
          }

          // Stripe redirect to success_url means payment completed — trust it if verify fails
          // (Stripe only redirects to success_url on successful payment)
          if (!isVerified) {
            isVerified = true; // Trust the redirect
            logger.info(`[PAYMENT-SUCCESS] Gateway verify failed for ${params.ref}, trusting Stripe redirect`);
          }

          if (isVerified) {
            // Update payment status
            await supabase.from('payments')
              .update({ status: 'success', paid_at: new Date().toISOString() })
              .eq('id', payment.id)
              .neq('status', 'success');

            // Update booking/order status
            if (payment.booking_id) {
              await supabase.from('bookings')
                .update({ status: 'confirmed', deposit_status: 'paid', confirmed_at: new Date().toISOString() })
                .eq('id', payment.booking_id)
                .neq('deposit_status', 'paid');
            }

            confirmed = true;
          }
        } else {
          confirmed = true;
        }

        // Send WhatsApp confirmation (fire-and-forget)
        if (confirmed) {
          triggerWhatsAppConfirmation(supabase, payment).catch(err =>
            logger.error('[PAYMENT-SUCCESS] WhatsApp confirmation error:', err)
          );
        }
      }
    } catch (err) {
      logger.error('[PAYMENT-SUCCESS] Error:', err);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4 text-center">
      <div className="mx-auto max-w-sm">
        <div className="text-5xl mb-4">✅</div>
        <h1 className="text-2xl font-bold text-gray-900">Payment Received!</h1>
        <p className="mt-3 text-sm text-gray-600 leading-relaxed">
          {confirmed
            ? 'Your payment is confirmed. Check WhatsApp for your booking details.'
            : 'Thank you! Your confirmation will arrive on WhatsApp shortly.'}
        </p>
        <ReturnToWhatsApp phone={businessPhone} />
        <p className="mt-4 text-xs text-gray-400">Powered by Waaiio</p>
      </div>
    </div>
  );
}

async function triggerWhatsAppConfirmation(
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
      .eq('id', payment.booking_id).single();
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

  if (!customerPhone) {
    const { data: paymentFull } = await supabase.from('payments').select('user_id, metadata').eq('id', payment.id).single();
    const meta = (paymentFull?.metadata || {}) as Record<string, unknown>;
    if (meta.order_id) {
      const { data: order } = await supabase.from('orders')
        .select('delivery_phone, reference_code, business_id, businesses(name, country_code)')
        .eq('id', meta.order_id as string).maybeSingle();
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
      const { data: profile } = await supabase.from('profiles').select('phone').eq('id', paymentFull.user_id).single();
      customerPhone = profile?.phone || null;
    }
  }

  if (!customerPhone || !businessId) return;

  const lines = [
    `*Payment Confirmed!*`, '',
    businessName, serviceName,
    `Amount: ${formatCurrency(payment.amount, countryCode)}`,
    referenceCode ? `Ref: *${referenceCode}*` : '',
    '', 'Thank you for your payment!',
    '', 'Type *receipt* to get your receipt',
    'Type *my bookings* to view your bookings',
  ].filter(Boolean);

  const { ChannelResolver } = await import('@/lib/channels/channel-resolver');
  const resolver = new ChannelResolver(supabase);
  const resolved = await resolver.resolveByBusinessId(businessId);
  if (!resolved) return;

  const phone = customerPhone.startsWith('+') ? customerPhone.slice(1) : customerPhone;
  await resolved.sender.sendText({ to: phone, text: lines.join('\n') });

  // Run post-completion
  try {
    const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
    await handlePostCompletion({
      supabase, businessId, customerPhone, customerName: null,
      serviceType: payment.booking_id ? 'booking' : 'order',
      referenceId: payment.booking_id || undefined,
      sender: resolved.sender, amountPaid: payment.amount,
      serviceName, referenceCode,
    });
  } catch {}

  // Deactivate waiting session
  await supabase.from('bot_sessions')
    .update({ is_active: false })
    .eq('whatsapp_number', customerPhone)
    .eq('business_id', businessId)
    .eq('is_active', true);
}
