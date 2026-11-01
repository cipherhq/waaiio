/**
 * Merchant operation-bound step-up authorization for channel changes.
 *
 * Mirrors the admin step-up pattern (lib/admin-step-up.ts) but operates
 * on merchant_step_up_authorizations for business owners. Uses the same
 * Supabase native TOTP MFA infrastructure.
 *
 * Flow: PREPARE → VERIFY → (consumed atomically inside SQL wrapper)
 */

import { hashOperationParams } from './admin-step-up';

export type MerchantStepUpAction = 'channel_number_change' | 'channel_disconnect';

const STEP_UP_MAX_AGE_SECONDS = 300; // 5 minutes

/**
 * Canonical params for merchant step-up operations.
 * MUST be used by both prepare and consume/finish paths to ensure hash consistency.
 * Never accept params from the client — always derive from server-loaded state.
 */
export function canonicalMerchantParams(
  action: MerchantStepUpAction,
  businessId: string,
  candidateId?: string,
): Record<string, unknown> {
  if (action === 'channel_number_change') {
    if (!candidateId) throw new MerchantStepUpError('candidate_id required for channel_number_change');
    return { action: 'channel_number_change', business_id: businessId, candidate_id: candidateId };
  }
  if (action === 'channel_disconnect') {
    if (!candidateId) throw new MerchantStepUpError('target_channel_id required for channel_disconnect');
    return { action: 'channel_disconnect', business_id: businessId, target_channel_id: candidateId };
  }
  throw new MerchantStepUpError(`Unknown action: ${action}`);
}

export interface MerchantStepUpPrepareResult {
  stepUpId: string;
  factorId: string;
  challengeId: string;
}

/**
 * Prepare a merchant step-up authorization for a channel change.
 *
 * The caller must already have verified the user owns the business.
 * The step-up is bound to the exact user, business, action, and target.
 */
export async function prepareMerchantStepUp(
  userId: string,
  businessId: string,
  sessionId: string,
  bearerToken: string,
  actionType: MerchantStepUpAction,
  targetId: string | null,
  params: Record<string, unknown>,
): Promise<MerchantStepUpPrepareResult> {
  const { createServiceClient } = await import('@/lib/supabase/service');
  const supabase = createServiceClient();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) throw new MerchantStepUpError('Missing Supabase configuration');

  // Get TOTP factor via GoTrue
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      'Authorization': `Bearer ${bearerToken}`,
      'apikey': anonKey,
    },
  });
  if (!userRes.ok) throw new MerchantStepUpError('Failed to get MFA factors');
  const userData = await userRes.json();

  const totpFactor = (userData.factors ?? [])
    .find((f: { factor_type: string; status: string }) => f.factor_type === 'totp' && f.status === 'verified');

  if (!totpFactor) {
    throw new MerchantStepUpError('NO_TOTP_ENROLLED');
  }

  // Create challenge
  const challengeRes = await fetch(`${supabaseUrl}/auth/v1/factors/${totpFactor.id}/challenge`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${bearerToken}`,
      'apikey': anonKey,
      'Content-Type': 'application/json',
    },
  });
  if (!challengeRes.ok) throw new MerchantStepUpError('Failed to create MFA challenge');
  const challenge = await challengeRes.json();

  const paramsHash = hashOperationParams(params);

  const { data: stepUp, error: insertError } = await supabase
    .from('merchant_step_up_authorizations')
    .insert({
      owner_user_id: userId,
      business_id: businessId,
      session_id: sessionId,
      action_type: actionType,
      target_id: targetId,
      params_hash: paramsHash,
      challenge_id: challenge.id,
      factor_id: totpFactor.id,
      expires_at: new Date(Date.now() + STEP_UP_MAX_AGE_SECONDS * 1000).toISOString(),
    })
    .select('id')
    .single();

  if (insertError || !stepUp) {
    throw new MerchantStepUpError('Failed to create step-up authorization');
  }

  return {
    stepUpId: stepUp.id,
    factorId: totpFactor.id,
    challengeId: challenge.id,
  };
}

/**
 * Verify a merchant step-up with a TOTP code.
 *
 * Returns refreshed session tokens (GoTrue rotates on MFA verify).
 */
export async function verifyMerchantStepUp(
  userId: string,
  sessionId: string,
  bearerToken: string,
  stepUpId: string,
  code: string,
): Promise<{ access_token: string; refresh_token: string }> {
  const { createServiceClient } = await import('@/lib/supabase/service');
  const supabase = createServiceClient();

  const { data: stepUp, error } = await supabase
    .from('merchant_step_up_authorizations')
    .select('id, owner_user_id, session_id, challenge_id, factor_id, verified_at, consumed_at, expires_at')
    .eq('id', stepUpId)
    .single();

  if (error || !stepUp) throw new MerchantStepUpError('Step-up not found');
  if (stepUp.owner_user_id !== userId) throw new MerchantStepUpError('Step-up belongs to a different user');
  if (stepUp.session_id !== sessionId) throw new MerchantStepUpError('Step-up belongs to a different session');
  if (stepUp.verified_at) throw new MerchantStepUpError('Step-up already verified');
  if (stepUp.consumed_at) throw new MerchantStepUpError('Step-up already consumed');
  if (new Date(stepUp.expires_at) < new Date()) throw new MerchantStepUpError('Step-up expired');

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) throw new MerchantStepUpError('Missing Supabase configuration');
  if (!stepUp.factor_id) throw new MerchantStepUpError('Step-up has no factor identity');

  const verifyRes = await fetch(`${supabaseUrl}/auth/v1/factors/${stepUp.factor_id}/verify`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${bearerToken}`,
      'apikey': anonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ challenge_id: stepUp.challenge_id, code }),
  });

  if (!verifyRes.ok) {
    const errBody = await verifyRes.json().catch(() => ({}));
    throw new MerchantStepUpError(errBody?.msg || errBody?.error || 'TOTP verification failed');
  }

  const verifiedSession = await verifyRes.json();
  if (typeof verifiedSession?.access_token !== 'string' ||
      typeof verifiedSession?.refresh_token !== 'string') {
    throw new MerchantStepUpError('MFA verification returned no refreshed session');
  }

  // Mark verified with all predicates
  const { data: marked, error: updateError } = await supabase
    .from('merchant_step_up_authorizations')
    .update({ verified_at: new Date().toISOString() })
    .eq('id', stepUpId)
    .eq('owner_user_id', userId)
    .eq('session_id', sessionId)
    .is('verified_at', null)
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('id')
    .maybeSingle();

  if (updateError || !marked) throw new MerchantStepUpError('Step-up verification is no longer pending');

  return { access_token: verifiedSession.access_token, refresh_token: verifiedSession.refresh_token };
}

export class MerchantStepUpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MerchantStepUpError';
  }
}
