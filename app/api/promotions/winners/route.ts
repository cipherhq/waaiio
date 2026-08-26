import { logger } from '@/lib/logger';
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import { decryptPromoCode } from '@/lib/promotions/crypto';
import { formatPromoCode, isRoutablePromoCode } from '@/lib/promotions/normalize';

function maskPhone(phone: string): string {
  if (!phone || phone.length < 4) return phone;
  const last4 = phone.slice(-4);
  return `••••••${last4}`;
}

/**
 * Resolve the redeemed printed code for a claimed winning redemption.
 *
 * Defense-in-depth: decryption is only permitted when ALL of these
 * integrity conditions are proven from durable database rows:
 *   1. Caller passed capability/business authorization (checked before this function).
 *   2. Redemption belongs to the authorized business/campaign (checked before this function).
 *   3. Redemption outcome is 'winner' (query filter + re-checked here).
 *   4. promo_code_id is non-null and resolves to an existing promo_campaign_codes row.
 *   5. Code row campaign_id matches the redemption campaign_id.
 *   6. Code row status is durably 'claimed'.
 *   7. Code row outcome is 'winner' (not just trusting the redemption outcome).
 *   8. Only then is encrypted_code decrypted.
 *
 * If any condition fails, returns null. Never exposes ciphertext, hash,
 * or winner-allocation metadata.
 */
function resolveRedeemedCode(
  codeRow: CodeJoin | CodeJoin[] | null,
  redemptionCampaignId: string,
): string | null {
  if (!codeRow) return null;
  const code = Array.isArray(codeRow) ? (codeRow[0] ?? null) : codeRow;
  if (!code) return null;

  // Check 5: code belongs to same campaign as the redemption
  if (code.campaign_id !== redemptionCampaignId) return null;
  // Check 6: code is durably claimed
  if (code.status !== 'claimed') return null;
  // Check 7: code outcome is winner (don't trust redemption outcome alone)
  if (code.outcome !== 'winner') return null;
  // Check 8: decrypt and validate result looks like a real promo code
  if (!code.encrypted_code) return null;
  try {
    const decrypted = decryptPromoCode(code.encrypted_code);
    // Validate the decrypted value is a valid normalized promo code.
    // decryptToken returns the input as-is for non-encrypted strings,
    // so this guards against corrupt/plaintext-passthrough values.
    if (!isRoutablePromoCode(decrypted)) return null;
    return formatPromoCode(decrypted);
  } catch (err) {
    logger.error('[PROMOTIONS] winner code decryption failed', {
      redemptionCampaignId,
      codeStatus: code.status,
    });
    return null;
  }
}

type CodeJoin = {
  encrypted_code: string | null;
  campaign_id: string;
  status: string;
  outcome: string;
};

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

  // Check 1: Caller passed capability/business authorization
  const guard = await requireCapability(supabase, service, {
    businessId,
    userId: user.id,
    capability: 'promo_verification',
    action: 'read_history',
  });
  if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

  // Check 2: Campaign belongs to this business
  const { data: campaign, error: campaignError } = await service
    .from('promo_campaigns')
    .select('id')
    .eq('id', campaignId)
    .eq('business_id', businessId)
    .maybeSingle();

  if (campaignError || !campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
  }

  // Build query — join redemptions with prizes AND codes for redeemed-code recovery
  const offset = (page - 1) * limit;

  // Check 3: Only winner redemptions (outcome='winner')
  // Check 4: promo_code_id FK join fetches the linked code row
  let query = service
    .from('promo_redemptions')
    .select(
      `id,
       phone_e164,
       campaign_id,
       claim_reference,
       claimed_at,
       fulfillment_status,
       fulfillment_reference,
       fulfillment_notes,
       fulfilled_at,
       verification_mode,
       verification_status,
       verified_at,
       promo_campaign_codes!promo_code_id ( encrypted_code, campaign_id, status, outcome ),
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
    campaign_id: string;
    claim_reference: string;
    claimed_at: string;
    fulfillment_status: string;
    fulfillment_reference: string | null;
    fulfillment_notes: string | null;
    fulfilled_at: string | null;
    verification_mode: string;
    verification_status: string;
    verified_at: string | null;
    promo_campaign_codes: CodeJoin | CodeJoin[] | null;
    promo_prizes: PrizeJoin | PrizeJoin[] | null;
  };

  function firstPrize(raw: PrizeJoin | PrizeJoin[] | null): PrizeJoin | null {
    if (!raw) return null;
    return Array.isArray(raw) ? (raw[0] ?? null) : raw;
  }

  // Checks 5-8 happen inside resolveRedeemedCode for each row
  const winners = ((redemptions as RedemptionRow[] | null) || []).map((r) => ({
    id: r.id,
    phone_e164: maskPhone(r.phone_e164),
    redeemed_code: resolveRedeemedCode(r.promo_campaign_codes, r.campaign_id),
    prize_name: firstPrize(r.promo_prizes)?.name ?? null,
    prize_type: firstPrize(r.promo_prizes)?.prize_type ?? null,
    claim_reference: r.claim_reference,
    claimed_at: r.claimed_at,
    fulfillment_status: r.fulfillment_status,
    fulfillment_reference: r.fulfillment_reference,
    fulfillment_notes: r.fulfillment_notes,
    fulfilled_at: r.fulfilled_at,
    verification_mode: r.verification_mode,
    verification_status: r.verification_status,
    verified_at: r.verified_at,
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
