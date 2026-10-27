import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * Seating Resources CRUD API
 *
 * GET: List seating resources for the authenticated business
 * POST: Create a new seating resource
 * PATCH: Update a seating resource
 */

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const businessId = request.nextUrl.searchParams.get('businessId');
    if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });

    // RLS enforces owner check
    const { data, error } = await supabase
      .from('seating_resources')
      .select('*')
      .eq('business_id', businessId)
      .order('sort_order')
      .order('name');

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data });
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { businessId, name, resource_type, capacity, min_party_size, section,
            reservation_duration_minutes, deposit_amount, description,
            available_days, available_from, available_to } = body;

    if (!businessId || !name?.trim()) {
      return NextResponse.json({ error: 'businessId and name are required' }, { status: 400 });
    }

    // RLS enforces ownership
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
    return NextResponse.json({ data }, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { id, ...updates } = body;

    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

    // RLS enforces ownership
    const { data, error } = await supabase
      .from('seating_resources')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data });
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
