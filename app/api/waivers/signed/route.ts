import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';
import { logger } from '@/lib/logger';

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = request.nextUrl;
    const businessId = searchParams.get('business_id');
    const templateId = searchParams.get('template_id');
    const search = searchParams.get('search');
    const from = searchParams.get('from');
    const to = searchParams.get('to');

    if (!businessId) {
      return NextResponse.json({ error: 'business_id required' }, { status: 400 });
    }

    let query = supabase
      .from('signed_waivers')
      .select('*, waiver_templates!inner(title, token)')
      .eq('business_id', businessId)
      .order('signed_at', { ascending: false });

    if (templateId) {
      query = query.eq('template_id', templateId);
    }

    if (search) {
      const safe = sanitizeFilterValue(search);
      query = query.or(`customer_name.ilike.%${safe}%,customer_phone.ilike.%${safe}%,customer_email.ilike.%${safe}%`);
    }

    if (from) {
      query = query.gte('signed_at', from);
    }

    if (to) {
      query = query.lte('signed_at', to);
    }

    const { data, error } = await query.limit(200);

    if (error) {
      logger.error('Failed to fetch signed waivers:', error);
      return NextResponse.json({ error: 'Failed to fetch signed waivers' }, { status: 500 });
    }

    return NextResponse.json(data || []);
  } catch (err) {
    logger.error('Signed waivers GET error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
