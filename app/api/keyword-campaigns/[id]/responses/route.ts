import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Load campaign to verify ownership
  const { data: campaign } = await supabase
    .from('keyword_campaigns')
    .select('business_id, name, keyword')
    .eq('id', id)
    .single();
  if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });

  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', campaign.business_id)
    .eq('owner_id', user.id)
    .single();
  if (!biz) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  // Pagination
  const page = parseInt(request.nextUrl.searchParams.get('page') || '1', 10);
  const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '50', 10), 200);
  const offset = (page - 1) * limit;
  const format = request.nextUrl.searchParams.get('format');

  // Get total count
  const { count: totalCount } = await supabase
    .from('keyword_campaign_responses')
    .select('*', { count: 'exact', head: true })
    .eq('campaign_id', id);

  // If CSV export, fetch all (up to 10k)
  if (format === 'csv') {
    const { data: allResponses, error } = await supabase
      .from('keyword_campaign_responses')
      .select('phone, customer_name, responded_at')
      .eq('campaign_id', id)
      .order('responded_at', { ascending: false })
      .limit(10000);

    if (error) {
      logger.error('[KEYWORD_CAMPAIGNS] CSV export error:', error.message);
      return NextResponse.json({ error: 'Export failed' }, { status: 500 });
    }

    const rows = allResponses || [];
    const csvHeader = 'phone,customer_name,responded_at';
    const csvRows = rows.map((r) => {
      const name = (r.customer_name || '').replace(/"/g, '""');
      return `${r.phone},"${name}",${r.responded_at}`;
    });
    const csv = [csvHeader, ...csvRows].join('\n');

    const filename = `${campaign.name.replace(/[^a-zA-Z0-9]/g, '_')}_responses.csv`;
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  }

  // Paginated JSON response
  const { data: responses, error } = await supabase
    .from('keyword_campaign_responses')
    .select('*')
    .eq('campaign_id', id)
    .order('responded_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    logger.error('[KEYWORD_CAMPAIGNS] Responses list error:', error.message);
    return NextResponse.json({ error: 'Failed to fetch responses' }, { status: 500 });
  }

  return NextResponse.json({
    responses: responses || [],
    pagination: {
      page,
      limit,
      total: totalCount || 0,
      total_pages: Math.ceil((totalCount || 0) / limit),
    },
  });
}
