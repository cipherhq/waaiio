import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

type RouteContext = { params: Promise<{ id: string }> };

// ── GET: Fetch a single class with recurrence rules ──

export async function GET(request: NextRequest, ctx: RouteContext) {
  try {
    const { id } = await ctx.params;
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'class-get'), 30, 60_000);
    if (rateLimit) return rateLimit;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const service = createServiceClient();

    // Fetch the class (service with is_class=true)
    const { data: cls, error: clsError } = await service
      .from('services')
      .select('id, business_id, name, description, price, duration_minutes, max_capacity, is_active, is_class, deleted_at')
      .eq('id', id)
      .eq('is_class', true)
      .is('deleted_at', null)
      .single();

    if (clsError || !cls) {
      return NextResponse.json({ error: 'Class not found' }, { status: 404 });
    }

    const guard = await requireCapability(supabase, service, {
      businessId: cls.business_id, userId: user.id, capability: 'class_booking' as never, action: 'read_history',
    });
    if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

    // Fetch recurrence rules
    const { data: rules } = await service
      .from('class_recurrence_rules')
      .select('*, business_staff(id, name)')
      .eq('service_id', id)
      .order('weekday')
      .order('start_time');

    return NextResponse.json({ data: { ...cls, recurrence_rules: rules || [] } });
  } catch (err) {
    logger.withContext({ op: 'class.get' }).error(`Unexpected error: ${err}`);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── PATCH: Update a class (service fields + optionally archive) ──

export async function PATCH(request: NextRequest, ctx: RouteContext) {
  try {
    const { id } = await ctx.params;
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'class-patch'), 10, 60_000);
    if (rateLimit) return rateLimit;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { name, description, price, durationMinutes, maxCapacity, isActive } = body;

    const service = createServiceClient();

    // Verify class exists and belongs to user's business
    const { data: cls, error: clsError } = await service
      .from('services')
      .select('id, business_id, is_class, is_active, deleted_at')
      .eq('id', id)
      .eq('is_class', true)
      .is('deleted_at', null)
      .single();

    if (clsError || !cls) {
      return NextResponse.json({ error: 'Class not found' }, { status: 404 });
    }

    const guard = await requireCapability(supabase, service, {
      businessId: cls.business_id, userId: user.id, capability: 'class_booking' as never, action: 'manage_existing',
    });
    if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

    // Build update payload — only include provided fields
    const update: Record<string, unknown> = {};
    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        return NextResponse.json({ error: 'Name cannot be empty' }, { status: 400 });
      }
      update.name = name.trim();
    }
    if (description !== undefined) update.description = description?.trim() || null;
    if (price !== undefined) {
      if (typeof price !== 'number' || price < 0) {
        return NextResponse.json({ error: 'Price must be a non-negative number' }, { status: 400 });
      }
      update.price = price;
    }
    if (durationMinutes !== undefined) {
      if (typeof durationMinutes !== 'number' || durationMinutes < 1) {
        return NextResponse.json({ error: 'Duration must be at least 1 minute' }, { status: 400 });
      }
      update.duration_minutes = durationMinutes;
    }
    if (maxCapacity !== undefined) {
      if (typeof maxCapacity !== 'number' || maxCapacity < 1) {
        return NextResponse.json({ error: 'Capacity must be at least 1' }, { status: 400 });
      }
      update.max_capacity = maxCapacity;
    }
    if (isActive !== undefined) {
      update.is_active = Boolean(isActive);
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    // Perform the update
    const { error: updateError } = await service
      .from('services')
      .update(update)
      .eq('id', id);

    if (updateError) {
      logger.withContext({ op: 'class.update', classId: id }).error(`Update failed: ${updateError.message}`);
      return NextResponse.json({ error: 'Failed to update class' }, { status: 500 });
    }

    // If archiving (isActive = false), deactivate all recurrence rules
    // so no new sessions are generated
    if (isActive === false && cls.is_active === true) {
      await service
        .from('class_recurrence_rules')
        .update({ is_active: false })
        .eq('service_id', id);

      logger.withContext({ op: 'class.archive', classId: id }).info('Class archived, recurrence rules deactivated');
    }

    // If reactivating, log it (rules remain deactivated — owner must manually reactivate schedules)
    if (isActive === true && cls.is_active === false) {
      logger.withContext({ op: 'class.reactivate', classId: id }).info('Class reactivated — recurrence rules remain as-is');
    }

    // Fetch updated class
    const { data: updated } = await service
      .from('services')
      .select('id, business_id, name, description, price, duration_minutes, max_capacity, is_active, is_class')
      .eq('id', id)
      .single();

    return NextResponse.json({ data: updated });
  } catch (err) {
    logger.withContext({ op: 'class.update' }).error(`Unexpected error: ${err}`);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── DELETE: Hard-delete class only if no booking/session history ──

export async function DELETE(request: NextRequest, ctx: RouteContext) {
  try {
    const { id } = await ctx.params;
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'class-delete'), 5, 60_000);
    if (rateLimit) return rateLimit;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const service = createServiceClient();

    // Verify class exists and belongs to user's business
    const { data: cls, error: clsError } = await service
      .from('services')
      .select('id, business_id, is_class, deleted_at')
      .eq('id', id)
      .eq('is_class', true)
      .is('deleted_at', null)
      .single();

    if (clsError || !cls) {
      return NextResponse.json({ error: 'Class not found' }, { status: 404 });
    }

    const guard = await requireCapability(supabase, service, {
      businessId: cls.business_id, userId: user.id, capability: 'class_booking' as never, action: 'manage_existing',
    });
    if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

    // Check for any bookings tied to this class's sessions
    const { count: bookingCount } = await service
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('service_id', id);

    if (bookingCount && bookingCount > 0) {
      return NextResponse.json({
        error: 'Cannot delete this class — it has booking history. Archive it instead to preserve records.',
        bookingCount,
      }, { status: 409 });
    }

    // Check for any sessions with attendees (via class_sessions)
    const { data: sessionIds } = await service
      .from('class_sessions')
      .select('id')
      .eq('service_id', id);

    if (sessionIds && sessionIds.length > 0) {
      const ids = sessionIds.map(s => s.id);
      const { count: sessionBookingCount } = await service
        .from('bookings')
        .select('id', { count: 'exact', head: true })
        .in('class_session_id', ids);

      if (sessionBookingCount && sessionBookingCount > 0) {
        return NextResponse.json({
          error: 'Cannot delete this class — sessions have booking history. Archive it instead.',
          bookingCount: sessionBookingCount,
        }, { status: 409 });
      }
    }

    // Safe to soft-delete (matches existing services pattern)
    const { error: deleteError } = await service
      .from('services')
      .update({ deleted_at: new Date().toISOString(), is_active: false })
      .eq('id', id);

    if (deleteError) {
      logger.withContext({ op: 'class.delete', classId: id }).error(`Delete failed: ${deleteError.message}`);
      return NextResponse.json({ error: 'Failed to delete class' }, { status: 500 });
    }

    // Clean up: deactivate recurrence rules
    await service
      .from('class_recurrence_rules')
      .update({ is_active: false })
      .eq('service_id', id);

    // Clean up: cancel future unbooked scheduled sessions
    if (sessionIds && sessionIds.length > 0) {
      await service
        .from('class_sessions')
        .update({ status: 'cancelled', cancellation_reason: 'Class deleted' })
        .eq('service_id', id)
        .eq('status', 'scheduled')
        .gte('date', new Date().toISOString().split('T')[0]);
    }

    logger.withContext({ op: 'class.delete', classId: id }).info('Class soft-deleted');
    return NextResponse.json({ success: true });
  } catch (err) {
    logger.withContext({ op: 'class.delete' }).error(`Unexpected error: ${err}`);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
