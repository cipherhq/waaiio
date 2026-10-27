import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { logAdminAudit } from '@/lib/admin-audit';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET — list seating resources for a business (admin read) */
export async function GET(request: NextRequest) {
  const admin = await requirePlatformAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const businessId = request.nextUrl.searchParams.get('businessId');
  if (!businessId || !UUID_RE.test(businessId)) {
    return NextResponse.json({ error: 'Valid businessId required' }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('seating_resources')
    .select('*')
    .eq('business_id', businessId)
    .order('sort_order')
    .order('name');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

/** POST — create seating resource for a business (admin write) */
export async function POST(request: NextRequest) {
  const admin = await requirePlatformAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  if (admin.role !== 'admin') return NextResponse.json({ error: 'Admin role required' }, { status: 403 });

  const body = await request.json();
  const { businessId, name, resource_type, capacity, min_party_size, section,
          reservation_duration_minutes, deposit_amount, description,
          available_days, available_from, available_to } = body;

  if (!businessId || !UUID_RE.test(businessId) || !name?.trim()) {
    return NextResponse.json({ error: 'businessId and name required' }, { status: 400 });
  }

  const supabase = createServiceClient();

  // Verify business exists
  const { data: biz } = await supabase.from('businesses').select('id').eq('id', businessId).maybeSingle();
  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

  const { data, error } = await supabase
    .from('seating_resources')
    .insert({
      business_id: businessId,
      name: name.trim(),
      resource_type: resource_type || 'table',
      capacity: capacity || 4,
      min_party_size: min_party_size || 1,
      section: section?.trim() || null,
      reservation_duration_minutes: reservation_duration_minutes || 90,
      deposit_amount: deposit_amount || 0,
      description: description?.trim() || null,
      available_days: available_days?.length > 0 ? available_days : null,
      available_from: available_from || null,
      available_to: available_to || null,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAdminAudit({
    actorId: admin.userId,
    action: 'create_seating_resource',
    entityType: 'seating_resource',
    entityId: data.id,
    details: { businessId, name: name.trim(), resource_type },
  });

  return NextResponse.json({ data }, { status: 201 });
}

/** PATCH — update seating resource (admin write) */
export async function PATCH(request: NextRequest) {
  const admin = await requirePlatformAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  if (admin.role !== 'admin') return NextResponse.json({ error: 'Admin role required' }, { status: 403 });

  const body = await request.json();
  const { id, ...updates } = body;

  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Valid id required' }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('seating_resources')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAdminAudit({
    actorId: admin.userId,
    action: 'update_seating_resource',
    entityType: 'seating_resource',
    entityId: id,
    details: { updates: Object.keys(updates) },
  });

  return NextResponse.json({ data });
}
