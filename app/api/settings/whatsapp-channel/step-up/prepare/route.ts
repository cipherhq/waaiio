import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { prepareMerchantStepUp, MerchantStepUpError, canonicalMerchantParams } from '@/lib/merchant-step-up';
import type { MerchantStepUpAction } from '@/lib/merchant-step-up';

/**
 * POST /api/settings/whatsapp-channel/step-up/prepare
 *
 * Prepares a merchant MFA step-up for channel number change or disconnect.
 * Requires authenticated business owner with verified TOTP factor.
 *
 * Params are NEVER accepted from body — derived from server-loaded state.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  const { business_id, action_type } = body;

  if (!business_id || !action_type) {
    return NextResponse.json({ error: 'Missing business_id or action_type' }, { status: 400 });
  }

  const validActions: MerchantStepUpAction[] = ['channel_number_change', 'channel_disconnect'];
  if (!validActions.includes(action_type)) {
    return NextResponse.json({ error: 'Invalid action_type' }, { status: 400 });
  }

  // Verify business ownership
  const { data: biz } = await supabase
    .from('businesses')
    .select('id, owner_id')
    .eq('id', business_id)
    .eq('owner_id', user.id)
    .single();

  if (!biz) {
    return NextResponse.json({ error: 'Business not found or not owned by you' }, { status: 403 });
  }

  const { createServiceClient } = await import('@/lib/supabase/service');
  const service = createServiceClient();
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) return NextResponse.json({ error: 'No active session' }, { status: 401 });

  // Claims.sub must match getUser().id — reject token/user identity mismatch
  const { data: claimsData } = await service.auth.getClaims(token);
  const claims = claimsData?.claims as Record<string, unknown> | undefined;
  const sessionId = claims?.session_id as string | undefined;
  const claimsSub = claims?.sub as string | undefined;
  if (!sessionId) return NextResponse.json({ error: 'Cannot determine session' }, { status: 401 });
  if (claimsSub !== user.id) {
    return NextResponse.json({ error: 'Token identity mismatch' }, { status: 401 });
  }

  // Derive params from server state — NEVER trust body.params
  let serverTargetId: string | null;
  let serverParams: Record<string, unknown>;
  try {
    if (action_type === 'channel_number_change') {
      if (typeof body.candidate_id !== 'string' || !body.candidate_id) {
        return NextResponse.json({ error: 'Select a ready candidate first.' }, { status: 400 });
      }
      // Validate the explicitly selected ready candidate for this business
      const { data: readyCand } = await service
        .from('whatsapp_channel_candidates')
        .select('id')
        .eq('business_id', business_id)
        .eq('id', body.candidate_id)
        .eq('status', 'ready')
        .maybeSingle();
      if (!readyCand) {
        return NextResponse.json({ error: 'No ready candidate found. Complete provider verification first.' }, { status: 409 });
      }
      serverTargetId = readyCand.id;
      serverParams = canonicalMerchantParams('channel_number_change', business_id, readyCand.id);
    } else {
      if (typeof body.target_channel_id !== 'string' || !body.target_channel_id) {
        return NextResponse.json({ error: 'Select a shared destination first.' }, { status: 400 });
      }
      const { data: target, error } = await service.rpc('channel_change_shared_target', {
        p_business_id: business_id, p_target_channel_id: body.target_channel_id,
      });
      if (error || !target?.id) return NextResponse.json({ error: 'Shared destination is no longer eligible. Reload and select again.' }, { status: 409 });
      serverTargetId = target.id;
      serverParams = canonicalMerchantParams('channel_disconnect', business_id, target.id);
    }
  } catch (err) {
    if (err instanceof MerchantStepUpError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to derive operation parameters' }, { status: 500 });
  }

  try {
    const result = await prepareMerchantStepUp(
      user.id,
      business_id,
      sessionId,
      token,
      action_type as MerchantStepUpAction,
      serverTargetId,
      serverParams,
    );

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof MerchantStepUpError) {
      if (err.message === 'NO_TOTP_ENROLLED') {
        return NextResponse.json({
          error: 'Two-factor authentication is required for this operation. Please enable 2FA in your account settings first.',
          code: 'NO_TOTP_ENROLLED',
        }, { status: 403 });
      }
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: 'Step-up preparation failed' }, { status: 500 });
  }
}
