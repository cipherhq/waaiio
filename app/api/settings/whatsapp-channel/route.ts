import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * GET /api/settings/whatsapp-channel?business_id=...
 * Returns the WhatsApp channel info for a business.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });

  const businessId = request.nextUrl.searchParams.get('business_id');
  if (!businessId) return NextResponse.json({ message: 'Missing business_id' }, { status: 400 });

  // Verify ownership
  const { data: business } = await supabase
    .from('businesses')
    .select('id, owner_id, wa_method, country_code')
    .eq('id', businessId)
    .single();

  if (!business || business.owner_id !== user.id) {
    return NextResponse.json({ message: 'Not found' }, { status: 404 });
  }

  // Get channel info
  const service = createServiceClient();
  const { data: channel } = await service
    .from('whatsapp_channels')
    .select('id, phone_number, channel_type, provider, connection_method, connection_status, display_name, is_active')
    .eq('business_id', businessId)
    .eq('channel_type', 'dedicated')
    .eq('is_active', true)
    .maybeSingle();

  // Preview only eligible destinations using the same database authority as execution.
  // Country is loaded from the business, never from a request override.
  const country = business.country_code?.trim();
  const sharedTargets: { id: string; phone_number: string; country_code: string }[] = [];
  if (country && business.wa_method !== 'shared') {
    const { data: channels, error } = await service.from('whatsapp_channels')
      .select('id').eq('channel_type', 'shared').eq('is_active', true)
      .eq('connection_status', 'active').is('business_id', null)
      .in('country_code', country === 'GH' ? ['GH', 'NG'] : [country]);
    if (error) return NextResponse.json({ message: 'Unable to load shared destinations' }, { status: 503 });
    for (const candidate of channels || []) {
      const { data: target, error: targetError } = await service.rpc('channel_change_shared_target', {
        p_business_id: businessId, p_target_channel_id: candidate.id,
      });
      if (!targetError && target?.id) sharedTargets.push({
        id: target.id, phone_number: target.phone_number, country_code: target.country_code,
      });
    }
  }

  return NextResponse.json({
    shared_targets: sharedTargets,
    wa_method: business.wa_method || 'shared',
    channel: channel || null,
  });
}

/**
 * DELETE /api/settings/whatsapp-channel
 * Disconnects the dedicated WhatsApp channel and reverts to shared.
 *
 * #799: Requires merchant MFA step-up via disconnect_with_merchant_auth.
 * Body: { business_id, stepUpId, target_channel_id }
 *
 * Session and params_hash are derived server-side using the same canonical
 * helper as prepare, ensuring hash consistency.
 */
export async function DELETE(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    // Support query-param fallback for business_id
  }

  const businessId = (body.business_id as string) || request.nextUrl.searchParams.get('business_id');
  const stepUpId = body.stepUpId as string | undefined;

  if (!businessId) return NextResponse.json({ message: 'Missing business_id' }, { status: 400 });
  if (!stepUpId) {
    return NextResponse.json({
      error: 'Two-factor authentication is required to disconnect your WhatsApp number.',
      code: 'STEP_UP_REQUIRED',
    }, { status: 403 });
  }

  // Verify ownership
  const { data: business } = await supabase
    .from('businesses')
    .select('id, owner_id')
    .eq('id', businessId)
    .single();

  if (!business || business.owner_id !== user.id) {
    return NextResponse.json({ message: 'Not found' }, { status: 404 });
  }

  // Derive session_id and params_hash server-side
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) return NextResponse.json({ message: 'No active session' }, { status: 401 });

  const service = createServiceClient();
  const { data: claimsData } = await service.auth.getClaims(token);
  const claims = claimsData?.claims as Record<string, unknown> | undefined;
  const sessionId = claims?.session_id as string | undefined;
  const claimsSub = claims?.sub as string | undefined;
  if (!sessionId) return NextResponse.json({ message: 'Cannot determine session' }, { status: 401 });
  if (claimsSub !== user.id) {
    return NextResponse.json({ message: 'Token identity mismatch' }, { status: 401 });
  }

  const expectedTarget = typeof body.target_channel_id === 'string' ? body.target_channel_id : '';
  if (!expectedTarget) return NextResponse.json({ error: 'Select a shared destination first.' }, { status: 400 });

  // Use the same canonical params helper as prepare to ensure hash match
  const { canonicalMerchantParams } = await import('@/lib/merchant-step-up');
  const { hashOperationParams } = await import('@/lib/admin-step-up');
  const paramsHash = hashOperationParams(canonicalMerchantParams('channel_disconnect', businessId, expectedTarget));

  // #799: Atomic disconnect with merchant MFA step-up
  try {
    const { data: result, error: rpcError } = await service.rpc('disconnect_with_merchant_auth', {
      p_business_id: businessId,
      p_step_up_id: stepUpId,
      p_owner_user_id: user.id,
      p_expected_target_channel_id: expectedTarget,
      p_session_id: sessionId,
      p_params_hash: paramsHash,
    });

    if (rpcError) {
      const msg = rpcError.message || 'Disconnect failed';
      if (msg.includes('step_up_invalid') || msg.includes('session_binding_required')) {
        return NextResponse.json({ error: 'MFA authorization invalid, expired, or already used.', code: 'STEP_UP_INVALID' }, { status: 403 });
      }
      if (msg.includes('no_shared_capacity')) {
        return NextResponse.json({ error: 'No shared channel with available capacity. Contact support.' }, { status: 409 });
      }
      if (msg.includes('target_mismatch')) {
        return NextResponse.json({ error: 'Shared channel assignment changed. Please retry.' }, { status: 409 });
      }
      return NextResponse.json({ error: `Cannot disconnect: ${msg}` }, { status: 409 });
    }

    const res = result as { ok?: boolean; idempotent?: boolean } | null;
    if (!res?.ok) {
      return NextResponse.json({ error: 'Disconnect failed' }, { status: 500 });
    }

    return NextResponse.json({ message: 'Disconnected', idempotent: res.idempotent || false });
  } catch {
    return NextResponse.json({ error: 'Disconnect failed' }, { status: 500 });
  }
}
