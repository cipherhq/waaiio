import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

const VALID_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

// ── GET: List recurrence rules for a business/service ──

export async function GET(request: NextRequest) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'class-recurrence-get'), 30, 60_000);
    if (rateLimit) return rateLimit;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const serviceId = request.nextUrl.searchParams.get('serviceId');
    const businessId = request.nextUrl.searchParams.get('businessId');

    if (!businessId) {
      return NextResponse.json({ error: 'businessId is required' }, { status: 400 });
    }

    const service = createServiceClient();
    const guard = await requireCapability(supabase, service, {
      businessId, userId: user.id, capability: 'class_booking' as never, action: 'read_history',
    });
    if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

    let query = service
      .from('class_recurrence_rules')
      .select('*, business_staff(id, name)')
      .eq('business_id', businessId)
      .order('weekday')
      .order('start_time');

    if (serviceId) {
      query = query.eq('service_id', serviceId);
    }

    const { data, error } = await query;
    if (error) {
      logger.withContext({ op: 'class-recurrence.get', businessId }).error(`Failed to fetch recurrence rules: ${error.message}`);
      return NextResponse.json({ error: 'Failed to fetch recurrence rules' }, { status: 500 });
    }

    return NextResponse.json({ data });
  } catch (err) {
    logger.withContext({ op: 'class-recurrence.get' }).error(`Unexpected error: ${err}`);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── POST: Create a new recurrence rule ──

export async function POST(request: NextRequest) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'class-recurrence-post'), 10, 60_000);
    if (rateLimit) return rateLimit;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { businessId, serviceId, weekday, startTime, staffId, locationId, capacityOverride, effectiveFrom, effectiveUntil } = body;

    if (!businessId || !serviceId || !weekday || !startTime) {
      return NextResponse.json({ error: 'businessId, serviceId, weekday, and startTime are required' }, { status: 400 });
    }

    if (!VALID_WEEKDAYS.includes(weekday)) {
      return NextResponse.json({ error: `weekday must be one of: ${VALID_WEEKDAYS.join(', ')}` }, { status: 400 });
    }

    const service = createServiceClient();
    const guard = await requireCapability(supabase, service, {
      businessId, userId: user.id, capability: 'class_booking' as never, action: 'create_new',
    });
    if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

    // Atomic recurrence creation via DB authority
    const { data: result, error: rpcError } = await service
      .rpc('create_class_recurrence_atomic', {
        p_business_id: businessId,
        p_service_id: serviceId,
        p_weekday: weekday,
        p_start_time: startTime,
        p_staff_id: staffId || null,
        p_location_id: locationId || null,
        p_capacity_override: capacityOverride || null,
        p_effective_from: effectiveFrom || null,
        p_effective_until: effectiveUntil || null,
      });

    if (rpcError) {
      logger.withContext({ op: 'class-recurrence.create', businessId, serviceId }).error(`Atomic recurrence creation failed: ${rpcError.message}`);
      return NextResponse.json({ error: 'Failed to create recurrence rule' }, { status: 500 });
    }

    if (!result?.success) {
      return NextResponse.json({ error: result?.reason || 'Failed to create recurrence rule' }, { status: 400 });
    }

    return NextResponse.json({ data: result }, { status: 201 });
  } catch (err) {
    logger.withContext({ op: 'class-recurrence.create' }).error(`Unexpected error: ${err}`);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── PUT: Update a recurrence rule (atomic reconciliation) ──

export async function PUT(request: NextRequest) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'class-recurrence-put'), 10, 60_000);
    if (rateLimit) return rateLimit;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { businessId, ruleId, weekday, startTime, staffId, locationId, capacityOverride, effectiveFrom, effectiveUntil, isActive, clearStaff } = body;

    if (!businessId || !ruleId) {
      return NextResponse.json({ error: 'businessId and ruleId are required' }, { status: 400 });
    }

    if (weekday !== undefined && !VALID_WEEKDAYS.includes(weekday)) {
      return NextResponse.json({ error: `weekday must be one of: ${VALID_WEEKDAYS.join(', ')}` }, { status: 400 });
    }

    const service = createServiceClient();
    const guard = await requireCapability(supabase, service, {
      businessId, userId: user.id, capability: 'class_booking' as never, action: 'manage_existing',
    });
    if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

    // Atomic reconciliation via DB authority
    const { data: result, error: rpcError } = await service
      .rpc('reconcile_class_recurrence', {
        p_rule_id: ruleId,
        p_business_id: businessId,
        p_action: 'update',
        p_weekday: weekday || null,
        p_start_time: startTime || null,
        p_staff_id: staffId || null,
        p_location_id: locationId || null,
        p_capacity_override: capacityOverride ?? null,
        p_effective_from: effectiveFrom || null,
        p_effective_until: effectiveUntil ?? null,
        p_is_active: isActive ?? null,
        p_clear_staff: clearStaff || false,
      });

    if (rpcError) {
      logger.withContext({ op: 'class-recurrence.update', businessId, ruleId }).error(`Reconciliation failed: ${rpcError.message}`);
      return NextResponse.json({ error: 'Failed to update recurrence rule' }, { status: 500 });
    }

    if (!result?.success) {
      const reason = result?.reason;
      if (reason === 'booked_sessions_exist') {
        return NextResponse.json({
          error: 'Cannot update — future sessions have active bookings. Cancel or reschedule those bookings first.',
          booked_session_count: result?.booked_session_count,
        }, { status: 409 });
      }
      return NextResponse.json({ error: reason || 'Failed to update recurrence rule' }, { status: 400 });
    }

    return NextResponse.json({ data: result });
  } catch (err) {
    logger.withContext({ op: 'class-recurrence.update' }).error(`Unexpected error: ${err}`);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── DELETE: Delete a recurrence rule ──

export async function DELETE(request: NextRequest) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'class-recurrence-delete'), 10, 60_000);
    if (rateLimit) return rateLimit;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { businessId, ruleId } = body;

    if (!businessId || !ruleId) {
      return NextResponse.json({ error: 'businessId and ruleId are required' }, { status: 400 });
    }

    const service = createServiceClient();
    const guard = await requireCapability(supabase, service, {
      businessId, userId: user.id, capability: 'class_booking' as never, action: 'manage_existing',
    });
    if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

    // Atomic deletion via DB authority
    const { data: result, error: rpcError } = await service
      .rpc('reconcile_class_recurrence', {
        p_rule_id: ruleId,
        p_business_id: businessId,
        p_action: 'delete',
      });

    if (rpcError) {
      logger.withContext({ op: 'class-recurrence.delete', businessId, ruleId }).error(`Reconciliation failed: ${rpcError.message}`);
      return NextResponse.json({ error: 'Failed to delete recurrence rule' }, { status: 500 });
    }

    if (!result?.success) {
      const reason = result?.reason;
      if (reason === 'booked_sessions_exist') {
        return NextResponse.json({
          error: 'Cannot delete rule — future sessions have active bookings. Cancel those sessions first.',
          booked_session_count: result?.booked_session_count,
        }, { status: 409 });
      }
      return NextResponse.json({ error: reason || 'Failed to delete recurrence rule' }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.withContext({ op: 'class-recurrence.delete' }).error(`Unexpected error: ${err}`);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
