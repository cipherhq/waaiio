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

  // Owner/admin only
  const guard = await requireCapabilityWithRole(service, {
    businessId, userId: user.id, capability: 'promo_verification', action: 'read_history',
    allowedRoles: ['owner', 'admin'],
  });
  if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

  // Load redemption — directly business + campaign + winner scoped
  const { data: redemption, error } = await service
    .from('promo_redemptions')
    .select('id, phone_e164')
    .eq('id', redemptionId)
    .eq('campaign_id', campaignId)
    .eq('business_id', businessId)
    .eq('outcome', 'winner')
    .maybeSingle();

  if (error || !redemption) {
    return NextResponse.json({ error: 'Winner not found' }, { status: 404 });
  }

  // Audit BEFORE disclosure — fail closed
  const { error: auditError } = await service
    .from('admin_audit_logs')
    .insert({
      actor_id: user.id,
      action: 'promotions.winner_phone_reveal',
      entity_type: 'promo_redemption',
      entity_id: redemptionId,
      details: {
        business_id: businessId,
        campaign_id: campaignId,
        actor_role: guard.role,
      },
    });

  if (auditError) {
    return NextResponse.json({ error: 'Audit recording failed' }, { status: 500 });
  }

  return NextResponse.json(
    { phone_e164: redemption.phone_e164 },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
