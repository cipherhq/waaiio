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
import { logAdminAudit } from '@/lib/admin-audit';

export type StepUpAction =
  | 'payout_approve'
  | 'payout_reject'
  | 'payout_generate'
  | 'provider_config'
  | 'team_grant'
  | 'team_revoke'
  | 'impersonate'
  | 'refund'
  | 'reseller_payout_approve'
  | 'reseller_payout_reject'
  | 'reseller_payout_mark_paid'
  | 'reseller_payout_generate'
  | 'commercial_config'
  | 'messaging_config'
  | 'messaging_suspension'
  | 'payout_confirm_settlement'
  | 'payout_force_settle';

const STEP_UP_MAX_AGE_SECONDS = 300; // 5 minutes

/**
 * Canonical hash of operation parameters.
 * Ensures that the step-up is bound to the exact values the admin confirmed.
 *
 * Uses recursive stable serialization — NOT JSON.stringify with a replacer
 * array, which silently drops nested object keys that aren't in the array.
 */
export function hashOperationParams(params: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(params)).digest('hex');
}

/**
 * Recursively serialize a value with sorted object keys at every nesting level.
 * Produces a deterministic string for any JSON-compatible value tree.
 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
  }
  return JSON.stringify(value);
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
  // Session ID comes from the same cryptographically verified admin access token.
  const sessionId = admin.sessionId;
  if (!sessionId) {
    throw new StepUpError('Cannot determine session identity');
  }

  // C0: Use official GET /auth/v1/user endpoint (SDK's mfa.listFactors() uses this).
  // GET /auth/v1/factors does NOT exist in GoTrue — runtime blocker.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) throw new StepUpError('Missing Supabase configuration');

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      'Authorization': `Bearer ${admin.bearerToken}`,
      'apikey': anonKey,
    },
  });

  if (!userRes.ok) throw new StepUpError('Failed to get user MFA factors');
  const userData = await userRes.json();

  const totpFactor = (userData.factors ?? [])
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
      factor_id: totpFactor.id,
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
): Promise<{ access_token: string; refresh_token: string }> {
  const { createServiceClient } = await import('@/lib/supabase/service');
  const supabase = createServiceClient();

  // Session ID comes from the same cryptographically verified admin access token.
  const sessionId = admin.sessionId;
  if (!sessionId) throw new StepUpError('Cannot determine session identity');

  // Load the pending step-up
  const { data: stepUp, error } = await supabase
    .from('admin_step_up_authorizations')
    .select('id, admin_user_id, session_id, challenge_id, factor_id, verified_at, consumed_at, expires_at')
    .eq('id', stepUpId)
    .single();

  if (error || !stepUp) throw new StepUpError('Step-up authorization not found');
  if (stepUp.admin_user_id !== admin.userId) throw new StepUpError('Step-up belongs to a different admin');
  // SEC-005: Verify the same session that prepared the step-up is verifying it
  if (stepUp.session_id !== sessionId) throw new StepUpError('Step-up belongs to a different session');
  if (stepUp.verified_at) throw new StepUpError('Step-up already verified');
  if (stepUp.consumed_at) throw new StepUpError('Step-up already consumed');
  if (new Date(stepUp.expires_at) < new Date()) throw new StepUpError('Step-up expired');

  // Always verify against the exact factor that created this challenge.
  // Re-enumerating factors can select another factor if their order changes.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) throw new StepUpError('Missing Supabase configuration');
  if (!stepUp.factor_id) throw new StepUpError('Step-up challenge has no factor identity');

  const verifyRes = await fetch(`${supabaseUrl}/auth/v1/factors/${stepUp.factor_id}/verify`, {
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

  // GoTrue rotates the session tokens during MFA verification. The browser
  // must persist them before executing the authorized operation.
  const verifiedSession = await verifyRes.json();
  if (typeof verifiedSession?.access_token !== 'string' ||
      typeof verifiedSession?.refresh_token !== 'string') {
    throw new StepUpError('MFA verification returned no refreshed session');
  }

  // The verification transition is conditional on *all* pending-state
  // predicates. Checking only the error is insufficient: UPDATE of zero rows
  // is not an authorization success (and races must not re-verify an old grant).
  const { data: marked, error: updateError } = await supabase
    .from('admin_step_up_authorizations')
    .update({ verified_at: new Date().toISOString() })
    .eq('id', stepUpId)
    .eq('admin_user_id', admin.userId)
    .eq('session_id', sessionId)
    .eq('challenge_id', stepUp.challenge_id)
    .eq('factor_id', stepUp.factor_id)
    .is('verified_at', null)
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('id')
    .maybeSingle();

  if (updateError || !marked) throw new StepUpError('Step-up verification is no longer pending');

  return { access_token: verifiedSession.access_token, refresh_token: verifiedSession.refresh_token };
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
  // Session ID comes from the same cryptographically verified admin access token.
  const sessionId = admin.sessionId;
  if (!sessionId) throw new StepUpError('Cannot determine session identity');

  const paramsHash = hashOperationParams(params);

  // Atomic consumption: all predicates — including target_id — are checked
  // in the same UPDATE. If any predicate fails, zero rows are updated and
  // the step-up is NOT consumed. No post-hoc rollback needed.
  let query = supabase
    .from('admin_step_up_authorizations')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', stepUpId)
    .eq('admin_user_id', admin.userId)
    .eq('session_id', sessionId)
    .eq('action_type', actionType)
    .eq('params_hash', paramsHash)
    .not('verified_at', 'is', null)
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString());

  // Handle null target_id atomically within the same query
  if (targetId === null) {
    query = query.is('target_id', null);
  } else {
    query = query.eq('target_id', targetId);
  }

  const { data, error } = await query.select('id');

  if (error) throw new StepUpError('Step-up consumption query failed');

  if (!data || data.length === 0) {
    throw new StepUpError('Step-up authorization invalid, expired, already used, or does not match this operation');
  }

  // Log the step-up consumption
  logAdminAudit({
    actorId: admin.userId,
    action: 'step_up_consumed',
    entityType: actionType,
    entityId: targetId ?? null,
    details: { step_up_id: stepUpId, action_type: actionType },
    ipAddress: 'server',
  });

  return true;
}

export class StepUpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepUpError';
  }
}
