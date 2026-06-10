import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const rateLimit = rateLimitResponse(getRateLimitKey(request, 'create-manual-booking'), 20, 60_000);
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

    // Get service details
    const serviceClient = createServiceClient();
    const { data: service } = await serviceClient
      .from('services')
      .select('name, price, duration_minutes')
      .eq('id', serviceId)
      .eq('business_id', businessId)
      .single();
    if (!service) return NextResponse.json({ error: 'Service not found' }, { status: 404 });

    // Check for time conflicts
    const { count: conflictCount } = await serviceClient
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', businessId)
      .eq('date', date)
      .eq('time', time.padStart(5, '0'))
      .in('status', ['confirmed', 'pending', 'in_progress']);

    if ((conflictCount ?? 0) > 0) {
      return NextResponse.json({ error: 'This time slot is already booked' }, { status: 409 });
    }

    // Generate reference code
    const refCode = `${businessId.slice(0, 4).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;

    // Insert booking directly (simpler than RPC for manual bookings -- no slot contention from dashboard)
    const { data: booking, error: insertErr } = await serviceClient.from('bookings').insert({
      business_id: businessId,
      service_id: serviceId,
      date,
      time,
      guest_name: customerName,
      guest_phone: customerPhone,
      guest_email: customerEmail || null,
      party_size: partySize || 1,
      staff_id: staffId || null,
      staff_name: staffId ? undefined : null,
      notes: notes || null,
      reference_code: refCode,
      status: 'confirmed',
      flow_type: 'scheduling',
      channel: 'dashboard',
      total_amount: service.price ?? 0,
      deposit_amount: 0,
      deposit_status: 'not_required',
      confirmed_at: new Date().toISOString(),
    }).select('id, reference_code').single();

    if (insertErr) {
      logger.error('[MANUAL BOOKING] Insert error:', insertErr);
      return NextResponse.json({ error: 'Failed to create booking' }, { status: 500 });
    }

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

    // Send WhatsApp confirmation if requested
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
          await resolved.sender.sendText({
            to: phone,
            text: [
              '*Booking Confirmed!*',
              '',
              `${biz.name}`,
              `${service.name}`,
              `${dateLabel}`,
              `${time}`,
              `Ref: *${refCode}*`,
              '',
              'See you there!',
            ].join('\n'),
          });
          whatsappSent = true;
        }
      } catch (err) {
        logger.error('[MANUAL BOOKING] WhatsApp error:', err);
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
