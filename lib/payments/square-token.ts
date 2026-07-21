/**
 * Square OAuth token lifecycle.
 *
 * 3-stage refresh lease protocol:
 *   1. acquire_refresh_lease RPC — set lease with unique claim_token
 *   2. Call Square OAuth externally (outside DB transaction)
 *   3. complete_refresh_lease RPC — rotate only if claim_token still owns lease AND lease unexpired
 *
 * After successful refresh, re-reads the credential (another worker may have
 * completed a newer refresh). Never returns stale tokens.
 *
 * Never returns an expired token. Never logs token values.
 * Never falls back to platform credentials for a connected merchant.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { encryptToken, decryptToken } from '@/lib/encryption';
import { logger } from '@/lib/logger';

const REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
const squareAppId = process.env.SQUARE_OAUTH_APP_ID || process.env.SQUARE_APPLICATION_ID || '';
const squareAppSecret = process.env.SQUARE_OAUTH_APP_SECRET || process.env.SQUARE_APPLICATION_SECRET || '';
const squareEnvironment = process.env.SQUARE_ENVIRONMENT || 'sandbox';

function getSquareBaseUrl(): string {
  return squareEnvironment === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
}

const PERMANENT_ERRORS = ['invalid_grant', 'unauthorized', 'ACCESS_TOKEN_REVOKED'];

/**
 * Resolve a Square access token for a connection.
 * Returns null (fail closed) if the token cannot be resolved — NEVER falls
 * back to platform credentials for a connected merchant.
 */
export async function resolveSquareToken(
  supabase: SupabaseClient,
  connectionId: string,
): Promise<{ accessToken: string; secretId: string } | null> {
  const { data: secret } = await supabase
    .from('business_connection_secrets')
    .select('id, encrypted_secret_key, encrypted_refresh_token, token_expires_at, token_refreshed_at, refresh_lease_expires_at')
    .eq('payout_account_id', connectionId)
    .is('revoked_at', null)
    .maybeSingle();

  if (!secret?.encrypted_secret_key) return null;

  const now = Date.now();
  const expiresAt = secret.token_expires_at ? new Date(secret.token_expires_at).getTime() : null;
  const refreshedAt = secret.token_refreshed_at ? new Date(secret.token_refreshed_at).getTime() : null;
  const isExpired = expiresAt !== null && expiresAt <= now;
  const nearExpiry = expiresAt !== null && (expiresAt - now) < REFRESH_THRESHOLD_MS;
  const isStale = refreshedAt !== null && (now - refreshedAt) > REFRESH_THRESHOLD_MS;
  const neverRefreshed = refreshedAt === null && expiresAt !== null;
  const needsRefresh = isExpired || nearExpiry || isStale || neverRefreshed;

  const refreshToken = secret.encrypted_refresh_token
    ? decryptToken(secret.encrypted_refresh_token) : null;

  if (needsRefresh && refreshToken && squareAppId && squareAppSecret) {
    const leaseExpires = secret.refresh_lease_expires_at
      ? new Date(secret.refresh_lease_expires_at).getTime() : 0;

    if (leaseExpires > now) {
      // Another refresh in progress
      if (isExpired) {
        // Token is expired but another worker is refreshing — brief wait and re-read
        await new Promise(resolve => setTimeout(resolve, 2000));
        const { data: refreshedSecret } = await supabase
          .from('business_connection_secrets')
          .select('encrypted_secret_key, token_expires_at, refresh_lease_expires_at')
          .eq('id', secret.id)
          .is('revoked_at', null)
          .single();
        if (refreshedSecret?.token_expires_at) {
          const newExpiry = new Date(refreshedSecret.token_expires_at).getTime();
          if (newExpiry > now) {
            // Winner refreshed successfully — use new token
            return { accessToken: decryptToken(refreshedSecret.encrypted_secret_key), secretId: secret.id };
          }
        }
        // Still expired after wait — the winner may have failed
        return null;
      }
      // Not expired, just near expiry — use current token while another worker refreshes
      return { accessToken: decryptToken(secret.encrypted_secret_key), secretId: secret.id };
    }

    const refreshed = await refreshWithLease(supabase, secret.id, refreshToken);
    if (refreshed) {
      // Re-read the credential — another worker may have completed a newer refresh
      const { data: fresh } = await supabase
        .from('business_connection_secrets')
        .select('encrypted_secret_key')
        .eq('id', secret.id)
        .is('revoked_at', null)
        .single();
      if (fresh?.encrypted_secret_key) {
        return { accessToken: decryptToken(fresh.encrypted_secret_key), secretId: secret.id };
      }
      return null;
    }

    // Refresh failed
    if (isExpired) {
      await markConnectionUnhealthy(supabase, secret.id, 'token_expired_refresh_failed');
      return null;
    }
    return { accessToken: decryptToken(secret.encrypted_secret_key), secretId: secret.id };
  }

  if (isExpired) {
    await markConnectionUnhealthy(supabase, secret.id, 'token_expired_no_refresh');
    return null;
  }

  return { accessToken: decryptToken(secret.encrypted_secret_key), secretId: secret.id };
}

async function refreshWithLease(
  supabase: SupabaseClient,
  secretId: string,
  refreshToken: string,
): Promise<boolean> {
  const claimToken = randomUUID();

  const { data: leaseResult } = await supabase.rpc('acquire_refresh_lease', {
    p_secret_id: secretId,
    p_claim_token: claimToken,
    p_lease_seconds: 60,
  });
  if (!leaseResult?.acquired) return false;

  try {
    const res = await fetch(`${getSquareBaseUrl()}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: squareAppId,
        client_secret: squareAppSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();

    if (data.error || !data.access_token) {
      const errorType = (data.error as string) || '';
      if (PERMANENT_ERRORS.includes(errorType)) {
        await markConnectionUnhealthy(supabase, secretId, errorType);
      }
      logger.error('[SQUARE-TOKEN] Refresh rejected (no token details logged)');
      return false;
    }

    const encryptedAccess = encryptToken(data.access_token as string);
    const encryptedRefresh = data.refresh_token
      ? encryptToken(data.refresh_token as string) : '';
    const newExpiresAt = (data.expires_at as string) || null;

    const { data: completeResult } = await supabase.rpc('complete_refresh_lease', {
      p_secret_id: secretId,
      p_claim_token: claimToken,
      p_new_access_token: encryptedAccess,
      p_new_refresh_token: encryptedRefresh,
      p_new_expires_at: newExpiresAt ? new Date(newExpiresAt).toISOString() : null,
    });

    if (!completeResult?.success) {
      logger.warn('[SQUARE-TOKEN] Lease completion rejected:', completeResult?.reason);
      return false;
    }
    return true;
  } catch {
    logger.error('[SQUARE-TOKEN] Provider timeout (lease will expire)');
    return false;
  }
}

async function markConnectionUnhealthy(
  supabase: SupabaseClient, secretId: string, reason: string,
): Promise<void> {
  const { data: secret } = await supabase
    .from('business_connection_secrets')
    .select('payout_account_id')
    .eq('id', secretId).single();
  if (secret?.payout_account_id) {
    await supabase.from('payout_accounts').update({
      health_status: 'unhealthy', connection_status: 'pending_review',
      updated_at: new Date().toISOString(),
    }).eq('id', secret.payout_account_id);
    logger.warn('[SQUARE-TOKEN] Connection marked unhealthy:', reason);
  }
}

/**
 * Handle oauth.authorization.revoked.
 * Transactional: revokes connection + secrets atomically.
 * Idempotent: duplicate calls are safe.
 */
export async function handleOAuthRevocation(
  supabase: SupabaseClient, merchantId: string,
): Promise<{ revoked: boolean }> {
  if (!merchantId) return { revoked: false };

  // Transactional revocation via RPC — connection + secrets atomically
  const { data: result, error: rpcErr } = await supabase.rpc('revoke_square_connection', {
    p_merchant_id: merchantId,
  });

  if (rpcErr) {
    logger.error('[SQUARE-REVOKE] RPC error (no sensitive details)');
    throw new Error('Revocation RPC failed');
  }

  return { revoked: result?.revoked || false };
}
