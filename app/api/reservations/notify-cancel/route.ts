import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { resolveProactiveLocalization } from '@/lib/payments/proactive-localization';
import { fillFlowCopy } from '@/lib/bot/flows/flow-localization';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { formatDisplayDate } from '@/lib/bot/format-date';
import { logger } from '@/lib/logger';

/**
 * POST /api/reservations/notify-cancel
 * Sends a WhatsApp cancellation notification to the guest.
 * Verifies reservation is actually cancelled before sending.
 */
export async function POST(request: NextRequest) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'notify-cancel'), 20, 60_000);
    if (rateLimit) return rateLimit;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { reservationId, businessId } = await request.json();
    if (!reservationId || !businessId) {
      return NextResponse.json({ error: 'reservationId and businessId required' }, { status: 400 });
    }

    // Verify business ownership
    const { data: biz } = await supabase
      .from('businesses')
      .select('id, name, country_code')
      .eq('id', businessId)
      .eq('owner_id', user.id)
      .single();

    if (!biz) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const serviceClient = createServiceClient();

    // Load reservation — scoped to this business, must be cancelled
    const { data: reservation } = await serviceClient
      .from('reservations')
      .select('id, reference_code, guest_name, guest_phone, check_in, check_out, status')
      .eq('id', reservationId)
      .eq('business_id', businessId)
      .single();

    if (!reservation) {
      return NextResponse.json({ error: 'Reservation not found' }, { status: 404 });
    }

    if (reservation.status !== 'cancelled') {
      return NextResponse.json({ error: 'Reservation is not cancelled' }, { status: 400 });
    }

    if (!reservation.guest_phone) {
      return NextResponse.json({ success: true, notified: false, reason: 'no_phone' });
    }

    const resolver = new ChannelResolver(serviceClient);
    const resolved = await resolver.resolveByBusinessId(businessId);

    if (!resolved) {
      return NextResponse.json({ success: true, notified: false, reason: 'no_channel' });
    }

    const toPhone = reservation.guest_phone.startsWith('+')
      ? reservation.guest_phone.slice(1)
      : reservation.guest_phone;

    const l10n = await resolveProactiveLocalization(serviceClient, reservation.guest_phone, businessId);
    const checkInLabel = formatDisplayDate(reservation.check_in, 'short', l10n.language, biz.country_code || 'NG');
    await resolved.sender.sendText({
      to: toPhone,
      text: fillFlowCopy(l10n.language, 'notification.reservation_cancelled', { businessName: biz.name, referenceCode: reservation.reference_code, checkInDate: checkInLabel }),
    });

    return NextResponse.json({ success: true, notified: true });
  } catch (error) {
    logger.error('[RESERVATION] Cancel notify error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
