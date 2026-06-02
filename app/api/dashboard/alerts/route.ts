import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

export async function GET(request: NextRequest) {
  try {
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
      .select('id, type, severity, title, message, is_read, created_at', { count: 'exact' })
      .eq('business_id', business.id)
      .eq('is_read', false)
      .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .order('created_at', { ascending: false })
      .range(from, to);

    const response = NextResponse.json({ alerts: alerts || [], total: count || 0 });
    response.headers.set('Cache-Control', 'private, max-age=30, stale-while-revalidate=60');
    return response;
  } catch (error) {
    logger.error('[ALERTS] GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Verify business ownership
    const { data: business } = await supabase
      .from('businesses')
      .select('id')
      .eq('owner_id', user.id)
      .in('status', ['active', 'pending'])
      .limit(1)
      .maybeSingle();

    if (!business) return NextResponse.json({ error: 'No business found' }, { status: 403 });

    const body = await request.json();
    const alertIds = body.alertIds as string[];

    if (!Array.isArray(alertIds) || alertIds.length === 0) {
      return NextResponse.json({ error: 'alertIds required' }, { status: 400 });
    }

    const { error } = await supabase
      .from('alerts')
      .update({ is_read: true })
      .in('id', alertIds)
      .eq('business_id', business.id);

    if (error) {
      logger.error('[ALERTS] PATCH error:', error);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[ALERTS] PATCH error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
