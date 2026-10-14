import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { logAdminAudit } from '@/lib/admin-audit';

/** DB enum: subscription_tier AS ENUM ('free', 'growth', 'business') */
const VALID_TIERS = new Set(['free', 'growth', 'business']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read the business's active subscription to determine if they are paying.
 * Returns { paidPlan, revertsOn } or nulls if no active paid subscription.
 */
async function getSubscriptionInfo(
  supabase: ReturnType<typeof createServiceClient>,
  businessId: string,
) {
  const { data: sub } = await supabase
    .from('subscriptions')
    .select('status, plan, current_period_end')
    .eq('business_id', businessId)
    .maybeSingle();

  const isPaying =
    sub?.status === 'active' &&
    (sub.plan === 'growth' || sub.plan === 'business');

  return {
    paidPlan: isPaying ? sub.plan : null,
    revertsOn: isPaying ? sub.current_period_end : null,
  };
}

/** GET — return current tier + paid plan info for pre-save confirmation */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid business ID' }, { status: 400 });
  }

  const supabase = createServiceClient();

  const { data: biz, error: bizError } = await supabase
    .from('businesses')
    .select('subscription_tier')
    .eq('id', id)
    .single();

  if (bizError || !biz) {
    return NextResponse.json({ error: 'Business not found' }, { status: 404 });
  }

  const { paidPlan, revertsOn } = await getSubscriptionInfo(supabase, id);

  return NextResponse.json({
    tier: biz.subscription_tier,
    paidPlan,
    revertsOn,
  });
}

/** POST — change the business's subscription_tier (admin override) */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid business ID' }, { status: 400 });
  }

  let body: { tier?: string };
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { tier } = body;
  if (!tier || !VALID_TIERS.has(tier)) {
    return NextResponse.json(
      { error: `Invalid tier. Must be one of: ${[...VALID_TIERS].join(', ')}` },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  const { data: biz, error: bizError } = await supabase
    .from('businesses')
    .select('id, name, subscription_tier')
    .eq('id', id)
    .single();

  if (bizError || !biz) {
    return NextResponse.json({ error: 'Business not found' }, { status: 404 });
  }

  const previousTier = biz.subscription_tier;

  // Read subscription info for the response and audit log
  const { paidPlan, revertsOn } = await getSubscriptionInfo(supabase, id);

  if (previousTier === tier) {
    return NextResponse.json({ tier, paidPlan, revertsOn });
  }

  // Single write: only businesses.subscription_tier
  const { error: updateError } = await supabase
    .from('businesses')
    .update({ subscription_tier: tier })
    .eq('id', id);

  if (updateError) {
    return NextResponse.json({ error: 'Failed to update business tier' }, { status: 500 });
  }

  const ipAddress = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;

  await logAdminAudit({
    actorId: admin.userId,
    action: 'change_subscription_tier',
    entityType: 'business',
    entityId: id,
    details: {
      previous_tier: previousTier,
      new_tier: tier,
      business_name: biz.name,
      paid_plan: paidPlan,
      reverts_on: revertsOn,
    },
    ipAddress,
  });

  return NextResponse.json({ tier, paidPlan, revertsOn });
}
