import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

async function requireAdminOrFinance(supabase: any): Promise<{ user: any } | { error: string; status: number }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Unauthorized', status: 401 };

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || !['admin', 'finance'].includes(profile.role)) {
    return { error: 'Admin or Finance role required', status: 403 };
  }
  return { user };
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const auth = await requireAdminOrFinance(supabase);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const params = request.nextUrl.searchParams;
  const page = Math.max(1, parseInt(params.get('page') || '1'));
  const status = params.get('status') || 'all';
  const businessId = params.get('business_id');
  const perPage = 20;

  let query = supabase
    .from('business_payouts')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((page - 1) * perPage, page * perPage - 1);

  if (status !== 'all') {
    query = query.eq('status', status);
  }
  if (businessId) {
    query = query.eq('business_id', businessId);
  }

  const { data, count, error } = await query;

  if (error) {
    return NextResponse.json({ error: 'Failed to fetch payouts' }, { status: 500 });
  }

  return NextResponse.json({
    payouts: data || [],
    total: count || 0,
    page,
    per_page: perPage,
    total_pages: Math.ceil((count || 0) / perPage),
  });
}
