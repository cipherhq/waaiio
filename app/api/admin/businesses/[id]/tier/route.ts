import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { logAdminAudit } from '@/lib/admin-audit';

/** DB enum: subscription_tier AS ENUM ('free', 'growth', 'business') */
const VALID_TIERS = new Set(['free', 'growth', 'business']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // ── Auth: full-admin only (matches isFullAdmin gate in the UI) ──
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  // ── Validate path param ──
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid business ID' }, { status: 400 });
  }

  // ── Parse + validate body ──
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

  // ── Read current business ──
  const { data: biz, error: bizError } = await supabase
    .from('businesses')
    .select('id, name, subscription_tier')
    .eq('id', id)
    .single();

  if (bizError || !biz) {
    return NextResponse.json({ error: 'Business not found' }, { status: 404 });
  }

  const previousTier = biz.subscription_tier;

  if (previousTier === tier) {
    return NextResponse.json({ tier });
  }

  // ── Update businesses.subscription_tier ──
  const { error: bizUpdateError } = await supabase
    .from('businesses')
    .update({ subscription_tier: tier })
    .eq('id', id);

  if (bizUpdateError) {
    return NextResponse.json({ error: 'Failed to update business tier' }, { status: 500 });
  }

  // ── Update subscriptions.tier ──
  const { error: subUpdateError } = await supabase
    .from('subscriptions')
    .update({ tier })
    .eq('business_id', id);

  if (subUpdateError) {
    // Rollback the businesses update
    await supabase
      .from('businesses')
      .update({ subscription_tier: previousTier })
      .eq('id', id);

    return NextResponse.json({ error: 'Failed to update subscription tier' }, { status: 500 });
  }

  // ── Audit log (server-side, matches both page patterns) ──
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
    },
    ipAddress,
  });

  return NextResponse.json({ tier });
}
