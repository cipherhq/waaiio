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
    // A separate 'resend' intent is only safe after the original 'create' delivery
    // is terminal-known (sent/delivered/read). All other states are either reclaimable
    // (pending, failed) or unresolved (claiming, dispatched, indeterminate) — creating
    // a separate resend would risk two logical intents for the same confirmation.
    //
    // If no create intent exists, use purpose='create' instead of treating absence
    // as resend eligibility.
    let effectivePurpose = purpose;
    if (purpose === 'resend') {
      const { data: createIntent } = await serviceClient
        .from('booking_confirmation_intents')
        .select('id, status')
        .eq('booking_id', bookingId)
        .eq('purpose', 'create')
        .maybeSingle();

      if (!createIntent) {
        // No create intent exists — use 'create' purpose, not resend
        effectivePurpose = 'create';
      } else {
        const terminalKnownStates = ['sent', 'delivered', 'read'];
        if (!terminalKnownStates.includes(createIntent.status)) {
          // Create intent is not terminal-known — block resend.
          // For pending/failed: retry the original create intent instead.
          // For claiming/dispatched/indeterminate: must resolve first.
          return NextResponse.json({
            success: false,
            reason: 'create_intent_unresolved',
            create_intent_status: createIntent.status,
            message: `Cannot resend: the original confirmation is in '${createIntent.status}' state. ` +
              (createIntent.status === 'pending' || createIntent.status === 'failed'
                ? 'Retry the original confirmation instead of creating a new resend.'
                : 'Resolve the original intent before resending.'),
          }, { status: 409 });
        }
        // Terminal-known (sent/delivered/read) — safe to create a deliberate resend
      }
    }

    // Step 1: Claim the confirmation intent
    const { data: claimResult, error: claimError } = await serviceClient
      .rpc('claim_booking_confirmation', {
        p_booking_id: bookingId,
        p_purpose: effectivePurpose,
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

    // Fetch booking details (shared by both WhatsApp and email)
    const { data: bookingData } = await serviceClient
      .from('bookings')
      .select(`
        reference_code, date, time,
        service:services(name),
        appointment:appointments(name)
      `)
      .eq('id', bookingId)
      .single();

    const itemName = bookingData
      ? (bookingData.service as any)?.name || (bookingData.appointment as any)?.name || 'Booking'
      : 'Booking';
    const dateLabel = bookingData
      ? new Date(bookingData.date + 'T00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
      : '';

    // ── WhatsApp confirmation via durable intent lifecycle ──
    let waOutcome: 'sent' | 'indeterminate' | 'preflight_failed' = 'preflight_failed';

    const resolver = new ChannelResolver(serviceClient);
    const resolved = await resolver.resolveByBusinessId(businessId);

    if (!resolved?.cloud || !guestPhone || !bookingData) {
      // WhatsApp preflight failure — intent stays in 'claiming' (reclaimable after lease expiry).
      // Do NOT call record_booking_confirmation_outcome — intent is not yet dispatched.
      const reason = !resolved?.cloud ? 'no_whatsapp_channel' : !guestPhone ? 'no_phone' : 'no_booking_data';
      logger.warn(`[BOOKING CONFIRM] WhatsApp preflight failed: ${reason}`);
      // waOutcome stays 'preflight_failed'
    } else {
      // All WhatsApp preflight passed — proceed through dispatch barrier
      const { data: dispatchResult, error: dispatchError } = await serviceClient
        .rpc('mark_booking_confirmation_dispatched', {
          p_intent_id: intentId,
          p_claim_token: claimToken,
          p_channel: 'whatsapp',
          p_template_name: 'booking_confirmation_text',
        });

      if (dispatchError || !dispatchResult?.dispatched) {
        logger.error('[BOOKING CONFIRM] Dispatch barrier failed:', dispatchError || dispatchResult);
        // waOutcome stays 'preflight_failed'
      } else {
        // Exactly ONE provider API call — no retry, no fallback
        const phone = guestPhone.startsWith('+') ? guestPhone.slice(1) : guestPhone;
        const messageText = [
          '*Booking Confirmed!*', '',
          `${biz.name}`, `${itemName}`, `${dateLabel}`, `${bookingData.time}`,
          `Ref: *${bookingData.reference_code}*`, '', 'See you there!',
        ].join('\n');

        const sendResult = await singleAttemptWhatsAppSend(resolved.cloud, phone, messageText);

        // Record outcome — persistence must positively succeed
        const durableOutcome = sendResult.outcome === 'sent' ? 'sent' : 'indeterminate';
        const { data: outcomeData, error: outcomeError } = await serviceClient.rpc('record_booking_confirmation_outcome', {
          p_intent_id: intentId, p_claim_token: claimToken,
          p_outcome: durableOutcome,
          p_provider_message_id: sendResult.providerMessageId,
          p_error_message: sendResult.outcome !== 'sent' ? (sendResult.error || 'ambiguous_provider_outcome') : null,
        });

        const persisted = !outcomeError && (outcomeData as Record<string, unknown>)?.success === true;
        if (!persisted) {
          // Persistence not confirmed — durable row remains dispatched/unknown
          logger.error('[BOOKING CONFIRM] Outcome persistence not confirmed:', outcomeError ?? outcomeData);
          waOutcome = 'indeterminate';
        } else {
          // Returned state matches durable state
          waOutcome = durableOutcome as 'sent' | 'indeterminate';
        }
      }
    }

    // ── Email confirmation — independent of WhatsApp ──
    // Attempted regardless of WhatsApp channel availability or outcome.
    // Email success does NOT change the WhatsApp intent state.
    let emailOutcome: 'sent' | 'failed' | 'not_attempted' = 'not_attempted';
    try {
      const emailAddr = guestEmail || (guestPhone ? await findCustomerEmail(serviceClient, guestPhone, businessId) : null);
      if (emailAddr && bookingData) {
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
        emailOutcome = 'sent';
      }
    } catch (emailErr) {
      logger.warn('[BOOKING CONFIRM] Email send failed (non-critical):', emailErr);
      emailOutcome = 'failed';
    }

    return NextResponse.json({
      success: waOutcome === 'sent',
      intent_id: intentId,
      channel: 'whatsapp',
      outcome: waOutcome,
      email: emailOutcome,
    });
  } catch (err) {
    logger.error('[BOOKING CONFIRM] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
