import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapabilityWithRole } from '@/lib/capabilities/api-guard';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const service = createServiceClient();
  const { businessId, campaignId, redemptionId } = body;

  if (!businessId || !campaignId || !redemptionId) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  // Owner/admin/manager
  const guard = await requireCapabilityWithRole(service, {
    businessId, userId: user.id, capability: 'promo_verification', action: 'manage_existing',
    allowedRoles: ['owner', 'admin', 'manager'],
  });
  if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

  // Existence check only — no phone_e164 in SELECT
  const { data: redemption } = await service
    .from('promo_redemptions')
    .select('id')
    .eq('id', redemptionId)
    .eq('campaign_id', campaignId)
    .maybeSingle();

  if (!redemption) {
    return NextResponse.json({ error: 'Winner not found' }, { status: 404 });
  }

  // Verify campaign belongs to business
  const { data: campaign } = await service
    .from('promo_campaigns')
    .select('id')
    .eq('id', campaignId)
    .eq('business_id', businessId)
    .maybeSingle();

  if (!campaign) {
    return NextResponse.json({ error: 'Winner not found' }, { status: 404 });
  }

  return NextResponse.json(
    { error: 'template_not_ready', message: 'Winner contact template pending approval. This feature will be available in a future update.' },
    { status: 503 },
  );
}
