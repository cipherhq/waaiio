/**
 * GET    /api/engage/segments/[id] — Get a single segment
 * PUT    /api/engage/segments/[id] — Update a segment
 * DELETE /api/engage/segments/[id] — Delete a segment
 *
 * Authorization via requireCapabilityWithRole(broadcast, action, roles).
 * All DB access through service client after authorization.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapabilityWithRole } from '@/lib/capabilities/api-guard';
import { validateAudienceExpression } from '@/lib/engage/audience-dsl';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const businessId = searchParams.get('businessId');

    if (!businessId) {
      return NextResponse.json({ error: 'businessId is required' }, { status: 400 });
    }

    const service = createServiceClient();
    const guard = await requireCapabilityWithRole(service, {
      businessId,
      userId: user.id,
      capability: 'broadcast',
      action: 'read_history',
      allowedRoles: ['owner', 'admin', 'manager'],
    });

    if (!guard.allowed) {
      return NextResponse.json(guard.denial, { status: guard.status });
    }

    const { data: segment, error } = await service
      .from('engage_segments')
      .select('*')
      .eq('id', id)
      .eq('business_id', businessId)
      .maybeSingle();

    if (error) {
      console.error('[engage/segments/[id]] get error:', error);
      return NextResponse.json({ error: 'Failed to load segment' }, { status: 500 });
    }

    if (!segment) {
      return NextResponse.json({ error: 'Segment not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, segment });
  } catch (err) {
    console.error('[engage/segments/[id]] GET error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { businessId, name, description, expression } = body;

    if (!businessId || typeof businessId !== 'string') {
      return NextResponse.json({ error: 'businessId is required' }, { status: 400 });
    }

    const service = createServiceClient();
    const guard = await requireCapabilityWithRole(service, {
      businessId,
      userId: user.id,
      capability: 'broadcast',
      action: 'manage_existing',
      allowedRoles: ['owner', 'admin'],
    });

    if (!guard.allowed) {
      return NextResponse.json(guard.denial, { status: guard.status });
    }

    // Build update payload
    const updates: Record<string, unknown> = {};
    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        return NextResponse.json({ error: 'name must be a non-empty string' }, { status: 400 });
      }
      updates.name = name.trim();
    }
    if (description !== undefined) {
      updates.description = description?.trim() || null;
    }
    if (expression !== undefined) {
      const validation = validateAudienceExpression(expression);
      if (!validation.valid) {
        return NextResponse.json(
          { error: 'invalid_expression', details: validation.errors },
          { status: 400 },
        );
      }
      updates.expression = expression;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    const { data: segment, error } = await service
      .from('engage_segments')
      .update(updates)
      .eq('id', id)
      .eq('business_id', businessId)
      .select()
      .maybeSingle();

    if (error) {
      console.error('[engage/segments/[id]] update error:', error);
      return NextResponse.json({ error: 'Failed to update segment' }, { status: 500 });
    }

    if (!segment) {
      return NextResponse.json({ error: 'Segment not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, segment });
  } catch (err) {
    console.error('[engage/segments/[id]] PUT error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const businessId = searchParams.get('businessId');

    if (!businessId) {
      return NextResponse.json({ error: 'businessId is required' }, { status: 400 });
    }

    const service = createServiceClient();
    const guard = await requireCapabilityWithRole(service, {
      businessId,
      userId: user.id,
      capability: 'broadcast',
      action: 'manage_existing',
      allowedRoles: ['owner', 'admin'],
    });

    if (!guard.allowed) {
      return NextResponse.json(guard.denial, { status: guard.status });
    }

    const { error, count } = await service
      .from('engage_segments')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('business_id', businessId);

    if (error) {
      console.error('[engage/segments/[id]] delete error:', error);
      return NextResponse.json({ error: 'Failed to delete segment' }, { status: 500 });
    }

    if (count === 0) {
      return NextResponse.json({ error: 'Segment not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[engage/segments/[id]] DELETE error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
