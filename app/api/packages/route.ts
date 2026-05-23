import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const businessId = request.nextUrl.searchParams.get('business_id');
  if (!businessId) return NextResponse.json({ error: 'Missing business_id' }, { status: 400 });

  const { data, error } = await supabase
    .from('service_packages')
    .select('*')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: 'Failed to fetch packages' }, { status: 500 });
  return NextResponse.json({ packages: data });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { business_id, name, description, price, num_sessions, service_ids, valid_days } = body;

  if (!business_id || !name || !price || !num_sessions) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  // Verify ownership
  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', business_id)
    .eq('owner_id', user.id)
    .single();

  if (!biz) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { data, error } = await supabase
    .from('service_packages')
    .insert({
      business_id,
      name: name.trim(),
      description: description?.trim() || null,
      price: Math.max(0, Number(price)),
      num_sessions: Math.max(1, Number(num_sessions)),
      service_ids: service_ids || [],
      valid_days: valid_days ? Math.max(1, Number(valid_days)) : 365,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: 'Failed to create package' }, { status: 500 });
  return NextResponse.json({ package: data });
}

export async function PUT(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { id, business_id, ...updates } = body;

  if (!id || !business_id) {
    return NextResponse.json({ error: 'Missing id or business_id' }, { status: 400 });
  }

  // Verify ownership
  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', business_id)
    .eq('owner_id', user.id)
    .single();

  if (!biz) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // Only allow specific fields to be updated
  const safeUpdates: Record<string, unknown> = {};
  if (updates.name !== undefined) safeUpdates.name = String(updates.name).trim();
  if (updates.description !== undefined) safeUpdates.description = updates.description?.trim() || null;
  if (updates.price !== undefined) safeUpdates.price = Math.max(0, Number(updates.price));
  if (updates.num_sessions !== undefined) safeUpdates.num_sessions = Math.max(1, Number(updates.num_sessions));
  if (updates.service_ids !== undefined) safeUpdates.service_ids = updates.service_ids;
  if (updates.valid_days !== undefined) safeUpdates.valid_days = Math.max(1, Number(updates.valid_days));
  if (updates.is_active !== undefined) safeUpdates.is_active = Boolean(updates.is_active);

  const { data, error } = await supabase
    .from('service_packages')
    .update(safeUpdates)
    .eq('id', id)
    .eq('business_id', business_id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: 'Failed to update package' }, { status: 500 });
  return NextResponse.json({ package: data });
}
