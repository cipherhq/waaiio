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

    // Validate required fields
    if (!businessId || !serviceId || !date || !time || !customerName || !customerPhone) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
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
    const { data: service } = await serviceClient
      .from('services')
      .select('name, price, duration_minutes, max_capacity, buffer_minutes')
      .eq('id', serviceId)
      .eq('business_id', businessId)
      .single();
    if (!service) return NextResponse.json({ error: 'Service not found' }, { status: 404 });

    // Look up staff name if staffId provided
    let staffName: string | null = null;
    if (staffId) {
      const { data: staffMember } = await serviceClient
        .from('business_staff')
        .select('name')
        .eq('id', staffId)
        .single();
      staffName = staffMember?.name || null;
    }

    // ── Atomic booking via canonical RPC (prevents race conditions) ──
    const maxCapacity = service.max_capacity ?? 1;
    const { data: slotResult, error: slotError } = await serviceClient
      .rpc('book_slot_atomic', {
        p_business_id: businessId,
        p_user_id: null, // manual bookings don't have a user_id
        p_service_id: serviceId,
        p_staff_id: staffId || null,
        p_date: date,
        p_time: time,
        p_party_size: partySize || 1,
        p_max_capacity: maxCapacity,
        p_flow_type: 'scheduling',
        p_deposit_amount: 0,
        p_deposit_status: 'not_required',
        p_status: 'confirmed',
        p_guest_name: customerName,
        p_guest_phone: customerPhone,
        p_guest_email: customerEmail || null,
        p_special_requests: notes || null,
        p_venue_address: null,
        p_end_date: null,
        p_addons_snapshot: null,
        p_promo_code_id: null,
        p_total_amount: service.price ?? 0,
        p_staff_name: staffName,
        p_location_id: null,
        p_appointment_id: null,
        p_buffer_minutes: service.buffer_minutes ?? 0,
        p_duration: service.duration_minutes ?? 30,
        p_bot_session_id: null,
      })
      .single() as { data: { booking_id: string; reference_code: string; slot_available: boolean } | null; error: unknown };

    if (slotError || !slotResult) {
      logger.error('[MANUAL BOOKING] Atomic booking RPC error:', slotError);
      return NextResponse.json({ error: 'Failed to create booking' }, { status: 500 });
    }

    if (!slotResult.slot_available) {
      return NextResponse.json({ error: 'This time slot is already booked' }, { status: 409 });
    }

    // Set dashboard-specific fields (channel, confirmed_at) that the RPC doesn't handle
    await serviceClient
      .from('bookings')
      .update({
        channel: 'dashboard',
        confirmed_at: new Date().toISOString(),
      })
      .eq('id', slotResult.booking_id);

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
            `${service.name}`,
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
                  'Service': service.name,
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
        p_booking_amount: service.price ?? 0,
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
