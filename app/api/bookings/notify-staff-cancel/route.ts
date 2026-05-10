import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { notifyStaffBookingCancelled } from '@/lib/bot/flows/shared/notify-staff';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { bookingId, businessId } = await request.json();
    if (!bookingId || !businessId) {
      return NextResponse.json({ error: 'bookingId and businessId required' }, { status: 400 });
    }

    // Verify ownership
    const { data: biz } = await supabase
      .from('businesses')
      .select('id, name')
      .eq('id', businessId)
      .eq('owner_id', user.id)
      .single();

    if (!biz) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const serviceClient = createServiceClient();

    // Get booking with staff and service info
    const { data: booking } = await serviceClient
      .from('bookings')
      .select('id, staff_id, guest_name, date, time, reference_code, service_id, services:service_id(name)')
      .eq('id', bookingId)
      .eq('business_id', businessId)
      .single();

    if (!booking?.staff_id) {
      return NextResponse.json({ ok: true, message: 'No staff to notify' });
    }

    // Resolve sender for WhatsApp
    const resolver = new ChannelResolver(serviceClient);
    const resolved = await resolver.resolveByBusinessId(businessId);
    if (!resolved) {
      return NextResponse.json({ ok: true, message: 'No WhatsApp channel available' });
    }
    const sender = resolved.sender;

    const dateLabel = new Date(booking.date + 'T00:00').toLocaleDateString('en-US', {
      weekday: 'long', day: 'numeric', month: 'long',
    });

    await notifyStaffBookingCancelled({
      supabase: serviceClient,
      sender,
      businessId,
      staffId: booking.staff_id,
      customerName: booking.guest_name || 'Customer',
      serviceName: ((booking as any).services as { name: string } | null)?.name || '',
      date: dateLabel,
      time: booking.time || '',
      referenceCode: booking.reference_code || '',
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('[API] notify-staff-cancel error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
