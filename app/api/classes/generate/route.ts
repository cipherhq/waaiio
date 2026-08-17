import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

// ── POST: Trigger session generation for a service ──

export async function POST(request: NextRequest) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'class-generate'), 5, 60_000);
    if (rateLimit) return rateLimit;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { businessId, serviceId, daysAhead } = body;

    if (!businessId || !serviceId) {
      return NextResponse.json({ error: 'businessId and serviceId are required' }, { status: 400 });
    }

    // Capability guard: class_booking / manage_existing
    const service = createServiceClient();
    const guard = await requireCapability(supabase, service, {
      businessId, userId: user.id, capability: 'class_booking' as never, action: 'manage_existing',
    });
    if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

    // Verify the service belongs to this business and is a class
    const { data: svc } = await service
      .from('services')
      .select('id, is_class')
      .eq('id', serviceId)
      .eq('business_id', businessId)
      .single();

    if (!svc) {
      return NextResponse.json({ error: 'Service not found or does not belong to this business' }, { status: 404 });
    }
    if (!svc.is_class) {
      return NextResponse.json({ error: 'Service is not configured as a class' }, { status: 400 });
    }

    // Call the RPC to generate sessions
    const effectiveDaysAhead = daysAhead && daysAhead > 0 && daysAhead <= 90 ? daysAhead : 30;

    const { data: result, error: rpcError } = await service.rpc('generate_class_sessions', {
      p_service_id: serviceId,
      p_days_ahead: effectiveDaysAhead,
    });

    if (rpcError) {
      logger.withContext({ op: 'class-generate', businessId, serviceId }).error(`Session generation failed: ${rpcError.message}`);
      return NextResponse.json({ error: 'Failed to generate sessions' }, { status: 500 });
    }

    // The RPC may return a count or the generated rows depending on implementation.
    // Handle both cases gracefully.
    const count = typeof result === 'number'
      ? result
      : Array.isArray(result)
        ? result.length
        : 0;

    logger.withContext({ op: 'class-generate', businessId, serviceId }).info(`Generated ${count} class sessions for next ${effectiveDaysAhead} days`);

    return NextResponse.json({
      success: true,
      count,
      daysAhead: effectiveDaysAhead,
    });
  } catch (err) {
    logger.withContext({ op: 'class-generate' }).error(`Unexpected error: ${err}`);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
