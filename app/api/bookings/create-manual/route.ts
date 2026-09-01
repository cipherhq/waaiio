import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireAnyCapability } from '@/lib/capabilities/api-guard';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { singleAttemptWhatsAppSend } from '@/lib/channels/single-attempt-send';
import { findCustomerEmail } from '@/lib/channels/send-or-email';
import { businessNotificationEmail } from '@/lib/email/templates';
import { sendEmail } from '@/lib/email/client';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'create-manual-booking'), 20, 60_000);
    if (rateLimit) return rateLimit;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const {
      businessId,
      serviceId,
      appointmentId,
      date,
      time,
      customerName,
      customerPhone,
      customerEmail,
      partySize,
      staffId,
      notes,
      sendConfirmation,
      classSessionId,
    } = body;

    // Validate required fields — exactly one of serviceId or appointmentId
    if (!businessId || !date || !time || !customerName || !customerPhone) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }
    if (!serviceId && !appointmentId) {
      return NextResponse.json({ error: 'Either serviceId or appointmentId is required' }, { status: 400 });
    }
    if (serviceId && appointmentId) {
      return NextResponse.json({ error: 'Provide serviceId or appointmentId, not both' }, { status: 400 });
    }
    if (classSessionId && appointmentId) {
      return NextResponse.json({ error: 'Cannot combine appointmentId and classSessionId' }, { status: 400 });
    }
    if (classSessionId && !serviceId) {
      return NextResponse.json({ error: 'classSessionId requires serviceId' }, { status: 400 });
    }

    // Reject past dates
    const today = new Date().toISOString().split('T')[0];
    if (date < today) {
      return NextResponse.json({ error: 'Date cannot be in the past' }, { status: 400 });
    }

    // ── Resolve authoritative service type for capability enforcement ──
    const serviceClient = createServiceClient();

    // Detect class service from the authoritative record
    let isClassService = false;
    if (serviceId) {
      const { data: svcCheck } = await serviceClient
        .from('services')
        .select('is_class')
        .eq('id', serviceId)
        .eq('business_id', businessId)
        .maybeSingle();
      isClassService = svcCheck?.is_class ?? false;
    }

    // Class service requires class_booking + classSessionId
    if (isClassService) {
      if (!classSessionId) {
        return NextResponse.json({ error: 'Class services require a classSessionId' }, { status: 400 });
      }
      const guard = await requireAnyCapability(supabase, serviceClient, {
        businessId, userId: user.id, capabilities: ['class_booking' as import('@/lib/capabilities/types').CapabilityId], action: 'create_new',
      });
      if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });
    } else {
      const guard = await requireAnyCapability(supabase, serviceClient, {
        businessId, userId: user.id, capabilities: ['appointment', 'scheduling'], action: 'create_new',
      });
      if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });
    }

    // Get business name/country for notifications
    const { data: biz } = await serviceClient
      .from('businesses')
      .select('name, country_code')
      .eq('id', businessId)
      .single();
    if (!biz) return NextResponse.json({ error: 'Business data unavailable' }, { status: 500 });

    // Resolve the bookable item — service or appointment
    let itemName: string;
    let itemPrice: number;
    let itemDuration: number;
    let itemMaxCapacity: number;
    let itemBufferMinutes: number;

    let itemRequiresStaff = false;

    if (appointmentId) {
      const { data: appt } = await serviceClient
        .from('appointments')
        .select('name, price, duration_minutes, max_capacity, buffer_minutes, requires_staff')
        .eq('id', appointmentId)
        .eq('business_id', businessId)
        .single();
      if (!appt) return NextResponse.json({ error: 'Appointment type not found' }, { status: 404 });
      itemName = appt.name;
      itemPrice = appt.price ?? 0;
      itemDuration = appt.duration_minutes ?? 30;
      itemMaxCapacity = appt.max_capacity ?? 1;
      itemBufferMinutes = appt.buffer_minutes ?? 0;
      itemRequiresStaff = appt.requires_staff ?? false;
    } else {
      const { data: service } = await serviceClient
        .from('services')
        .select('name, price, duration_minutes, max_capacity, buffer_minutes, requires_staff')
        .eq('id', serviceId)
        .eq('business_id', businessId)
        .single();
      if (!service) return NextResponse.json({ error: 'Service not found' }, { status: 404 });
      itemName = service.name;
      itemPrice = service.price ?? 0;
      itemDuration = service.duration_minutes ?? 30;
      itemMaxCapacity = service.max_capacity ?? 1;
      itemBufferMinutes = service.buffer_minutes ?? 0;
      itemRequiresStaff = service.requires_staff ?? false;
    }

    // Reject requires_staff items without a staff assignment (non-class only)
    // Class bookings use session instructor — DB authority validates
    if (itemRequiresStaff && !staffId && !classSessionId) {
      return NextResponse.json({ error: 'This service requires a staff member to be assigned' }, { status: 400 });
    }

    // Look up and validate staff if staffId provided
    let staffName: string | null = null;
    if (staffId) {
      const { data: staffMember } = await serviceClient
        .from('business_staff')
        .select('name, is_active')
        .eq('id', staffId)
        .eq('business_id', businessId)
        .single();
      if (!staffMember) {
        return NextResponse.json({ error: 'Staff member not found for this business' }, { status: 400 });
      }
      if (!staffMember.is_active) {
        return NextResponse.json({ error: 'Staff member is no longer active' }, { status: 400 });
      }
      staffName = staffMember.name || null;
    }

    // ── Resolve customer identity (bookings.user_id = customer, not operator) ──
    const { createWhatsAppUser } = await import('@/lib/bot/flows/shared/user');
    const nameParts = customerName.trim().split(/\s+/);
    const firstName = nameParts[0] || customerName;
    const lastName = nameParts.slice(1).join(' ') || '';

    const customerId = await createWhatsAppUser(
      serviceClient,
      customerPhone,
      firstName,
      lastName,
      customerEmail || undefined,
    );

    if (!customerId) {
      return NextResponse.json({ error: 'Failed to resolve customer identity' }, { status: 500 });
    }

    // ── Atomic manual booking via wrapper RPC ──
    const { data: slotResult, error: slotError } = await serviceClient
      .rpc('book_manual_slot_atomic', {
        p_business_id: businessId,
        p_user_id: customerId,
        p_service_id: appointmentId ? null : serviceId,
        p_staff_id: staffId || null,
        p_date: date,
        p_time: time,
        p_party_size: partySize || 1,
        p_max_capacity: itemMaxCapacity,
        p_guest_name: customerName,
        p_guest_phone: customerPhone,
        p_guest_email: customerEmail || null,
        p_notes: notes || null,
        p_total_amount: itemPrice,
        p_staff_name: staffName,
        p_buffer_minutes: itemBufferMinutes,
        p_duration: itemDuration,
        p_appointment_id: appointmentId || null,
        p_class_session_id: classSessionId || null,
      })
      .single() as { data: { booking_id: string; reference_code: string; slot_available: boolean } | null; error: unknown };

    if (slotError || !slotResult) {
      logger.error('[MANUAL BOOKING] Atomic booking RPC error:', slotError);
      return NextResponse.json({ error: 'Failed to create booking' }, { status: 500 });
    }

    if (!slotResult.slot_available) {
      return NextResponse.json({ error: 'This time slot is already booked' }, { status: 409 });
    }

    const booking = { id: slotResult.booking_id, reference_code: slotResult.reference_code };

    // ── Durable confirmation dispatch via intent lifecycle ──
    // Booking creation succeeds regardless of notification outcome.
    // WhatsApp and email are independent — email does not depend on WA channel.
    let notificationOutcome: 'sent' | 'failed' | 'indeterminate' | 'preflight_failed' | 'skipped' = 'skipped';
    let whatsappSent = false;

    const dateLabel = new Date(date + 'T00:00').toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long',
    });

    if (sendConfirmation && customerPhone) {
      try {
        // Step 1: Claim the durable confirmation intent (creates + claims atomically)
        const { data: claimResult, error: claimError } = await serviceClient
          .rpc('claim_booking_confirmation', {
            p_booking_id: booking.id,
            p_purpose: 'create',
            p_business_id: businessId,
          });

        if (claimError || !claimResult?.claimed) {
          logger.warn('[MANUAL BOOKING] Intent claim failed:', claimError || claimResult);
          notificationOutcome = 'failed';
        } else {
          const intentId = claimResult.intent_id;
          const claimToken = claimResult.claim_token;

          // Step 2: All preflight BEFORE the dispatch barrier
          const resolver = new ChannelResolver(serviceClient);
          const resolved = await resolver.resolveByBusinessId(businessId);

          if (!resolved?.cloud) {
            // No WhatsApp channel — intent stays in claiming (reclaimable after lease)
            logger.warn('[MANUAL BOOKING] No WhatsApp channel, intent stays reclaimable');
            notificationOutcome = 'preflight_failed';
          } else {
            const phone = customerPhone.startsWith('+') ? customerPhone.slice(1) : customerPhone;
            const messageText = [
              '*Booking Confirmed!*', '',
              `${biz.name}`, `${itemName}`, `${dateLabel}`, `${time}`,
              `Ref: *${booking.reference_code}*`, '', 'See you there!',
            ].join('\n');

            // Step 3: Mark dispatched — irreversible barrier
            const { data: dispatchResult, error: dispatchError } = await serviceClient
              .rpc('mark_booking_confirmation_dispatched', {
                p_intent_id: intentId, p_claim_token: claimToken,
                p_channel: 'whatsapp', p_template_name: 'booking_confirmation_text',
              });

            if (dispatchError || !dispatchResult?.dispatched) {
              logger.error('[MANUAL BOOKING] Dispatch barrier failed:', dispatchError || dispatchResult);
              notificationOutcome = 'failed';
            } else {
              // Step 4: Exactly ONE provider API call — no retry, no fallback
              const sendResult = await singleAttemptWhatsAppSend(resolved.cloud, phone, messageText);

              // Step 5: Record outcome — persistence must succeed for truthful reporting
              const durableOutcome = sendResult.outcome === 'sent' ? 'sent' : 'indeterminate';
              const { error: outcomeError } = await serviceClient.rpc('record_booking_confirmation_outcome', {
                p_intent_id: intentId, p_claim_token: claimToken,
                p_outcome: durableOutcome,
                p_provider_message_id: sendResult.providerMessageId,
                p_error_message: sendResult.outcome !== 'sent' ? (sendResult.error || 'ambiguous_provider_outcome') : null,
              });

              if (outcomeError) {
                // Persistence failed — durable row remains dispatched/unknown
                logger.error('[MANUAL BOOKING] Outcome persistence failed:', outcomeError);
                notificationOutcome = 'indeterminate';
              } else if (sendResult.outcome === 'sent') {
                whatsappSent = true;
                notificationOutcome = 'sent';
              } else {
                // Durable state is 'indeterminate' — return must agree
                notificationOutcome = 'indeterminate';
              }
            }
          }
        }
      } catch (err) {
        logger.error('[MANUAL BOOKING] WhatsApp notification error:', err);
        notificationOutcome = 'failed';
      }
    }

    // ── Email confirmation — independent of WhatsApp ──
    // Attempted regardless of WhatsApp channel availability or outcome.
    // Email success does NOT change the WhatsApp intent state.
    let emailOutcome: 'sent' | 'failed' | 'not_attempted' = 'not_attempted';
    if (sendConfirmation) {
      try {
        const emailAddr = customerEmail || (customerPhone ? await findCustomerEmail(serviceClient, customerPhone, businessId) : null);
        if (emailAddr) {
          await sendEmail({
            to: emailAddr,
            subject: `Booking Confirmed - ${biz.name}`,
            html: businessNotificationEmail({
              businessName: biz.name,
              title: 'Booking Confirmed',
              message: `Your booking at ${biz.name} has been confirmed.`,
              details: {
                [appointmentId ? 'Appointment' : 'Service']: itemName,
                'Date': dateLabel,
                'Time': time,
                'Reference': booking.reference_code,
              },
            }).html,
          });
          emailOutcome = 'sent';
        }
      } catch (emailErr) {
        logger.warn('[MANUAL BOOKING] Email send failed (non-critical):', emailErr);
        emailOutcome = 'failed';
      }
    }

    // Update customer profile (non-blocking).
    // Manual bookings pass p_booking_amount: 0 — no payment has occurred,
    // so we must NOT inflate customer total_spent/LTV. Spend is only
    // recorded when an actual payment is processed (#244).
    try {
      await serviceClient.rpc('upsert_customer_profile', {
        p_business_id: businessId,
        p_phone: customerPhone,
        p_name: customerName,
        p_booking_amount: 0,
        p_is_booking: true,
        p_is_order: false,
      });
    } catch {
      // Non-critical
    }

    return NextResponse.json({
      success: true,
      booking_id: booking.id,
      reference_code: booking.reference_code,
      whatsapp_sent: whatsappSent,
      notification_outcome: notificationOutcome,
    });
  } catch (err) {
    logger.error('[MANUAL BOOKING] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
