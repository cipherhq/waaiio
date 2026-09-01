import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { sendOrEmail, findCustomerEmail } from '@/lib/channels/send-or-email';
import { businessNotificationEmail } from '@/lib/email/templates';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

/**
 * POST /api/bookings/confirm
 *
 * Dispatches a booking confirmation notification using the durable intent system.
 * Uses claim/dispatch/outcome RPCs to ensure exactly-once delivery with
 * crash-recovery semantics (#244).
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

    // Step 2: Resolve channel and pin the send decision BEFORE dispatch
    const resolver = new ChannelResolver(serviceClient);
    const resolved = await resolver.resolveByBusinessId(businessId);

    if (!resolved) {
      // No channel available — record as failed (pre-dispatch)
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
    const channel = guestPhone ? 'whatsapp' : (guestEmail ? 'email' : null);
    const templateName = 'booking_confirmation_text';

    if (!channel) {
      await serviceClient.rpc('record_booking_confirmation_outcome', {
        p_intent_id: intentId,
        p_claim_token: claimToken,
        p_outcome: 'failed',
        p_error_message: 'no_contact_method',
      });
      return NextResponse.json({
        success: false,
        reason: 'no_contact_method',
        intent_id: intentId,
      }, { status: 422 });
    }

    // Step 3: Mark dispatched — this is the irreversible barrier
    const { data: dispatchResult, error: dispatchError } = await serviceClient
      .rpc('mark_booking_confirmation_dispatched', {
        p_intent_id: intentId,
        p_claim_token: claimToken,
        p_channel: channel,
        p_template_name: templateName,
      });

    if (dispatchError || !dispatchResult?.dispatched) {
      logger.error('[BOOKING CONFIRM] Dispatch barrier failed:', dispatchError || dispatchResult);
      return NextResponse.json({
        success: false,
        reason: 'dispatch_failed',
        intent_id: intentId,
      }, { status: 500 });
    }

    // Step 4: Send the message (post-dispatch — crash here = indeterminate)
    let messageSent = false;
    let providerMessageId: string | null = null;

    try {
      const phone = guestPhone?.startsWith('+') ? guestPhone.slice(1) : guestPhone;
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

      const emailAddr = guestEmail || (guestPhone ? await findCustomerEmail(serviceClient, guestPhone, businessId) : null);

      const result = await sendOrEmail({
        supabase: serviceClient,
        sender: resolved.sender,
        to: phone || '',
        text: messageText,
        businessName: biz.name,
        alwaysEmail: true,
        email: emailAddr ? {
          address: emailAddr,
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
        } : null,
      });

      messageSent = result.whatsapp === 'sent' || result.email === 'sent';
      // sendOrEmail doesn't return provider message IDs, so we track via channel
    } catch (err) {
      logger.error('[BOOKING CONFIRM] Send error (post-dispatch):', err);
      // Post-dispatch failure = indeterminate (message may or may not have been sent)
      await serviceClient.rpc('record_booking_confirmation_outcome', {
        p_intent_id: intentId,
        p_claim_token: claimToken,
        p_outcome: 'indeterminate',
        p_error_message: err instanceof Error ? err.message : 'send_error',
      });
      return NextResponse.json({
        success: false,
        reason: 'send_error_indeterminate',
        intent_id: intentId,
      }, { status: 500 });
    }

    // Step 5: Record outcome
    const outcome = messageSent ? 'sent' : 'failed';
    await serviceClient.rpc('record_booking_confirmation_outcome', {
      p_intent_id: intentId,
      p_claim_token: claimToken,
      p_outcome: outcome,
      p_provider_message_id: providerMessageId,
      p_error_message: messageSent ? null : 'send_returned_not_sent',
    });

    return NextResponse.json({
      success: messageSent,
      intent_id: intentId,
      channel,
      outcome,
    });
  } catch (err) {
    logger.error('[BOOKING CONFIRM] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
