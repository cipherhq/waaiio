import { ReturnToWhatsApp } from '@/components/ReturnToWhatsApp';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';
import { isWhiteLabel } from '@/lib/whitelabel';
import { resolvePaymentFromRef } from '@/lib/payments/payment-success-resolver';
import { reconcileAndConfirm, getConfirmationMessage } from '@/lib/payments/payment-success-helpers';

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
  let bookingChannel: string | null = null;
  let isTicketing = false;
  let ticketCodes: string[] = [];
  let hasPhone = false;
  let subscriptionTier = 'free';
  let exactOriginFailed = false;

  // Verify payment and trigger WhatsApp confirmation automatically
  if (params.ref) {
    try {
      const supabase = createServiceClient();
      // Resolve payment through canonical resolver:
      // 1. Exact gateway_reference (provider-neutral — works for cs_... Stripe sessions and all other providers)
      // 2. Booking reference_code fallback (provider-neutral — existing behavior)
      // 3. Legacy Stripe entity-reference fallback (for old sessions with WA-OR-xxxx, etc.)
      const { payment: resolvedPayment, path } = await resolvePaymentFromRef(supabase, params.ref);
      if (path) {
        logger.info('[PAYMENT-SUCCESS] Payment resolved via ' + path, { ref: params.ref });
      }
      const payment = resolvedPayment;

      if (payment) {
        const biz = payment.businesses as unknown as { phone: string; name: string; country_code?: string; subscription_tier?: string } | null;
        if (biz?.subscription_tier) subscriptionTier = biz.subscription_tier;

        // ── #230/#231: Exact-origin Return to WhatsApp resolution ──
        // WhatsApp-origin payments (where _confirmation_origin === 'whatsapp')
        // must return the customer to the EXACT channel that originated the
        // transaction, not a business-level fallback that may be a different
        // country's number. Uses _inbound_channel_id persisted by #219.
        const confirmationOrigin = (payment.metadata as Record<string, unknown> | null)?._confirmation_origin as string | undefined;
        const inboundChannelId = (payment.metadata as Record<string, unknown> | null)?._inbound_channel_id as string | undefined;
        const isWhatsAppOrigin = confirmationOrigin === 'whatsapp';

        if (isWhatsAppOrigin && inboundChannelId && payment.business_id) {
          // Exact-origin path: resolve the originating channel by ID
          const { data: originChannel } = await supabase
            .from('whatsapp_channels')
            .select('id, phone_number, is_active, business_id, channel_type')
            .eq('id', inboundChannelId)
            .maybeSingle();

          if (
            originChannel?.is_active &&
            originChannel.phone_number &&
            // Cross-tenant guard: channel must belong to this business or be shared
            (originChannel.business_id === payment.business_id || originChannel.channel_type === 'shared')
          ) {
            businessPhone = originChannel.phone_number;
          } else {
            // Exact-origin channel missing, inactive, or cross-tenant mismatch.
            // Fail closed: show manual return message instead of wrong number.
            exactOriginFailed = true;
            logger.warn('[PAYMENT-SUCCESS] #230: exact-origin channel unavailable, failing closed', {
              inboundChannelId,
              businessId: payment.business_id,
              channelFound: !!originChannel,
              isActive: originChannel?.is_active,
              channelBusinessId: originChannel?.business_id,
            });
          }
        } else if (isWhatsAppOrigin && !inboundChannelId) {
          // WhatsApp-origin but no _inbound_channel_id persisted — fail closed
          exactOriginFailed = true;
          logger.warn('[PAYMENT-SUCCESS] #230: WhatsApp-origin payment missing _inbound_channel_id', {
            paymentId: payment.id,
          });
        } else {
          // Non-WhatsApp-origin (web or legacy): use existing business-level fallback chain
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
        }

        // ── Canonical Payment Authority: server-side reconciliation ──
        // Browser redirect alone is NOT proof of payment.
        const { reconcilePayment } = await import('@/lib/payments/reconcile');
        const { confirmed: isConfirmed } = await reconcileAndConfirm(supabase, payment.id, reconcilePayment);
        confirmed = isConfirmed;

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
      }
    } catch (err) {
      logger.error('[PAYMENT-SUCCESS] Error:', err);
    }
  }

  const isWebChannel = bookingChannel === 'web';

  const confirmationMessage = getConfirmationMessage(confirmed, isWebChannel);

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
        {/* #230/#231: exact-origin failed — show manual return instead of wrong number */}
        {exactOriginFailed && (
          <p className="mt-4 text-sm text-gray-500">
            Please return to your WhatsApp conversation manually.
          </p>
        )}
        {/* Show "Return to WhatsApp" only when not exact-origin-failed */}
        {!exactOriginFailed && (!isWebChannel || hasPhone) && <ReturnToWhatsApp phone={businessPhone} />}
        {!isWhiteLabel(subscriptionTier) && (
          <p className="mt-4 text-xs text-gray-400">Powered by Waaiio</p>
        )}
      </div>
    </div>
  );
}
