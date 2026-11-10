import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { deliverAfterBookingIntake } from '@/lib/intake/send';
import { logger } from '@/lib/logger';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * #963: the business approved a booking in the dashboard. If the booking's
 * service links an after-booking intake form, send it now (once, inside the
 * client's 24-hour window). Owner-only; the booking must belong to a business
 * the signed-in user owns. Never changes the booking.
 */
export async function POST(request: NextRequest) {
  const limited = await rateLimitResponseAsync(getRateLimitKey(request, 'intake-after-confirm'), 60, 60_000);
  if (limited) return limited;
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const bookingId = typeof body?.bookingId === 'string' ? body.bookingId : '';
    const businessId = typeof body?.businessId === 'string' ? body.businessId : '';
    if (!UUID.test(bookingId) || !UUID.test(businessId)) {
      return NextResponse.json({ error: 'bookingId and businessId required' }, { status: 400 });
    }

    const { data: biz } = await supabase.from('businesses').select('id')
      .eq('id', businessId).eq('owner_id', user.id).maybeSingle();
    if (!biz) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const service = createServiceClient();
    const { data: booking } = await service.from('bookings').select('id')
      .eq('id', bookingId).eq('business_id', businessId).maybeSingle();
    if (!booking) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const result = await deliverAfterBookingIntake(service, bookingId);
    return NextResponse.json({ status: result.status, ...(result.status === 'skipped' ? { reason: result.reason } : {}) });
  } catch (err) {
    logger.error('[INTAKE] after-confirm failed:', (err as Error).message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
