import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const businessId = searchParams.get('businessId');
    if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });

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
    const { data, error } = await serviceClient
      .from('business_locations')
      .select('*')
      .eq('business_id', businessId)
      .order('is_primary', { ascending: false });

    if (error) return NextResponse.json({ error: 'Failed to fetch locations' }, { status: 500 });
    return NextResponse.json({ locations: data });
  } catch {
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
    const { businessId, name, address, city, phone, operatingHours, isPrimary } = body;
    if (!businessId || !name || !address) {
      return NextResponse.json({ error: 'businessId, name, and address required' }, { status: 400 });
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

    // If setting as primary, unset existing primary
    if (isPrimary) {
      await serviceClient.from('business_locations').update({ is_primary: false }).eq('business_id', businessId);
    }

    const { data, error } = await serviceClient
      .from('business_locations')
      .insert({
        business_id: businessId,
        name,
        address,
        city: city || null,
        phone: phone || null,
        operating_hours: operatingHours || {},
        is_primary: isPrimary || false,
        is_active: true,
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: 'Failed to create location' }, { status: 500 });
    return NextResponse.json({ location: data });
  } catch {
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
    const { id, businessId, ...updates } = body;
    if (!id || !businessId) return NextResponse.json({ error: 'id and businessId required' }, { status: 400 });

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
    if (updates.name !== undefined) updateData.name = updates.name;
    if (updates.address !== undefined) updateData.address = updates.address;
    if (updates.city !== undefined) updateData.city = updates.city;
    if (updates.phone !== undefined) updateData.phone = updates.phone;
    if (updates.operatingHours !== undefined) updateData.operating_hours = updates.operatingHours;
    if (updates.isActive !== undefined) updateData.is_active = updates.isActive;
    if (updates.isPrimary !== undefined) {
      if (updates.isPrimary) {
        await serviceClient.from('business_locations').update({ is_primary: false }).eq('business_id', businessId);
      }
      updateData.is_primary = updates.isPrimary;
    }

    const { error } = await serviceClient.from('business_locations').update(updateData).eq('id', id).eq('business_id', businessId);
    if (error) return NextResponse.json({ error: 'Failed to update' }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch {
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

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    const businessId = searchParams.get('businessId');
    if (!id || !businessId) return NextResponse.json({ error: 'id and businessId required' }, { status: 400 });

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
    await serviceClient.from('business_locations').delete().eq('id', id).eq('business_id', businessId);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
