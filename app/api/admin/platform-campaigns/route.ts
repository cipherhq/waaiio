import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { adminCorsHeaders } from '@/lib/admin-cors';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/platform-campaigns
 * List campaigns with pagination.
 */
export async function GET(request: NextRequest) {
  const origin = request.headers.get('origin');
  const cors = adminCorsHeaders(origin, 'GET, POST, OPTIONS');
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: cors });

  const supabase = createServiceClient();
  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status');
  const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '20')));
  const offset = (page - 1) * limit;

  let query = supabase
    .from('platform_campaigns')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('status', status);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: 'Failed to load campaigns' }, { status: 500, headers: cors });

  return NextResponse.json({ data: data || [], total: count || 0, page, limit }, { headers: cors });
}

/**
 * POST /api/admin/platform-campaigns
 * Create a new campaign.
 */
export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  const cors = adminCorsHeaders(origin, 'GET, POST, OPTIONS');
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: cors });

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const { name, campaign_type, market_scope, message_config, consent_type, starts_at, ends_at } = body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400, headers: cors });
  }
  if ((name as string).trim().length > 200) {
    return NextResponse.json({ error: 'name must be 200 characters or fewer' }, { status: 400, headers: cors });
  }

  const validTypes = ['opt_in', 'waitlist', 'survey', 'feedback', 'event_interest', 'data_collection', 'notification', 'broadcast'];
  if (!campaign_type || !validTypes.includes(campaign_type as string)) {
    return NextResponse.json({ error: `campaign_type must be one of: ${validTypes.join(', ')}` }, { status: 400, headers: cors });
  }

  const validConsent = ['opt_in', 'informational', 'transactional'];
  if (!consent_type || !validConsent.includes(consent_type as string)) {
    return NextResponse.json({ error: `consent_type is required and must be one of: ${validConsent.join(', ')}` }, { status: 400, headers: cors });
  }

  // Validate timing
  if (starts_at && ends_at && new Date(starts_at as string) >= new Date(ends_at as string)) {
    return NextResponse.json({ error: 'starts_at must be before ends_at' }, { status: 400, headers: cors });
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('platform_campaigns')
    .insert({
      name: (name as string).trim().slice(0, 200),
      campaign_type,
      market_scope: Array.isArray(market_scope) ? market_scope : [],
      message_config: message_config || {},
      consent_type,
      starts_at: starts_at || null,
      ends_at: ends_at || null,
      created_by: admin.userId,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: 'Failed to create campaign' }, { status: 500, headers: cors });

  // Audit log
  await supabase.from('admin_audit_logs').insert({
    actor_id: admin.userId,
    action: 'platform_campaign_created',
    entity_type: 'platform_campaign',
    entity_id: data.id,
    details: { name: data.name, campaign_type: data.campaign_type },
  }).then(() => {}, () => {});

  return NextResponse.json({ data }, { status: 201, headers: cors });
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: adminCorsHeaders(request.headers.get('origin'), 'GET, POST, OPTIONS') });
}
