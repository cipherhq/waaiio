import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const businessId = searchParams.get('businessId');
    if (!businessId) {
      return NextResponse.json({ error: 'businessId required' }, { status: 400 });
    }

    // Verify ownership
    const { data: business } = await supabase
      .from('businesses')
      .select('id')
      .eq('id', businessId)
      .eq('owner_id', user.id)
      .maybeSingle();

    if (!business) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Role suggestions endpoint
    const roles = searchParams.get('roles');
    if (roles === 'true') {
      const serviceClient = createServiceClient();
      const { data: roleData } = await serviceClient
        .from('business_staff')
        .select('role')
        .eq('business_id', businessId);
      const uniqueRoles = [...new Set((roleData || []).map(r => r.role).filter(Boolean))];
      return NextResponse.json({ roles: uniqueRoles });
    }

    const serviceClient = createServiceClient();
    const { data, error } = await serviceClient
      .from('business_staff')
      .select('*')
      .eq('business_id', businessId)
      .order('name');

    if (error) {
      return NextResponse.json({ error: 'Failed to fetch staff' }, { status: 500 });
    }

    const response = NextResponse.json({ staff: data });
    response.headers.set('Cache-Control', 'private, max-age=30, stale-while-revalidate=120');
    return response;
  } catch (error) {
    logger.error('[STAFF] GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { businessId, name, phone, email, role, services, schedule, commission_rate, notes, start_date, color } = body;

    if (!businessId || !name) {
      return NextResponse.json({ error: 'businessId and name required' }, { status: 400 });
    }

    // Sanitize role — allow any alphanumeric string up to 50 chars
    if (role && (typeof role !== 'string' || role.length > 50)) {
      return NextResponse.json({ error: 'Role must be a string under 50 characters' }, { status: 400 });
    }

    // Verify ownership
    const { data: business } = await supabase
      .from('businesses')
      .select('id')
      .eq('id', businessId)
      .eq('owner_id', user.id)
      .maybeSingle();

    if (!business) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // ── Capability check: staff ──
    const { data: staffCap } = await supabase
      .from('business_capabilities')
      .select('id')
      .eq('business_id', businessId)
      .eq('capability', 'staff')
      .eq('is_enabled', true)
      .maybeSingle();
    if (!staffCap) return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });

    const serviceClient = createServiceClient();
    const { data, error } = await serviceClient
      .from('business_staff')
      .insert({
        business_id: businessId,
        name,
        phone: phone || null,
        email: email || null,
        role: role || 'Staff',
        services: services || [],
        schedule: schedule || {},
        is_active: true,
        commission_rate: commission_rate ?? null,
        notes: notes || null,
        start_date: start_date || null,
        color: color || null,
      })
      .select()
      .single();

    if (error) {
      logger.error('[STAFF] Insert error:', error);
      return NextResponse.json({ error: 'Failed to create staff member' }, { status: 500 });
    }

    return NextResponse.json({ staff: data });
  } catch (error) {
    logger.error('[STAFF] POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { staffId, businessId, name, phone, email, role, services, schedule, is_active, commission_rate, notes, start_date, color, photo_url } = body;

    if (!staffId || !businessId) {
      return NextResponse.json({ error: 'staffId and businessId required' }, { status: 400 });
    }

    // Verify ownership
    const { data: business } = await supabase
      .from('businesses')
      .select('id')
      .eq('id', businessId)
      .eq('owner_id', user.id)
      .maybeSingle();

    if (!business) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const serviceClient = createServiceClient();
    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name;
    if (phone !== undefined) updateData.phone = phone || null;
    if (email !== undefined) updateData.email = email || null;
    if (role !== undefined) updateData.role = role;
    if (services !== undefined) updateData.services = services;
    if (schedule !== undefined) updateData.schedule = schedule;
    if (is_active !== undefined) updateData.is_active = is_active;
    if (commission_rate !== undefined) updateData.commission_rate = commission_rate;
    if (notes !== undefined) updateData.notes = notes || null;
    if (start_date !== undefined) updateData.start_date = start_date || null;
    if (color !== undefined) updateData.color = color || null;
    if (photo_url !== undefined) updateData.photo_url = photo_url;

    const { error } = await serviceClient
      .from('business_staff')
      .update(updateData)
      .eq('id', staffId)
      .eq('business_id', businessId);

    if (error) {
      logger.error('[STAFF] Update error:', error);
      return NextResponse.json({ error: 'Failed to update staff member' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[STAFF] PUT error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { staffId, businessId } = body;

    if (!staffId || !businessId) {
      return NextResponse.json({ error: 'staffId and businessId required' }, { status: 400 });
    }

    // Verify ownership
    const { data: business } = await supabase
      .from('businesses')
      .select('id')
      .eq('id', businessId)
      .eq('owner_id', user.id)
      .maybeSingle();

    if (!business) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const serviceClient = createServiceClient();
    const { error } = await serviceClient
      .from('business_staff')
      .delete()
      .eq('id', staffId)
      .eq('business_id', businessId);

    if (error) {
      logger.error('[STAFF] Delete error:', error);
      return NextResponse.json({ error: 'Failed to delete staff member' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[STAFF] DELETE error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
