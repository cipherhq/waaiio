import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: business } = await supabase
    .from('businesses')
    .select('id')
    .eq('owner_id', user.id)
    .in('status', ['active', 'pending'])
    .limit(1)
    .maybeSingle();

  if (!business) return NextResponse.json({ alerts: [] });

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get('page') || '1');
  const perPage = 20;
  const from = (page - 1) * perPage;
  const to = from + perPage - 1;

  const { data: alerts, count } = await supabase
    .from('alerts')
    .select('*', { count: 'exact' })
    .eq('business_id', business.id)
    .order('created_at', { ascending: false })
    .range(from, to);

  return NextResponse.json({ alerts: alerts || [], total: count || 0 });
}

export async function PATCH(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const alertIds = body.alertIds as string[];

  if (!Array.isArray(alertIds) || alertIds.length === 0) {
    return NextResponse.json({ error: 'alertIds required' }, { status: 400 });
  }

  await supabase
    .from('alerts')
    .update({ is_read: true })
    .in('id', alertIds);

  return NextResponse.json({ success: true });
}
