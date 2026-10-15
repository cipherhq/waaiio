/**
 * GET  /api/engage/segments — List segments for a business
 * POST /api/engage/segments — Create a new segment
 *
 * Authorization via requireCapabilityWithRole(broadcast, action, roles).
 * All DB access through service client after authorization.
 * created_by set from authenticated user context, never request JSON.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapabilityWithRole } from '@/lib/capabilities/api-guard';
import { validateAudienceExpression } from '@/lib/engage/audience-dsl';

export async function GET(request: NextRequest) {
  try {
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

    const { data: segments, error } = await service
      .from('engage_segments')
      .select('id, name, description, expression, is_dynamic, created_by, created_at, updated_at')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[engage/segments] list error:', error);
      return NextResponse.json({ error: 'Failed to load segments' }, { status: 500 });
    }

    return NextResponse.json({ success: true, segments: segments || [] });
  } catch (err) {
    console.error('[engage/segments] GET error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
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
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (!expression) {
      return NextResponse.json({ error: 'expression is required' }, { status: 400 });
    }

    // Validate DSL
    const validation = validateAudienceExpression(expression);
    if (!validation.valid) {
      return NextResponse.json(
        { error: 'invalid_expression', details: validation.errors },
        { status: 400 },
      );
    }

    const service = createServiceClient();
    const guard = await requireCapabilityWithRole(service, {
      businessId,
      userId: user.id,
      capability: 'broadcast',
      action: 'create_new',
      allowedRoles: ['owner', 'admin'],
    });

    if (!guard.allowed) {
      return NextResponse.json(guard.denial, { status: guard.status });
    }

    // created_by from auth context, never request body
    const { data: segment, error } = await service
      .from('engage_segments')
      .insert({
        business_id: businessId,
        name: name.trim(),
        description: description?.trim() || null,
        expression,
        is_dynamic: true,
        created_by: user.id,
      })
      .select()
      .single();

    if (error) {
      console.error('[engage/segments] create error:', error);
      return NextResponse.json({ error: 'Failed to create segment' }, { status: 500 });
    }

    return NextResponse.json({ success: true, segment }, { status: 201 });
  } catch (err) {
    console.error('[engage/segments] POST error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
