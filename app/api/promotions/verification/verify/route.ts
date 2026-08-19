import { logger } from '@/lib/logger';
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import { hashPickupToken } from '@/lib/promotions/crypto';

/**
 * POST /api/promotions/verification/verify
 *
 * Verify a secure pickup OTP. Does NOT accept phone — derived from redemption.
 * Raw OTP is never logged, stored, or returned. Only HMAC passes to DB.
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const service = createServiceClient();
  const { businessId, redemptionId, token } = body as {
    businessId?: string; redemptionId?: string; token?: string;
  };

  if (!businessId) return NextResponse.json({ error: 'businessId is required' }, { status: 400 });
  if (!redemptionId) return NextResponse.json({ error: 'redemptionId is required' }, { status: 400 });
  if (!token || typeof token !== 'string' || !/^\d{6}$/.test(token)) {
    return NextResponse.json({ error: 'token must be a 6-digit code' }, { status: 400 });
  }

  const guard = await requireCapability(supabase, service, {
    businessId, userId: user.id, capability: 'promo_verification', action: 'manage_existing',
  });
  if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

  // Derive phone from redemption (never accept phone from browser)
  const { data: redemption } = await service
    .from('promo_redemptions')
    .select('phone_e164')
    .eq('id', redemptionId)
    .eq('business_id', businessId)
    .maybeSingle();

  if (!redemption) {
    return NextResponse.json({ error: 'Redemption not found' }, { status: 404 });
  }

  // Compute HMAC — raw token never sent to DB or logged
  const tokenHmac = hashPickupToken(businessId, redemptionId, redemption.phone_e164, token);

  // Delegate to atomic DB RPC
  const { data: result, error: rpcError } = await service.rpc('verify_promo_pickup', {
    p_business_id: businessId,
    p_redemption_id: redemptionId,
    p_token_hmac: tokenHmac,
    p_actor_user_id: user.id,
  });

  if (rpcError) {
    logger.error('[PROMO-PICKUP] verify RPC error:', rpcError);
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 });
  }

  if (!result?.success) {
    const reason = result?.reason || 'unknown';
    if (reason === 'invalid_token') {
      return NextResponse.json({
        error: 'Invalid verification code',
        attempts_remaining: result.attempts_remaining,
      }, { status: 422 });
    }
    if (reason === 'max_attempts_exceeded' || reason === 'verification_locked') {
      return NextResponse.json({ error: 'Too many failed attempts. Request a new code.' }, { status: 422 });
    }
    if (reason === 'token_expired') {
      return NextResponse.json({ error: 'Verification code has expired. Request a new one.' }, { status: 422 });
    }
    return NextResponse.json({ error: `Verification failed: ${reason}` }, { status: 422 });
  }

  return NextResponse.json({ verified: true, already_verified: result.already_verified || false });
}
