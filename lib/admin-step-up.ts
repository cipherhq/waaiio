/**
 * Operation-bound, single-use, concurrency-safe admin step-up authorization.
 *
 * SEC-005 Layer 4: Sensitive admin operations require fresh MFA confirmation
 * bound to the exact operation, target, and parameters.
 *
 * Flow:
 *  1. PREPARE — Server records admin, session, action, target, params; creates
 *     an MFA challenge via Supabase GoTrue API; returns stepUpId + challengeId.
 *  2. VERIFY — Admin submits TOTP code; server verifies via GoTrue; marks
 *     step-up as verified. The step-up is now consumable for exactly 5 minutes.
 *  3. CONSUME — At the mutation boundary, the route handler atomically consumes
 *     the step-up. If already consumed, expired, or mismatched, the mutation
 *     is rejected.
 *
 * Concurrency safety: consumption uses UPDATE ... WHERE consumed_at IS NULL
 * RETURNING id, which is atomic under PostgreSQL's MVCC. Two concurrent
 * consumers of the same step-up: exactly one gets the row, the other gets
 * zero rows and is rejected.
 */

import { createHash } from 'crypto';
import type { PlatformAdmin } from './admin-auth';

export type StepUpAction =
  | 'payout_approve'
  | 'payout_generate'
  | 'provider_config'
  | 'team_grant'
  | 'team_revoke'
  | 'impersonate'
  | 'refund';

const STEP_UP_MAX_AGE_SECONDS = 300; // 5 minutes

/**
 * Canonical hash of operation parameters.
 * Ensures that the step-up is bound to the exact values the admin confirmed.
 */
export function hashOperationParams(params: Record<string, unknown>): string {
  const sorted = JSON.stringify(params, Object.keys(params).sort());
  return createHash('sha256').update(sorted).digest('hex');
}

export interface StepUpPrepareResult {
  stepUpId: string;
  factorId: string;
  challengeId: string;
}

/**
 * Prepare a step-up authorization for a sensitive operation.
 *
 * Creates a challenge via the Supabase GoTrue API using the admin's bearer
 * token, and records the pending step-up in admin_step_up_authorizations.
 */
export async function prepareStepUp(
  admin: PlatformAdmin,
  actionType: StepUpAction,
  targetId: string | null,
  params: Record<string, unknown>,
): Promise<StepUpPrepareResult> {
  const { createServiceClient } = await import('@/lib/supabase/service');
  const supabase = createServiceClient();
  const { getSessionIdFromToken } = await import('./admin-auth');

  const sessionId = getSessionIdFromToken(admin.bearerToken);
  if (!sessionId) {
    throw new StepUpError('Cannot determine session identity');
  }

  // Get the admin's enrolled TOTP factor
  const { data: factors } = await supabase.from('auth.mfa_factors' as never).select('id, factor_type, status').eq('user_id', admin.userId);

  // Use GoTrue API directly to list factors for the user
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) throw new StepUpError('Missing Supabase configuration');

  const factorsRes = await fetch(`${supabaseUrl}/auth/v1/factors`, {
    headers: {
      'Authorization': `Bearer ${admin.bearerToken}`,
      'apikey': anonKey,
    },
  });

  if (!factorsRes.ok) throw new StepUpError('Failed to list MFA factors');
  const factorsData = await factorsRes.json();

  const totpFactor = (Array.isArray(factorsData) ? factorsData : factorsData?.totp ?? [])
    .find((f: { factor_type: string; status: string }) => f.factor_type === 'totp' && f.status === 'verified');

  if (!totpFactor) {
    throw new StepUpError('No verified TOTP factor enrolled');
  }

  // Create MFA challenge via GoTrue API
  const challengeRes = await fetch(`${supabaseUrl}/auth/v1/factors/${totpFactor.id}/challenge`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${admin.bearerToken}`,
      'apikey': anonKey,
      'Content-Type': 'application/json',
    },
  });

  if (!challengeRes.ok) throw new StepUpError('Failed to create MFA challenge');
  const challenge = await challengeRes.json();

  const paramsHash = hashOperationParams(params);

  // Insert the pending step-up authorization
  const { data: stepUp, error: insertError } = await supabase
    .from('admin_step_up_authorizations')
    .insert({
      admin_user_id: admin.userId,
      session_id: sessionId,
      action_type: actionType,
      target_id: targetId,
      params_hash: paramsHash,
      challenge_id: challenge.id,
      expires_at: new Date(Date.now() + STEP_UP_MAX_AGE_SECONDS * 1000).toISOString(),
    })
    .select('id')
    .single();

  if (insertError || !stepUp) {
    throw new StepUpError('Failed to create step-up authorization');
  }

  return {
    stepUpId: stepUp.id,
    factorId: totpFactor.id,
    challengeId: challenge.id,
  };
}

/**
 * Verify a step-up authorization with a TOTP code.
 *
 * Verifies the MFA challenge via GoTrue API and marks the step-up as verified.
 */
export async function verifyStepUp(
  admin: PlatformAdmin,
  stepUpId: string,
  code: string,
): Promise<boolean> {
  const { createServiceClient } = await import('@/lib/supabase/service');
  const supabase = createServiceClient();

  // Load the pending step-up
  const { data: stepUp, error } = await supabase
    .from('admin_step_up_authorizations')
    .select('id, admin_user_id, challenge_id, verified_at, consumed_at, expires_at')
    .eq('id', stepUpId)
    .single();

  if (error || !stepUp) throw new StepUpError('Step-up authorization not found');
  if (stepUp.admin_user_id !== admin.userId) throw new StepUpError('Step-up belongs to a different admin');
  if (stepUp.verified_at) throw new StepUpError('Step-up already verified');
  if (stepUp.consumed_at) throw new StepUpError('Step-up already consumed');
  if (new Date(stepUp.expires_at) < new Date()) throw new StepUpError('Step-up expired');

  // Load the challenge to get the factor ID
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) throw new StepUpError('Missing Supabase configuration');

  // Verify via GoTrue — this is the cryptographic TOTP verification
  // We need to find the factor ID from the challenge. Query auth.mfa_challenges.
  const { data: challengeRow } = await supabase
    .from('auth.mfa_challenges' as never)
    .select('factor_id')
    .eq('id', stepUp.challenge_id)
    .single();

  // If we can't read the challenge directly, use the GoTrue API with the admin's token
  // The challenge was created for the admin's factor, so verify through the factor
  const factorsRes = await fetch(`${supabaseUrl}/auth/v1/factors`, {
    headers: {
      'Authorization': `Bearer ${admin.bearerToken}`,
      'apikey': anonKey,
    },
  });

  if (!factorsRes.ok) throw new StepUpError('Failed to list factors for verification');
  const factorsData = await factorsRes.json();
  const totpFactor = (Array.isArray(factorsData) ? factorsData : factorsData?.totp ?? [])
    .find((f: { factor_type: string; status: string }) => f.factor_type === 'totp' && f.status === 'verified');

  if (!totpFactor) throw new StepUpError('No verified TOTP factor');

  const verifyRes = await fetch(`${supabaseUrl}/auth/v1/factors/${totpFactor.id}/verify`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${admin.bearerToken}`,
      'apikey': anonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      challenge_id: stepUp.challenge_id,
      code,
    }),
  });

  if (!verifyRes.ok) {
    const errBody = await verifyRes.json().catch(() => ({}));
    throw new StepUpError(errBody?.msg || errBody?.error || 'TOTP verification failed');
  }

  // Mark step-up as verified
  const { error: updateError } = await supabase
    .from('admin_step_up_authorizations')
    .update({ verified_at: new Date().toISOString() })
    .eq('id', stepUpId)
    .is('verified_at', null);

  if (updateError) throw new StepUpError('Failed to mark step-up as verified');

  return true;
}

/**
 * Atomically consume a verified step-up authorization at the mutation boundary.
 *
 * This is the concurrency-safe gate. The UPDATE ... WHERE consumed_at IS NULL
 * ensures exactly-once consumption under concurrent requests.
 *
 * @param admin - The authenticated admin (must match step-up owner)
 * @param stepUpId - The step-up authorization ID
 * @param actionType - Must match the action the step-up was created for
 * @param targetId - Must match the target
 * @param params - Must hash to the same value as preparation
 * @returns true if consumed successfully
 * @throws StepUpError if the step-up is invalid, expired, mismatched, or already consumed
 */
export async function consumeStepUp(
  admin: PlatformAdmin,
  stepUpId: string,
  actionType: StepUpAction,
  targetId: string | null,
  params: Record<string, unknown>,
): Promise<boolean> {
  const { createServiceClient } = await import('@/lib/supabase/service');
  const supabase = createServiceClient();
  const { getSessionIdFromToken } = await import('./admin-auth');

  const sessionId = getSessionIdFromToken(admin.bearerToken);
  if (!sessionId) throw new StepUpError('Cannot determine session identity');

  const paramsHash = hashOperationParams(params);

  // Atomic consumption: UPDATE only if not already consumed, not expired,
  // verified, and all operation bindings match.
  const { data, error } = await supabase
    .from('admin_step_up_authorizations')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', stepUpId)
    .eq('admin_user_id', admin.userId)
    .eq('session_id', sessionId)
    .eq('action_type', actionType)
    .eq('params_hash', paramsHash)
    .not('verified_at', 'is', null)
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('id');

  // Also check target_id (may be null)
  // Note: Supabase .eq with null doesn't work; handle separately
  if (error) throw new StepUpError('Step-up consumption query failed');

  if (!data || data.length === 0) {
    // Could be: already consumed, expired, wrong params, wrong action, wrong user, wrong session
    throw new StepUpError('Step-up authorization invalid, expired, already used, or does not match this operation');
  }

  // Verify target_id matches (separate check because null handling)
  const { data: row } = await supabase
    .from('admin_step_up_authorizations')
    .select('target_id')
    .eq('id', stepUpId)
    .single();

  if (row && row.target_id !== targetId) {
    // Rollback: un-consume (best effort — the mismatch is a programming error)
    await supabase
      .from('admin_step_up_authorizations')
      .update({ consumed_at: null })
      .eq('id', stepUpId);
    throw new StepUpError('Step-up target_id mismatch');
  }

  // Log the step-up consumption
  await supabase.from('admin_audit_logs').insert({
    actor_id: admin.userId,
    action: 'step_up_consumed',
    entity_type: actionType,
    entity_id: targetId ?? undefined,
    details: { step_up_id: stepUpId, action_type: actionType },
    ip_address: 'server',
  }).then(() => {}, () => {});

  return true;
}

export class StepUpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepUpError';
  }
}
