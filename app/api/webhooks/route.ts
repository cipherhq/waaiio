import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { randomBytes } from 'crypto';

async function authenticateAndVerifyOwnership(businessId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  const { data: business } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', businessId)
    .eq('owner_id', user.id)
    .maybeSingle();

  if (!business) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  return { user, business };
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const businessId = searchParams.get('businessId');
    if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });

    const auth = await authenticateAndVerifyOwnership(businessId);
    if ('error' in auth) return auth.error;

    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from('webhook_endpoints')
      .select('*, webhook_deliveries(id, event_type, success, attempted_at)')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false });

    if (error) return NextResponse.json({ error: 'Failed to fetch webhooks' }, { status: 500 });
    return NextResponse.json({ endpoints: data });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { businessId, url, events } = body;
    if (!businessId || !url || !events?.length) {
      return NextResponse.json({ error: 'businessId, url, and events required' }, { status: 400 });
    }

    const auth = await authenticateAndVerifyOwnership(businessId);
    if ('error' in auth) return auth.error;

    const secret = randomBytes(32).toString('hex');

    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from('webhook_endpoints')
      .insert({
        business_id: businessId,
        url,
        secret,
        events,
        is_active: true,
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: 'Failed to create webhook' }, { status: 500 });
    return NextResponse.json({ endpoint: data });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, businessId, url, events, isActive } = body;
    if (!id || !businessId) return NextResponse.json({ error: 'id and businessId required' }, { status: 400 });

    const auth = await authenticateAndVerifyOwnership(businessId);
    if ('error' in auth) return auth.error;

    const supabase = createServiceClient();
    const updateData: Record<string, unknown> = {};
    if (url !== undefined) updateData.url = url;
    if (events !== undefined) updateData.events = events;
    if (isActive !== undefined) updateData.is_active = isActive;

    const { error } = await supabase.from('webhook_endpoints').update(updateData).eq('id', id).eq('business_id', businessId);
    if (error) return NextResponse.json({ error: 'Failed to update' }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    const businessId = searchParams.get('businessId');
    if (!id || !businessId) return NextResponse.json({ error: 'id and businessId required' }, { status: 400 });

    const auth = await authenticateAndVerifyOwnership(businessId);
    if ('error' in auth) return auth.error;

    const supabase = createServiceClient();
    await supabase.from('webhook_endpoints').delete().eq('id', id).eq('business_id', businessId);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
