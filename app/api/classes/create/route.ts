import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

/**
 * POST /api/classes/create
 * Atomic class creation: service + recurrence rule + session generation.
 * Uses create_class_atomic DB function — no orphan services on failure.
 */
export async function POST(request: NextRequest) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'class-create'), 10, 60_000);
    if (rateLimit) return rateLimit;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { businessId, name, price, durationMinutes, maxCapacity, weekday, startTime, staffId, locationId, capacityOverride, description } = body;

    if (!businessId || !name) {
      return NextResponse.json({ error: 'businessId and name are required' }, { status: 400 });
    }

    const service = createServiceClient();
    const guard = await requireCapability(supabase, service, {
      businessId, userId: user.id, capability: 'class_booking' as never, action: 'create_new',
    });
    if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

    const { data: result, error: rpcError } = await service
      .rpc('create_class_atomic', {
        p_business_id: businessId,
        p_name: name,
        p_price: price || 0,
        p_duration_minutes: durationMinutes || 60,
        p_max_capacity: maxCapacity || 10,
        p_weekday: weekday || null,
        p_start_time: startTime || null,
        p_staff_id: staffId || null,
        p_location_id: locationId || null,
        p_capacity_override: capacityOverride || null,
        p_description: description || null,
      });

    if (rpcError) {
      logger.withContext({ op: 'class.create', businessId }).error(`Class creation failed: ${rpcError.message}`);
      return NextResponse.json({ error: 'Failed to create class' }, { status: 500 });
    }

    if (!result?.success) {
      return NextResponse.json({ error: result?.reason || 'Failed to create class' }, { status: 400 });
    }

    return NextResponse.json({ data: result }, { status: 201 });
  } catch (err) {
    logger.withContext({ op: 'class.create' }).error(`Unexpected error: ${err}`);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
