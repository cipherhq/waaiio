import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requirePlatformAdmin } from '@/lib/admin-auth';

export const dynamic = 'force-dynamic';

// Safe columns for payout list response — excludes claim_token, provider_idempotency_key
const PAYOUT_LIST_COLUMNS = [
  'id', 'business_id', 'period_start', 'period_end',
  'gross_amount', 'platform_fee', 'gateway_fee', 'net_amount',
  'status', 'flags', 'payout_account_id', 'transfer_method',
  'approved_by', 'approved_at', 'rejected_reason',
  'gateway_transfer_code', 'transfer_reference',
  'paid_at', 'notes', 'created_at', 'updated_at',
  'businesses(name, country_code)',
].join(', ');

export async function GET(request: NextRequest) {
  const admin = await requirePlatformAdmin(request, { requiredRole: ['admin', 'finance'] });
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const service = createServiceClient();

  const params = request.nextUrl.searchParams;
  const page = Math.max(1, parseInt(params.get('page') || '1'));
  const status = params.get('status') || 'all';
  const businessId = params.get('business_id');
  const search = params.get('search') || '';
  const dateFrom = params.get('date_from') || '';
  const dateTo = params.get('date_to') || '';
  const perPage = 20;

  let query = service
    .from('business_payouts')
    .select(PAYOUT_LIST_COLUMNS, { count: 'exact' })
    .order('created_at', { ascending: false });

  if (status !== 'all') {
    query = query.eq('status', status);
  }
  if (businessId) {
    query = query.eq('business_id', businessId);
  }
  if (dateFrom) {
    query = query.gte('created_at', dateFrom);
  }
  if (dateTo) {
    query = query.lte('created_at', dateTo + 'T23:59:59');
  }

  // Apply pagination
  query = query.range((page - 1) * perPage, page * perPage - 1);

  const { data, count, error } = await query;

  if (error) {
    return NextResponse.json({ error: 'Failed to fetch payouts' }, { status: 500 });
  }

  // Shape response with business name/country
  const payouts = (data || []).map((p: any) => {
    const biz = p.businesses as { name: string; country_code: string | null } | null;
    return {
      id: p.id,
      business_id: p.business_id,
      business_name: biz?.name || 'Unknown',
      country_code: biz?.country_code || 'NG',
      payout_account_id: p.payout_account_id,
      period_start: p.period_start,
      period_end: p.period_end,
      gross_amount: p.gross_amount,
      platform_fee: p.platform_fee,
      gateway_fee: p.gateway_fee,
      net_amount: p.net_amount,
      status: p.status,
      flags: p.flags,
      transfer_method: p.transfer_method,
      approved_by: p.approved_by,
      approved_at: p.approved_at,
      rejected_reason: p.rejected_reason,
      gateway_transfer_code: p.gateway_transfer_code,
      transfer_reference: p.transfer_reference,
      paid_at: p.paid_at,
      notes: p.notes,
      created_at: p.created_at,
      updated_at: p.updated_at,
    };
  });

  return NextResponse.json({
    payouts,
    total: count || 0,
    page,
    per_page: perPage,
    total_pages: Math.ceil((count || 0) / perPage),
  });
}
