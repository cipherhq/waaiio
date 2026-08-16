import { logger } from '@/lib/logger';
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';

function maskPhone(phone: string): string {
  if (!phone || phone.length < 4) return phone;
  const last4 = phone.slice(-4);
  return `••••••${last4}`;
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = request.nextUrl;
  const businessId = searchParams.get('businessId');
  const campaignId = searchParams.get('campaignId');
  const fulfillmentStatus = searchParams.get('fulfillmentStatus');
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '20', 10)));

  if (!businessId) {
    return NextResponse.json({ error: 'businessId is required' }, { status: 400 });
  }
  if (!campaignId) {
    return NextResponse.json({ error: 'campaignId is required' }, { status: 400 });
  }

  const service = createServiceClient();

  const guard = await requireCapability(supabase, service, {
    businessId,
    userId: user.id,
    capability: 'promo_verification',
    action: 'read_history',
  });
  if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

  // Verify campaign belongs to this business
  const { data: campaign, error: campaignError } = await service
    .from('promo_campaigns')
    .select('id')
    .eq('id', campaignId)
    .eq('business_id', businessId)
    .maybeSingle();

  if (campaignError || !campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
  }

  // Build query — join redemptions with prizes for prize name/type
  const offset = (page - 1) * limit;

  let query = service
    .from('promo_redemptions')
    .select(
      `id,
       phone_e164,
       claim_reference,
       claimed_at,
       fulfillment_status,
       fulfillment_reference,
       fulfillment_notes,
       fulfilled_at,
       promo_prizes ( name, prize_type )`,
      { count: 'exact' },
    )
    .eq('campaign_id', campaignId)
    .eq('business_id', businessId)
    .eq('outcome', 'winner')
    .order('claimed_at', { ascending: false });

  const validFulfillmentStatuses = ['pending', 'processing', 'fulfilled', 'rejected', 'cancelled'];
  if (fulfillmentStatus && validFulfillmentStatuses.includes(fulfillmentStatus)) {
    query = query.eq('fulfillment_status', fulfillmentStatus);
  }

  const { data: redemptions, count, error: queryError } = await query.range(offset, offset + limit - 1);

  if (queryError) {
    logger.error('[PROMOTIONS] winners query error:', queryError);
    return NextResponse.json({ error: 'Failed to fetch winners' }, { status: 500 });
  }

  type PrizeJoin = { name: string; prize_type: string };
  type RedemptionRow = {
    id: string;
    phone_e164: string;
    claim_reference: string;
    claimed_at: string;
    fulfillment_status: string;
    fulfillment_reference: string | null;
    fulfillment_notes: string | null;
    fulfilled_at: string | null;
    // Supabase returns the joined row as an object (many-to-one via prize_id FK)
    promo_prizes: PrizeJoin | PrizeJoin[] | null;
  };

  function firstPrize(raw: PrizeJoin | PrizeJoin[] | null): PrizeJoin | null {
    if (!raw) return null;
    return Array.isArray(raw) ? (raw[0] ?? null) : raw;
  }

  const winners = ((redemptions as RedemptionRow[] | null) || []).map((r) => ({
    id: r.id,
    phone_e164: maskPhone(r.phone_e164),
    prize_name: firstPrize(r.promo_prizes)?.name ?? null,
    prize_type: firstPrize(r.promo_prizes)?.prize_type ?? null,
    claim_reference: r.claim_reference,
    claimed_at: r.claimed_at,
    fulfillment_status: r.fulfillment_status,
    fulfillment_reference: r.fulfillment_reference,
    fulfillment_notes: r.fulfillment_notes,
    fulfilled_at: r.fulfilled_at,
  }));

  return NextResponse.json({
    winners,
    pagination: {
      page,
      limit,
      total: count ?? 0,
    },
  });
}
