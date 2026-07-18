import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
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

    // Verify ownership
    const { data: biz } = await supabase
      .from('businesses')
      .select('id, name, country_code')
      .eq('id', businessId)
      .eq('owner_id', user.id)
      .single();
    if (!biz) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    // Get service details (including max_capacity for slot validation)
    const serviceClient = createServiceClient();
    const { data: service } = await serviceClient
      .from('services')
      .select('name, price, duration_minutes, max_capacity, buffer_time')
      .eq('id', serviceId)
      .eq('business_id', businessId)
      .single();
    if (!service) return NextResponse.json({ error: 'Service not found' }, { status: 404 });

    // Use atomic RPC with advisory lock — prevents double-booking and enforces max_capacity
    const { data: rpcResult, error: rpcError } = await serviceClient.rpc('book_slot_atomic', {
      p_business_id: businessId,
      p_user_id: user.id,
      p_service_id: serviceId,
      p_staff_id: staffId || null,
      p_date: date,
      p_time: time.padStart(5, '0'),
      p_party_size: partySize || 1,
      p_max_capacity: service.max_capacity || 1,
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
      p_staff_name: null,
      p_location_id: null,
      p_appointment_id: null,
      p_buffer_minutes: service.buffer_time || 0,
      p_duration: service.duration_minutes || 30,
    });

    if (rpcError) {
      if (rpcError.message?.includes('fully booked') || rpcError.message?.includes('slot_taken')) {
        return NextResponse.json({ error: 'This time slot is fully booked' }, { status: 409 });
      }
      logger.error('[MANUAL-BOOKING] RPC error:', rpcError.message);
      return NextResponse.json({ error: 'Failed to create booking' }, { status: 500 });
    }

    const bookingId = rpcResult;
    const { data: booking } = await serviceClient.from('bookings').select('*').eq('id', bookingId).single();
    if (!booking) {
      return NextResponse.json({ error: 'Booking created but could not retrieve details' }, { status: 500 });
    }

    // Update with dashboard-specific fields
    await serviceClient.from('bookings').update({
      channel: 'dashboard',
      confirmed_at: new Date().toISOString(),
    }).eq('id', bookingId);

    // If staffId provided, look up staff name and update
    if (staffId) {
      const { data: staffMember } = await serviceClient
        .from('business_staff')
        .select('name')
        .eq('id', staffId)
        .single();
      if (staffMember) {
        await serviceClient
          .from('bookings')
          .update({ staff_name: staffMember.name })
          .eq('id', booking.id);
      }
    }

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
            `Ref: *${refCode}*`,
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
                  'Reference': refCode,
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
