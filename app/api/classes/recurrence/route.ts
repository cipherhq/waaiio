import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

// ── GET: List recurrence rules for a service ──

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

    // Capability guard: class_booking / read_history (reading rules is always allowed)
    const service = createServiceClient();
    const guard = await requireCapability(supabase, service, {
      businessId, userId: user.id, capability: 'class_booking' as never, action: 'read_history',
    });
    if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

    let query = service
      .from('class_recurrence_rules')
      .select('*, services!inner(id, name, business_id)')
      .eq('services.business_id', businessId)
      .order('created_at', { ascending: false });

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
    const { businessId, serviceId, dayOfWeek, startTime, endTime, instructorName, capacity } = body;

    if (!businessId || !serviceId || dayOfWeek === undefined || !startTime) {
      return NextResponse.json({ error: 'businessId, serviceId, dayOfWeek, and startTime are required' }, { status: 400 });
    }

    // Capability guard: class_booking / create_new
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

    if (!svc) {
      return NextResponse.json({ error: 'Service not found or does not belong to this business' }, { status: 404 });
    }
    if (!svc.is_class) {
      return NextResponse.json({ error: 'Service is not configured as a class' }, { status: 400 });
    }

    // Insert the recurrence rule
    const { data: rule, error: insertError } = await service
      .from('class_recurrence_rules')
      .insert({
        service_id: serviceId,
        day_of_week: dayOfWeek,
        start_time: startTime,
        end_time: endTime || null,
        instructor_name: instructorName || null,
        capacity: capacity || null,
      })
      .select()
      .single();

    if (insertError) {
      logger.withContext({ op: 'class-recurrence.create', businessId, serviceId }).error(`Failed to create recurrence rule: ${insertError.message}`);
      return NextResponse.json({ error: 'Failed to create recurrence rule' }, { status: 500 });
    }

    // Regenerate sessions for the next 30 days
    const { error: rpcError } = await service.rpc('generate_class_sessions', {
      p_service_id: serviceId,
      p_days_ahead: 30,
    });

    if (rpcError) {
      logger.withContext({ op: 'class-recurrence.generate', businessId, serviceId }).error(`Session generation failed after rule creation: ${rpcError.message}`);
      // Rule was created successfully, but session generation failed — not a fatal error
    }

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
    const { businessId, ruleId, dayOfWeek, startTime, endTime, instructorName, capacity } = body;

    if (!businessId || !ruleId) {
      return NextResponse.json({ error: 'businessId and ruleId are required' }, { status: 400 });
    }

    // Capability guard: class_booking / manage_existing
    const service = createServiceClient();
    const guard = await requireCapability(supabase, service, {
      businessId, userId: user.id, capability: 'class_booking' as never, action: 'manage_existing',
    });
    if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

    // Verify the rule belongs to a service owned by this business
    const { data: existingRule } = await service
      .from('class_recurrence_rules')
      .select('id, service_id, services!inner(business_id)')
      .eq('id', ruleId)
      .single();

    if (!existingRule) {
      return NextResponse.json({ error: 'Recurrence rule not found' }, { status: 404 });
    }

    const ruleServices = (existingRule as unknown as { services: { business_id: string }[] }).services;
    const ruleBizId = ruleServices[0]?.business_id;
    if (ruleBizId !== businessId) {
      return NextResponse.json({ error: 'Rule does not belong to this business' }, { status: 403 });
    }

    // Build update payload — only include provided fields
    const updates: Record<string, unknown> = {};
    if (dayOfWeek !== undefined) updates.day_of_week = dayOfWeek;
    if (startTime !== undefined) updates.start_time = startTime;
    if (endTime !== undefined) updates.end_time = endTime;
    if (instructorName !== undefined) updates.instructor_name = instructorName;
    if (capacity !== undefined) updates.capacity = capacity;

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

    // Regenerate sessions to reflect the updated schedule
    const { error: rpcError } = await service.rpc('generate_class_sessions', {
      p_service_id: existingRule.service_id,
      p_days_ahead: 30,
    });

    if (rpcError) {
      logger.withContext({ op: 'class-recurrence.generate', businessId }).error(`Session generation failed after rule update: ${rpcError.message}`);
    }

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

    // Capability guard: class_booking / manage_existing
    const service = createServiceClient();
    const guard = await requireCapability(supabase, service, {
      businessId, userId: user.id, capability: 'class_booking' as never, action: 'manage_existing',
    });
    if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

    // Verify ownership
    const { data: existingRule } = await service
      .from('class_recurrence_rules')
      .select('id, service_id, services!inner(business_id)')
      .eq('id', ruleId)
      .single();

    if (!existingRule) {
      return NextResponse.json({ error: 'Recurrence rule not found' }, { status: 404 });
    }

    const delRuleServices = (existingRule as unknown as { services: { business_id: string }[] }).services;
    const ruleBizId = delRuleServices[0]?.business_id;
    if (ruleBizId !== businessId) {
      return NextResponse.json({ error: 'Rule does not belong to this business' }, { status: 403 });
    }

    const { error: deleteError } = await service
      .from('class_recurrence_rules')
      .delete()
      .eq('id', ruleId);

    if (deleteError) {
      logger.withContext({ op: 'class-recurrence.delete', businessId, ruleId }).error(`Failed to delete recurrence rule: ${deleteError.message}`);
      return NextResponse.json({ error: 'Failed to delete recurrence rule' }, { status: 500 });
    }

    // Regenerate sessions (removes orphaned future sessions)
    const { error: rpcError } = await service.rpc('generate_class_sessions', {
      p_service_id: existingRule.service_id,
      p_days_ahead: 30,
    });

    if (rpcError) {
      logger.withContext({ op: 'class-recurrence.generate', businessId }).error(`Session generation failed after rule deletion: ${rpcError.message}`);
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.withContext({ op: 'class-recurrence.delete' }).error(`Unexpected error: ${err}`);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
