import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { singleAttemptWhatsAppSend } from '@/lib/channels/single-attempt-send';
import { findCustomerEmail } from '@/lib/channels/send-or-email';
import { businessNotificationEmail } from '@/lib/email/templates';
import { sendEmail } from '@/lib/email/client';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

/**
 * POST /api/bookings/confirm
 *
 * Dispatches a booking confirmation notification using the durable intent system.
 * Uses claim/dispatch/outcome RPCs to ensure exactly-once delivery with
 * crash-recovery semantics (#244).
 *
 * Resend safety: Before allowing purpose='resend', this route verifies the
 * original 'create' intent is in a terminal state. If the create intent is
 * in 'dispatched' or 'indeterminate' status, the resend is blocked to prevent
 * duplicate delivery.
 *
 * Body: { bookingId: string, businessId: string, purpose?: 'create' | 'resend' }
 */
export async function POST(request: NextRequest) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'confirm-booking'), 10, 60_000);
    if (rateLimit) return rateLimit;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { bookingId, businessId, purpose = 'create' } = body;

    if (!bookingId || !businessId) {
      return NextResponse.json({ error: 'Missing required fields: bookingId, businessId' }, { status: 400 });
    }

    if (!['create', 'resend'].includes(purpose)) {
      return NextResponse.json({ error: 'Invalid purpose. Must be "create" or "resend"' }, { status: 400 });
    }

    // Verify business ownership
    const serviceClient = createServiceClient();
    const { data: biz } = await serviceClient
      .from('businesses')
      .select('id, name, country_code, owner_id')
      .eq('id', businessId)
      .single();

    if (!biz) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }
    if (biz.owner_id !== user.id) {
      return NextResponse.json({ error: 'Not authorized for this business' }, { status: 403 });
    }

    // ── Resend safety gate ──
    // Before allowing purpose='resend', check the 'create' intent status.
    // If the original create intent is in a non-terminal state (dispatched,
    // indeterminate, claiming), block the resend — we can't safely send again
    // when we don't know if the first message was delivered.
    if (purpose === 'resend') {
      const { data: createIntent } = await serviceClient
        .from('booking_confirmation_intents')
        .select('id, status')
        .eq('booking_id', bookingId)
        .eq('purpose', 'create')
        .maybeSingle();

      if (createIntent) {
        const nonTerminalStates = ['claiming', 'dispatched', 'indeterminate'];
        if (nonTerminalStates.includes(createIntent.status)) {
          return NextResponse.json({
            success: false,
            reason: 'create_intent_unresolved',
            create_intent_status: createIntent.status,
            message: `Cannot resend: the original confirmation is in '${createIntent.status}' state. ` +
              'Resolve the original intent before resending.',
          }, { status: 409 });
        }
      }
      // If create intent doesn't exist or is in a terminal state (sent, delivered,
      // read, failed, pending), resend is allowed.
    }

    // Step 1: Claim the confirmation intent
    const { data: claimResult, error: claimError } = await serviceClient
      .rpc('claim_booking_confirmation', {
        p_booking_id: bookingId,
        p_purpose: purpose,
        p_business_id: businessId,
      });

    if (claimError) {
      logger.error('[BOOKING CONFIRM] Claim RPC error:', claimError);
      return NextResponse.json({ error: 'Failed to claim confirmation' }, { status: 500 });
    }

    if (!claimResult?.claimed) {
      return NextResponse.json({
        success: false,
        reason: claimResult?.reason || 'claim_failed',
        intent_id: claimResult?.intent_id,
      }, { status: 409 });
    }

    const intentId = claimResult.intent_id;
    const claimToken = claimResult.claim_token;
    const guestPhone = claimResult.guest_phone;
    const guestEmail = claimResult.guest_email;

    // Step 2: Resolve channel and do all preflight BEFORE dispatch barrier
    const resolver = new ChannelResolver(serviceClient);
    const resolved = await resolver.resolveByBusinessId(businessId);

    if (!resolved || !resolved.cloud) {
      // No WhatsApp channel available — record as pre-dispatch failure (reclaimable)
      await serviceClient.rpc('record_booking_confirmation_outcome', {
        p_intent_id: intentId,
        p_claim_token: claimToken,
        p_outcome: 'failed',
        p_error_message: 'no_whatsapp_channel_available',
      });

      return NextResponse.json({
        success: false,
        reason: 'no_channel',
        intent_id: intentId,
      }, { status: 422 });
    }

    // Fetch booking details for the message
    const { data: bookingData } = await serviceClient
      .from('bookings')
      .select(`
        reference_code, date, time,
        service:services(name),
        appointment:appointments(name)
      `)
      .eq('id', bookingId)
      .single();

    if (!bookingData) {
      await serviceClient.rpc('record_booking_confirmation_outcome', {
        p_intent_id: intentId,
        p_claim_token: claimToken,
        p_outcome: 'failed',
        p_error_message: 'booking_data_not_found',
      });
      return NextResponse.json({ error: 'Booking data not found' }, { status: 404 });
    }

    const itemName = (bookingData.service as any)?.name || (bookingData.appointment as any)?.name || 'Booking';

    if (!guestPhone) {
      await serviceClient.rpc('record_booking_confirmation_outcome', {
        p_intent_id: intentId,
        p_claim_token: claimToken,
        p_outcome: 'failed',
        p_error_message: 'no_phone_number',
      });
      return NextResponse.json({
        success: false,
        reason: 'no_contact_method',
        intent_id: intentId,
      }, { status: 422 });
    }

    // Step 3: Mark dispatched — this is the irreversible barrier
    // All preflight is done. After this, any failure is indeterminate.
    const { data: dispatchResult, error: dispatchError } = await serviceClient
      .rpc('mark_booking_confirmation_dispatched', {
        p_intent_id: intentId,
        p_claim_token: claimToken,
        p_channel: 'whatsapp',
        p_template_name: 'booking_confirmation_text',
      });

    if (dispatchError || !dispatchResult?.dispatched) {
      logger.error('[BOOKING CONFIRM] Dispatch barrier failed:', dispatchError || dispatchResult);
      return NextResponse.json({
        success: false,
        reason: 'dispatch_failed',
        intent_id: intentId,
      }, { status: 500 });
    }

    // Step 4: Exactly ONE provider API call — no retry, no fallback
    const phone = guestPhone.startsWith('+') ? guestPhone.slice(1) : guestPhone;
    const dateLabel = new Date(bookingData.date + 'T00:00').toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
    const messageText = [
      '*Booking Confirmed!*',
      '',
      `${biz.name}`,
      `${itemName}`,
      `${dateLabel}`,
      `${bookingData.time}`,
      `Ref: *${bookingData.reference_code}*`,
      '',
      'See you there!',
    ].join('\n');

    const sendResult = await singleAttemptWhatsAppSend(
      resolved.cloud,
      phone,
      messageText,
    );

    // Step 5: Record outcome based on exact provider response
    let outcome: 'sent' | 'indeterminate';

    if (sendResult.outcome === 'sent') {
      await serviceClient.rpc('record_booking_confirmation_outcome', {
        p_intent_id: intentId,
        p_claim_token: claimToken,
        p_outcome: 'sent',
        p_provider_message_id: sendResult.providerMessageId,
      });
      outcome = 'sent';
    } else if (sendResult.outcome === 'unknown') {
      // Ambiguous provider outcome — message may or may not have been sent
      await serviceClient.rpc('record_booking_confirmation_outcome', {
        p_intent_id: intentId,
        p_claim_token: claimToken,
        p_outcome: 'indeterminate',
        p_error_message: sendResult.error || 'ambiguous_provider_outcome',
      });
      outcome = 'indeterminate';
    } else {
      // 'failed' after dispatch barrier — per DB contract, post-dispatch failure
      // must be recorded as indeterminate (even though 4xx is definitive, the
      // DB enforces this constraint for safety)
      await serviceClient.rpc('record_booking_confirmation_outcome', {
        p_intent_id: intentId,
        p_claim_token: claimToken,
        p_outcome: 'indeterminate',
        p_error_message: `post_dispatch_4xx: ${sendResult.error}`,
      });
      outcome = 'indeterminate';
    }

    // Best-effort email alongside (independent of WhatsApp intent lifecycle)
    try {
      const emailAddr = guestEmail || (guestPhone ? await findCustomerEmail(serviceClient, guestPhone, businessId) : null);
      if (emailAddr) {
        await sendEmail({
          to: emailAddr,
          subject: `Booking Confirmed - ${biz.name}`,
          html: businessNotificationEmail({
            businessName: biz.name,
            title: 'Booking Confirmed',
            message: `Your booking at ${biz.name} has been confirmed.`,
            details: {
              [bookingData.appointment ? 'Appointment' : 'Service']: itemName,
              'Date': dateLabel,
              'Time': bookingData.time,
              'Reference': bookingData.reference_code,
            },
          }).html,
        });
      }
    } catch (emailErr) {
      logger.warn('[BOOKING CONFIRM] Email send failed (non-critical):', emailErr);
    }

    return NextResponse.json({
      success: outcome === 'sent',
      intent_id: intentId,
      channel: 'whatsapp',
      outcome,
    });
  } catch (err) {
    logger.error('[BOOKING CONFIRM] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
