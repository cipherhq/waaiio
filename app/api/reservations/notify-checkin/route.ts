import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

/**
 * POST /api/reservations/notify-checkin
 * Sends a WhatsApp check-in confirmation message to the guest.
 */
export async function POST(request: NextRequest) {
  try {
    const rateLimit = rateLimitResponse(getRateLimitKey(request, 'notify-checkin'), 20, 60_000);
    if (rateLimit) return rateLimit;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { reservationId, businessId } = await request.json();
    if (!reservationId || !businessId) {
      return NextResponse.json({ error: 'reservationId and businessId required' }, { status: 400 });
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

    const { data: reservation } = await serviceClient
      .from('reservations')
      .select('id, reference_code, guest_name, guest_phone, check_in, check_out, nights')
      .eq('id', reservationId)
      .eq('business_id', businessId)
      .single();

    if (!reservation || !reservation.guest_phone) {
      return NextResponse.json({ error: 'Reservation not found' }, { status: 404 });
    }

    const resolver = new ChannelResolver(serviceClient);
    const resolved = await resolver.resolveByBusinessId(businessId);

    if (resolved) {
      const toPhone = reservation.guest_phone.startsWith('+')
        ? reservation.guest_phone.slice(1)
        : reservation.guest_phone;

      await resolved.sender.sendText({
        to: toPhone,
        text: [
          `✅ *Check-In Confirmed*`,
          '',
          `Welcome to *${biz.name}*!`,
          `🔑 Ref: *${reservation.reference_code}*`,
          `📅 Check-out: ${new Date(reservation.check_out + 'T00:00').toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' })}`,
          '',
          `We hope you enjoy your stay! If you need anything, just send us a message here.`,
        ].join('\n'),
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[CHECKIN] Notify error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
