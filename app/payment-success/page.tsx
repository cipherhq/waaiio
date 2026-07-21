import { ReturnToWhatsApp } from '@/components/ReturnToWhatsApp';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';
import { sendProactiveConfirmation } from '@/lib/payments/send-confirmation';
import { processSuccessfulPayment } from '@/lib/payments/process-success';
import { isWhiteLabel } from '@/lib/whitelabel';

export const metadata = {
  title: 'Payment Successful — Waaiio',
  robots: 'noindex',
};

export default async function PaymentSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string; type?: string; paymentId?: string }>;
}) {
  const params = await searchParams;
  let businessPhone: string | undefined;
  let confirmed = false;
  let bookingChannel: string | null = null;
  let isTicketing = false;
  let ticketCodes: string[] = [];
  let hasPhone = false;
  let subscriptionTier = 'free';

  const lookupRef = params.ref || params.paymentId;

  // Verify payment and trigger WhatsApp confirmation automatically
  if (lookupRef) {
    try {
      const supabase = createServiceClient();

      // Square redirects with ?paymentId=<uuid> — look up by id first
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let payment: any = null;

      if (params.paymentId) {
        payment = (await supabase
          .from('payments')
          .select('id, status, amount, booking_id, invoice_id, campaign_id, order_id, reservation_id, business_id, businesses(phone, name, country_code, subscription_tier)')
          .eq('id', params.paymentId)
          .maybeSingle()).data;
      }

      // Fallback: ref can be gateway_reference (cs_test_xxx) OR booking reference_code (WA-BK-3218)
      if (!payment && lookupRef) {
        payment = (await supabase
          .from('payments')
          .select('id, status, amount, booking_id, invoice_id, campaign_id, order_id, reservation_id, business_id, businesses(phone, name, country_code, subscription_tier)')
          .eq('gateway_reference', lookupRef)
          .order('created_at', { ascending: false }).limit(1).maybeSingle()).data;
      }

      // Fallback: match by booking reference_code
      if (!payment && params.ref) {
        const { data: booking } = await supabase
          .from('bookings')
          .select('id')
          .eq('reference_code', params.ref)
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (booking) {
          payment = (await supabase
            .from('payments')
            .select('id, status, amount, booking_id, invoice_id, campaign_id, order_id, reservation_id, business_id, businesses(phone, name, country_code, subscription_tier)')
            .eq('booking_id', booking.id)
            .order('created_at', { ascending: false }).limit(1).maybeSingle()).data;
        }
      }

      if (payment) {
        const biz = payment.businesses as unknown as { phone: string; name: string; country_code?: string; subscription_tier?: string } | null;
        if (biz?.subscription_tier) subscriptionTier = biz.subscription_tier;

        // Get the WhatsApp channel number (not the owner's personal phone)
        if (payment.business_id) {
          // Try assigned channel first, then dedicated, then shared
          const { data: bizFull } = await supabase
            .from('businesses')
            .select('assigned_channel_id, whatsapp_channel_id')
            .eq('id', payment.business_id)
            .single();

          const channelId = bizFull?.assigned_channel_id || bizFull?.whatsapp_channel_id;
          if (channelId) {
            const { data: ch } = await supabase.from('whatsapp_channels').select('phone_number').eq('id', channelId).maybeSingle();
            if (ch?.phone_number) businessPhone = ch.phone_number;
          }
          if (!businessPhone) {
            const { data: dedicated } = await supabase.from('whatsapp_channels').select('phone_number')
              .eq('business_id', payment.business_id).eq('channel_type', 'dedicated').eq('is_active', true).maybeSingle();
            if (dedicated?.phone_number) businessPhone = dedicated.phone_number;
          }
          if (!businessPhone) {
            const cc = biz?.country_code || 'US';
            const { data: shared } = await supabase.from('whatsapp_channels').select('phone_number')
              .eq('channel_type', 'shared').eq('country_code', cc).eq('is_active', true).limit(1).maybeSingle();
            if (shared?.phone_number) businessPhone = shared.phone_number;
          }
        }
        if (!businessPhone) businessPhone = biz?.phone || undefined;

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

          // If gateway verification fails, do NOT blindly trust the redirect.
          // The webhook will handle confirmation when it arrives.
          if (!isVerified) {
            logger.warn(`[PAYMENT-SUCCESS] Gateway verify failed for ${lookupRef}, waiting for webhook`);
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

        // Fetch booking channel and ticket info for UI rendering
        if (confirmed && payment.booking_id) {
          try {
            const { data: bookingInfo } = await supabase
              .from('bookings')
              .select('channel, flow_type, guest_phone')
              .eq('id', payment.booking_id)
              .single();
            bookingChannel = bookingInfo?.channel || null;
            isTicketing = bookingInfo?.flow_type === 'ticketing';
            hasPhone = !!bookingInfo?.guest_phone;

            // Fetch ticket codes for ticketing bookings (for "View Tickets" link)
            if (isTicketing) {
              const { data: tickets } = await supabase
                .from('event_tickets')
                .select('ticket_code')
                .eq('booking_id', payment.booking_id);
              ticketCodes = (tickets || []).map(t => t.ticket_code);
            }
          } catch (infoErr) {
            logger.error('[PAYMENT-SUCCESS] Failed to fetch booking info:', infoErr);
          }
        }

        // Process payment pipeline + send WhatsApp confirmation (awaited, not fire-and-forget)
        if (confirmed) {
          try {
            await processSuccessfulPayment(supabase, {
              id: payment.id,
              amount: payment.amount,
              booking_id: payment.booking_id,
              invoice_id: payment.invoice_id,
              campaign_id: payment.campaign_id,
              order_id: payment.order_id || null,
              reservation_id: payment.reservation_id || null,
            });
          } catch (pipeErr) {
            logger.error('[PAYMENT-SUCCESS] Pipeline error:', pipeErr);
          }

          try {
            await triggerWhatsAppConfirmation(supabase, payment);
          } catch (waErr) {
            logger.error('[PAYMENT-SUCCESS] WhatsApp confirmation error:', waErr);
          }
        }
      }
    } catch (err) {
      logger.error('[PAYMENT-SUCCESS] Error:', err);
    }
  }

  const isWebChannel = bookingChannel === 'web';

  // Determine confirmation message
  let confirmationMessage: string;
  if (!confirmed) {
    confirmationMessage = isWebChannel
      ? 'Thank you! Your confirmation will arrive in your email shortly.'
      : 'Thank you! Your confirmation will arrive on WhatsApp shortly.';
  } else if (isWebChannel) {
    confirmationMessage = 'Your payment is confirmed. Confirmation sent to your email.';
  } else {
    confirmationMessage = 'Your payment is confirmed. Check WhatsApp for your booking details.';
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4 text-center">
      <div className="mx-auto max-w-sm">
        <div className="text-5xl mb-4">✅</div>
        <h1 className="text-2xl font-bold text-gray-900">Payment Received!</h1>
        <p className="mt-3 text-sm text-gray-600 leading-relaxed">
          {confirmationMessage}
        </p>
        {/* Show ticket link for web channel ticketing purchases */}
        {isWebChannel && isTicketing && ticketCodes.length > 0 && (
          <a
            href={`/tickets/${ticketCodes[0]}`}
            className="mt-4 inline-flex items-center justify-center gap-2 rounded-xl bg-purple-600 px-6 py-3 text-sm font-semibold text-white transition hover:bg-purple-700"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
            </svg>
            View Your Tickets
          </a>
        )}
        {/* Show "Return to WhatsApp" only for WhatsApp channel or web channel with phone */}
        {(!isWebChannel || hasPhone) && <ReturnToWhatsApp phone={businessPhone} />}
        {!isWhiteLabel(subscriptionTier) && (
          <p className="mt-4 text-xs text-gray-400">Powered by Waaiio</p>
        )}
      </div>
    </div>
  );
}

async function triggerWhatsAppConfirmation(
  supabase: ReturnType<typeof createServiceClient>,
  payment: { id: string; booking_id: string | null; invoice_id: string | null; campaign_id: string | null; amount: number },
): Promise<void> {
  await sendProactiveConfirmation(supabase, payment, '[PAYMENT-SUCCESS]');
}
