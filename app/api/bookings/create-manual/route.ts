import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireAnyCapability } from '@/lib/capabilities/api-guard';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { sendOrEmail, findCustomerEmail } from '@/lib/channels/send-or-email';
import { businessNotificationEmail } from '@/lib/email/templates';
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

    // Reject past dates
    const today = new Date().toISOString().split('T')[0];
    if (date < today) {
      return NextResponse.json({ error: 'Date cannot be in the past' }, { status: 400 });
    }

    // ── Capability enforcement: appointment OR scheduling / create_new ──
    const serviceClient = createServiceClient();
    const guard = await requireAnyCapability(supabase, serviceClient, {
      businessId, userId: user.id, capabilities: ['appointment', 'scheduling'], action: 'create_new',
    });
    if (!guard.allowed) {
      return NextResponse.json(guard.denial, { status: guard.status });
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

    // Reject requires_staff items without a staff assignment
    if (itemRequiresStaff && !staffId) {
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
    // Uses the canonical createWhatsAppUser helper: finds existing profile by
    // phone/email, or creates a new auth user + profile. Same mechanism used by
    // the bot scheduling flow and public booking route.
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

    // Send confirmation via WhatsApp (with email fallback) if requested
    let whatsappSent = false;
    if (sendConfirmation && customerPhone) {
      try {
        const resolver = new ChannelResolver(serviceClient);
        const resolved = await resolver.resolveByBusinessId(businessId);
        if (resolved) {
          const phone = customerPhone.startsWith('+') ? customerPhone.slice(1) : customerPhone;
          const dateLabel = new Date(date + 'T00:00').toLocaleDateString('en-GB', {
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
            `${time}`,
            `Ref: *${booking.reference_code}*`,
            '',
            'See you there!',
          ].join('\n');

          // Use provided email or look up from customer profile
          const emailAddr = customerEmail || await findCustomerEmail(serviceClient, customerPhone, businessId);

          const result = await sendOrEmail({
            supabase: serviceClient,
            sender: resolved.sender,
            to: phone,
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
                  [appointmentId ? 'Appointment' : 'Service']: itemName,
                  'Date': dateLabel,
                  'Time': time,
                  'Reference': booking.reference_code,
                },
              }).html,
            } : null,
          });
          whatsappSent = result.whatsapp === 'sent';
        }
      } catch (err) {
        logger.error('[MANUAL BOOKING] Notification error:', err);
      }
    }

    // Update customer profile (non-blocking)
    try {
      await serviceClient.rpc('upsert_customer_profile', {
        p_business_id: businessId,
        p_phone: customerPhone,
        p_name: customerName,
        p_booking_amount: itemPrice,
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
    });
  } catch (err) {
    logger.error('[MANUAL BOOKING] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
