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

    // Verify the service belongs to this business and is a class
    const { data: svc } = await service
      .from('services')
      .select('id, is_class')
      .eq('id', serviceId)
      .eq('business_id', businessId)
      .single();

    if (!svc) return NextResponse.json({ error: 'Service not found or does not belong to this business' }, { status: 404 });
    if (!svc.is_class) return NextResponse.json({ error: 'Service is not configured as a class' }, { status: 400 });

    // Validate staff belongs to business and is active
    if (staffId) {
      const { data: staffCheck } = await service
        .from('business_staff')
        .select('id')
        .eq('id', staffId)
        .eq('business_id', businessId)
        .eq('is_active', true)
        .maybeSingle();
      if (!staffCheck) return NextResponse.json({ error: 'Staff member not found, inactive, or does not belong to this business' }, { status: 400 });
    }

    // Validate location belongs to business
    if (locationId) {
      const { data: locCheck } = await service
        .from('business_locations')
        .select('id')
        .eq('id', locationId)
        .eq('business_id', businessId)
        .eq('is_active', true)
        .maybeSingle();
      if (!locCheck) return NextResponse.json({ error: 'Location not found or does not belong to this business' }, { status: 400 });
    }

    const { data: rule, error: insertError } = await service
      .from('class_recurrence_rules')
      .insert({
        business_id: businessId,
        service_id: serviceId,
        weekday,
        start_time: startTime,
        staff_id: staffId || null,
        location_id: locationId || null,
        capacity_override: capacityOverride || null,
        effective_from: effectiveFrom || new Date().toISOString().split('T')[0],
        effective_until: effectiveUntil || null,
      })
      .select()
      .single();

    if (insertError) {
      logger.withContext({ op: 'class-recurrence.create', businessId, serviceId }).error(`Failed to create recurrence rule: ${insertError.message}`);
      return NextResponse.json({ error: 'Failed to create recurrence rule' }, { status: 500 });
    }

    // Generate sessions
    await service.rpc('generate_class_sessions', { p_service_id: serviceId, p_days_ahead: 28 });

    return NextResponse.json({ data: rule }, { status: 201 });
  } catch (err) {
    logger.withContext({ op: 'class-recurrence.create' }).error(`Unexpected error: ${err}`);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── PUT: Update a recurrence rule ──

export async function PUT(request: NextRequest) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'class-recurrence-put'), 10, 60_000);
    if (rateLimit) return rateLimit;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { businessId, ruleId, weekday, startTime, staffId, locationId, capacityOverride, effectiveFrom, effectiveUntil, isActive } = body;

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

    // Verify rule belongs to this business
    const { data: existingRule } = await service
      .from('class_recurrence_rules')
      .select('id, service_id, business_id')
      .eq('id', ruleId)
      .eq('business_id', businessId)
      .single();

    if (!existingRule) return NextResponse.json({ error: 'Recurrence rule not found' }, { status: 404 });

    // Check if schedule is changing (weekday or startTime)
    const isScheduleChange = weekday !== undefined || startTime !== undefined;

    if (isScheduleChange) {
      // Check for future sessions with active bookings
      const { data: bookedSessions } = await service
        .from('class_sessions')
        .select('id, date, start_time')
        .eq('recurrence_rule_id', ruleId)
        .eq('status', 'scheduled')
        .gte('date', new Date().toISOString().split('T')[0]);

      if (bookedSessions && bookedSessions.length > 0) {
        const sessionIds = bookedSessions.map(s => s.id);
        const { count } = await service
          .from('bookings')
          .select('id', { count: 'exact', head: true })
          .in('class_session_id', sessionIds)
          .in('status', ['confirmed', 'pending', 'in_progress']);

        if ((count || 0) > 0) {
          return NextResponse.json({
            error: 'Cannot change schedule — future sessions have active bookings. Cancel or reschedule those bookings first.',
            booked_session_count: count,
          }, { status: 409 });
        }

        // Safe to remove unbooked future sessions for this rule
        await service
          .from('class_sessions')
          .delete()
          .eq('recurrence_rule_id', ruleId)
          .eq('status', 'scheduled')
          .gte('date', new Date().toISOString().split('T')[0]);
      }
    }

    // Validate staff if changing
    if (staffId !== undefined && staffId !== null) {
      const { data: staffCheck } = await service
        .from('business_staff')
        .select('id')
        .eq('id', staffId)
        .eq('business_id', businessId)
        .eq('is_active', true)
        .maybeSingle();
      if (!staffCheck) return NextResponse.json({ error: 'Staff member not found or inactive' }, { status: 400 });
    }

    // Build update payload
    const updates: Record<string, unknown> = {};
    if (weekday !== undefined) updates.weekday = weekday;
    if (startTime !== undefined) updates.start_time = startTime;
    if (staffId !== undefined) updates.staff_id = staffId || null;
    if (locationId !== undefined) updates.location_id = locationId || null;
    if (capacityOverride !== undefined) updates.capacity_override = capacityOverride || null;
    if (effectiveFrom !== undefined) updates.effective_from = effectiveFrom;
    if (effectiveUntil !== undefined) updates.effective_until = effectiveUntil || null;
    if (isActive !== undefined) updates.is_active = isActive;

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    const { data: updatedRule, error: updateError } = await service
      .from('class_recurrence_rules')
      .update(updates)
      .eq('id', ruleId)
      .select()
      .single();

    if (updateError) {
      logger.withContext({ op: 'class-recurrence.update', businessId, ruleId }).error(`Failed to update recurrence rule: ${updateError.message}`);
      return NextResponse.json({ error: 'Failed to update recurrence rule' }, { status: 500 });
    }

    // Regenerate sessions
    await service.rpc('generate_class_sessions', { p_service_id: existingRule.service_id, p_days_ahead: 28 });

    return NextResponse.json({ data: updatedRule });
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

    // Verify rule belongs to this business
    const { data: existingRule } = await service
      .from('class_recurrence_rules')
      .select('id, service_id, business_id')
      .eq('id', ruleId)
      .eq('business_id', businessId)
      .single();

    if (!existingRule) return NextResponse.json({ error: 'Recurrence rule not found' }, { status: 404 });

    // Check for future sessions with active bookings
    const { data: futureSessions } = await service
      .from('class_sessions')
      .select('id')
      .eq('recurrence_rule_id', ruleId)
      .eq('status', 'scheduled')
      .gte('date', new Date().toISOString().split('T')[0]);

    if (futureSessions && futureSessions.length > 0) {
      const sessionIds = futureSessions.map(s => s.id);
      const { count } = await service
        .from('bookings')
        .select('id', { count: 'exact', head: true })
        .in('class_session_id', sessionIds)
        .in('status', ['confirmed', 'pending', 'in_progress']);

      if ((count || 0) > 0) {
        return NextResponse.json({
          error: 'Cannot delete rule — future sessions have active bookings. Cancel those sessions first.',
          booked_session_count: count,
        }, { status: 409 });
      }

      // Delete unbooked future sessions belonging to this rule
      await service
        .from('class_sessions')
        .delete()
        .eq('recurrence_rule_id', ruleId)
        .eq('status', 'scheduled')
        .gte('date', new Date().toISOString().split('T')[0]);
    }

    const { error: deleteError } = await service
      .from('class_recurrence_rules')
      .delete()
      .eq('id', ruleId);

    if (deleteError) {
      logger.withContext({ op: 'class-recurrence.delete', businessId, ruleId }).error(`Failed to delete recurrence rule: ${deleteError.message}`);
      return NextResponse.json({ error: 'Failed to delete recurrence rule' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.withContext({ op: 'class-recurrence.delete' }).error(`Unexpected error: ${err}`);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
