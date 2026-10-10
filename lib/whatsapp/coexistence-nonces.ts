/**
 * #592 Phase 2 — Server-owned signup nonces for coexistence anti-replay.
 *
 * Nonces bind a coexistence signup session to a specific business_id and
 * prevent replay/cross-session attacks in the Meta FINISH callback flow.
 *
 * All operations use the service client (bypasses RLS) because the
 * coexistence_signup_nonces table is accessible only to service_role.
 *
 * Nonce lifecycle:
 * 1. generateSignupNonce() — called when business starts coexistence onboarding
 * 2. consumeSignupNonce() — called by FINISH callback handler to validate + consume
 * 3. cleanExpiredNonces() — called by cron to garbage-collect stale nonces
 */

import { randomUUID, randomBytes } from 'crypto';
import { createServiceClient } from '@/lib/supabase/service';

/** TTL for signup nonces — 15 minutes is tight enough for a single signup session */
const NONCE_TTL_MS = 15 * 60 * 1000;

/** How long after expiry before cron deletes the nonce row (for audit trail) */
const CLEANUP_GRACE_INTERVAL = '1 hour';

export interface GenerateNonceResult {
  nonce: string;
  expiresAt: Date;
}

export interface ConsumeNonceResult {
  valid: boolean;
  businessId?: string;
  error?: string;
}

export interface CleanupResult {
  deleted: number;
}

/**
 * Generate a cryptographically random nonce and store it in the DB.
 *
 * The nonce is a combination of a UUID and random bytes to ensure
 * uniqueness and unpredictability. Stored with a 15-minute TTL.
 */
export async function generateSignupNonce(businessId: string): Promise<GenerateNonceResult> {
  if (!businessId || typeof businessId !== 'string') {
    throw new Error('businessId is required to generate a signup nonce');
  }

  const nonce = `${randomUUID()}-${randomBytes(16).toString('hex')}`;
  const expiresAt = new Date(Date.now() + NONCE_TTL_MS);

  const service = createServiceClient();

  const { error } = await service.from('coexistence_signup_nonces').insert({
    business_id: businessId,
    nonce,
    expires_at: expiresAt.toISOString(),
  });

  if (error) {
    throw new Error(`Failed to store signup nonce: ${error.message}`);
  }

  return { nonce, expiresAt };
}

/**
 * Atomically look up and consume a nonce.
 *
 * The consumption is atomic: we UPDATE ... WHERE nonce = $1 AND consumed_at IS NULL
 * AND expires_at > now(). If zero rows are updated, the nonce is invalid (unknown,
 * expired, or already consumed). This prevents double-consume race conditions.
 *
 * Returns the business_id the nonce was issued for, allowing the FINISH handler
 * to bind the callback to the correct tenant.
 */
export async function consumeSignupNonce(
  nonce: string,
  sessionIdentifier?: string,
): Promise<ConsumeNonceResult> {
  if (!nonce || typeof nonce !== 'string') {
    return { valid: false, error: 'nonce_required' };
  }

  const service = createServiceClient();

  // Step 1: Atomic consume — update only if not consumed and not expired.
  // We use a two-step approach: first try to update (CAS), then read if successful.
  // This avoids TOCTOU — the UPDATE's WHERE clause is the authoritative gate.
  const { data: updated, error: updateError } = await service
    .from('coexistence_signup_nonces')
    .update({
      consumed_at: new Date().toISOString(),
      consumed_by_session: sessionIdentifier || null,
    })
    .eq('nonce', nonce)
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('business_id')
    .maybeSingle();

  if (updateError) {
    return { valid: false, error: `nonce_consumption_failed: ${updateError.message}` };
  }

  if (!updated) {
    // Nonce was not found, already consumed, or expired
    return { valid: false, error: 'nonce_invalid_or_expired' };
  }

  return {
    valid: true,
    businessId: updated.business_id,
  };
}

/**
 * Delete expired nonces that are past the grace period.
 *
 * Called from cron — not from the request path. We keep expired nonces
 * for 1 hour after expiry for audit purposes before garbage-collecting.
 */
export async function cleanExpiredNonces(): Promise<CleanupResult> {
  const service = createServiceClient();

  // Delete nonces that expired more than 1 hour ago
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { data, error } = await service
    .from('coexistence_signup_nonces')
    .delete()
    .lt('expires_at', cutoff)
    .select('id');

  if (error) {
    throw new Error(`Failed to clean expired nonces: ${error.message}`);
  }

  return { deleted: data?.length ?? 0 };
}
