import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { canonicalMerchantParams } from '@/lib/merchant-step-up';
import { hashOperationParams } from '@/lib/admin-step-up';
import { logger } from '@/lib/logger';
import { decryptToken } from '@/lib/encryption';

/**
 * POST /api/whatsapp/add-number/finish
 *
 * Promotes a ready candidate with merchant MFA step-up.
 * Called after provider validation (OTP verified, candidate status=ready)
 * when the original verify returned STEP_UP_REQUIRED.
 *
 * Body: { business_id, candidate_id, step_up_id }
 *
 * Params hash is derived from the canonical helper using server-loaded
 * candidate state — NEVER from client-supplied params.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { business_id, candidate_id, step_up_id } = body;

  if (!business_id || !candidate_id || !step_up_id) {
    return NextResponse.json({ error: 'Missing business_id, candidate_id, or step_up_id' }, { status: 400 });
  }

  // Verify ownership
  const { data: biz } = await supabase
    .from('businesses')
    .select('id, owner_id')
    .eq('id', business_id)
    .eq('owner_id', user.id)
    .single();
  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

  // Derive session_id from verified JWT (server-side, not client)
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) return NextResponse.json({ error: 'No session' }, { status: 401 });

  const service = createServiceClient();
  const { data: claimsData } = await service.auth.getClaims(token);
  const claims = claimsData?.claims as Record<string, unknown> | undefined;
  const sessionId = claims?.session_id as string | undefined;
  const claimsSub = claims?.sub as string | undefined;
  if (!sessionId) return NextResponse.json({ error: 'Cannot determine session' }, { status: 401 });
  if (claimsSub !== user.id) {
    return NextResponse.json({ error: 'Token identity mismatch' }, { status: 401 });
  }

  // Verify the candidate is ready and owned by this business
  const { data: cand } = await service
    .from('whatsapp_channel_candidates')
    .select('id, status, business_id, connection_source, waba_id, meta_access_token')
    .eq('id', candidate_id)
    .eq('business_id', business_id)
    .single();

  if (!cand || cand.status !== 'ready') {
    return NextResponse.json({ error: 'Candidate not found or not ready' }, { status: 409 });
  }

  // Compute params_hash from canonical helper — matches what prepare stored
  const paramsHash = hashOperationParams(
    canonicalMerchantParams('channel_number_change', business_id, candidate_id),
  );

  // Call atomic promotion (step-up consumed inside SQL on success only)
  try {
    const { data: result, error: rpcError } = await service.rpc(
      'promote_candidate_with_merchant_auth',
      {
        p_candidate_id: candidate_id,
        p_business_id: business_id,
        p_step_up_id: step_up_id,
        p_owner_user_id: user.id,
        p_session_id: sessionId,
        p_params_hash: paramsHash,
      },
    );

    if (rpcError) {
      const msg = rpcError.message || 'unknown';
      logger.error('[ADD-NUMBER-FINISH] Promotion failed:', msg);
      if (msg.includes('step_up_required') || msg.includes('step_up_invalid') || msg.includes('session_binding_required')) {
        return NextResponse.json({
          error: 'MFA authorization invalid, expired, or already used.',
          code: 'STEP_UP_INVALID',
        }, { status: 403 });
      }
      return NextResponse.json({ error: msg }, { status: 409 });
    }

    if ((result as { ok?: boolean })?.ok !== true) {
      return NextResponse.json({ error: 'Promotion failed' }, { status: 409 });
    }

    // Post-promotion: templates + trial/allowance reconciliation (non-fatal)
    // Use candidate's WABA or fall back to platform WABA
    try {
      const hosted = cand.connection_source === 'waaiio_hosted';
      const effectiveWabaId = cand.waba_id || (hosted ? process.env.META_CLOUD_WABA_ID : undefined);
      const effectiveToken = hosted ? process.env.META_CLOUD_ACCESS_TOKEN
        : cand.meta_access_token ? decryptToken(cand.meta_access_token) : undefined;
      if (effectiveWabaId && effectiveToken) {
        const { provisionTemplates } = await import('@/lib/channels/provision-templates');
        await provisionTemplates(effectiveWabaId, effectiveToken);
      }
    } catch { /* non-fatal */ }

    try {
      await service.rpc('reconcile_paid_allowance', { p_business_id: business_id });
    } catch { /* non-fatal */ }

    return NextResponse.json({
      success: true,
      channel_id: (result as { channel_id?: string })?.channel_id,
    });
  } catch (err) {
    logger.error('[ADD-NUMBER-FINISH] Error:', err);
    return NextResponse.json({ error: 'Promotion failed' }, { status: 500 });
  }
}
